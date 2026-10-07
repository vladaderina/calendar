import { useSyncExternalStore } from 'react';
import { v4 as uuid } from 'uuid';
import type { Task } from './types';
import { DEFAULT_SPHERES, DEFAULT_TOPIC } from './types';
import { supabase, isSupabaseAvailable, toTaskRow, fromTaskRow } from './lib/supabase';
import { initAuth, getUserId } from './lib/auth';

const TASKS_KEY = 'calendar.tasks.v1';
const SPHERES_KEY = 'calendar.spheres.v1';
const TOPICS_KEY = 'calendar.topics.v1';
const JOURNAL_KEY = 'calendar.journal.v1';
const VIEW_KEY = 'calendar.view.v1';

// ── LocalStorage helpers (fallback + offline cache) ──────────────────────
function loadTasks(): Task[] {
  try {
    return JSON.parse(localStorage.getItem(TASKS_KEY) || '[]');
  } catch {
    return [];
  }
}
function loadSpheres(): string[] {
  try {
    const raw = localStorage.getItem(SPHERES_KEY);
    if (!raw) return [...DEFAULT_SPHERES];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr : [...DEFAULT_SPHERES];
  } catch {
    return [...DEFAULT_SPHERES];
  }
}
function loadTopics(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TOPICS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return typeof obj === 'object' && obj !== null ? obj : {};
  } catch {
    return {};
  }
}
function loadJournal(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '{}');
  } catch {
    return {};
  }
}
function loadView(): string {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    return saved || 'week';
  } catch {
    return 'week';
  }
}

// ── In-memory state (always mirrors localStorage) ───────────────────────
let tasks: Task[] = loadTasks();
let spheres: string[] = loadSpheres();
let topics: Record<string, string[]> = loadTopics();
let journal: Record<string, string> = loadJournal();
let lastView: string = loadView();
const snapshot = { tasks, spheres, topics, journal, lastView };
const listeners = new Set<() => void>();

// Snapshot of the tasks as of the last emit. Comparing against it is what
// turns "something changed" into "these exact rows changed" — the whole point
// of the incremental sync below.
let prevTaskSnapshot = new Map<string, Task>();

// Coalescing window for outbound writes. Small enough to feel instant, large
// enough that a burst of mutations (a drag, a rename) becomes one request.
const SYNC_DEBOUNCE_MS = 40;

// How often the fallback poll checks the server when realtime is silent.


function emit() {
  // Queue only the task rows that were added, changed, or removed. Identity
  // comparison is enough: every mutating store method builds new Task objects
  // rather than editing in place.
  const next = new Map<string, Task>();
  for (const t of tasks) next.set(t.id, t);
  for (const [id, t] of next) {
    if (prevTaskSnapshot.get(id) !== t) queueTaskPut(id);
  }
  for (const id of prevTaskSnapshot.keys()) {
    if (!next.has(id)) queueTaskDelete(id);
  }
  prevTaskSnapshot = next;

  snapshot.tasks = tasks;
  snapshot.spheres = spheres;
  snapshot.topics = topics;
  snapshot.journal = journal;
  snapshot.lastView = lastView;
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  localStorage.setItem(SPHERES_KEY, JSON.stringify(spheres));
  localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  localStorage.setItem(VIEW_KEY, lastView);
  // Journal / spheres / view are diffed against the server-confirmed shadows
  // in flushPending; nudge a flush only when one of them actually moved.
  if (syncedJournal !== journal || syncedSpheres !== spheres || syncedView !== lastView) {
    scheduleSync();
  }
  listeners.forEach((l) => l());
}

// ── Remote → local ────────────────────────────────────────────────────────
// The single place a server payload replaces local task state. It updates the
// diff baseline too, so applying remote rows never echoes them straight back
// to the server as "changes".
// Guard against a truncated response wiping real local data.
//
// A stalled connection can truncate a body while the status line still says
// 200, and an empty payload is indistinguishable from "the server really has
// no tasks". Applying it blindly would blank the calendar AND persist the
// blank list, so we only trust an empty result once we have seen genuine rows
// from the server at least once. After that, an empty list means a real
// deletion and is honoured.
let sawRemoteRows = false;
// Sphere equivalent, so a truncated empty payload cannot blank the palette.
let sawRemoteSpheres = false;

function applyRemoteTasks(rows: any[]) {
  if (rows.length === 0) {
    if (!sawRemoteRows && tasks.length > 0) {
      console.warn('[supabase] ignoring empty remote payload before first real load');
      return;
    }
  } else {
    sawRemoteRows = true;
  }
  const next = rows.map(fromTaskRow);
  tasks = next;
  prevTaskSnapshot = new Map(next.map((t) => [t.id, t]));
  snapshot.tasks = tasks;
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  listeners.forEach((l) => l());
}

// ── Manual refresh (polling is unreliable on this network) ───────────────
// The tables `tasks`, `spheres`, `journal_entries`, `user_settings` are NOT
// members of the `supabase_realtime` publication (they are created by plain
// SQL and must be added manually in Supabase's SQL Editor). Without them the
// realtime socket reports SUBSCRIBED but delivers zero events, so realtime
// sync is impossible.
//
// Instead, the app:
// 1. Fetches remote state on startup (with retries).
// 2. Syncs to the server when the user makes a change.
// 3. Offers a manual "refresh" button for the user to pull changes.
// 4. Auto-refreshes on visibility/focus to catch external updates.
//
// For true realtime you (the user) must run in Supabase's SQL Editor:
//   ALTER PUBLICATION supabase_realtime ADD TABLE tasks, spheres, journal_entries, user_settings;
export async function pullRemoteTasks(): Promise<void> {
  if (!isSupabaseAvailable || !supabase) return;
  const userId = getUserId();
  if (!userId) return;
  // Pull every slice, not just tasks: a refresh button that fixes tasks but
  // leaves the journal and palette stale is a half-sync. Sequential for the
  // same reason as the initial load — parallel requests starve each other.
  await fetchTasks(userId);
  await fetchSpheres(userId);
  await fetchJournal(userId);
  await fetchView(userId);
  listeners.forEach((l) => l());
}

// Idempotent: initSupabase() and the bootstrap below both call this, and a
// second registration would double every visibilitychange into two pulls.
let syncEventsWired = false;

function setupSyncEvents() {
  if (syncEventsWired) return;
  syncEventsWired = true;
  // Auto-refresh when the tab becomes visible (phone: when the app is brought
  // to the foreground; desktop: when the browser tab regains focus).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void pullRemoteTasks();
    }
  });
  window.addEventListener('online', () => { void pullRemoteTasks(); });
}

// ── Supabase sync ────────────────────────────────────────────────────────
//
// Why this is incremental now. The old version mirrored the ENTIRE local
// state on every change: every task, every journal entry, every sphere, the
// view row. With ~55 tasks that is 55+ sequential round-trips per keystroke
// commit, so a note typed on the laptop took seconds to reach the phone —
// and the flood of change events could re-enter the sync. We now send only
// what actually changed:
//
//   * task writes go through the single `queueTaskPut` / `queueTaskDelete`
//     helpers, so every mutation site is covered by construction;
//   * journal / spheres / view are diffed against what the server last
//     confirmed (the `synced*` shadows below);
//   * a small pump serialises the writes and coalesces bursts, so a drag or
//     a rename that fires many mutations becomes ONE request per task.
//
// Every write still carries user_id, which is what the postgres_changes
// filter needs for the change to reach the other device.

let syncPumpRunning = false;
let syncPending = false;
const taskPutQueue = new Set<string>();
const taskDeleteQueue = new Set<string>();

// Last state the server confirmed. Diffing against these is what keeps an
// unchanged journal or palette from being re-uploaded on every edit.
let syncedJournal: Record<string, string> | null = null;
let syncedSpheres: string[] | null = null;
let syncedView: string | null = null;

function queueTaskPut(id: string) {
  taskDeleteQueue.delete(id);
  taskPutQueue.add(id);
  scheduleSync();
}

function queueTaskDelete(id: string) {
  taskPutQueue.delete(id);
  taskDeleteQueue.add(id);
  scheduleSync();
}

// Coalesce a burst of mutations into one flush.
function scheduleSync() {
  if (syncPending) return;
  syncPending = true;
  setTimeout(() => {
    syncPending = false;
    void drainSync();
  }, SYNC_DEBOUNCE_MS);
}

function hasPendingSync(): boolean {
  return (
    taskPutQueue.size > 0 ||
    taskDeleteQueue.size > 0 ||
    syncedJournal !== journal ||
    syncedSpheres !== spheres ||
    syncedView !== lastView
  );
}

async function drainSync(): Promise<void> {
  if (syncPumpRunning) return;   // a flush is already in flight
  if (!isSupabaseAvailable || !supabase) return;
  if (!getUserId()) return;      // no identity → nothing can be attributed
  syncPumpRunning = true;
  try {
    // Mutations arriving while we await re-queue themselves, so loop until
    // quiet. The iteration cap is a safety valve, not an expected exit.
    let guard = 0;
    while (hasPendingSync() && guard++ < 50) {
      await flushPending();
    }
  } finally {
    syncPumpRunning = false;
  }
}

async function flushPending(): Promise<void> {
  if (!isSupabaseAvailable || !supabase) return;
  const userId = getUserId();
  if (!userId) {
    // Nothing can be written without an identity. Advance the shadows anyway
    // so hasPendingSync() settles instead of spinning.
    syncedJournal = { ...journal };
    syncedSpheres = [...spheres];
    syncedView = lastView;
    taskPutQueue.clear();
    taskDeleteQueue.clear();
    return;
  }

  // ── Tasks: one request per changed task, in a single batch ────────────
  const puts = [...taskPutQueue];
  const deletes = [...taskDeleteQueue];
  // Clear BEFORE awaiting: a mutation arriving mid-flight re-queues itself.
  taskPutQueue.clear();
  taskDeleteQueue.clear();

  try {
    if (puts.length > 0) {
      const rows = puts
        .map((id) => tasks.find((t) => t.id === id))
        .filter((t): t is Task => Boolean(t))
        .map((t) => toTaskRow(t, userId));
      if (rows.length > 0) {
        // Tasks DO carry their primary key, so the default conflict target
        // (id) is correct here — no onConflict needed.
        const { error } = await supabase.from('tasks').upsert(rows);
        if (error) {
          rows.forEach((r) => taskPutQueue.add(r.id));
          console.warn('[supabase] task upsert error:', error.message);
        }
      }
    }
    if (deletes.length > 0) {
      const { error } = await supabase.from('tasks').delete().in('id', deletes);
      if (error) {
        deletes.forEach((id) => taskDeleteQueue.add(id));
        console.warn('[supabase] task delete error:', error.message);
      }
    }
  } catch (e) {
    puts.forEach((id) => taskPutQueue.add(id));
    deletes.forEach((id) => taskDeleteQueue.add(id));
    console.warn('[supabase] sync tasks error:', e);
  }
  // ── Journal: only entries whose text actually changed ─────────────────
  try {
    const shadow = syncedJournal ?? {};
    const changed = Object.entries(journal).filter(([k, v]) => shadow[k] !== v);
    const removed = Object.keys(shadow).filter((k) => !(k in journal));
    if (changed.length > 0) {
      // onConflict is REQUIRED here. These rows carry no `id`, so PostgREST
      // would default the conflict target to the primary key, which never
      // matches — the INSERT then trips the unique index (user_id, date_key)
      // with a 23505 and the whole write is rejected. Naming the real unique
      // key turns it into a genuine upsert.
      const { error } = await supabase.from('journal_entries').upsert(
        changed.map(([dateKey, text]) => ({
          user_id: userId,
          date_key: dateKey,
          text,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'user_id,date_key' },
      );
      if (error) {
        // Do NOT advance the shadow on failure, or the entry is never
        // retried and silently stays out of sync forever.
        console.warn('[supabase] journal upsert error:', error.message);
      } else {
        syncedJournal = { ...journal };
      }
    } else {
      syncedJournal = { ...journal };
    }
    if (removed.length > 0) {
      await supabase
        .from('journal_entries')
        .delete()
        .eq('user_id', userId)
        .in('date_key', removed);
    }
    // The shadow is advanced inside the upsert branch above — only on a
    // confirmed write — so a failed flush stays pending and is retried.
  } catch (e) {
    console.warn('[supabase] sync journal error:', e);
  }

  // ── Spheres: only when the list or its order actually changed ─────────
  try {
    if (syncedSpheres !== spheres) {
      // Same story as the journal: these rows have no `id`, so the conflict
      // target must be the real unique key (user_id, name) or the write
      // fails with 23505 against spheres_user_name_idx.
      const { error } = await supabase.from('spheres').upsert(
        spheres.map((name, idx) => ({ user_id: userId, name, order: idx })),
        { onConflict: 'user_id,name' },
      );
      if (error) {
        console.warn('[supabase] spheres upsert error:', error.message);
      } else {
        syncedSpheres = [...spheres];
      }
    }
  } catch (e) {
    console.warn('[supabase] sync spheres error:', e);
  }

  // ── View state ────────────────────────────────────────────────────────
  try {
    if (syncedView !== lastView) {
      const { error } = await supabase
        .from('user_settings')
        .upsert({ user_id: userId, last_view: lastView });
      if (error) {
        console.warn('[supabase] sync view error:', error.message);
      } else {
        syncedView = lastView;
      }
    }
  } catch (e) {
    console.warn('[supabase] sync view error:', e);
  }
}

// Drop the diff shadows so the next flush re-uploads everything. Called
// after a remote reset or a fresh sign-in.
export function resetSyncShadows() {
  sawRemoteRows = false;
  sawRemoteSpheres = false;
  syncedJournal = null;
  syncedSpheres = null;
  syncedView = null;
  taskPutQueue.clear();
  taskDeleteQueue.clear();
}

// ── Initialise Supabase (auth + realtime + initial load) ────────────────
export { initAuth, getCurrentUser, signOut, isAnonymous, type AuthResult } from './lib/auth';

// Load one remote slice. Each loader is independent, so they run together
// instead of queueing up one after another — on a slow link the four
// sequential requests used to add up to the whole startup delay.
//
// Retry wrapper for PostgREST reads.
//
// On this link roughly every other larger response stalls until the request
// deadline, so a single failed attempt must not leave a slice empty — the
// calendar would look wiped on a device that simply hit a bad packet. Four
// attempts with a growing pause ride out the flaky ones; `null` means "we
// genuinely could not read it", and the caller then leaves local state alone.
async function withRetry<T>(
  label: string,
  run: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
  attempts = 6,
): Promise<T | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, error } = await run();
    if (!error && data != null) return data;
    // A hung socket is the common case here, so the pause stays short and
    // grows slowly: several quick retries beat one long wait.
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * attempt));
  }
  console.warn(`[supabase] could not load ${label} after ${attempts} attempts`);
  return null;
}

// The columns the client actually reads. select('*') also pulls columns the
// schema may grow later, which inflates every response for nothing.
const TASK_COLS =
  'id,user_id,title,notes,start_date,end_date,sphere,recurrence,recurrence_days,year_dates,reminder_days,color,priority,unplanned,order,completed,completed_at,completed_dates,excluded_dates,recurrence_until,subtask_ids,subtask_of,created_at';

// Rows per request. One response holding every task is ~17–27 KB, and on this
// link a response that size stalls: the headers arrive in ~0.35s and the body
// then never completes, so the read hits its deadline and retries. Pages of 25
// rows are ~14 KB and come back in ~0.5s (measured 3/3 pages clean, 25+25+7).
// Paging trades a few fast requests for one that never finishes.
const TASK_PAGE = 25;

async function fetchTasks(userId: string) {
  if (!supabase) return;
  const rows: any[] = [];
  for (let page = 0; page < 20; page++) {
    const from = page * TASK_PAGE;
    const chunk = await withRetry('tasks', () =>
      supabase!
        .from('tasks')
        .select(TASK_COLS)
        .eq('user_id', userId)
        // Stable order is required for paging: rows shifted between requests
        // would otherwise be skipped or duplicated.
        .order('id')
        .range(from, from + TASK_PAGE - 1),
    );
    if (!chunk) return; // a page failed — keep whatever we already have
    rows.push(...(chunk as any[]));
    if ((chunk as any[]).length < TASK_PAGE) break; // last page
  }
  // The server is the source of truth on load: apply as-is so a task deleted
  // on another device disappears here too. applyRemoteTasks still refuses an
  // empty payload until real rows have been seen once.
  applyRemoteTasks(rows);
}

async function fetchSpheres(userId: string) {
  if (!supabase) return;
  const data = await withRetry('spheres', () =>
    supabase!.from('spheres').select('*').eq('user_id', userId).order('order', { ascending: true }),
  );
  if (!data) return;
  // Authoritative, but never let a truncated empty payload wipe the palette:
  // an empty list is only trusted once we have seen real rows, or when there
  // is nothing local to lose.
  if (data.length === 0 && !sawRemoteSpheres && spheres.length > 0) return;
  if (data.length > 0) sawRemoteSpheres = true;
  spheres = (data as any[]).map((r) => r.name);
  snapshot.spheres = spheres;
  syncedSpheres = [...spheres];
  localStorage.setItem(SPHERES_KEY, JSON.stringify(spheres));
}

async function fetchJournal(userId: string) {
  if (!supabase) return;
  const data = await withRetry('journal', () =>
    supabase!.from('journal_entries').select('*').eq('user_id', userId),
  );
  if (!data) return;
  const serverJournal: Record<string, string> = {};
  for (const row of data as any[]) serverJournal[row.date_key] = row.text;

  // Merge with LOCAL WINNING for keys we already hold.
  //
  // Rationale: an entry that failed to upload lives only on this device. If the
  // server copy won, the user's own writing would be deleted by a mere page
  // load. Keys the server has and we do not are adopted; for a key both sides
  // have we keep ours and let the journal diff push it up (syncedJournal is
  // set to the SERVER view below, so exactly those keys re-upload).
  let adopted = false;
  for (const [k, v] of Object.entries(serverJournal)) {
    if (!(k in journal)) {
      journal[k] = v;
      adopted = true;
    }
  }
  if (adopted) {
    snapshot.journal = journal;
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  }
  syncedJournal = serverJournal;

  // If we still hold an entry the server does not have (or a newer value for
  // one), push it up now. Without this, a journal entry that lost its first
  // upload would sit locally forever, only reaching the server the next time
  // the user happened to edit something.
  const diverged = Object.entries(journal).some(([k, v]) => serverJournal[k] !== v);
  if (diverged) scheduleSync();
}

async function fetchView(userId: string) {
  if (!supabase) return;
  // A missing row is normal (maybeSingle → data null); a NETWORK failure must
  // not be mistaken for one, or the view silently reverts to the default.
  const data = await withRetry<{ last_view: string | null } | null>('view', () =>
    supabase!.from('user_settings').select('last_view').eq('user_id', userId).maybeSingle(),
  );
  if (!data?.last_view) return;
  lastView = data.last_view;
  snapshot.lastView = lastView;
  syncedView = lastView;
  localStorage.setItem(VIEW_KEY, lastView);
}

// Realtime channels. Wired up BEFORE the initial load so a change made on the
// other device while we are still fetching is not missed.
function subscribeRealtime(userId: string) {
  if (!supabase) return;

  supabase
    .channel(`public:tasks:user_id=eq.${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${userId}` },
      (payload) => {
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          const task = fromTaskRow(payload.new as any);
          tasks = tasks.filter((t) => t.id !== task.id);
          tasks = [...tasks, task];
        } else if (payload.eventType === 'DELETE') {
          const gone = (payload.old as any)?.id ?? (payload.new as any)?.id;
          if (!gone) return;
          tasks = tasks.filter((t) => t.id !== gone);
        }
        prevTaskSnapshot = new Map(tasks.map((t) => [t.id, t]));
        snapshot.tasks = tasks;
        localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
        listeners.forEach((l) => l());
      },
    )
    .subscribe();

  supabase
    .channel(`public:spheres:user_id=eq.${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'spheres', filter: `user_id=eq.${userId}` },
      () => { void fetchSpheres(userId).then(() => listeners.forEach((l) => l())); },
    )
    .subscribe();

  supabase
    .channel(`public:journal_entries:user_id=eq.${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'journal_entries', filter: `user_id=eq.${userId}` },
      (payload: any) => {
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          journal[payload.new.date_key] = payload.new.text;
        } else if (payload.eventType === 'DELETE' && payload.old) {
          delete journal[payload.old.date_key];
        }
        snapshot.journal = journal;
        syncedJournal = { ...journal };
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
        listeners.forEach((l) => l());
      },
    )
    .subscribe();
}

export async function initSupabase(): Promise<void> {
  if (!isSupabaseAvailable || !supabase) return;

  const user = await initAuth();
  if (!user) return;

  // Channels first, then fetch. Any change that lands between them is either
  // delivered by the channel or picked up by the initial load.
  try {
    subscribeRealtime(user.id);
  } catch (e) {
    console.warn('[supabase] subscription error:', e);
  }

  // The four slices are independent, but they are fetched ONE AFTER ANOTHER.
  //
  // Firing them together starves them: the browser allows only ~6 connections
  // per host, and on this link a stalled socket lingers until its deadline. In
  // a parallel batch all four grabbed a slot at once, the first one's stuck
  // socket held its slot while the others timed out behind it, and the slices
  // that lost the race stayed empty. Sequentially a stuck request costs one
  // timeout and the next slice starts on a fresh connection — measured far
  // more reliable, and the retry above absorbs the occasional stall.
  await fetchTasks(user.id);
  await fetchSpheres(user.id);
  await fetchJournal(user.id);
  await fetchView(user.id);

  listeners.forEach((l) => l());

  setupSyncEvents();
}

const PRIORITY_WEIGHT: Record<string, number> = { high: 0, normal: 1, low: 2 };

export const store = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  add(input: Partial<Task> & { title: string }): Task {
    const priority = input.priority ?? 'low';
    const t: Task = {
      id: uuid(),
      title: input.title,
      notes: input.notes,
      startDate: input.startDate,
      endDate: input.endDate ?? input.startDate,
      sphere: input.sphere,
      topic: input.topic,
      recurrence: input.recurrence ?? 'none',
      recurrenceDays: input.recurrenceDays,
      yearDates: input.yearDates,
      reminderDays: input.reminderDays,
      color: input.color,
      priority,
      unplanned: input.unplanned ?? false,
      order: input.order ?? priorityBaseOrder(priority) + Date.now(),
      completed: false,
      completedDates: input.completedDates,
      excludedDates: input.excludedDates,
      recurrenceUntil: input.recurrenceUntil,
      subtaskIds: input.subtaskIds,
      subtaskOf: input.subtaskOf,
      createdAt: new Date().toISOString(),
    };
    tasks = [...tasks, t];
    emit();
    return t;
  },
  update(id: string, patch: Partial<Task>) {
    tasks = tasks.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, ...patch };
      if (patch.priority != null && patch.priority !== t.priority && patch.order == null) {
        next.order = priorityBaseOrder(patch.priority);
      }
      return next;
    });
    emit();
  },
  remove(id: string) {
    tasks = tasks.filter((t) => t.id !== id);
    emit();
  },
  removeOccurrence(id: string, dateIso: string) {
    tasks = tasks.map((t) =>
      t.id === id
        ? { ...t, excludedDates: [...(t.excludedDates ?? []), dateIso] }
        : t
    );
    emit();
  },
  removeThisAndFollowing(id: string, dateIso: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const start = t.startDate ?? dateIso;
    if (dateIso <= start) {
      tasks = tasks.filter((x) => x.id !== id);
      emit();
      return;
    }
    const until = prevDayIso(dateIso);
    tasks = tasks.map((x) => (x.id === id ? { ...x, recurrenceUntil: until } : x));
    emit();
  },
  reorder(orderedIds: string[]) {
    const stamps = tasks
      .filter((t) => orderedIds.includes(t.id))
      .map((t) => t.order ?? 0)
      .sort((a, b) => a - b);
    const map = new Map<string, number>();
    orderedIds.forEach((id, i) => map.set(id, stamps[i] ?? Date.now() + i));
    tasks = tasks.map((t) => (map.has(t.id) ? { ...t, order: map.get(t.id) } : t));
    emit();
  },
  addSubtask(parentId: string, title: string, parentColor?: string): Task | null {
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent) return null;
    const parentEnd = parent.endDate ?? parent.startDate;
    const today = new Date().toISOString().slice(0, 10);
    const sub = this.add({
      title: title.trim(),
      startDate: today,
      endDate: parentEnd,
      unplanned: false, // has startDate, so not unplanned
      priority: parent.priority ?? 'normal',
      color: parentColor ?? parent.color,
      subtaskOf: parent.id,
      reminderDays: parent.reminderDays,
    });
    const ids = [...(parent.subtaskIds ?? []), sub.id];
    tasks = tasks.map((t) => (t.id === parentId ? { ...t, subtaskIds: ids } : t));
    emit();
    return sub;
  },
  addSubtasks(parentId: string, titles: string[]): Task[] {
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent) return [];
    const parentEnd = parent.endDate ?? parent.startDate;
    const today = new Date().toISOString().slice(0, 10);
    const created: Task[] = [];
    const parentColor = parent.color;
    for (const title of titles) {
      const t = title.trim();
      if (!t) continue;
      const id = uuid();
      const sub: Task = {
        id, title: t, startDate: today, endDate: parentEnd,
        unplanned: false, // has startDate, so not in backlog
        priority: 'normal', color: parentColor,
        subtaskOf: parent.id, order: Date.now() + created.length,
        completed: false, recurrence: 'none', createdAt: new Date().toISOString(),
        reminderDays: parent.reminderDays,
      };
      created.push(sub);
    }
    if (created.length > 0) {
      const ids = [...(parent.subtaskIds ?? []), ...created.map((s) => s.id)];
      tasks = [...tasks, ...created];
      tasks = tasks.map((t) => (t.id === parentId ? { ...t, subtaskIds: ids } : t));
      emit();
    }
    return created;
  },
  removeWithSubtasks(id: string) {
    const toDelete: string[] = [id];
    const collectSubtasks = (parentId: string) => {
      const parent = tasks.find((t) => t.id === parentId);
      if (!parent?.subtaskIds) return;
      for (const sid of parent.subtaskIds) {
        const sub = tasks.find((t) => t.id === sid);
        if (sub && !sub.completed) {
          toDelete.push(sid);
          collectSubtasks(sid);
        }
      }
    };
    collectSubtasks(id);
    tasks = tasks.filter((t) => !toDelete.includes(t.id));
    emit();
  },
  subtaskCompletion(parentId: string): { done: number; total: number } {
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent || !parent.subtaskIds?.length) return { done: 0, total: 0 };
    let done = 0, total = 0;
    for (const id of parent.subtaskIds) {
      const sub = tasks.find((t) => t.id === id);
      if (!sub) continue;
      total++;
      if (sub.completed) done++;
    }
    return { done, total };
  },
  toggleComplete(id: string, dateIso?: string) {
    tasks = tasks.map((t) => {
      if (t.id !== id) return t;
      if (t.recurrence !== 'none' && dateIso) {
        const done = t.completedDates ?? [];
        const has = done.includes(dateIso);
        return {
          ...t,
          completedDates: has ? done.filter((d) => d !== dateIso) : [...done, dateIso],
        };
      }
      return {
        ...t,
        completed: !t.completed,
        completedAt: !t.completed ? new Date().toISOString() : undefined,
      };
    });
    emit();
  },
  renameSphere(oldName: string, newName: string) {
    const name = newName.trim();
    if (!name || name === oldName) return;
    spheres = spheres.map((s) => (s === oldName ? name : s));
    tasks = tasks.map((t) => (t.sphere === oldName ? { ...t, sphere: name } : t));
    // Copy topics from old sphere name to new
    const oldTopics = topics[oldName];
    if (oldTopics) {
      topics = { ...topics, [name]: oldTopics };
      delete topics[oldName];
    }
    emit();
  },
  addSphere(name: string) {
    const n = name.trim();
    if (!n || spheres.includes(n)) return;
    spheres = [...spheres, n];
    // Initialize with empty topics (Основное is implicit)
    topics = { ...topics, [n]: [] };
    emit();
  },
  removeSphere(name: string) {
    spheres = spheres.filter((s) => s !== name);
    tasks = tasks.map((t) => (t.sphere === name ? { ...t, sphere: undefined } : t));
    const newTopics = { ...topics };
    delete newTopics[name];
    topics = newTopics;
    emit();
  },
  reorderSpheres(ordered: string[]) {
    const filtered = ordered.filter((s) => spheres.includes(s));
    spheres = filtered.length ? filtered : [...spheres];
    emit();
  },
  reorderTopics(sphere: string, ordered: string[]) {
    const existing = topics[sphere] ?? [];
    const filtered = ordered.filter((t) => existing.includes(t));
    if (filtered.length !== existing.length) return;
    topics = { ...topics, [sphere]: filtered };
    emit();
  },
  addTopic(sphere: string, name: string) {
    const n = name.trim();
    if (!n || !spheres.includes(sphere)) return;
    const list = topics[sphere] ?? [];
    if (list.includes(n)) return;
    topics = { ...topics, [sphere]: [...list, n] };
    emit();
  },
  removeTopic(sphere: string, name: string) {
    if (name === DEFAULT_TOPIC || !spheres.includes(sphere)) return;
    const list = topics[sphere] ?? [];
    const next = list.filter((t) => t !== name);
    if (next.length === list.length) return; // Not found
    topics = { ...topics, [sphere]: next };
    // Move tasks from this topic to Основное
    tasks = tasks.map((t) =>
      t.sphere === sphere && t.topic === name
        ? { ...t, topic: undefined }
        : t
    );
    emit();
  },
  renameTopic(sphere: string, oldName: string, newName: string) {
    const name = newName.trim();
    if (!name || name === oldName || !spheres.includes(sphere)) return;
    const list = topics[sphere] ?? [];
    if (!list.includes(oldName) || list.includes(name)) return;
    topics = {
      ...topics,
      [sphere]: list.map((t) => (t === oldName ? name : t)),
    };
    tasks = tasks.map((t) =>
      t.sphere === sphere && t.topic === oldName ? { ...t, topic: name } : t
    );
    emit();
  },
  clearAll() {
    tasks = [];
    spheres = [...DEFAULT_SPHERES];
    journal = {};
    lastView = 'week';
    localStorage.removeItem(TASKS_KEY);
    localStorage.setItem(SPHERES_KEY, JSON.stringify(spheres));
    localStorage.removeItem(JOURNAL_KEY);
    localStorage.setItem(VIEW_KEY, lastView);
    emit();
  },
  getById(id: string): Task | undefined {
    return tasks.find((t) => t.id === id);
  },
  // ── Journal ──────────────────────────────────────────────────────
  saveJournalEntry(dateKey: string, text: string) {
    const trimmed = text.trim();
    if (trimmed) {
      journal[dateKey] = trimmed;
    } else {
      delete journal[dateKey];
    }
    snapshot.journal = journal;
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
    scheduleSync();
    listeners.forEach((l) => l());
  },
  saveJournalAll(data: Record<string, string>) {
    journal = data;
    snapshot.journal = journal;
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
    scheduleSync();
    listeners.forEach((l) => l());
  },
  deleteJournalEntry(dateKey: string) {
    delete journal[dateKey];
    snapshot.journal = journal;
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
    scheduleSync();
    listeners.forEach((l) => l());
  },
  removeSubtask(parentId: string, subtaskId: string) {
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent?.subtaskIds?.includes(subtaskId)) return;
    tasks = tasks.filter((t) => t.id !== subtaskId);
    tasks = tasks.map((t) =>
      t.id === parentId
        ? { ...t, subtaskIds: t.subtaskIds?.filter((id) => id !== subtaskId) }
        : t
    );
    emit();
  },
  // ── View ─────────────────────────────────────────────────────────
  saveView(view: string) {
    lastView = view;
    snapshot.lastView = lastView;
    localStorage.setItem(VIEW_KEY, lastView);
    scheduleSync();
    listeners.forEach((l) => l());
  },
};

function priorityBaseOrder(priority: string): number {
  const weight = PRIORITY_WEIGHT[priority] ?? 1;
  return weight * 1e15;
}

function prevDayIso(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function useTasks(): Task[] {
  return useSyncExternalStore(store.subscribe, () => snapshot.tasks, () => snapshot.tasks);
}
export function useSpheres(): string[] {
  return useSyncExternalStore(store.subscribe, () => snapshot.spheres, () => snapshot.spheres);
}
export function useTopics(): Record<string, string[]> {
  return useSyncExternalStore(store.subscribe, () => snapshot.topics, () => snapshot.topics);
}
export function useJournal(): Record<string, string> {
  return useSyncExternalStore(store.subscribe, () => snapshot.journal, () => snapshot.journal);
}
export function useLastView(): string {
  return useSyncExternalStore(store.subscribe, () => snapshot.lastView, () => snapshot.lastView);
}

// ── Self-starting sync bootstrap ─────────────────────────────────────────
// setupSyncEvents() is also called at the end of initSupabase(), but that path
// can bail out early (auth unavailable, a rejected promise) and would silently
// leave the app with no way to notice remote changes. Wiring it here makes the
// refresh net independent of the init sequence. It is idempotent thanks to the
// guard inside, so the duplicate call is harmless.
if (typeof window !== 'undefined' && isSupabaseAvailable) {
  setTimeout(() => { setupSyncEvents(); }, 3000);
}
