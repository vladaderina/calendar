import { useSyncExternalStore } from 'react';
import { v4 as uuid } from 'uuid';
import type { Task } from './types';
import { DEFAULT_SPHERES, DEFAULT_TOPIC } from './types';
import { supabase, isSupabaseAvailable, toTaskRow, fromTaskRow } from './lib/supabase';
import { initAuth, getUserId } from './lib/auth';
import { getColors, saveColors, colorsCustomized, isDefaultPalette, type TaskColor } from './config/colors';
import { wheelJson, mergeWheel } from './lib/wheel';
import { wheelNotesJson, mergeWheelNotes } from './lib/wheelNotes';
import {
  MAX_LEVEL,
  emptyCategory,
  inSubtree,
  insertNode,
  keyPath,
  mapNode,
  mergeTree,
  newNode,
  newNoteNode,
  nodeAt,
  normalizeTree,
  pathExists,
  pathKey,
  removeNodeAt,
  renamePrefix,
  reorderLevel,
  type BlockKind,
  type Tree,
  type TreeNode,
} from './lib/tree';

const TASKS_KEY = 'calendar.tasks.v1';
const SPHERES_KEY = 'calendar.spheres.v1';
const TOPICS_KEY = 'calendar.topics.v1';
const JOURNAL_KEY = 'calendar.journal.v1';
try {
  localStorage.removeItem(JOURNAL_KEY);
} catch {}
const VIEW_KEY = 'calendar.view.v1';
// Deletion tombstones: a delete that has not been confirmed by the server yet
// must survive a page reload, or reloading while a delete is in flight brings
// the category/note back. Kept in localStorage, not in memory.
const TOMBSTONES_KEY = 'calendar.tombstones.v1';

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
// The dashboard's folder tree. Old profiles hold a flat `{ sphere: [name] }`
// list; `normalizeTree` turns it into nodes that carry a tasks block, so the
// categories the user already has keep showing their tasks.
function loadTopics(): Tree {
  try {
    const raw = localStorage.getItem(TOPICS_KEY);
    if (!raw) return {};
    return normalizeTree(JSON.parse(raw));
  } catch {
    return {};
  }
}
function loadJournal(): Record<string, string> {
  return {};
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
let topics: Tree = loadTopics();
let journal: Record<string, string> = loadJournal();
let lastView: string = loadView();

// Rebuild the dashboard's sub-category tabs from the task rows themselves.
//
// A task carries its sub-category in its OWN row (`topic`, encoded in `notes`
// for the deployed schema), but the list of tabs a category shows lives in a
// single settings segment. Losing that segment (a fresh browser profile, cleared
// storage, an old tab writing a colours-only settings string) used to make the
// sub-categories disappear from the dashboard — and, because the dashboard only
// lists topics the category owns, every task filed under them disappeared with
// them. The task rows are on the server, so the tab list can always be rebuilt.
//
// Deleting a topic also clears `topic` on its tasks and renaming rewrites them,
// so a restored tab is never a topic the user removed on purpose.
function ensureTaskPath(tree: Tree, sphere: string, path: string[]): Tree {
  const category = tree[sphere] ?? emptyCategory();
  let list = category.children;
  let existing = 0;
  for (const name of path) {
    const found = list.find((node) => node.name === name);
    if (!found) break;
    existing += 1;
    list = found.children;
  }
  if (existing === path.length) return tree;
  // Build the missing tail as a chain; these nodes exist only because a task
  // points at them, so they get a tasks block.
  let chain: TreeNode | null = null;
  for (let i = path.length - 1; i >= existing; i--) {
    chain = { ...newNode(path[i], ['tasks']), children: chain ? [chain] : [] };
  }
  if (!chain) return tree;
  const children = existing ? insertNode(category.children, path.slice(0, existing), chain) : [...category.children, chain];
  return { ...tree, [sphere]: { ...category, children } };
}

function restoreTopicsFromTasks(): void {
  let next: Tree | null = null;
  for (const task of tasks) {
    const sphere = task.sphere;
    const topic = task.topic;
    if (!sphere || !topic || topic === DEFAULT_TOPIC) continue;
    if (!spheres.includes(sphere)) continue;
    const path = keyPath(topic);
    if (!path.length || path.length > MAX_LEVEL - 1) continue;
    const before: Tree = next ?? topics;
    const after = ensureTaskPath(before, sphere, path);
    if (after !== before) next = after;
  }
  if (next) topics = next;
}

/** Categories that exist without a tree entry (data from before folders/blocks,
 *  or a row inserted straight into the database) would open with NO blocks and
 *  look empty although they hold tasks. Give them a tasks block once. A category
 *  the user creates herself always gets an explicit entry (`blocks: []`). */
function ensureCategoryTrees(): void {
  let changed = false;
  const next = { ...topics };
  for (const sphere of spheres) {
    if (!next[sphere]) {
      next[sphere] = { blocks: ['tasks'], children: [] };
      changed = true;
    }
  }
  if (changed) {
    topics = next;
    try {
      localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
    } catch {
      // quota — the map is rebuilt from tasks on the next load anyway
    }
  }
}

restoreTopicsFromTasks();
ensureCategoryTrees();

const snapshot = { tasks, spheres, topics, journal, lastView };
const listeners = new Set<() => void>();

// ── Sync status (visible to the user) ────────────────────────────────────
// Without this the app shows an empty or stale calendar while the network is
// failing and gives no hint that the server was never reached — the user sees
// "в базе всё есть, а тут пусто" and cannot tell a real empty calendar from a
// failed load. Every read/write path reports here; the header renders it.
export type SyncState = 'idle' | 'syncing' | 'ok' | 'error' | 'offline';
export type SyncStatus = { state: SyncState; message: string; lastSuccessAt: number | null };
let syncStatus: SyncStatus = { state: 'idle', message: '', lastSuccessAt: null };
const syncStatusListeners = new Set<() => void>();
const syncStatusSnapshot = { current: syncStatus };
const SYNC_STATE_KEY = 'calendar.syncstate.v1';

function setSyncStatus(next: Partial<SyncStatus>): void {
  const merged: SyncStatus = { ...syncStatus, ...next };
  if (
    merged.state === syncStatus.state &&
    merged.message === syncStatus.message &&
    merged.lastSuccessAt === syncStatus.lastSuccessAt
  ) return;
  syncStatus = merged;
  syncStatusSnapshot.current = merged;
  if (merged.state === 'ok') {
    try { localStorage.setItem(SYNC_STATE_KEY, String(merged.lastSuccessAt ?? Date.now())); } catch {}
  }
  syncStatusListeners.forEach((l) => l());
}

export function getSyncStatus(): SyncStatus {
  return syncStatus;
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => { syncStatusListeners.add(l); return () => { syncStatusListeners.delete(l); }; },
    () => syncStatusSnapshot.current,
    () => syncStatusSnapshot.current,
  );
}

// Last time the server answered with real data. Shown in the banner so the user
// can tell "local copy from 3 days ago" from "local copy from 2 minutes ago".
function loadLastSyncAt(): number | null {
  try {
    const raw = localStorage.getItem(SYNC_STATE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
syncStatus = { ...syncStatus, lastSuccessAt: loadLastSyncAt() };
syncStatusSnapshot.current = syncStatus;

// Snapshot of the tasks as of the last emit. Comparing against it is what
// turns "something changed" into "these exact rows changed" — the whole point
// of the incremental sync below.
let prevTaskSnapshot = new Map<string, Task>();

// Coalescing window for outbound writes. Small enough to feel instant, large
// enough that a burst of mutations (a drag, a rename) becomes one request.
const SYNC_DEBOUNCE_MS = 40;

// How often the fallback poll checks the server when realtime is silent.


function emit() {
  // Never let a task's sub-category exist without its tab (see
  // restoreTopicsFromTasks): a task whose topic has no tab is invisible on the
  // dashboard, which reads to the user as "задачи пропали".
  restoreTopicsFromTasks();
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
  if (
    !sameJournal(syncedJournal, journal) ||
    !sameStringArray(syncedSpheres, spheres) ||
    syncedView !== lastView ||
    topicsPendingSync() ||
    catPending()
  ) {
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

async function applyRemoteTasks(rows: any[], userId: string): Promise<void> {
  if (rows.length === 0 && tasks.length > 0) {
    // An empty payload is only believable if we are really authenticated as
    // this user AND the server really has no rows. A 200 with `[]` also comes
    // back when the JWT has expired or RLS filters everything out, and treating
    // that as "the user deleted all 55 tasks" wipes the calendar AND persists
    // the wipe. Ask the server for a count and check the session first.
    const { data: sessionData } = await supabase!.auth.getSession();
    if (!sessionData.session?.user || sessionData.session.user.id !== userId) {
      console.warn('[supabase] empty payload without a valid session — keeping local tasks');
      setSyncStatus({ state: 'error', message: 'сессия истекла — войдите заново' });
      return;
    }
    const { count, error } = await supabase!
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (error || count === null) {
      console.warn('[supabase] could not confirm empty task list — keeping local tasks');
      setSyncStatus({ state: 'error', message: 'нет связи с сервером' });
      return;
    }
    if (count > 0) {
      console.warn(`[supabase] empty payload but server holds ${count} tasks — keeping local tasks`);
      setSyncStatus({ state: 'error', message: 'сервер прислал пустой ответ — показаны локальные данные' });
      return;
    }
    if (!sawRemoteRows) {
      console.warn('[supabase] ignoring empty remote payload before first real load');
      return;
    }
  } else if (rows.length > 0) {
    sawRemoteRows = true;
  }

  // A response is a snapshot of the server taken BEFORE it arrived, so it can
  // easily predate the user's own last few actions. Replacing `tasks` with it
  // blindly is what made tasks and edits vanish. Merge instead:
  const fetched = rows.map(fromTaskRow);
  // A row that is TOMBSTONED but present on the server means a stale client
  // pushed it back after our delete landed. Drop it from the view AND re-arm the
  // DELETE: without this the resurrected row is merely hidden here and stays in
  // the database (where the other device keeps seeing it).
  const resurrected = fetched.filter((t) => deletedTaskIds.has(t.id));
  if (resurrected.length > 0) {
    console.warn(`[supabase] ${resurrected.length} deleted task(s) came back — removing them again`);
    resurrected.forEach((t) => taskDeleteQueue.add(t.id));
    savePending();
    scheduleSync();
  }
  const remote = fetched.filter((t) => !deletedTaskIds.has(t.id));
  const remoteIds = new Set(remote.map((t) => t.id));

  const unconfirmed: Task[] = [];
  for (const t of tasks) {
    if (remoteIds.has(t.id)) continue;
    // Not yet uploaded (or its write is in flight) → handled by the merge
    // below; present in the response → remote wins unless a write is pending.
    if (!pendingTaskRows.has(t.id) && !taskPutQueue.has(t.id)) unconfirmed.push(t);
  }

  // For the rest, "absent from the response" may mean "deleted on another
  // device" — or it may mean "skipped by a paged read / lost to a truncated
  // body". Ask the server about exactly these ids before dropping them, since
  // a drop here is indistinguishable from the user deleting their own work.
  // "Absent from the response" has two meanings and they need opposite
  // handling. A row this device has SEEN on the server before, now gone, is a
  // deletion made elsewhere — drop it. A row the server has never had is work
  // this device still owes it — upload it. Treating both as "still owed" is what
  // made a delete come back on the other device within seconds.
  const knownBefore = new Set(serverKnownIds);
  // First fetch after this build: the set is empty, so nothing can be classified
  // as "seen before". Assume server-known, or the upgrade itself would re-upload
  // every row of every device at once.
  const bootstrap = knownBefore.size === 0;

  let kept = unconfirmed;
  if (unconfirmed.length > 0) {
    // Ask the server about every local row the response did not contain. The
    // batch used to be capped at 60 ids, which silently skipped the whole check
    // for a calendar with more local-only rows than that — those rows stayed on
    // this device forever and never reached the other one. Instead, chunk the
    // ids and confirm them all.
    const stillThere = new Set<string>();
    let confirmed = true;
    for (let i = 0; i < unconfirmed.length; i += 60) {
      const batch = unconfirmed.slice(i, i + 60).map((t) => t.id);
      const found = await withRetry<{ id: string }[]>(
        'tasks-confirm',
        () => supabase!.from('tasks').select('id').eq('user_id', userId).in('id', batch),
        2,
      );
      // A failed read means "unknown", not "deleted": keep everything.
      if (found === null) {
        confirmed = false;
        break;
      }
      found.forEach((r) => stillThere.add(r.id));
    }
    if (confirmed) {
      const absent = unconfirmed.filter((t) => !stillThere.has(t.id));
      // Deleted on another device: we knew these rows were on the server and the
      // confirm-read says they are gone. Drop them (never re-upload).
      const removedElsewhere = absent.filter((t) => knownBefore.has(t.id));
      if (removedElsewhere.length > 0) {
        console.warn(`[supabase] ${removedElsewhere.length} task(s) deleted on another device — applying locally`);
      }
      // Local-only work: created or edited while the link was down and its upload
      // never landed. Dropping it here would be silent data loss, so keep it and
      // put it back in the upload queue.
      const missing = bootstrap ? [] : absent.filter((t) => !knownBefore.has(t.id));
      if (missing.length > 0) {
        // Re-queueing puts them into pendingTaskRows, so the merge below keeps
        // the local copy and the pump uploads it on the next flush.
        console.warn(`[supabase] ${missing.length} local task(s) missing on server — re-queueing upload`);
        missing.forEach((t) => queueTaskPut(t.id));
      }
      kept = unconfirmed.filter((t) => stillThere.has(t.id));
    }
  }

  const merged = new Map<string, Task>();
  for (const t of remote) merged.set(t.id, t);
  // A row with a write still owed to the server keeps its LOCAL version: the
  // response predates that write, so letting it win would undo the edit on
  // screen (and, before this merge, on the server too).
  for (const t of tasks) {
    if (pendingTaskRows.has(t.id) || taskPutQueue.has(t.id)) merged.set(t.id, t);
  }
  for (const t of kept) merged.set(t.id, t);
  tasks = [...merged.values()];
  // Remember what the server holds NOW (plus the rows the confirm-read just
  // proved exist), so the next fetch can tell a deletion made elsewhere from
  // work this device still owes.
  serverKnownIds.clear();
  for (const t of remote) serverKnownIds.add(t.id);
  for (const t of kept) serverKnownIds.add(t.id);
  saveServerIds();
  prevTaskSnapshot = new Map(tasks.map((t) => [t.id, t]));
  snapshot.tasks = tasks;
  // Server rows may carry sub-categories this device's tab list lost; rebuild
  // the tabs now so the dashboard shows them without waiting for an edit.
  const topicsBeforeRestore = JSON.stringify(topics);
  restoreTopicsFromTasks();
  if (JSON.stringify(topics) !== topicsBeforeRestore) {
    snapshot.topics = topics;
    localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
    scheduleSync();
  }
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
  if (isOffline()) {
    setSyncStatus({ state: 'offline', message: 'нет сети — изменения копятся на устройстве' });
    return;
  }
  if (syncStatus.state === 'error' || syncStatus.state === 'offline') {
    setSyncStatus({ state: 'syncing', message: 'пробую снова…' });
  }
  // Pull every slice, not just tasks: a refresh button that fixes tasks but
  // leaves the journal and palette stale is a half-sync. Sequential for the
  // same reason as the initial load — parallel requests starve each other.
  await fetchTasks(userId);
  await fetchSpheres(userId);
  await fetchJournal(userId);
  await fetchView(userId);
  listeners.forEach((l) => l());
  // A failed load must not be a dead end: with no local copy the calendar is
  // empty and the user only sees "нет данных". Keep trying with backoff until
  // the server answers, so the board fills itself once the link recovers.
  if (syncStatus.state === 'error') scheduleLoadRetry();
  else loadRetryCount = 0;
}

// ── Automatic retry after a failed load ───────────────────────────────────
// The poll already retries reads every 2.5 s, but it is suspended when the tab
// is in the background (phone screen off) and it gives up quietly. This timer
// is the deliberate "try again until it works" path: 2 s, 4 s, 8 s … up to a
// minute, 8 attempts. A successful read resets the counter.
let loadRetryTimer: ReturnType<typeof setTimeout> | null = null;
let loadRetryCount = 0;

function scheduleLoadRetry(): void {
  if (loadRetryTimer) return;
  if (isOffline()) return;
  if (loadRetryCount >= 8) return;
  const delay = Math.min(60000, 2000 * 2 ** loadRetryCount);
  loadRetryCount++;
  loadRetryTimer = setTimeout(() => {
    loadRetryTimer = null;
    void pullRemoteTasks();
  }, delay);
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
      // A phone that was suspended mid-request comes back with dead sockets;
      // the pending writes are restored from localStorage, so a pull now both
      // re-sends them and picks up what the other device did meanwhile.
      void pullRemoteTasks();
    }
  });
  window.addEventListener('offline', () => {
    setSyncStatus({ state: 'offline', message: 'нет сети — изменения копятся на устройстве' });
  });
  window.addEventListener('online', () => {
    setSyncStatus({ state: 'syncing', message: 'связь восстановлена, синхронизирую…' });
    if (hasPendingSync()) void drainSync();
    void pullRemoteTasks();
  });
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
let syncedColorsJson: string | null = null;
// The year-wheel marks travel in the same `user_settings.last_view` string as
// the palette, so the two must always be written TOGETHER: writing only one of
// them used to drop the other segment from the server row.
let syncedWheelJson: string | null = null;
// Last wheel-note list the server confirmed. The wheel's notes are a fully
// separate list from tasks, so they get their own segment and their own shadow:
// mixing them into the wheel-marks string would make one device's note edit
// look like a repaint of the whole year.
let syncedNotesJson: string | null = null;
// Last topic map (`{ sphere: [topic, ...] }`) the server confirmed. Topics are
// the sub-categories of the dashboard, and they live ONLY in this segment —
// without it a topic created on the laptop never exists on the phone, and
// every task filed under it has nowhere to show up.
let syncedTopicsJson: string | null = null;

// True when this device holds a topic map the server has not confirmed yet.
// Kept in one place because both the emit() nudge and the flush use it.
function topicsPendingSync(): boolean {
  const current = JSON.stringify(topics);
  return syncedTopicsJson === null ? current !== '{}' : syncedTopicsJson !== current;
}

// True when this device holds wheel notes the server has not confirmed. Same
// rule as topics: an EMPTY list is not uploaded (a fresh browser profile would
// otherwise erase the notes the other device made), but a list with tombstones
// in it is — a deletion has to reach the server too.
function notesPendingSync(): boolean {
  const current = wheelNotesJson();
  return syncedNotesJson === null ? current !== '{}' : syncedNotesJson !== current;
}

function sameColors(a: string | null, b: string): boolean {
  if (a === null) return false;
  return a === b;
}

// ── user_settings payload ────────────────────────────────────────────────
// Shape: `sync#colors:<json>#wheel:<json>#topics:<json>`. Every segment is
// optional, and an old plain view name (`week`) may still be in the row from
// before this format existed. Segments are always written in that fixed order
// and split by marker POSITION, so a value can never swallow the one after it
// (the old code sliced the palette up to `#wheel:`, which broke the moment a
// third segment was appended).
const SETTINGS_MARKERS = ['#colors:', '#wheel:', '#topics:', '#cat:', '#notes:'] as const;
type SettingsSegment = 'colors' | 'wheel' | 'topics' | 'cat' | 'notes';

export function splitSettings(raw: string): {
  colors: string | null;
  wheel: string | null;
  topics: string | null;
  cat: string | null;
  notes: string | null;
} {
  const text = raw ?? '';
  const out: Record<SettingsSegment, string | null> = { colors: null, wheel: null, topics: null, cat: null, notes: null };
  for (let i = 0; i < SETTINGS_MARKERS.length; i++) {
    const marker = SETTINGS_MARKERS[i];
    const at = text.indexOf(marker);
    if (at < 0) continue;
    const start = at + marker.length;
    let end = text.length;
    for (let j = i + 1; j < SETTINGS_MARKERS.length; j++) {
      const next = text.indexOf(SETTINGS_MARKERS[j], start);
      if (next >= 0) {
        end = next;
        break;
      }
    }
    out[marker.slice(1, -1) as SettingsSegment] = text.slice(start, end);
  }
  return out;
}

export function buildSettings(
  colors: string | null,
  wheel: string | null,
  topicsList: string | null = null,
  cat: string | null = null,
  notes: string | null = null,
): string {
  return 'sync'
    + (colors ? `#colors:${colors}` : '')
    + (wheel ? `#wheel:${wheel}` : '')
    + (topicsList ? `#topics:${topicsList}` : '')
    + (cat ? `#cat:${cat}` : '')
    + (notes ? `#notes:${notes}` : '');
}

// Push the settings segments that changed, PRESERVING the one we are not
// writing. The row is read first because a device may hold a segment it does
// not own (a fresh browser profile has the built-in palette, but the server
// may hold the user's renamed one — writing our own string blindly deleted it).
async function pushSettings(userId: string): Promise<void> {
  if (!supabase) return;
  const currentColors = JSON.stringify(getColors());
  const colorsChanged = colorsCustomized() && !sameColors(syncedColorsJson, currentColors);
  const currentWheel = wheelJson();
  const wheelChanged = syncedWheelJson !== currentWheel;
  // Topics (sub-categories) live only in this one JSON segment. A device that
  // has never synced and holds an empty map must not upload it — that would
  // erase the topic lists the other device created.
  const currentTopics = JSON.stringify(topics);
  const topicsChanged = syncedTopicsJson === null
    ? currentTopics !== '{}'
    : syncedTopicsJson !== currentTopics;
  // Category deletions/re-creations. `catPending()` is a shadow comparison, so
  // a device that only LEARNED the intent from the server (or never deleted
  // anything) writes nothing, and one that deleted something writes once.
  const catChanged = catPending();
  const currentNotes = wheelNotesJson();
  const notesChanged = notesPendingSync();
  if (!colorsChanged && !wheelChanged && !topicsChanged && !catChanged && !notesChanged) return;

  const { data, error } = await supabase
    .from('user_settings')
    .select('last_view')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[supabase] sync settings read error:', error.message);
    return; // do not overwrite a row we could not read
  }
  const existing = splitSettings(((data as any)?.last_view as string) ?? '');
  const colors = colorsChanged ? currentColors : existing.colors;
  const wheel = wheelChanged ? currentWheel : existing.wheel;
  const topicsSegment = topicsChanged ? currentTopics : existing.topics;
  // The row may already carry deletions made on the other device. Merging
  // before writing is what keeps a push from THIS device from erasing them —
  // and the union is exactly what both devices end up agreeing on.
  let catSegment = existing.cat;
  if (catChanged) {
    let parsedCat: unknown = null;
    if (existing.cat) {
      try {
        parsedCat = JSON.parse(existing.cat);
      } catch {
        parsedCat = null;
      }
    }
    if (parsedCat) adoptCatIntent(parsedCat);
    catSegment = catIntentJson();
  }
  // A segment this device is not writing is taken from the server row as-is,
  // so a push never erases the notes (or palette, or topics) of the other one.
  const notesSegment = notesChanged ? currentNotes : existing.notes;
  const { error: writeError } = await supabase
    .from('user_settings')
    .upsert({ user_id: userId, last_view: buildSettings(colors, wheel, topicsSegment, catSegment, notesSegment) });
  if (writeError) {
    console.warn('[supabase] sync settings error:', writeError.message);
    return;
  }
  if (colorsChanged) syncedColorsJson = currentColors;
  if (wheelChanged) syncedWheelJson = currentWheel;
  if (topicsChanged) syncedTopicsJson = currentTopics;
  if (catChanged && catSegment) setSyncedCat(catSegment);
  if (notesChanged) syncedNotesJson = currentNotes;
}

// ── Deletion tombstones ──────────────────────────────────────────────────
// A pending deletion must survive a fetch that still sees the row.
//
// The fetch paths ADOPT anything the server has and we do not (that is how an
// entry written on the phone reaches the laptop). The same rule resurrects a
// row the user just deleted while its DELETE was still in flight or had
// failed: the fetch re-adds it, and since the local list now matches the
// server again, no retry is ever scheduled — the deletion is lost for good and
// the note/category reappears on every reload.
//
// Remembering the key until the delete is CONFIRMED is what makes a deletion
// stick. Entries leave these sets only after the server accepted the delete.
const deletedJournalKeys = new Set<string>();
// ── Category deletions ────────────────────────────────────────────────────
//
// A category deletion must be a fact about the ACCOUNT, not about one browser.
//
// The old shape was a name list in this browser's localStorage with a 24 h
// expiry, plus a DELETE queued once. That is exactly "удаляю категорию, а через
// время она снова появляется": as soon as the local memory expired, any stale
// copy of the old list — the other device whose tab still held the category, a
// phone that was offline when the delete happened, a fresh browser profile —
// re-uploaded the row, and there was nothing left to argue with. The row then
// stood in the table forever and every fetch adopted it again.
//
// So the intent itself now travels in `user_settings.last_view` (the `#cat:`
// segment), which every device already reads: two timestamps per name, `d` =
// deleted at, `r` = re-created at. A name is deleted while `d > r`. There is no
// expiry — re-creating the category clears the deletion by stamping `r`, which
// is a smaller and much more visible event than "the category quietly returns
// a day later".
const sphereTombstoneAt = new Map<string, number>();   // name → deleted at
const sphereRevivedAt = new Map<string, number>();     // name → re-created at
// Derived from the two maps above: the set every fetch path filters with.
const deletedSpheres = new Set<string>();
// Names whose row on the server is still owed a DELETE right now. Kept apart
// from the tombstone set on purpose: `hasPendingSync()` must settle once the
// DELETE is confirmed, while the intent itself stays forever.
const sphereDeleteQueue = new Set<string>();

// Text of this device's intent as it was last seen on / written to the server.
// A device with nothing to say (no deletions ever) must not upload an empty
// segment, and a device that learned the intent from a fetch must not re-upload
// it in a loop.
const CAT_SHADOW_KEY = 'calendar.cat_synced.v1';
const EMPTY_CAT_INTENT = '{"d":{},"r":{}}';
let syncedCatJson: string | null = (() => {
  try {
    return localStorage.getItem(CAT_SHADOW_KEY);
  } catch {
    return null;
  }
})();

// Names whose row the server has actually confirmed as gone. Without this the
// startup re-queue below asked the server to delete every category ever deleted,
// on every load, forever — a request per session that only ever answered "0 rows
// removed" and looked like a blocked (RLS) delete.
const CAT_CONFIRMED_KEY = 'calendar.cat_confirmed.v1';
const confirmedSphereDeletes = new Set<string>();
function loadConfirmedSpheres(): void {
  try {
    const raw = localStorage.getItem(CAT_CONFIRMED_KEY);
    if (!raw) return;
    (JSON.parse(raw) as string[]).forEach((name) => {
      if (typeof name === 'string' && name) confirmedSphereDeletes.add(name);
    });
  } catch {
    // a corrupt blob just means every delete is re-issued once
  }
}
function saveConfirmedSpheres(): void {
  try {
    localStorage.setItem(CAT_CONFIRMED_KEY, JSON.stringify([...confirmedSphereDeletes]));
  } catch {
    // non-fatal
  }
}

// Names this device has actually SEEN in a server list. Same idea as
// `serverKnownIds` for tasks, and needed for the same reason: "absent from a
// fetch" has two meanings — created here and not uploaded yet (keep it, the
// flush owes the server that row) or deleted elsewhere (drop it). Persisted, so
// a reload does not turn a local-only category into a deleted one.
const SPHERE_SEEN_KEY = 'calendar.sphere_seen.v1';
const sphereSeenOnServer = new Set<string>();
function loadSeenSpheres(): void {
  try {
    const raw = localStorage.getItem(SPHERE_SEEN_KEY);
    if (!raw) return;
    (JSON.parse(raw) as string[]).forEach((name) => {
      if (typeof name === 'string' && name) sphereSeenOnServer.add(name);
    });
  } catch {
    // a corrupt blob just means the next fetch rebuilds it
  }
}
function saveSeenSpheres(): void {
  try {
    localStorage.setItem(SPHERE_SEEN_KEY, JSON.stringify([...sphereSeenOnServer]));
  } catch {
    // non-fatal
  }
}

function deletedByIntent(name: string): boolean {
  const at = sphereTombstoneAt.get(name);
  if (at === undefined) return false;
  return at > (sphereRevivedAt.get(name) ?? 0);
}

// Rebuild the filter set from the merged maps. Returns the deleted names.
function syncDeletedSphereSet(): string[] {
  const names = [...sphereTombstoneAt.keys()].filter(deletedByIntent);
  deletedSpheres.clear();
  names.forEach((n) => deletedSpheres.add(n));
  return names;
}

function sortedTimestamps(map: Map<string, number>): Record<string, number> {
  // Sorted so two devices with the same intent produce the same text — that is
  // what makes the shadow comparison (and therefore the pending state) stable.
  return Object.fromEntries(
    [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

function catIntentJson(): string {
  return JSON.stringify({
    d: sortedTimestamps(sphereTombstoneAt),
    r: sortedTimestamps(sphereRevivedAt),
  });
}

function catPending(): boolean {
  const current = catIntentJson();
  if (syncedCatJson === null) return current !== EMPTY_CAT_INTENT;
  return syncedCatJson !== current;
}

function setSyncedCat(text: string): void {
  syncedCatJson = text;
  try {
    localStorage.setItem(CAT_SHADOW_KEY, text);
  } catch {
    // non-fatal: the shadow then lives for the session only
  }
}

// Fold one side's timestamps into the other, later timestamp wins per name.
function mergeTimestamps(target: Map<string, number>, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  let changed = false;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    if (!name || at <= 0 || (target.get(name) ?? 0) >= at) continue;
    target.set(name, at);
    changed = true;
  }
  return changed;
}

function canonicalCat(parsed: { d?: unknown; r?: unknown }): string {
  const d: Record<string, number> = {};
  const r: Record<string, number> = {};
  const fill = (target: Record<string, number>, raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) target[name] = value;
    }
  };
  fill(d, parsed?.d);
  fill(r, parsed?.r);
  const sorted = (m: Record<string, number>) =>
    Object.fromEntries(Object.entries(m).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  return JSON.stringify({ d: sorted(d), r: sorted(r) });
}

// Adopt the account's copy of the intent. `learned` means this device now knows
// something new (so its list must be re-filtered and the rows it still holds
// are owed a DELETE); `serverUpToDate` means the server already carries the
// union, so there is nothing to push back.
function adoptCatIntent(parsed: unknown): { learned: boolean; serverUpToDate: boolean } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { learned: false, serverUpToDate: false };
  }
  const typed = parsed as { d?: unknown; r?: unknown };
  const learnedD = mergeTimestamps(sphereTombstoneAt, typed.d);
  const learnedR = mergeTimestamps(sphereRevivedAt, typed.r);
  const learned = learnedD || learnedR;
  if (learned) {
    // This device may still hold rows for those names (it had them, the other
    // device deleted them): they are owed a DELETE now.
    syncDeletedSphereSet().forEach((name) => sphereDeleteQueue.add(name));
  }
  const merged = catIntentJson();
  return { learned, serverUpToDate: canonicalCat(typed) === merged };
}
// Task deletions need the same protection. Without it a fetch that still sees
// the row re-adds it, and a DELETE queued for a row the fetch just removed is
// silently dropped by the flush (it looks the task up in `tasks`).
const deletedTaskIds = new Set<string>();

// How long a task tombstone is remembered. It used to be cleared as soon as the
// DELETE was confirmed, and that is exactly what let deleted tasks come back:
// another device (or another tab / another origin of the same account) still
// held the row in its own localStorage and pushed its whole snapshot later, the
// upsert re-created the row, and this device had nothing left to argue with —
// no tombstone, so the fetch adopted it. Keeping the id for a week makes the
// deletion authoritative on every device that deleted it: the row is filtered
// out of every fetch AND the DELETE is re-issued whenever the server hands it
// back, until the stale copy stops pushing.
const TASK_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Only recent tombstones are re-queued at startup; older ones stay as filters
// and re-arm themselves the moment a resurrected row shows up.
const TASK_TOMBSTONE_REQUEUE_MS = 24 * 60 * 60 * 1000;
const taskTombstoneAt = new Map<string, number>();

// Ids this device has actually SEEN in a server response.
//
// This is the difference between the two reasons a local row can be absent from
// a fetch, and getting it wrong costs the feature:
//   · seen before, absent now → deleted on another device → drop it here;
//   · never seen              → created here while the link was down → upload it.
// Without this set the fetch treats both as "local work that never landed" and
// re-uploads the row the other device just deleted — the delete comes back
// within seconds, on every device, forever (a ping-pong that never converges).
// Persisted, so a reload does not lose the knowledge.
const SERVER_IDS_KEY = 'calendar.server_ids.v1';
const serverKnownIds = new Set<string>();
let serverIdsLoaded = false;

function loadServerIds(): void {
  if (serverIdsLoaded) return;
  serverIdsLoaded = true;
  try {
    const raw = localStorage.getItem(SERVER_IDS_KEY);
    if (!raw) return;
    (JSON.parse(raw) as string[]).forEach((id) => serverKnownIds.add(id));
  } catch {
    // ignore a corrupt blob: the next fetch rebuilds the set
  }
}

function saveServerIds(): void {
  try {
    localStorage.setItem(SERVER_IDS_KEY, JSON.stringify([...serverKnownIds]));
  } catch {
    // non-fatal
  }
}

function markTaskTombstone(id: string): void {
  deletedTaskIds.add(id);
  if (!taskTombstoneAt.has(id)) taskTombstoneAt.set(id, Date.now());
}

// Remember that the user removed a category, and keep owing the server its
// DELETE until it confirms the row is gone.
//
// The stamp is always "now", never "the first time I saw this name": a stale
// device that re-creates the row a month later must lose to the deletion, and
// the comparison is per name across devices.
function markSphereTombstone(name: string): void {
  sphereTombstoneAt.set(name, Date.now());
  syncDeletedSphereSet();
  sphereDeleteQueue.add(name);
  // Owed again: whatever the server confirmed in the past is about the row that
  // was there then, not about this one.
  confirmedSphereDeletes.delete(name);
  saveConfirmedSpheres();
  saveTombstones();
}

// The user created this category again: forget the delete, or the tombstones
// would remove the fresh row on the next fetch.
//
// Re-creation is recorded as a timestamp too (`r`), not by deleting the entry:
// the other devices hold their own copy of the deletion intent, and "this device
// no longer remembers" would lose to it forever. `r` newer than `d` wins
// everywhere.
//
// The stamp is written even when THIS device has no tombstone for the name
// (creating a category offline, before the first fetch told it that the name was
// deleted once): without it the very next fetch would adopt the old deletion and
// the category the user just typed would disappear.
function clearSphereTombstone(name: string): void {
  sphereDeleteQueue.delete(name);
  sphereRevivedAt.set(name, Date.now());
  syncDeletedSphereSet();
  saveTombstones();
}

function loadTombstones(): void {
  try {
    const raw = localStorage.getItem(TOMBSTONES_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      journal?: string[];
      cat?: { d?: Record<string, number>; r?: Record<string, number> };
      spheres?: string[];
      sphereAts?: Record<string, number>;
      tasks?: string[];
      taskAts?: Record<string, number>;
    };
    (parsed.journal ?? []).forEach((k) => deletedJournalKeys.add(k));
    const now = Date.now();
    // Category intent has NO expiry. Expiring it was the bug: after a day the
    // only memory of the delete was gone and a stale copy of the list brought
    // the category back on every device.
    mergeTimestamps(sphereTombstoneAt, parsed.cat?.d);
    mergeTimestamps(sphereRevivedAt, parsed.cat?.r);
    // Older builds stored a bare name list (+ timestamps). Fold them in, and
    // treat a name without a timestamp as deleted just now rather than as
    // expired-unseen.
    (parsed.spheres ?? []).forEach((name) => {
      if (!sphereTombstoneAt.has(name)) sphereTombstoneAt.set(name, parsed.sphereAts?.[name] ?? now);
    });
    mergeTimestamps(sphereTombstoneAt, parsed.sphereAts);
    // The delete may never have reached the server (tab closed mid-flush): owe
    // it again so the row is really removed instead of being hidden locally
    // while it lingers in the table. Names the server already confirmed as gone
    // are skipped — otherwise every load asks again, forever.
    syncDeletedSphereSet()
      .filter((name) => !confirmedSphereDeletes.has(name))
      .forEach((name) => sphereDeleteQueue.add(name));

    (parsed.tasks ?? []).forEach((id) => {
      // Tombstones written by the previous build carry no timestamp: treat them
      // as fresh (a delete we still owe) rather than expiring them unseen.
      const at = parsed.taskAts?.[id] ?? now;
      if (now - at > TASK_TOMBSTONE_TTL_MS) return;
      deletedTaskIds.add(id);
      taskTombstoneAt.set(id, at);
    });
  } catch {
    // A corrupt blob is not worth failing startup over.
  }
}

function saveTombstones(): void {
  try {
    localStorage.setItem(
      TOMBSTONES_KEY,
      JSON.stringify({
        journal: [...deletedJournalKeys],
        cat: { d: sortedTimestamps(sphereTombstoneAt), r: sortedTimestamps(sphereRevivedAt) },
        // Kept for a build that predates `cat:` (and for a manual rollback): it
        // reads these two keys as the delete list.
        spheres: [...deletedSpheres],
        sphereAts: sortedTimestamps(sphereTombstoneAt),
        tasks: [...deletedTaskIds],
        taskAts: Object.fromEntries(taskTombstoneAt),
      }),
    );
  } catch {
    // Quota/private-mode failures are non-fatal: tombstones then live for the
    // session only.
  }
}

loadConfirmedSpheres();
loadSeenSpheres();
loadTombstones();
loadServerIds();
// A delete that never reached the server (tab closed mid-flush, reload on a
// dead link) is still owed to it: re-queue so the row is really removed
// instead of being hidden locally forever while it lingers in the database.
deletedTaskIds.forEach((id) => {
  const at = taskTombstoneAt.get(id) ?? 0;
  if (Date.now() - at < TASK_TOMBSTONE_REQUEUE_MS) taskDeleteQueue.add(id);
});

// Write-ahead snapshot of every task waiting to be uploaded.
//
// The flush used to rebuild the row from the CURRENT `tasks` array
// (`tasks.find(...)`). A poll that applied a stale server snapshot in the
// 40 ms debounce window removed the row from `tasks`, the flush then found
// nothing, dropped the queued id without an error, and the task never reached
// the server at all — it vanished from the calendar and from localStorage with
// nothing to recover it. Keeping the exact object that was queued makes the
// write independent of whatever the state looks like when the flush runs.
const pendingTaskRows = new Map<string, Task>();

// ── Persisted write-ahead queue ──────────────────────────────────────────
// The pending put-map used to live only in memory, so a reload (or a crash, or
// a VPN drop that made the user close the tab) silently threw away every edit
// the server had not accepted yet: the next load pulled the OLD rows, "remote
// wins" replaced the local copies, and the moves the user made on the phone
// were gone with nothing on screen to say so. Persist the exact queued objects
// so an unconfirmed edit survives a reload and is retried.
const PENDING_KEY = 'calendar.pending_tasks.v1';

function savePending(): void {
  try {
    const puts: Record<string, Task> = {};
    pendingTaskRows.forEach((row, id) => {
      if (taskPutQueue.has(id)) puts[id] = row;
    });
    localStorage.setItem(PENDING_KEY, JSON.stringify({ puts }));
  } catch {
    // Quota / private mode: the queue then lives in memory only, as before.
  }
}

function loadPending(): void {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { puts?: Record<string, Task> };
    const puts = parsed.puts ?? {};
    for (const [id, row] of Object.entries(puts)) {
      if (!row || row.id !== id) continue;
      if (!tasks.some((t) => t.id === id)) continue; // deleted locally since
      if (deletedTaskIds.has(id)) continue;          // tombstone wins
      pendingTaskRows.set(id, row);
      taskPutQueue.add(id);
    }
  } catch {
    // ignore a corrupt queue
  }
}

// One-time: trust LOCAL rows over the server on the first load after this
// upgrade. Both devices were holding edits the other one never saw (the phone
// moved tasks while its writes could not reach the server), and the old merge
// rule — "present in the response wins" — would resolve that by deleting the
// newer local edit. On this first load every local row is queued, so it is
// kept on screen and pushed; the recovery then proceeds from real data
// instead of from whichever copy happened to arrive last.
// The flag is keyed by BUILD, not by device: the previous release set it once
// and never pushed again, so the phone's un-synced moves kept losing to the
// server on every later load. Bump SYNC_GUARD_VERSION with any release whose
// sync rules change, and the "local wins" push runs once more on each device.
const SYNC_GUARD_KEY = 'calendar.sync.guard.v1';
const SYNC_GUARD_VERSION = '2026-10-29-1';

// One-time "trust local" migration — RETIRED as a blanket push.
//
// The previous build queued EVERY local row for upload on the first load after
// an upgrade, to rescue edits the phone had made while its writes could not
// reach the server. The cost turned out to be worse than the benefit: a device
// whose cache still held a task deleted on the other device re-uploaded it, the
// row was re-created in the database, and both devices saw the deleted task come
// back — the exact symptom reported. The supported recovery paths now cover the
// same ground precisely:
//   · the persisted write-ahead queue restores this device's own owed writes;
//   · applyRemoteTasks asks the server about every local row the response does
//     not contain and re-queues exactly those (local-only work).
// So the flag is still written (older builds read it), but nothing is pushed.
function trustLocalOnFirstLoad(): void {
  try {
    localStorage.setItem(SYNC_GUARD_KEY, SYNC_GUARD_VERSION);
  } catch {
    // ignore
  }
}

function queueTaskPut(id: string) {
  const t = tasks.find((x) => x.id === id);
  if (t) pendingTaskRows.set(id, t);
  // Re-creating a previously deleted id cancels its tombstone.
  if (deletedTaskIds.delete(id)) {
    taskTombstoneAt.delete(id);
    saveTombstones();
  }
  taskDeleteQueue.delete(id);
  taskPutQueue.add(id);
  savePending();
  scheduleSync();
}

function queueTaskDelete(id: string) {
  pendingTaskRows.delete(id);
  taskPutQueue.delete(id);
  // Remember the delete for a week: a fetch that still sees the row must not
  // hand it back, and a stale client that re-uploads it must not win.
  markTaskTombstone(id);
  saveTombstones();
  taskDeleteQueue.add(id);
  savePending();
  scheduleSync();
}

// Restore what the last session still owed the server, then decide whether this
// device's rows are newer than the server's (one-time, see above).
loadPending();
trustLocalOnFirstLoad();

// Coalesce a burst of mutations into one flush.
function scheduleSync() {
  if (syncPending) return;
  syncPending = true;
  setTimeout(() => {
    syncPending = false;
    void drainSync();
  }, SYNC_DEBOUNCE_MS);
}

// ── Value comparison for the sync shadows ─────────────────────────────────
// The shadows must be compared BY VALUE, never by reference.
//
// `syncedJournal`/`syncedSpheres` are assigned a fresh object/array after a
// confirmed write, but `journal`/`spheres` are also replaced by new objects on
// every edit. Comparing the two with `!==` therefore reports "changed" even
// when the contents are identical — which kept `hasPendingSync()` true forever
// and made every flush loop the full 50 iterations, re-uploading the whole
// journal and palette each time.
function sameJournal(a: Record<string, string> | null, b: Record<string, string>): boolean {
  if (!a) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

function sameStringArray(a: string[] | null, b: string[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function hasPendingSync(): boolean {
  const currentColorsJson = JSON.stringify(getColors());
  // Only a palette the user actually edited is owed to the server, and
  // pushSettings follows the same rule. Comparing the raw JSON regardless made
  // this true forever on a device that never customised its palette (the
  // "already synced" shadow is only written when the palette is pushed), so
  // every flush ended in a failure state and the write pump sat in backoff —
  // delaying the deletes that matter.
  const colorsPending = colorsCustomized() && !sameColors(syncedColorsJson, currentColorsJson);
  return (
    taskPutQueue.size > 0 ||
    taskDeleteQueue.size > 0 ||
    pendingTaskRows.size > 0 ||
    !sameJournal(syncedJournal, journal) ||
    !sameStringArray(syncedSpheres, spheres) ||
    deletedJournalKeys.size > 0 ||
    sphereDeleteQueue.size > 0 ||
    catPending() ||
    colorsPending ||
    syncedWheelJson !== wheelJson() ||
    notesPendingSync()
  );
}

// A cheap fingerprint of "what is still owed to the server". Two consecutive
// identical fingerprints across a flush mean no progress was made.
function pendingSignature(): string {
  const currentColorsJson = JSON.stringify(getColors());
  const colorsPending = colorsCustomized() && !sameColors(syncedColorsJson, currentColorsJson);
  return [
    taskPutQueue.size,
    taskDeleteQueue.size,
    pendingTaskRows.size,
    sameJournal(syncedJournal, journal) ? 0 : 1,
    sameStringArray(syncedSpheres, spheres) ? 0 : 1,
    deletedJournalKeys.size,
    sphereDeleteQueue.size,
    catPending() ? 1 : 0,
    colorsPending ? 1 : 0,
    syncedWheelJson === wheelJson() ? 0 : 1,
    notesPendingSync() ? 1 : 0,
  ].join('|');
}

// A failing flush must not turn into a request storm. Every failed round used
// to be retried immediately by the next mutation and again by the 2.5 s poll,
// and the resulting pile of uploads starved the ~6 connections per host until
// even a plain SELECT timed out — on screen: "в БД всё есть, но в вебе пусто".
// After a failure the pump waits, and the wait grows up to a minute.
let flushFailures = 0;
let nextFlushAt = 0;

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// `force` bypasses the failure backoff. The startup push uses it: on the first
// load of a new version the device's rows must reach the server BEFORE the
// first read, and a backoff left over from the previous session (a failed round
// during the VPN drop) would otherwise skip exactly that push.
async function drainSync(force = false): Promise<void> {
  if (syncPumpRunning) return;   // a flush is already in flight
  if (!isSupabaseAvailable || !supabase) return;
  if (!getUserId()) return;      // no identity → nothing can be attributed
  if (isOffline()) return;       // browser knows there is no link; don't queue work
  if (!force && Date.now() < nextFlushAt) return; // backing off after a failed round
  syncPumpRunning = true;
  try {
    // Mutations arriving while we await re-queue themselves, so loop until
    // quiet. The iteration cap is a safety valve, not an expected exit.
    let guard = 0;
    // If a flush leaves the pending state completely unchanged the write is
    // failing (network, or a rejected DELETE). Retrying it in a tight loop
    // would just hammer the connection, so bail out after two identical
    // rounds; the next real edit — or the next fetch — schedules a fresh one.
    let stalled = 0;
    while (hasPendingSync() && guard++ < 50) {
      const sig = pendingSignature();
      await flushPending();
      if (pendingSignature() === sig) {
        if (++stalled >= 2) break;
      } else {
        stalled = 0;
      }
    }
  } finally {
    syncPumpRunning = false;
    // Still owed to the server after this round → back off instead of letting
    // the poll and the next edit re-issue the same failing request instantly.
    if (hasPendingSync()) {
      flushFailures = Math.min(flushFailures + 1, 6);
      nextFlushAt = Date.now() + Math.min(60000, 1000 * 2 ** flushFailures);
      setSyncStatus({
        state: 'error',
        message: 'изменения сохранены на устройстве, но не дошли до сервера — повторю автоматически',
      });
    } else {
      flushFailures = 0;
      nextFlushAt = 0;
      setSyncStatus({ state: 'ok', message: '', lastSuccessAt: Date.now() });
    }
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
    syncedWheelJson = wheelJson();
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
      // Send the version that was QUEUED, not whatever `tasks` happens to hold
      // now: a fetch that landed in between would otherwise publish a stale
      // copy (or nothing at all) and the edit would be silently lost.
      const sent = puts
        .map((id) => pendingTaskRows.get(id) ?? tasks.find((t) => t.id === id))
        .filter((t): t is Task => Boolean(t));
      const rows = sent.map((t) => toTaskRow(t, userId));
      if (rows.length > 0) {
        // Tasks DO carry their primary key, so the default conflict target
        // (id) is correct here — no onConflict needed.
        const { error } = await supabase.from('tasks').upsert(rows);
        if (error) {
          rows.forEach((r) => taskPutQueue.add(r.id));
          console.warn('[supabase] task upsert error:', error.message);
        } else {
          // Clear the snapshot only if no newer version was queued meanwhile.
          sent.forEach((t) => {
            if (pendingTaskRows.get(t.id) === t) pendingTaskRows.delete(t.id);
          });
          savePending();
        }
      } else {
        // Nothing left to send for these ids (already deleted locally or never
        // present): drop the pending snapshot so the pump can settle.
        puts.forEach((id) => pendingTaskRows.delete(id));
        savePending();
      }
    }
    if (deletes.length > 0) {
      // `.select('id')` is what makes this verifiable. A DELETE that RLS
      // filters out (a session whose role is not `authenticated`, a policy that
      // covers select/insert but not delete) answers 204 with ZERO rows and no
      // error — the client marks the delete done, the row stays in the table,
      // and the other device keeps showing it forever. Returning the affected
      // rows exposes that instead of silently accepting it.
      const { data: deletedRows, error } = await supabase
        .from('tasks')
        .delete()
        .eq('user_id', userId)
        .in('id', deletes)
        .select('id');
      if (error) {
        deletes.forEach((id) => taskDeleteQueue.add(id));
        console.warn('[supabase] task delete error:', error.message);
      } else {
        const gone = new Set((deletedRows ?? []).map((r: { id: string }) => r.id));
        const notRemoved = deletes.filter((id) => !gone.has(id));
        if (notRemoved.length > 0) {
          // Either the row was already absent (harmless) or the delete was
          // rejected silently (RLS). Loud, because that second case is a real
          // "deletion never syncs" bug and it produces no error anywhere else.
          console.warn(
            `[supabase] ${notRemoved.length} delete(s) removed 0 rows — row already gone, or blocked (check RLS delete policy)`,
            notRemoved.slice(0, 5),
          );
        }
        // The row is gone server-side. The tombstone is NOT cleared here: it
        // stays for a week as the record of the user's intent, because another
        // device (or another tab on the same account) may still be holding this
        // row and push it back later. See TASK_TOMBSTONE_TTL_MS.
        deletes.forEach((id) => {
          if (!taskDeleteQueue.has(id) && !taskTombstoneAt.has(id)) {
            markTaskTombstone(id);
          }
        });
        saveTombstones();
      }
    }
  } catch (e) {
    puts.forEach((id) => taskPutQueue.add(id));
    deletes.forEach((id) => taskDeleteQueue.add(id));
    console.warn('[supabase] sync tasks error:', e);
  }
  // ── Journal: disabled/removed ─────────────────────────────────────────
  try {
    syncedJournal = {};
  } catch (e) {
    console.warn('[supabase] sync journal error:', e);
  }

  // ── Spheres ───────────────────────────────────────────────────────────
  try {
    // The upsert and the delete are INDEPENDENT writes.
    //
    // They used to be nested — delete inside the upsert's success branch —
    // which meant a slow or failed upsert (routine on this connection) skipped
    // the delete entirely. The row then stayed in the table and the next fetch
    // brought the category straight back: exactly the reported "I delete a
    // category and it comes back" symptom. Each write now reports for itself.
    if (!sameStringArray(syncedSpheres, spheres)) {
      // These rows carry no `id`, so the conflict target must be the real
      // unique key (user_id, name) or the write trips the unique index
      // (23505) instead of updating.
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
    if (sphereDeleteQueue.size > 0) {
      // An upsert cannot express a deletion: a removed category is simply
      // absent from the payload, so its row survives. Only an explicit DELETE
      // removes it, and only a name in `sphereDeleteQueue` is actually owed one
      // (the intent itself outlives the confirmed delete, so re-issuing it every
      // flush would keep the pump and the poll busy forever).
      //
      // Before deleting, re-read the account's intent: this device's copy may be
      // older than the row. The case that matters is a category re-created on
      // another device (offline, or just faster) after this one learned of the
      // deletion — sweeping the fresh row away here would destroy it there too,
      // because the next fetch finds an empty list. The `#cat:` segment is the
      // tie-breaker: if its `r` is newer than our `d`, the category lives.
      let names = [...sphereDeleteQueue];
      try {
        const { data: freshRow } = await supabase
          .from('user_settings')
          .select('last_view')
          .eq('user_id', userId)
          .maybeSingle();
        const freshCat = splitSettings(((freshRow as any)?.last_view as string) ?? '').cat;
        if (freshCat) {
          adoptCatIntent(JSON.parse(freshCat));
          // Re-created elsewhere: nothing is owed, and the row must stay.
          names
            .filter((name) => !deletedByIntent(name))
            .forEach((name) => sphereDeleteQueue.delete(name));
          names = names.filter((name) => deletedByIntent(name));
        }
      } catch {
        // A failed pre-check must not turn into "never delete": fall through
        // with the intent this device already has.
      }
      if (names.length > 0) {
        const { data: removedRows, error: delErr } = await supabase
          .from('spheres')
          .delete()
          .eq('user_id', userId)
          .in('name', names)
          .select('name');
        if (delErr) {
          console.warn('[supabase] spheres delete error:', delErr.message);
        } else {
          // The tombstone STAYS: it is the record of the user's intent, and a
          // stale tab/device that still holds the name will re-create the row.
          // fetchSpheres re-queues the delete the moment that happens.
          names.forEach((name) => {
            sphereDeleteQueue.delete(name);
            confirmedSphereDeletes.add(name);
          });
          saveConfirmedSpheres();
          const gone = new Set(((removedRows ?? []) as { name: string }[]).map((r) => r.name));
          const notRemoved = names.filter((n) => !gone.has(n));
          if (notRemoved.length > 0) {
            // Either already absent (the usual, harmless case) or the DELETE was
            // filtered out by RLS, which answers 204 without an error — that one
            // is a real "deletion never reaches the server" bug, so say so.
            console.warn(
              `[supabase] ${notRemoved.length} sphere delete(s) removed 0 rows — row already gone, or blocked (check RLS delete policy)`,
              notRemoved.slice(0, 5),
            );
          }
          // The server now holds exactly the local list.
          syncedSpheres = [...spheres];
          saveTombstones();
        }
      }
    }
  } catch (e) {
    console.warn('[supabase] sync spheres error:', e);
  }

  // ── Palette + year-wheel settings ────────────────────────────────────
  // One row holds both segments; pushSettings preserves whichever segment this
  // device is not writing.
  //
  // A device that never customised the palette must NOT upload it. Its
  // "palette" is just the built-in list, and uploading it replaces the user's
  // renamed and reordered one on the server — every device then shows the
  // defaults. Only a palette the user actually edited is authoritative.
  try {
    await pushSettings(userId);
  } catch (e) {
    console.warn('[supabase] sync settings error:', e);
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
  syncedColorsJson = null;
  syncedWheelJson = null;
  syncedTopicsJson = null;
  syncedNotesJson = null;
  // Force the category intent to be re-uploaded: the shadow may describe a row
  // that never actually landed.
  syncedCatJson = null;
  try {
    localStorage.removeItem(CAT_SHADOW_KEY);
  } catch {
    // non-fatal
  }
  taskPutQueue.clear();
  taskDeleteQueue.clear();
  // Unconfirmed deletes stay in `deletedTaskIds`: they are still owed to the
  // server and must keep a fetch from resurrecting them.
  pendingTaskRows.clear();
}

// ── Initialise Supabase (auth + realtime + initial load) ────────────────
export { initAuth, getCurrentUser, signOut, type AuthResult } from './lib/auth';

// Listen to local color changes to sync to server
if (typeof window !== 'undefined') {
  window.addEventListener('colors-sync-request', () => {
    scheduleSync();
  });
  window.addEventListener('wheel-sync-request', () => {
    scheduleSync();
  });
  window.addEventListener('wheel-notes-sync-request', () => {
    scheduleSync();
  });
}

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
  const started = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { data, error } = await run();
    if (!error && data != null) {
      setSyncStatus({ state: 'ok', message: '', lastSuccessAt: Date.now() });
      return data;
    }
    if (error) {
      const msg = String(error.message ?? error);
      setSyncStatus({
        state: 'error',
        message: /abort|fetch|network|timeout|load failed/i.test(msg)
          ? 'нет связи с сервером'
          : `ошибка сервера: ${msg}`,
      });
    }
    // A hung socket is the common case here, so the pause stays short and
    // grows slowly: several quick retries beat one long wait.
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * attempt));
  }
  console.warn(`[supabase] could not load ${label} after ${attempts} attempts (${Date.now() - started} ms)`);
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
// 25 rows per request meant ~8 requests for every poll with a few hundred
// tasks; through the proxy that is what produced the bursts of
// ERR_CONNECTION_CLOSED. 200 rows is one request for a typical calendar
// (~35 KB) and still bounded, so a stall costs one page instead of the slice.
const TASK_PAGE = 200;

async function fetchTasks(userId: string, attempts = 6) {
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
      attempts,
    );
    if (!chunk) return; // a page failed — keep whatever we already have
    rows.push(...(chunk as any[]));
    if ((chunk as any[]).length < TASK_PAGE) break; // last page
  }
  // The server is the source of truth for rows we are not still pushing, so a
  // task deleted on another device disappears here too. applyRemoteTasks
  // merges (and confirms) instead of overwriting, and still refuses an empty
  // payload until real rows have been seen once.
  await applyRemoteTasks(rows, userId);
}

async function fetchSpheres(userId: string, attempts = 6) {
  if (!supabase) return;
  const data = await withRetry('spheres', () =>
    supabase!.from('spheres').select('*').eq('user_id', userId).order('order', { ascending: true }),
    attempts,
  );
  if (!data) return;
  // Authoritative, but never let a truncated empty payload wipe the palette:
  // an empty list is only trusted once we have seen real rows, or when there
  // is nothing local to lose.
  if (data.length === 0 && !sawRemoteSpheres && spheres.length > 0) return;
  if (data.length > 0) sawRemoteSpheres = true;
  const serverNames = (data as any[]).map((r) => r.name as string);
  const serverSet = new Set(serverNames);
  // Keep what this device created and never managed to upload. Without this a
  // plain pull (or the 4 s poll) replaced the list with the server's, so a
  // category typed just before a slow link settled vanished — and since it was
  // never uploaded, nothing could bring it back. The test is "the server has
  // never shown me this name": a name it HAS shown and now hides was deleted
  // on another device and must go.
  const unsent = spheres.filter(
    (name) => !deletedSpheres.has(name) && !serverSet.has(name) && !sphereSeenOnServer.has(name),
  );
  // Drop anything the user deleted that hasn't been confirmed server-side yet,
  // or the fetch hands the category straight back (the resurrection bug).
  spheres = [...serverNames.filter((name) => !deletedSpheres.has(name)), ...unsent];
  serverNames.forEach((name) => sphereSeenOnServer.add(name));
  saveSeenSpheres();
  snapshot.spheres = spheres;
  // The shadow records what the SERVER holds, tombstones included. Recording
  // the filtered list instead would make local and shadow agree, so the
  // pending delete would look already-synced and never be retried.
  syncedSpheres = serverNames;
  localStorage.setItem(SPHERES_KEY, JSON.stringify(spheres));
  // A tombstoned name the server still hands back is a STALE copy: another tab
  // or another device (or this one before its last reload) re-uploaded its old
  // category list after our DELETE landed. Re-delete it instead of keeping it
  // hidden only locally — that is what made a removed category reappear later.
  const resurrected = serverNames.filter((name) => deletedSpheres.has(name));
  if (resurrected.length > 0) {
    resurrected.forEach((name) => {
      sphereDeleteQueue.add(name);
      // The row exists again, so the earlier confirmation says nothing.
      confirmedSphereDeletes.delete(name);
    });
    saveConfirmedSpheres();
    saveTombstones();
    scheduleSync();
  } else if (spheres.length !== serverNames.length) {
    // A delete still owed to the server keeps `hasPendingSync()` true; nudge a
    // flush so it is retried now rather than on the next unrelated edit.
    scheduleSync();
  }
}

async function fetchJournal(_userId: string, _attempts = 6) {
  return;
}

async function fetchView(userId: string) {
  if (!supabase) return;
  // A missing row is normal (maybeSingle → data null); a NETWORK failure must
  // not be mistaken for one, or the view silently reverts to the default.
  const data = await withRetry<{ last_view: string | null } | null>('view', () =>
    supabase!.from('user_settings').select('last_view').eq('user_id', userId).maybeSingle(),
  );
  if (!data?.last_view) return;
  const remoteSetting = data.last_view;

  // ── Category deletions ──────────────────────────────────────────────
  // The durable half of "delete stays deleted". A device that never saw the
  // delete — a fresh browser profile, the phone that was offline while it
  // happened, a tab that has been open since yesterday — learns it here and
  // re-deletes the row instead of adopting it back.
  if (remoteSetting.includes('#cat:')) {
    const catPart = splitSettings(remoteSetting).cat;
    let parsedCat: unknown = null;
    if (catPart) {
      try {
        parsedCat = JSON.parse(catPart);
      } catch {
        parsedCat = null;
      }
    }
    if (parsedCat) {
      const { learned, serverUpToDate } = adoptCatIntent(parsedCat);
      // The row already carries exactly this union: nothing to push back, or
      // the write pump would never settle on a device that only listens.
      if (serverUpToDate) setSyncedCat(catIntentJson());
      if (learned) {
        const kept = spheres.filter((name) => !deletedSpheres.has(name));
        if (kept.length !== spheres.length) {
          spheres = kept;
          snapshot.spheres = spheres;
          localStorage.setItem(SPHERES_KEY, JSON.stringify(spheres));
          listeners.forEach((l) => l());
        }
        // Whatever this device still has on the server is owed a DELETE now.
        deletedSpheres.forEach((name) => sphereDeleteQueue.add(name));
        saveTombstones();
        scheduleSync();
      }
    }
  }

  // ── Year-wheel marks ────────────────────────────────────────────────
  // Merged per week by timestamp, so a device that edited week A does not lose
  // the weeks another device painted.
  if (remoteSetting.includes('#wheel:')) {
    const wheelPart = splitSettings(remoteSetting).wheel;
    if (wheelPart) {
      try {
        const merged = mergeWheel(JSON.parse(wheelPart));
        if (merged.adopted) listeners.forEach((l) => l());
        // Nothing local is newer than the server → nothing is owed to it.
        if (!merged.needPush) syncedWheelJson = wheelJson();
      } catch {
        // malformed segment — ignore, the next write repairs it
      }
    }
  }

  // An older build (or a palette edit from it) can overwrite the row with a
  // colours-only string, which drops the wheel segment. Re-upload the marks
  // instead of assuming the server still has them.
  if (!remoteSetting.includes('#wheel:') && wheelJson() !== '{}') {
    syncedWheelJson = null;
  }

  // ── Wheel notes ─────────────────────────────────────────────────────
  // The user's own notes on the wheel: a separate list from tasks, merged per
  // note by timestamp so two devices editing different notes both keep theirs.
  if (remoteSetting.includes('#notes:')) {
    const notesPart = splitSettings(remoteSetting).notes;
    if (notesPart) {
      try {
        const merged = mergeWheelNotes(JSON.parse(notesPart));
        if (merged.adopted) listeners.forEach((l) => l());
        if (!merged.needPush) syncedNotesJson = wheelNotesJson();
      } catch {
        // malformed segment — ignore, the next write repairs it
      }
    }
  }
  // Segment absent (an older build overwrote the row): push this device's notes
  // back rather than assume they are still on the server.
  if (!remoteSetting.includes('#notes:') && wheelNotesJson() !== '{}') {
    syncedNotesJson = null;
  }

  // ── Topics (sub-categories) ─────────────────────────────────────────
  // The dashboard's topic tabs, per category. Losing this segment is why a
  // task filed under a topic showed up in "Основное" everywhere: the topic map
  // existed on one device only.
  if (remoteSetting.includes('#topics:')) {
    const topicsPart = splitSettings(remoteSetting).topics;
    if (topicsPart) {
      try {
        // Accepts both the current tree and the old flat name list, so a phone
        // still on the previous build cannot wipe the folders.
        const remote = normalizeTree(JSON.parse(topicsPart));
        const localJson = JSON.stringify(topics);
        const remoteHasTopics = Object.values(remote).some(
          (category) => category.blocks.length > 0 || category.children.length > 0,
        );
        // Adopt the server map when this device cannot lose anything by it: it
        // is empty here, it matches what was last synced, or this is the first
        // sync of the session and the server actually holds topic lists (the
        // upgrade path — before, topics never left the device). A device with
        // UNSENT local topics keeps them instead, so a delete/rename made here
        // and still in flight is not undone by a fetch that predates it.
        const firstSyncOfSession = syncedTopicsJson === null;
        if (localJson === '{}' || localJson === syncedTopicsJson || (firstSyncOfSession && remoteHasTopics)) {
          topics = remote;
          syncedTopicsJson = JSON.stringify(topics);
          snapshot.topics = topics;
          localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
          listeners.forEach((l) => l());
        } else {
          // Topics were created here while the link was down: keep them, take
          // only the categories this device knows nothing about, and push the
          // merged map back.
          let adopted = false;
          for (const [sphere, category] of Object.entries(remote)) {
            if (!(sphere in topics)) {
              topics = { ...topics, [sphere]: category };
              adopted = true;
            }
          }
          if (adopted) {
            snapshot.topics = topics;
            localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
            listeners.forEach((l) => l());
          }
          scheduleSync();
        }
      } catch {
        // malformed segment — ignore, the next write repairs it
      }
    }
  }

  if (remoteSetting.includes('#colors:')) {
    // `#colors:` is no longer the last segment: the wheel segment may follow
    // it, so the palette JSON must be cut at the `#wheel:` marker.
    const colorsPart = splitSettings(remoteSetting).colors;
    if (colorsPart) {
      try {
        const parsedColors: TaskColor[] = JSON.parse(colorsPart);
        if (Array.isArray(parsedColors) && parsedColors.length > 0) {
          // Never let the built-in palette overwrite a customised one. Some
          // client (an older build, a fresh browser profile, the app opened on
          // the second hostname) may have uploaded the defaults; adopting them
          // here would destroy the user's names and their order on this device
          // too. Keep the real palette and push it back instead.
          if (isDefaultPalette(parsedColors) && !isDefaultPalette(getColors()) && colorsCustomized()) {
            console.warn('[supabase] server palette is the built-in one while this device has a custom one — keeping local and re-uploading');
            syncedColorsJson = null;
            scheduleSync();
            return;
          }
          saveColors(parsedColors, false);
          syncedColorsJson = colorsPart;
        }
      } catch {
        // ignore parse error
      }
    }
  }
}

// Realtime channels. Wired up BEFORE the initial load so a change made on the
// other device while we are still fetching is not missed.
//
// Switched OFF: through the deployment proxy the WebSocket is closed before it
// connects ("WebSocket is closed before the connection is established") on this
// link, so it produced a reconnect storm and console noise while polling
// already covers the same ground every 4 s. Flip to true once the socket is
// proven to survive the proxy.
const REALTIME_ENABLED = false;

function subscribeRealtime(userId: string) {
  if (!supabase || !REALTIME_ENABLED) return;

  supabase
    .channel(`public:tasks:user_id=eq.${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${userId}` },
      (payload) => {
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          const task = fromTaskRow(payload.new as any);
          // Our own DELETE for this id may still be in flight: an UPDATE event
          // that left the server before it landed must not re-add the row.
          if (deletedTaskIds.has(task.id)) return;
          tasks = tasks.filter((t) => t.id !== task.id);
          tasks = [...tasks, task];
        } else if (payload.eventType === 'DELETE') {
          const gone = (payload.old as any)?.id ?? (payload.new as any)?.id;
          if (!gone) return;
          tasks = tasks.filter((t) => t.id !== gone);
          // Keep the tombstone (see TASK_TOMBSTONE_TTL_MS): a confirmed delete
          // no longer means the row can never come back — a stale client can
          // still re-upload it, and the tombstone is what re-deletes it.
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

  // ── First load of a new version: push this device's rows FIRST ──────────
  //
  // The reported failure: tasks moved on the phone while its writes could not
  // reach the server. On the next load the read arrived first, the merge saw
  // server rows for those ids and treated them as authoritative, and the
  // device's own newer edits were dropped before they were ever uploaded. The
  // order is what decides the conflict, so it is fixed here explicitly:
  // upload what this device still owes, and only then read.
  //
  // This does not hide server data — the read still runs right after, so rows
  // that exist only on the server still arrive. It only means the device's own
  // edits are already on the server by the time the read resolves, so they come
  // back instead of being overwritten.
  if (hasPendingSync()) {
    setSyncStatus({ state: 'syncing', message: 'отправляю изменения с этого устройства…' });
    await drainSync(true);
  }

  // Start the poll loop BEFORE the initial fetch.
  //
  // The initial load is a blocking chain of requests, and on this link a
  // stalled socket can hold it for a long time (retries multiply the per-request
  // deadline). Waiting for it before scheduling the timer meant that for the
  // whole startup window the app neither polled nor received realtime — which is
  // exactly when a phone edit is most likely to be missed. The pump starts here
  // and the first poll simply races the initial fetch; whichever finishes fills
  // the same state.
  startPolling(user.id);

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
  // Startup on a dead link leaves the board empty. Keep retrying in the
  // background instead of waiting for the user to press refresh.
  if (syncStatus.state === 'error') scheduleLoadRetry();
}

// Background polling: pull changes every few seconds so a device that is not
// receiving realtime events still sees the other device's edits.
//
// Why this exists: realtime requires the four tables to be members of the
// `supabase_realtime` publication (a one-line SQL command run once in
// Supabase's SQL Editor). Until that is done the socket reports SUBSCRIBED but
// delivers nothing, and without polling a change made on the phone would not
// appear on the laptop until a manual refresh — the reported symptom.
//
// The guard matters as much as the timer: a poll issues several requests and a
// stalled socket can hold one for seconds, so without the flag a slow poll
// would overlap the next one and the requests would pile up, each starving the
// others of the ~6 available connections.
const POLL_MS = 4000;
let pollingActive = false;
let pollRunning = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function startPolling(userId: string): void {
  if (pollTimer) return;             // already polling
  pollingActive = true;
  pollTimer = setInterval(async () => {
    if (!pollingActive || !isSupabaseAvailable || !supabase) return;
    if (isOffline()) return;         // no link: every request would just fail
    // A hidden tab (a second window, a phone with the app in the background)
    // kept polling every 2.5 s and, with the paged task read, produced bursts of
    // requests that the link answered by closing connections. Nothing is visible
    // in a hidden tab; the visibility handler pulls as soon as it returns.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (pollRunning) return;         // previous poll still in flight
    if (syncPumpRunning) return;     // mid-write; don't fight the flush
    if (Date.now() < nextFlushAt) return; // write pump is backing off
    // Something local is still owed to the server (a write or delete that
    // failed earlier). Push that first and skip the pull this tick: pulling
    // now would re-adopt the row we are trying to remove, and the write is the
    // more urgent of the two. This is what makes a failed delete actually land
    // instead of waiting for the user's next edit.
    if (hasPendingSync()) {
      void drainSync();
      return;
    }
    pollRunning = true;
    try {
      // ONE attempt per slice: a poll runs every couple of seconds anyway, so
      // in-poll retries only stack up delay and hold connection slots. Failing
      // fast hands the slot back and the next tick tries again.
      //
      // Smallest slices first. Tasks are the heavy one (paged, ~14 KB a page
      // against a link where a larger response often stalls until its
      // deadline), so putting tasks first would delay the category palette and
      // the journal behind it by a whole timeout. Categories and notes are a
      // few kilobytes each and almost always land on the first try, so they go
      // first and the visible board updates in a couple of seconds.
      await fetchSpheres(userId, 1);
      await fetchJournal(userId, 1);
      await fetchView(userId);
      await fetchTasks(userId, 1);
      listeners.forEach((l) => l());
    } catch {
      // Network error or timeout; the next tick retries.
    } finally {
      pollRunning = false;
    }
  }, POLL_MS);
  // Exposed so a test (or a future settings toggle) can stop the loop.
  if (typeof window !== 'undefined') {
    (window as any).__stopPolling = () => {
      pollingActive = false;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
  }
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
      sameDayOnly: input.sameDayOnly ?? false,
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
      // Moving a task to another category must not carry a topic the new
      // category does not have: it would match no tab and vanish from the
      // dashboard. Explicit `topic` in the patch always wins.
      if (patch.sphere !== undefined && patch.sphere !== t.sphere && patch.topic === undefined) {
        if (next.topic && !pathExists(topics, patch.sphere ?? '', keyPath(next.topic))) {
          next.topic = undefined;
        }
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
    if (!name || name === oldName || !spheres.includes(oldName)) return;
    // Renaming ONTO an existing category must MERGE, not duplicate. `spheres`
    // would otherwise hold the name twice and the server's unique
    // (user_id, name) index rejects the whole upsert payload (21000), so the
    // rename would never reach the database at all.
    const collide = spheres.includes(name);
    spheres = collide
      ? spheres.filter((s) => s !== oldName)
      : spheres.map((s) => (s === oldName ? name : s));
    // A task moved into a folder the target category does not have would be
    // invisible (the dashboard only shows the folders a category owns), so it
    // falls back to the category itself.
    tasks = tasks.map((t) => {
      if (t.sphere !== oldName) return t;
      let topic = t.topic;
      if (collide && topic && !pathExists(topics, name, keyPath(topic))) topic = undefined;
      return { ...t, sphere: name, topic };
    });
    const oldTree = topics[oldName];
    if (oldTree || collide) {
      const next = { ...topics };
      delete next[oldName];
      if (oldTree) {
        const base = next[name] ?? emptyCategory();
        const children = [...base.children];
        for (const node of oldTree.children) {
          if (!children.some((c) => c.name === node.name)) children.push(node);
        }
        const blocks = [...base.blocks];
        for (const block of oldTree.blocks) if (!blocks.includes(block)) blocks.push(block);
        next[name] = { blocks, children };
      }
      topics = next;
    }
    // A rename is a CREATE of the new name plus a DELETE of the old one. The
    // upsert below only ever adds rows, so without this tombstone the old row
    // stays in the table, the next fetch reads both names, and the user sees
    // "переименовал — а появилась вторая категория" with the old list intact.
    markSphereTombstone(oldName);
    clearSphereTombstone(name);
    emit();
  },
  addSphere(name: string) {
    const n = name.trim();
    if (!n || spheres.includes(n)) return;
    // Creating a name the user deleted earlier cancels that delete, otherwise
    // the tombstone would remove the fresh row on the next fetch.
    clearSphereTombstone(n);
    spheres = [...spheres, n];
    // A brand new category starts with NO blocks: the user adds задачи /
    // заметки / мудборд herself.
    topics = { ...topics, [n]: emptyCategory() };
    emit();
  },
  removeSphere(name: string) {
    spheres = spheres.filter((s) => s !== name);
    tasks = tasks.map((t) => (t.sphere === name ? { ...t, sphere: undefined } : t));
    const newTopics = { ...topics };
    delete newTopics[name];
    topics = newTopics;
    // Record the intent and owe the server its DELETE. The tombstone outlives
    // the confirmed delete: a stale tab/device that re-uploads the old list is
    // then undone instead of silently resurrecting the category.
    markSphereTombstone(name);
    emit();
  },
  reorderSpheres(ordered: string[]) {
    const filtered = ordered.filter((s) => spheres.includes(s));
    spheres = filtered.length ? filtered : [...spheres];
    emit();
  },
  /** Reorder folders inside one level; `parentPath = []` is the category. */
  reorderTopics(sphere: string, orderedIds: string[], parentPath: string[] = []) {
    if (!spheres.includes(sphere)) return;
    const category = topics[sphere] ?? emptyCategory();
    const children = reorderLevel(category.children, parentPath, orderedIds);
    if (children === category.children) return;
    topics = { ...topics, [sphere]: { ...category, children } };
    emit();
  },
  /** Add a folder. `parentPath = []` puts it directly in the category; a new
   *  folder has no blocks until the user adds them. */
  addTopic(sphere: string, name: string, parentPath: string[] = []) {
    const n = name.trim();
    if (!n || !spheres.includes(sphere)) return;
    if (parentPath.length > MAX_LEVEL - 2) return; // deeper than 3 levels
    const category = topics[sphere] ?? emptyCategory();
    const siblings = parentPath.length
      ? (nodeAt(category.children, parentPath)?.children ?? [])
      : category.children;
    if (siblings.some((node) => node.name === n)) return;
    const children = insertNode(category.children, parentPath, newNode(n));
    topics = { ...topics, [sphere]: { ...category, children } };
    emit();
  },
  /** Add a NOTE inside a folder (or the category). The title lives in the tree,
   *  the checklist lives in the linked document (`lib/board`). */
  addNote(sphere: string, parentPath: string[], title: string, noteId: string) {
    const n = title.trim();
    if (!n || !noteId || !spheres.includes(sphere)) return;
    // Notes are leaves: they also fit INSIDE the last folder (category →
    // folder → folder → notes), one level deeper than a folder could go.
    if (parentPath.length > MAX_LEVEL - 1) return;
    const category = topics[sphere] ?? emptyCategory();
    const siblings = parentPath.length
      ? (nodeAt(category.children, parentPath)?.children ?? [])
      : category.children;
    if (siblings.some((node) => node.name === n)) return;
    const children = insertNode(category.children, parentPath, newNoteNode(n, noteId));
    topics = { ...topics, [sphere]: { ...category, children } };
    emit();
  },
  /** Delete a folder, everything inside it, and file its tasks under the
   *  category itself (nested tasks lose their path). */
  removeTopic(sphere: string, target: string | string[]) {
    if (!spheres.includes(sphere)) return;
    const path = typeof target === 'string' ? [target] : target;
    if (!path.length || path[0] === DEFAULT_TOPIC) return;
    const category = topics[sphere] ?? emptyCategory();
    if (!nodeAt(category.children, path)) return;
    topics = { ...topics, [sphere]: { ...category, children: removeNodeAt(category.children, path) } };
    // Tasks of the deleted folder (and of the folders inside it) move one
    // level up, not all the way back to the category.
    const parentTopic = path.length > 1 ? pathKey(path.slice(0, -1)) : undefined;
    tasks = tasks.map((t) =>
      t.sphere === sphere && inSubtree(t.topic, path) ? { ...t, topic: parentTopic } : t,
    );
    emit();
  },
  renameTopic(sphere: string, target: string | string[], newName: string) {
    const name = newName.trim();
    if (!name || !spheres.includes(sphere)) return;
    const path = typeof target === 'string' ? [target] : target;
    if (!path.length || name === path[path.length - 1]) return;
    const category = topics[sphere] ?? emptyCategory();
    if (!nodeAt(category.children, path)) return;
    const parentPath = path.slice(0, -1);
    const siblings = parentPath.length
      ? (nodeAt(category.children, parentPath)?.children ?? [])
      : category.children;
    if (siblings.some((node) => node.name === name)) return;
    const nextPath = [...parentPath, name];
    const children = mapNode(category.children, path, (node) => ({ ...node, name }));
    topics = { ...topics, [sphere]: { ...category, children } };
    // The tasks point at a path of names, so the whole subtree follows.
    tasks = tasks.map((t) =>
      t.sphere === sphere ? { ...t, topic: renamePrefix(t.topic, path, nextPath) } : t,
    );
    emit();
  },
  /** Which blocks a node shows; `path = []` is the category itself. */
  setBlocks(sphere: string, path: string[], blocks: BlockKind[]) {
    if (!spheres.includes(sphere)) return;
    const unique = blocks.filter((block, at) => blocks.indexOf(block) === at);
    const category = topics[sphere] ?? emptyCategory();
    if (!path.length) {
      topics = { ...topics, [sphere]: { ...category, blocks: unique } };
      emit();
      return;
    }
    if (!nodeAt(category.children, path)) return;
    const children = mapNode(category.children, path, (node) => ({ ...node, blocks: unique }));
    topics = { ...topics, [sphere]: { ...category, children } };
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
  getTasks(): Task[] {
    return tasks;
  },
  /** Top-level folder names per category. Used by the sync test. */
  getTopics(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [sphere, category] of Object.entries(topics)) {
      out[sphere] = category.children.map((node) => node.name);
    }
    return out;
  },
  /** The whole folder tree with its blocks. */
  getTree(): Tree {
    return topics;
  },
  getById(id: string): Task | undefined {
    return tasks.find((t) => t.id === id);
  },
  // ── Journal ──────────────────────────────────────────────────────
  saveJournalEntry(_dateKey: string, _text: string) {
    // No-op: journal removed
  },
  saveJournalAll(_data: Record<string, string>) {
    // No-op: journal removed
  },
  deleteJournalEntry(_dateKey: string) {
    // No-op: journal removed
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
    listeners.forEach((l) => l());
  },
};

// User-initiated "sync now": ignore any backoff, push what is still owed to the
// server and pull everything. Used by the refresh button and the retry link in
// the status banner.
export async function syncNow(): Promise<void> {
  flushFailures = 0;
  nextFlushAt = 0;
  loadRetryCount = 0;
  if (loadRetryTimer) { clearTimeout(loadRetryTimer); loadRetryTimer = null; }
  if (hasPendingSync()) {
    setSyncStatus({ state: 'syncing', message: 'отправляю изменения на сервер…' });
    await drainSync();
  }
  await pullRemoteTasks();
}

// ── Backup: export / restore between devices ──────────────────────────────
// Two devices can end up holding edits the other one never received (writes
// that never reached Supabase leave no trace on the server). A file is then the
// only way to move that work across. The backup is plain JSON so it can be
// pasted into a messenger instead of being downloaded.
export type BackupFile = {
  format: 'calendar-backup';
  version: 1;
  exportedAt: string;
  tasks: Task[];
  spheres: string[];
  /** Dashboard folder tree (categories → folders → folders, with blocks).
   *  Optional: files written before this field existed simply have no folders,
   *  and the tree is then rebuilt from the tasks' own `topic` values. Old flat
   *  `{ sphere: [name] }` files are still accepted (`normalizeTree`). */
  topics?: unknown;
};

// Explicit "send this device to the server". The automatic paths only push what
// looks changed; after a device has been offline the diff baseline can be wrong
// (it was recorded against rows that never landed), so the user needs one
// button that re-uploads everything currently on screen. Restoring a backup is
// the usual trigger: the merged rows must reach the server or the other device
// never sees them.
export type PushResult = { ok: boolean; message: string; total: number; pending: number };

export async function pushLocalToServer(): Promise<PushResult> {
  if (!isSupabaseAvailable || !supabase) {
    return { ok: false, message: 'Supabase не настроен — данные остаются только на устройстве', total: tasks.length, pending: 0 };
  }
  if (!getUserId()) {
    return { ok: false, message: 'Нет входа в аккаунт — отправка невозможна', total: tasks.length, pending: 0 };
  }
  if (isOffline()) {
    return { ok: false, message: 'Браузер сообщает, что сети нет', total: tasks.length, pending: 0 };
  }
  for (const t of tasks) {
    if (deletedTaskIds.has(t.id)) continue;
    pendingTaskRows.set(t.id, t);
    taskPutQueue.add(t.id);
  }
  // Spheres and colors are synced by diffing against the "already on the
  // server" shadows. Clearing them makes this push re-upload the palette too,
  // even when the diff says "unchanged" — the diff may have been recorded
  // against rows that never actually landed.
  syncedSpheres = null;
  syncedColorsJson = null;
  savePending();
  setSyncStatus({ state: 'syncing', message: 'отправляю данные на сервер…' });
  await drainSync(true);
  const pending = taskPutQueue.size + taskDeleteQueue.size;
  if (pending > 0) {
    return {
      ok: false,
      message: `Не удалось отправить ${pending} из ${tasks.length}: сервер не ответил. Данные сохранены на устройстве, повторю автоматически.`,
      total: tasks.length,
      pending,
    };
  }
  setSyncStatus({ state: 'ok', message: '', lastSuccessAt: Date.now() });
  return { ok: true, message: `Отправлено на сервер: ${tasks.length} задач`, total: tasks.length, pending: 0 };
}

export type PullResult = { ok: boolean; message: string; total: number };

// Explicit "pull from the server". This is the ordinary merge path, with a
// user-readable result on top: rows that exist on the server are adopted,
// rows only this device has are kept (never deleted by a pull), and anything
// this device still owes the server keeps its local version — otherwise the
// pull would undo an edit that has not been uploaded yet.
export async function pullFromServer(): Promise<PullResult> {
  if (!isSupabaseAvailable || !supabase) {
    return { ok: false, message: 'Supabase не настроен — данные остаются только на устройстве', total: tasks.length };
  }
  if (!getUserId()) {
    return { ok: false, message: 'Нет входа в аккаунт — загрузка невозможна', total: tasks.length };
  }
  if (isOffline()) {
    return { ok: false, message: 'Браузер сообщает, что сети нет', total: tasks.length };
  }
  setSyncStatus({ state: 'syncing', message: 'загружаю данные с сервера…' });
  await pullRemoteTasks();
  if (syncStatus.state === 'error') {
    return {
      ok: false,
      message: 'Сервер не ответил — показаны локальные данные. Попробуйте ещё раз через минуту.',
      total: tasks.length,
    };
  }
  setSyncStatus({ state: 'ok', message: '', lastSuccessAt: Date.now() });
  return { ok: true, message: `Получено с сервера. Сейчас на устройстве: ${tasks.length} задач`, total: tasks.length };
}

export function buildBackupJson(): string {
  const file: BackupFile = {
    format: 'calendar-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks,
    spheres,
    topics,
  };
  return JSON.stringify(file, null, 2);
}

function stableKey(obj: unknown): string {
  return JSON.stringify(obj, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export type RestoreResult = {
  ok: boolean;
  message: string;
  added: number;
  updated: number;
  total: number;
};

// Merge, never replace: rows the backup does not contain stay untouched (a
// backup from one device must not delete what the other device has), ids
// missing locally are added, and an id present on both sides takes the BACKUP's
// version — the file is the device the user made the newer edits on.
export function restoreFromBackupJson(text: string): RestoreResult {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'Файл повреждён: это не JSON', added: 0, updated: 0, total: tasks.length };
  }
  const rows: any[] = Array.isArray(parsed) ? parsed : parsed?.tasks;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, message: 'В копии нет задач', added: 0, updated: 0, total: tasks.length };
  }
  const byId = new Map<string, Task>(tasks.map((t) => [t.id, t]));
  let added = 0;
  let updated = 0;
  for (const raw of rows) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') continue;
    const incoming = raw as Task;
    const existing = byId.get(incoming.id);
    if (!existing) {
      byId.set(incoming.id, incoming);
      added++;
    } else if (stableKey(existing) !== stableKey(incoming)) {
      byId.set(incoming.id, incoming);
      updated++;
    }
  }
  const backupSpheres: string[] = Array.isArray(parsed?.spheres)
    ? parsed.spheres.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
    : [];
  // A backup from a stale device can hold categories that were deleted since.
  // The delete intent wins: restoring a file must not resurrect them.
  const nextSpheres = [...spheres, ...backupSpheres.filter((s) => !spheres.includes(s) && !deletedSpheres.has(s))];

  // Folders and blocks from the file, merged per category and per folder — a
  // backup from one device must not wipe what the other device has.
  if (parsed?.topics && typeof parsed.topics === 'object') {
    topics = mergeTree(topics, normalizeTree(parsed.topics));
  }

  tasks = [...byId.values()];
  spheres = nextSpheres.length ? nextSpheres : [...spheres];
  emit(); // diffs against prevTaskSnapshot → every restored row is queued

  return {
    ok: true,
    message: added || updated ? `Восстановлено: +${added} новых, ${updated} обновлено` : 'Всё уже совпадает',
    added,
    updated,
    total: tasks.length,
  };
}

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
export function useTopics(): Tree {
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
