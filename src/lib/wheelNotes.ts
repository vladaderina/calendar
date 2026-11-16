// Notes for the year wheel.
//
// These are the user's OWN notes: a small independent list that lives only on
// the wheel. They are deliberately NOT tasks — they never appear in the
// planner, the dashboard or any task list, they are not counted anywhere, and
// no task can appear here. Separate storage key, separate settings segment,
// separate merge.
//
// A note has no dates until it is PLANNED: dropping it on a week gives it a
// start/end (a whole week, or the length it already had) and a random colour
// from the shared palette. Unplanned notes stay in the left column, colourless.
//
// Two devices edit the same notes, so every entry carries `t` (time of the last
// change) and merges are last-write-wins per note. Deleting leaves a tombstone
// (an entry with `deleted: true`) so an older copy coming back from the server
// cannot resurrect the note.

import { v4 as uuid } from 'uuid';
import { randomPaletteColor } from '../config/colors';

export interface WheelNote {
  id: string;
  title: string;
  /** Absent while the note is not planned (it lives in the left column). */
  startDate?: string;
  endDate?: string;
  /** Palette colour, assigned when the note is first planned. */
  color: string;
  /** Last change (ms since epoch) — used to merge two devices. */
  t: number;
  deleted?: boolean;
}

const KEY = 'calendar.wheel_notes.v1';
const EVENT = 'wheel-notes-change';
const SYNC_EVENT = 'wheel-notes-sync-request';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

type Store = Record<string, WheelNote>;

function readAll(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const src = value as Record<string, unknown>;
      const title = typeof src.title === 'string' ? src.title : '';
      if (!title && src.deleted !== true) continue;
      out[id] = {
        id,
        title,
        startDate: typeof src.startDate === 'string' && ISO_DAY.test(src.startDate) ? src.startDate : undefined,
        endDate: typeof src.endDate === 'string' && ISO_DAY.test(src.endDate) ? src.endDate : undefined,
        color: typeof src.color === 'string' ? src.color : '',
        t: Number(src.t) || 0,
        deleted: src.deleted === true ? true : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(all: Store, sync = true): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // ignore quota errors
  }
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT));
  if (sync) window.dispatchEvent(new CustomEvent(SYNC_EVENT));
}

/** Every note the user can see, in creation order (the lists sort themselves). */
export function getWheelNotes(): WheelNote[] {
  return Object.values(readAll())
    .filter((n) => !n.deleted)
    .sort((a, b) => a.t - b.t);
}

export function getWheelNote(id: string): WheelNote | undefined {
  const n = readAll()[id];
  return n && !n.deleted ? n : undefined;
}

export function addWheelNote(title: string): WheelNote | null {
  const text = title.trim();
  if (!text) return null;
  const note: WheelNote = { id: uuid(), title: text, color: '', t: Date.now() };
  const all = readAll();
  all[note.id] = note;
  persist(all);
  return note;
}

export function updateWheelNote(
  id: string,
  patch: Partial<Pick<WheelNote, 'title' | 'startDate' | 'endDate' | 'color'>>,
): void {
  const all = readAll();
  const cur = all[id];
  if (!cur || cur.deleted) return;
  const next: WheelNote = { ...cur, ...patch, id, t: Date.now() };
  if (patch.title !== undefined) {
    const text = patch.title.trim();
    if (!text) return; // an empty title would make the note invisible
    next.title = text;
  }
  if (next.startDate === undefined) next.endDate = undefined;
  all[id] = next;
  persist(all);
}

/** Give the note its dates (and, the first time, its colour). */
export function planWheelNote(id: string, startDate: string, endDate?: string): void {
  const cur = getWheelNote(id);
  if (!cur || !ISO_DAY.test(startDate)) return;
  updateWheelNote(id, {
    startDate,
    endDate: endDate && ISO_DAY.test(endDate) ? endDate : startDate,
    color: cur.color || randomPaletteColor(),
  });
}

/** Back to the left column: dates gone, colour kept for when it returns. */
export function unplanWheelNote(id: string): void {
  updateWheelNote(id, { startDate: undefined, endDate: undefined });
}

export function removeWheelNote(id: string): void {
  const all = readAll();
  const cur = all[id];
  if (!cur) return;
  // Tombstone, never a plain delete: the other device may still hold the note
  // and push it back, and a missing entry cannot win that race.
  all[id] = { ...cur, title: '', deleted: true, t: Date.now() };
  persist(all);
}

/** Serialised notes — the payload that travels in `user_settings`. */
export function wheelNotesJson(): string {
  return JSON.stringify(readAll());
}

export function subscribeWheelNotes(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** Per-note last-write-wins merge of a payload from another device. */
export function mergeWheelNotes(remote: unknown): { adopted: boolean; needPush: boolean } {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
    return { adopted: false, needPush: true };
  }
  const all = readAll();
  let adopted = false;
  const remoteT = new Map<string, number>();
  for (const [id, value] of Object.entries(remote as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const src = value as Record<string, unknown>;
    const t = Number(src.t) || 0;
    remoteT.set(id, t);
    const cur = all[id];
    if ((Number(cur?.t) || -1) >= t) continue;
    const incoming: WheelNote = {
      id,
      title: typeof src.title === 'string' ? src.title : '',
      startDate: typeof src.startDate === 'string' && ISO_DAY.test(src.startDate) ? src.startDate : undefined,
      endDate: typeof src.endDate === 'string' && ISO_DAY.test(src.endDate) ? src.endDate : undefined,
      color: typeof src.color === 'string' ? src.color : '',
      t,
      deleted: src.deleted === true ? true : undefined,
    };
    all[id] = incoming;
    adopted = true;
  }
  if (adopted) persist(all, false);
  let needPush = false;
  for (const [id, note] of Object.entries(all)) {
    const remoteValue = remoteT.get(id);
    if (remoteValue === undefined || note.t > remoteValue) {
      needPush = true;
      break;
    }
  }
  return { adopted, needPush };
}
