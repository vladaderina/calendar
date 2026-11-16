// Moodboard + dashboard notes.
//
// Two kinds of entries live here, both belonging to the DASHBOARD only:
//   • photo — a picture for the moodboard (stored as a data URL, already
//     downscaled by `lib/image.ts`), with an optional caption;
//   • note  — a short sticky note in the notes block.
//
// They are deliberately NOT tasks: they are never counted in any task list,
// they never appear on the wheel or in the planner.
//
// Storage: one map in localStorage (`calendar.board.v1`), mirrored per entry
// into the `board_items` table. Every entry carries `t` (time of the last
// change) so two devices merge last-write-wins per entry, and deleting leaves
// a tombstone (`deleted: true`, picture bytes dropped) so an older copy coming
// back from the server cannot resurrect it.
import { useSyncExternalStore } from 'react';
import { v4 as uuid } from 'uuid';
import { supabase } from './supabase';
import { getUserId } from './auth';

const KEY = 'calendar.board.v1';
const EVENT = 'calendar-board-change';
const NUDGE = 'calendar-board-nudge';

/** Soft paper colours for the sticky notes. */
export const NOTE_COLORS = ['#fef3c7', '#dbeafe', '#fce7f3', '#dcfce7', '#ede9fe', '#ffedd5'];

export interface BoardPhoto {
  id: string;
  kind: 'photo';
  /** `data:image/...` — already downscaled, see `lib/image.ts`. */
  data: string;
  caption: string;
  /** Creation time. The grid is ordered by this, NOT by `t`: editing a
   *  caption must not make the photo jump to the end of the moodboard. */
  born: number;
  t: number;
  deleted?: boolean;
}

export interface BoardNote {
  id: string;
  kind: 'note';
  text: string;
  color: string;
  /** Creation time — the list order is stable across edits. */
  born: number;
  t: number;
  deleted?: boolean;
}

export type BoardItem = BoardPhoto | BoardNote;

type Store = Record<string, BoardItem>;

function isPhoto(item: BoardItem): item is BoardPhoto {
  return item.kind === 'photo';
}

function sanitize(id: string, value: unknown): BoardItem | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const t = Number(src.t) || 0;
  const deleted = src.deleted === true ? true : undefined;
  if (src.kind === 'photo') {
    const data = typeof src.data === 'string' && src.data.startsWith('data:image/') ? src.data : '';
    // A tombstone keeps no picture bytes — it only has to say "this is gone".
    if (!data && !deleted) return null;
    return {
      id,
      kind: 'photo',
      data: deleted ? '' : data,
      caption: typeof src.caption === 'string' ? src.caption : '',
      born: Number(src.born) || t,
      t,
      deleted,
    };
  }
  if (src.kind === 'note') {
    const text = typeof src.text === 'string' ? src.text : '';
    if (!text.trim() && !deleted) return null;
    return {
      id,
      kind: 'note',
      text,
      color: typeof src.color === 'string' ? src.color : NOTE_COLORS[0],
      born: Number(src.born) || t,
      t,
      deleted,
    };
  }
  return null;
}

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const item = sanitize(id, value);
      if (item) out[id] = item;
    }
    return out;
  } catch {
    return {};
  }
}

let items: Store = load();
let photosSnapshot: BoardPhoto[] = [];
let notesSnapshot: BoardNote[] = [];

function rebuild(): void {
  const all = Object.values(items).filter((item) => !item.deleted);
  photosSnapshot = all.filter(isPhoto).sort((a, b) => a.born - b.born);
  notesSnapshot = (all.filter((item) => !isPhoto(item)) as BoardNote[]).sort((a, b) => a.born - b.born);
}
rebuild();

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

function persist(nudge = true): void {
  rebuild();
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // quota exceeded — surfaced by the caller that tried to add a photo
  }
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT));
  if (nudge) window.dispatchEvent(new CustomEvent(NUDGE));
}

/** True when `persist` could actually write the whole map (photo quota). */
function storeFits(): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
    return true;
  } catch {
    return false;
  }
}

export function useBoardPhotos(): BoardPhoto[] {
  return useSyncExternalStore(subscribe, () => photosSnapshot, () => photosSnapshot);
}

export function useBoardNotes(): BoardNote[] {
  return useSyncExternalStore(subscribe, () => notesSnapshot, () => notesSnapshot);
}

export function getBoardPhotos(): BoardPhoto[] {
  return photosSnapshot;
}

export type AddResult = { ok: true } | { ok: false; message: string };

export function addBoardPhoto(data: string, caption = ''): AddResult {
  const id = uuid();
  const now = Date.now();
  items[id] = { id, kind: 'photo', data, caption, born: now, t: now };
  if (!storeFits()) {
    delete items[id];
    rebuild();
    return { ok: false, message: 'на устройстве кончилось место — удали пару фото' };
  }
  persist();
  return { ok: true };
}

export function updateBoardPhoto(id: string, patch: { caption?: string }): void {
  const cur = items[id];
  if (!cur || cur.kind !== 'photo' || cur.deleted) return;
  if (patch.caption !== undefined && patch.caption === cur.caption) return;
  items[id] = { ...cur, caption: patch.caption ?? cur.caption, t: Date.now() };
  persist();
}

export function addBoardNote(text: string, color = NOTE_COLORS[0]): BoardNote | null {
  const value = text.trim();
  if (!value) return null;
  const id = uuid();
  const now = Date.now();
  const note: BoardNote = { id, kind: 'note', text: value, color, born: now, t: now };
  items[id] = note;
  persist();
  return note;
}

export function updateBoardNote(id: string, patch: { text?: string; color?: string }): void {
  const cur = items[id];
  if (!cur || cur.kind !== 'note' || cur.deleted) return;
  const nextText = patch.text !== undefined ? patch.text : cur.text;
  if (!nextText.trim()) {
    removeBoardItem(id);
    return;
  }
  const next: BoardNote = {
    ...cur,
    text: nextText,
    color: patch.color ?? cur.color,
    t: Date.now(),
  };
  if (next.text === cur.text && next.color === cur.color) return;
  items[id] = next;
  persist();
}

/** Tombstone, never a plain delete: the other device may still hold the entry. */
export function removeBoardItem(id: string): void {
  const cur = items[id];
  if (!cur) return;
  if (cur.kind === 'photo') {
    items[id] = { ...cur, data: '', deleted: true, t: Date.now() };
  } else {
    items[id] = { ...cur, text: '', deleted: true, t: Date.now() };
  }
  persist();
}

// ── Supabase mirror ──────────────────────────────────────────────────────
// One row per entry (`board_items`), so adding a photo uploads only that
// photo — the whole moodboard is never rewritten in one request.

interface Row {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  t: number;
  deleted: boolean;
}

function toRow(item: BoardItem, userId: string): Row & { user_id: string } {
  const payload: Record<string, unknown> = item.kind === 'photo'
    ? { data: item.data, caption: item.caption, born: item.born }
    : { text: item.text, color: item.color, born: item.born };
  return { id: item.id, user_id: userId, kind: item.kind, payload, t: item.t, deleted: item.deleted === true };
}

function fromRow(row: Record<string, unknown>): BoardItem | null {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const base = {
    id: String(row.id),
    t: Number(row.t) || 0,
    deleted: row.deleted === true ? true : undefined,
  };
  if (row.kind === 'photo') {
    return sanitize(base.id, {
      ...base,
      kind: 'photo',
      data: typeof payload.data === 'string' ? payload.data : '',
      caption: typeof payload.caption === 'string' ? payload.caption : '',
      born: Number(payload.born) || undefined,
    });
  }
  if (row.kind === 'note') {
    return sanitize(base.id, {
      ...base,
      kind: 'note',
      text: typeof payload.text === 'string' ? payload.text : '',
      color: typeof payload.color === 'string' ? payload.color : NOTE_COLORS[0],
      born: Number(payload.born) || undefined,
    });
  }
  return null;
}

let inFlight: Promise<void> | null = null;
let again = false;

/** Pull the server copy, adopt newer entries, push local ones it lacks. */
export function syncBoard(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = runSync().finally(() => {
    inFlight = null;
    if (again) {
      again = false;
      void syncBoard();
    }
  });
  return inFlight;
}

async function runSync(): Promise<void> {
  const client = supabase;
  const userId = getUserId();
  if (!client || !userId) return;
  const { data, error } = await client.from('board_items').select('id,kind,payload,t,deleted');
  if (error) {
    console.warn('[board] sync read error:', error.message);
    return;
  }
  const remoteT = new Map<string, number>();
  let adopted = false;
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const id = String(raw.id);
    const t = Number(raw.t) || 0;
    remoteT.set(id, t);
    const cur = items[id];
    if (cur && cur.t >= t) continue;
    const incoming = fromRow(raw);
    if (!incoming) continue;
    items[id] = incoming;
    adopted = true;
  }
  if (adopted) persist(false);

  const dirty = Object.values(items).filter((item) => {
    const remote = remoteT.get(item.id);
    return remote === undefined || item.t > remote;
  });
  if (!dirty.length) return;

  // Send in size-capped batches: a batch must stay well under the gateway's
  // body limit, and one oversized request would drop every photo in it.
  let batch: (Row & { user_id: string })[] = [];
  let bytes = 0;
  const flush = async (): Promise<boolean> => {
    if (!batch.length) return true;
    const { error: writeError } = await client
      .from('board_items')
      .upsert(batch, { onConflict: 'id' });
    if (writeError) {
      console.warn('[board] sync write error:', writeError.message);
      return false;
    }
    batch = [];
    bytes = 0;
    return true;
  };
  for (const item of dirty) {
    const row = toRow(item, userId);
    const size = JSON.stringify(row).length;
    if (bytes + size > 3_000_000 && !(await flush())) return;
    batch.push(row);
    bytes += size;
  }
  await flush();
}

/** Keep the moodboard/notes in step while the dashboard is open. */
export function startBoardSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  let timer: number | undefined;
  const kick = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void syncBoard(), 900);
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void syncBoard();
  };
  window.addEventListener(NUDGE, kick);
  window.addEventListener('online', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  const interval = window.setInterval(onVisible, 60_000);
  void syncBoard();
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener(NUDGE, kick);
    window.removeEventListener('online', onVisible);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(interval);
  };
}
