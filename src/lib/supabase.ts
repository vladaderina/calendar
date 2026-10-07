import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { Task, Weekday } from '../types';

// Vite's `define` option in vite.config.ts replaces __SUPABASE_URL__ and
// __SUPABASE_ANON_KEY__ at build time with values from .env.
// The typeof guard handles both the Vite replacement and the runtime case.
declare const __SUPABASE_URL__: string | undefined;
declare const __SUPABASE_ANON_KEY__: string | undefined;

const url = typeof __SUPABASE_URL__ !== 'undefined' ? __SUPABASE_URL__ : '';
const anonKey = typeof __SUPABASE_ANON_KEY__ !== 'undefined' ? __SUPABASE_ANON_KEY__ : '';

// Supabase is used only when the project is configured (.env filled).
// Otherwise the app falls back to localStorage (existing behaviour).
export const isSupabaseAvailable = Boolean(url && anonKey);

// supabase-js (gotrue) wraps every token read in navigator.locks.request().
// In this environment that call never settles, so the promise chain stalls
// BEFORE the HTTP request is ever issued: the app renders an empty week with 55
// tasks sitting in the database, and no request appears in the network panel.
// A single-tab app needs no cross-process lock, so we install a pass-through
// one rather than depend on a browser API that can silently hang.
const passThroughLock = {
  request: async (_name: string, _opts: any, fn: any) => {
    const run = typeof _opts === 'function' ? _opts : fn;
    return run({ name: _name, mode: 'exclusive' });
  },
};
if (typeof globalThis.navigator !== 'undefined') {
  try {
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      writable: true,
      value: passThroughLock,
    });
  } catch {
    // Some engines refuse to redefine it; the app then behaves as before.
  }
}

// A network call to the Supabase host can stall indefinitely on some links
// (observed here: roughly every third request hangs until the OS gives up,
// while the rest answer in ~150ms). Without a deadline the client waits on the
// stuck socket forever and the app looks frozen; with one, a stalled request
// fails fast and the next attempt picks the change up.
//
// The deadline is deliberately short. Healthy responses take 180–400ms, so a
// request still silent after a few seconds is stuck, not slow — burning 8s on
// it also holds a connection slot (browsers allow only ~6 per host) that the
// other slices need. Failing fast and retrying recovers far quicker.
const REQUEST_TIMEOUT_MS = 3500;

const fetchWithTimeout: typeof fetch = (input, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const signal = init?.signal;
  // Respect a caller-supplied signal as well as our deadline.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
};

export const supabase: SupabaseClient | null = isSupabaseAvailable
  ? createClient(url!, anonKey!, {
      global: { fetch: fetchWithTimeout },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : null;

// Debug: export to window
if (typeof window !== 'undefined') {
  (window as any).supabase = supabase;
  (window as any).isSupabaseAvailable = isSupabaseAvailable;
}

// Convert a local Task to the DB-shaped row and back, keeping field name
// parity with the schema in supabase/migrations/20240927_tasks_schema.sql
// (snake_case columns; camelCase Task fields on the client).
type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  notes?: string;
  start_date?: string;
  end_date?: string;
  sphere?: string;
  recurrence: string;
  recurrence_days?: number[];
  year_dates?: string[];
  reminder_days?: number;
  color?: string;
  priority: string;
  unplanned: boolean;
  order?: number;
  completed: boolean;
  completed_at?: string;
  completed_dates?: string[];
  excluded_dates?: string[];
  recurrence_until?: string;
  subtask_ids?: string[];
  subtask_of?: string;
  created_at: string;
};

export function toTaskRow(t: Task, userId: string): TaskRow {
  return {
    id: t.id,
    user_id: userId,
    title: t.title,
    notes: t.notes,
    start_date: t.startDate,
    end_date: t.endDate,
    sphere: t.sphere,
    recurrence: t.recurrence,
    recurrence_days: t.recurrenceDays,
    year_dates: t.yearDates,
    reminder_days: t.reminderDays,
    color: t.color,
    priority: t.priority,
    unplanned: t.unplanned,
    order: t.order,
    completed: t.completed,
    completed_at: t.completedAt,
    completed_dates: t.completedDates,
    excluded_dates: t.excludedDates,
    recurrence_until: t.recurrenceUntil,
    subtask_ids: t.subtaskIds,
    subtask_of: t.subtaskOf,
    created_at: t.createdAt,
  };
}

export function fromTaskRow(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    startDate: r.start_date,
    endDate: r.end_date,
    sphere: r.sphere,
    recurrence: (r.recurrence ?? 'none') as Task['recurrence'],
    recurrenceDays: (r.recurrence_days ?? []) as Weekday[],
    yearDates: r.year_dates,
    reminderDays: r.reminder_days,
    color: r.color,
    priority: (r.priority ?? 'low') as Task['priority'],
    unplanned: r.unplanned,
    order: r.order,
    completed: r.completed,
    completedAt: r.completed_at,
    completedDates: r.completed_dates,
    excludedDates: r.excluded_dates,
    recurrenceUntil: r.recurrence_until,
    subtaskIds: r.subtask_ids,
    subtaskOf: r.subtask_of,
    createdAt: r.created_at ?? new Date().toISOString(),
  };
}

export type { User };
