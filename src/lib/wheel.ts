// Year wheel data — painted week sectors (several colours per week) + comments.
//
// The wheel is addressed by ISO week: the key of a mark is the yyyy-MM-dd of
// the MONDAY that starts the week. That way the same mark follows the real
// week no matter where the rolling window starts, and a plan painted for a
// future month is still there when that month arrives.
//
// A week may carry SEVERAL colours — that is what the wheel draws as zebra
// stripes inside one sector ("отпуск" + "работа" on the same week).
//
// Two devices edit the same marks, so every entry carries `t` (the time of the
// last change) and merges are last-write-wins per week. Clearing a colour or a
// note leaves a tombstone (an entry with `t` but no content) so that an older
// copy coming back from the server cannot resurrect it.

export interface WeekMark {
  /** Colours from the shared palette (hex), in the order they were added. */
  colors?: string[];
  /** Free-form comment attached to the week. */
  note?: string;
  /** Last change (ms since epoch) — used to merge two devices. */
  t: number;
}

export type WheelMarks = Record<string, WeekMark>;

const KEY = 'calendar.wheel.v1';
const CHANGED_EVENT = 'wheel-change';
const SYNC_EVENT = 'wheel-sync-request';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function normaliseColors(raw: unknown, legacy?: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  };
  if (Array.isArray(raw)) raw.forEach(push);
  // Older records kept a single `color` string.
  push(legacy);
  return out;
}

function readAll(): WheelMarks {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: WheelMarks = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!ISO_DAY.test(k) || !v || typeof v !== 'object') continue;
      const src = v as Record<string, unknown>;
      const colors = normaliseColors(src.colors, src.color);
      const note = typeof src.note === 'string' && src.note ? src.note : undefined;
      out[k] = { colors, note, t: Number(src.t) || 0 };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(marks: WheelMarks, sync = true): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(marks));
  } catch {
    // ignore quota errors
  }
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  if (sync) window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

function patch(weekStart: string, next: { colors?: string[]; note?: string | null }): void {
  if (!ISO_DAY.test(weekStart)) return;
  const all = readAll();
  const prev = all[weekStart] ?? { colors: [], t: 0 };
  const colors = next.colors === undefined ? (prev.colors ?? []) : next.colors;
  const note = next.note === undefined ? prev.note : (next.note ?? '').trim() || undefined;
  const same = colors.length === (prev.colors?.length ?? 0)
    && colors.every((c, i) => prev.colors?.[i] === c)
    && note === prev.note;
  if (same) return;
  all[weekStart] = { colors, note, t: Date.now() };
  persist(all);
}

export function getWheelMarks(): WheelMarks {
  return readAll();
}

export function getWeekMark(weekStart: string): WeekMark | undefined {
  return readAll()[weekStart];
}

/** A mark with neither a colour nor a note (a tombstone) is invisible. */
export function isMarkVisible(m: WeekMark | undefined): boolean {
  return Boolean(m && ((m.colors?.length ?? 0) > 0 || m.note));
}

export function setWeekColors(weekStart: string, colors: string[]): void {
  patch(weekStart, { colors: normaliseColors(colors) });
}

/** Add the colour to the week, or take it away when it is already there. */
export function toggleWeekColor(weekStart: string, color: string): void {
  const cur = getWeekMark(weekStart)?.colors ?? [];
  setWeekColors(
    weekStart,
    cur.includes(color) ? cur.filter((c) => c !== color) : [...cur, color],
  );
}

export function clearWeekColors(weekStart: string): void {
  patch(weekStart, { colors: [] });
}

export function setWeekNote(weekStart: string, note: string): void {
  patch(weekStart, { note });
}

export function clearWeekMark(weekStart: string): void {
  patch(weekStart, { colors: [], note: null });
}

/** Serialised marks — the payload that travels through `user_settings`. */
export function wheelJson(): string {
  return JSON.stringify(readAll());
}

/** Subscribe to local changes (this tab and merges from the server). */
export function subscribeWheel(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

/**
 * Apply marks that came from another device. Per-week last-write-wins: a
 * remote entry is adopted only when it is newer than the local one (or when
 * this device has none).
 *
 * Returns `adopted` (something came in) and `needPush` — true while ANY local
 * week is at least as new as its remote counterpart, INCLUDING weeks the
 * server does not have at all. Without that second flag a device that painted
 * a week while offline would consider itself in sync after a read and never
 * upload it.
 */
export function mergeWheel(remote: unknown): { adopted: boolean; needPush: boolean } {
  if (!remote || typeof remote !== 'object') return { adopted: false, needPush: true };
  const all = readAll();
  let adopted = false;
  const remoteT = new Map<string, number>();
  for (const [k, v] of Object.entries(remote as Record<string, unknown>)) {
    if (!ISO_DAY.test(k) || !v || typeof v !== 'object') continue;
    const src = v as Record<string, unknown>;
    const t = Number(src.t) || 0;
    remoteT.set(k, t);
    const incoming: WeekMark = {
      colors: normaliseColors(src.colors, src.color),
      note: typeof src.note === 'string' && src.note ? src.note : undefined,
      t,
    };
    const cur = all[k];
    const curT = cur ? Number(cur.t) || 0 : -1;
    if (curT < t) {
      all[k] = incoming;
      adopted = true;
    }
  }
  if (adopted) persist(all, false);
  let needPush = false;
  for (const [k, v] of Object.entries(all)) {
    const local = Number(v.t) || 0;
    const remoteValue = remoteT.get(k);
    if (remoteValue === undefined || local > remoteValue) {
      needPush = true;
      break;
    }
  }
  return { adopted, needPush };
}
