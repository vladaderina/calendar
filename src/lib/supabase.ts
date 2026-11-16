import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { Task, Weekday } from '../types';

// Vite's `define` option in vite.config.ts replaces __SUPABASE_URL__ and
// __SUPABASE_ANON_KEY__ at build time with values from .env.
// The typeof guard handles both the Vite replacement and the runtime case.
declare const __SUPABASE_URL__: string | undefined;
declare const __SUPABASE_ANON_KEY__: string | undefined;

const url = effectiveUrl(typeof __SUPABASE_URL__ !== 'undefined' ? __SUPABASE_URL__ : '');
const anonKey = typeof __SUPABASE_ANON_KEY__ !== 'undefined' ? __SUPABASE_ANON_KEY__ : '';

// Supabase is reached through the deployment's own origin when the app runs
// from it. Direct calls to *.supabase.co are unreliable on mobile and VPN
// links: the TLS connection is reset or the certificate verifier changes
// mid-request (ERR_CONNECTION_RESET / ERR_CERT_VERIFIER_CHANGED), every read
// fails after six retries and every queued write aborts. nginx on the hosting
// box proxies /luna-calendar-secure/sb/ to the same Supabase project, so the
// browser only ever talks to the certificate it already trusts.
function effectiveUrl(raw: string): string {
  if (!raw || typeof window === 'undefined') return raw;
  const base = '/luna-calendar-secure/';
  if (!window.location.pathname.startsWith(base)) return raw;
  // Local dev keeps talking to Supabase directly — the Vite server has no proxy.
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)) return raw;
  return `${window.location.origin}${base}sb`;
}

// Supabase is used only when the project is configured (.env filled).
// Otherwise the app falls back to localStorage (existing behaviour).
export const isSupabaseAvailable = Boolean(url && anonKey);

// supabase-js (gotrue) wraps every token read in navigator.locks.request().
// In this environment that call never settles, so the promise chain stalls
// BEFORE the HTTP request is ever issued: the app renders an empty week with 55
// tasks sitting in the database, and no request appears in the network panel.
//
// The old workaround was a pass-through "lock" that ran the callback
// immediately. That fixed the hang but broke something worse: gotrue uses the
// lock to SERIALISE token refresh, and a serialised refresh is what stops two
// in-flight refreshes from presenting the same refresh token. Supabase rotates
// the refresh token on every use, so the loser of that race gets
// "Invalid Refresh Token: Already Used", the client throws the session away and
// fires SIGNED_OUT — the login screen appears for no visible reason. Double
// effects in StrictMode, the 4 s poll and a second open tab are enough to race.
//
// So we keep an in-memory queue per lock name: same serialisation as the real
// API, no dependency on navigator.locks.
const lockChains = new Map<string, Promise<unknown>>();
const serialLock = {
  request: <T>(name: string, optsOrFn: unknown, maybeFn?: unknown): Promise<T> => {
    const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as (
      o: { name: string; mode: string },
    ) => Promise<T>;
    const run = () => fn({ name, mode: 'exclusive' });
    const previous = lockChains.get(name) ?? Promise.resolve();
    // Run after the previous holder finishes, whether it resolved or rejected.
    const next = previous.then(run, run);
    lockChains.set(name, next.catch(() => undefined));
    return next;
  },
};
if (typeof globalThis.navigator !== 'undefined') {
  try {
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      writable: true,
      value: serialLock,
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
// Deadlines are a compromise between "fail fast so a stuck socket releases
// its connection slot" and "do not kill a request that is merely slow".
//
// 3.5 s was too aggressive for reads: over a VPN or a weak mobile link a page
// of 25 tasks routinely needs longer than that, so every read was aborted
// (`net::ERR_NETWORK_IO_SUSPENDED`, `ERR_CONNECTION_RESET`) and the app showed
// an empty calendar while the rows sat safely in Postgres. 9 s still fails
// well before the OS gives up, but rides out a slow round-trip.
const REQUEST_TIMEOUT_MS = 9000;
// Uploads are a different size class: a batch of task rows is tens of KB, and
// on a slow link the same deadline aborts it mid-body (`AbortError: signal is
// aborted without reason` in the console, forever) — so a failed move never
// reached the server and the next load "undid" it. Writes get much longer.
const WRITE_TIMEOUT_MS = 30000;

const isWrite = (init?: RequestInit) => {
  const m = (init?.method ?? 'GET').toUpperCase();
  return m === 'POST' || m === 'PATCH' || m === 'PUT' || m === 'DELETE';
};

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url ?? '';
};

// Token refresh needs its own deadline. Aborting a refresh that the server has
// already processed is not free: the refresh token has been rotated by then, our
// copy is stale, and the NEXT refresh fails with "Invalid Refresh Token: Already
// Used" — the client wipes the session and the user sees the login screen. That
// is exactly what a 9 s (or even 30 s) abort did on a weak mobile link.
const AUTH_TIMEOUT_MS = 60000;

const fetchWithTimeout: typeof fetch = (input, init) => {
  const target = urlOf(input);
  const authCall = /\/auth\/v1\//.test(target);
  const deadline = authCall ? AUTH_TIMEOUT_MS : isWrite(init) ? WRITE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
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

// ── Transport tags stored inside `notes` ────────────────────────────────
// The deployed `tasks` table has no `topic` column (sub-category), and schema
// changes need SQL the app cannot run. Both extra flags therefore travel as
// tags appended to `notes` and are stripped again on the way in — the same
// trick `sameDayOnly` already used. Losing them silently is what made every
// task land in "Основное" after the next fetch: the row came back from the
// server without its topic and the merge adopted it.
const SAME_DAY_TAG = '#sameDayOnly';
const TOPIC_TAG = '#topic:';

function withTag(notes: string | undefined, tag: string): string {
  return notes ? `${notes} ${tag}` : tag;
}

export function toTaskRow(t: Task, userId: string): TaskRow {
  // Pack sameDayOnly tag into notes as `#sameDayOnly` if present
  let cleanNotes = t.notes;
  if (t.sameDayOnly) cleanNotes = withTag(cleanNotes, SAME_DAY_TAG);
  // encodeURIComponent keeps the topic free of spaces and `#`, so a single
  // regex can strip it and it can never break the segment parsing above.
  if (t.topic) cleanNotes = withTag(cleanNotes, `${TOPIC_TAG}${encodeURIComponent(t.topic)}`);
  return {
    id: t.id,
    user_id: userId,
    title: t.title,
    notes: cleanNotes,
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

const TOPIC_TAG_RE = /#topic:([^\s#]*)/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function fromTaskRow(r: TaskRow): Task {
  const hasSameDayTag = !!r.notes?.includes(SAME_DAY_TAG);
  // The sub-category is carried inside `notes` (see toTaskRow). Without this
  // the row reads back with no topic and the merge drops the task into
  // "Основное" — the reported "задачи не попадают в подкатегорию".
  const topicMatch = r.notes?.match(TOPIC_TAG_RE);
  let cleanNotes = r.notes;
  if (hasSameDayTag || topicMatch) {
    cleanNotes = cleanNotes
      ?.replace(/#topic:[^\s#]*/g, '')
      .replace(/#sameDayOnly/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || undefined;
  }
  return {
    id: r.id,
    title: r.title,
    notes: cleanNotes,
    topic: topicMatch ? safeDecode(topicMatch[1]) : undefined,
    sameDayOnly: hasSameDayTag,
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
