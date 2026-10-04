import { useSyncExternalStore } from 'react';
import { v4 as uuid } from 'uuid';
import type { Task } from './types';
import { DEFAULT_SPHERES } from './types';
import { supabase, isSupabaseAvailable, toTaskRow, fromTaskRow } from './lib/supabase';
import { initAuth, getUserId } from './lib/auth';

const TASKS_KEY = 'calendar.tasks.v1';
const SPHERES_KEY = 'calendar.spheres.v1';
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
let journal: Record<string, string> = loadJournal();
let lastView: string = loadView();
const snapshot = { tasks, spheres, journal, lastView };
const listeners = new Set<() => void>();

function emit() {
  snapshot.tasks = tasks;
  snapshot.spheres = spheres;
  snapshot.journal = journal;
  snapshot.lastView = lastView;
  localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  localStorage.setItem(SPHERES_KEY, JSON.stringify(spheres));
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  localStorage.setItem(VIEW_KEY, lastView);
  syncToSupabase();
  listeners.forEach((l) => l());
}

// ── Supabase sync ────────────────────────────────────────────────────────
async function syncToSupabase() {
  if (!isSupabaseAvailable || !supabase) return;
  const userId = getUserId();
  if (!userId) return;

  try {
    // --- Tasks ---
    // 1. Upsert every local task
    for (const t of tasks) {
      await supabase.from('tasks').upsert(toTaskRow(t, userId));
    }
    // 2. Delete tasks from DB that are no longer local (orphans)
    const { data: remoteRows } = await supabase
      .from('tasks')
      .select('id')
      .eq('user_id', userId);
    if (remoteRows) {
      const localIds = new Set(tasks.map((t) => t.id));
      const orphans = remoteRows
        .map((r: { id: string }) => r.id)
        .filter((id) => !localIds.has(id));
      if (orphans.length > 0) {
        await supabase.from('tasks').delete().in('id', orphans);
      }
    }
  } catch (e) {
    console.warn('[supabase] sync tasks error:', e);
  }

  try {
    // --- Spheres ---
    await supabase.from('spheres').upsert(
      spheres.map((name, idx) => ({
        user_id: userId,
        name,
        order: idx,
      }))
    );
  } catch (e) {
    console.warn('[supabase] sync spheres error:', e);
  }

  try {
    // --- Journal ---
    // Upsert all journal entries
    for (const [dateKey, text] of Object.entries(journal)) {
      await supabase.from('journal_entries').upsert({
        user_id: userId,
        date_key: dateKey,
        text,
        updated_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn('[supabase] sync journal error:', e);
  }

  try {
    // --- View state ---
    await supabase.from('user_settings').upsert({
      user_id: userId,
      last_view: lastView,
    });
  } catch (e) {
    console.warn('[supabase] sync view error:', e);
  }
}

// ── Initialise Supabase (auth + load remote data) ──────────────────────
export async function initSupabase(): Promise<void> {
  if (!isSupabaseAvailable || !supabase) return;

  const user = await initAuth();
  if (!user) return;

  try {
    // Load tasks
    const { data: taskRows, error: taskErr } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', user.id);

    if (!taskErr && taskRows && taskRows.length > 0) {
      tasks = taskRows.map(fromTaskRow);
      // Merge: take union of local + remote (remote wins for matching ids)
      const localIds = new Set(tasks.map((t) => t.id));
      const localExtra = loadTasks().filter((t) => !localIds.has(t.id));
      tasks = [...tasks, ...localExtra];
      snapshot.tasks = tasks;
      localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
    }

    // Load spheres
    const { data: sphereRows, error: sphereErr } = await supabase
      .from('spheres')
      .select('*')
      .eq('user_id', user.id)
      .order('order', { ascending: true });

    if (!sphereErr && sphereRows && sphereRows.length > 0) {
      spheres = sphereRows.map((r) => r.name);
      snapshot.spheres = spheres;
      localStorage.setItem(SPHERES_KEY, JSON.stringify(spheres));
    }

    // Load journal
    const { data: journalRows, error: journalErr } = await supabase
      .from('journal_entries')
      .select('*')
      .eq('user_id', user.id);

    if (!journalErr && journalRows) {
      const newJournal: Record<string, string> = { ...journal };
      journalRows.forEach((row) => {
        newJournal[row.date_key] = row.text;
      });
      journal = newJournal;
      snapshot.journal = journal;
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
    }

    // Load view state
    const { data: settingsRows, error: settingsErr } = await supabase
      .from('user_settings')
      .select('last_view')
      .eq('user_id', user.id)
      .single();

    if (!settingsErr && settingsRows && settingsRows.last_view) {
      lastView = settingsRows.last_view;
      snapshot.lastView = lastView;
      localStorage.setItem(VIEW_KEY, lastView);
    }

    listeners.forEach((l) => l());
  } catch (e) {
    console.warn('[supabase] init load error:', e);
  }

  // ── Real-time subscriptions ────────────────────────────────────────
  try {
    supabase
      .channel(`public:tasks:user_id=eq.${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${user.id}` },
        (payload) => {
          const row = payload.new as any;
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const task = fromTaskRow(row);
            tasks = tasks.filter((t) => t.id !== task.id);
            tasks = [...tasks, task];
          } else if (payload.eventType === 'DELETE') {
            tasks = tasks.filter((t) => t.id !== row.id);
          }
          snapshot.tasks = tasks;
          localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
          listeners.forEach((l) => l());
        }
      )
      .subscribe();

    supabase
      .channel(`public:spheres:user_id=eq.${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'spheres', filter: `user_id=eq.${user.id}` },
        (_payload) => {
          // Refresh spheres from DB to keep ordering
          if (!supabase) return;
          supabase
            .from('spheres')
            .select('*')
            .eq('user_id', user.id)
            .order('order', { ascending: true })
            .then(({ data }) => {
              if (data) {
                spheres = data.map((r) => r.name);
                snapshot.spheres = spheres;
                localStorage.setItem(SPHERES_KEY, JSON.stringify(spheres));
                listeners.forEach((l) => l());
              }
            });
        }
      )
      .subscribe();

    // Journal real-time subscription
    supabase
      .channel(`public:journal_entries:user_id=eq.${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'journal_entries', filter: `user_id=eq.${user.id}` },
        (payload: any) => {
          const row = payload.new as any;
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            journal[row.date_key] = row.text;
          } else if (payload.eventType === 'DELETE' && payload.old) {
            delete journal[payload.old.date_key];
          }
          snapshot.journal = journal;
          localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
          listeners.forEach((l) => l());
        }
      )
      .subscribe();
  } catch (e) {
    console.warn('[supabase] subscription error:', e);
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
    emit();
  },
  addSphere(name: string) {
    const n = name.trim();
    if (!n || spheres.includes(n)) return;
    spheres = [...spheres, n];
    emit();
  },
  removeSphere(name: string) {
    spheres = spheres.filter((s) => s !== name);
    tasks = tasks.map((t) => (t.sphere === name ? { ...t, sphere: undefined } : t));
    emit();
  },
  reorderSpheres(ordered: string[]) {
    const filtered = ordered.filter((s) => spheres.includes(s));
    spheres = filtered.length ? filtered : [...spheres];
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
    syncToSupabase();
    listeners.forEach((l) => l());
  },
  saveJournalAll(data: Record<string, string>) {
    journal = data;
    snapshot.journal = journal;
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
    syncToSupabase();
    listeners.forEach((l) => l());
  },
  deleteJournalEntry(dateKey: string) {
    delete journal[dateKey];
    snapshot.journal = journal;
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
    syncToSupabase();
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
    syncToSupabase();
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
export function useJournal(): Record<string, string> {
  return useSyncExternalStore(store.subscribe, () => snapshot.journal, () => snapshot.journal);
}
export function useLastView(): string {
  return useSyncExternalStore(store.subscribe, () => snapshot.lastView, () => snapshot.lastView);
}
