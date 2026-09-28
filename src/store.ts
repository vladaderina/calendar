import { useSyncExternalStore } from 'react';
import { v4 as uuid } from 'uuid';
import type { Task } from './types';
import { DEFAULT_SPHERES } from './types';

const KEY = 'calendar.tasks.v1';
const SPHERES_KEY = 'calendar.spheres.v1';

function loadTasks(): Task[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
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

let tasks: Task[] = loadTasks();
let spheres: string[] = loadSpheres();
let snapshot = { tasks, spheres };
const listeners = new Set<() => void>();

function emit() {
  snapshot = { tasks, spheres };
  localStorage.setItem(KEY, JSON.stringify(tasks));
  localStorage.setItem(SPHERES_KEY, JSON.stringify(spheres));
  listeners.forEach((l) => l());
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
      reminderDays: input.reminderDays,
      color: input.color,
      priority,
      unplanned: input.unplanned ?? false,
      order: input.order ?? priorityBaseOrder(priority) + Date.now(),
      completed: false,
      completedDates: input.completedDates,
      excludedDates: input.excludedDates,
      recurrenceUntil: input.recurrenceUntil,
      dependsOnTaskId: input.dependsOnTaskId,
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
  clearAll() {
    tasks = [];
    emit();
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
