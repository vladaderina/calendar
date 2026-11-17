// Moodboard + dashboard notes.
//
// Three kinds of entries live here, all belonging to the DASHBOARD only:
//   • photo — a picture for the moodboard (stored as a data URL, already
//     downscaled by `lib/image.ts`), with an optional caption;
//   • note  — a short sticky card in the «стикеры» block;
//   • doc   — a real note-document (title + checklist), shown as a file in the
//     category tree. Checklist lines may be planned to a day: that creates an
//     ordinary Task, so the existing day/week planner does the scheduling.
//
// They are deliberately NOT tasks themselves: none of them is counted in a task
// list, appears on the wheel or in the planner.
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
  /** Which dashboard node (category/folder) this picture belongs to. */
  nodeKey: string;
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
  /** Which dashboard node (category/folder) this note belongs to. */
  nodeKey: string;
  /** Creation time — the list order is stable across edits. */
  born: number;
  t: number;
  deleted?: boolean;
}

export interface DocBlock {
  id: string;
  kind: 'text' | 'check';
  text: string;
  /** Checklist state. A planned line is also done when its task is done. */
  done?: boolean;
  /** Task created by planning this line to a day (`startDate = endDate = date`). */
  taskId?: string;
  /** yyyy-MM-dd chosen for this line. */
  date?: string;
}

/** A note-document: what the tree shows as a note file. */
export interface BoardDoc {
  id: string;
  kind: 'doc';
  title: string;
  blocks: DocBlock[];
  nodeKey: string;
  born: number;
  t: number;
  deleted?: boolean;
}

export type BoardItem = BoardPhoto | BoardNote | BoardDoc;

type Store = Record<string, BoardItem>;

function isPhoto(item: BoardItem): item is BoardPhoto {
  return item.kind === 'photo';
}

function sanitizeBlocks(raw: unknown): DocBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: DocBlock[] = [];
  for (const item of raw.slice(0, 4000)) {
    if (!item || typeof item !== 'object') continue;
    const src = item as Record<string, unknown>;
    const check = src.kind === 'check';
    out.push({
      id: typeof src.id === 'string' && src.id ? src.id : uuid(),
      kind: check ? 'check' : 'text',
      text: typeof src.text === 'string' ? src.text : '',
      done: check && src.done === true ? true : undefined,
      taskId: typeof src.taskId === 'string' && src.taskId ? src.taskId : undefined,
      date: typeof src.date === 'string' ? src.date : undefined,
    });
  }
  return out;
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
      nodeKey: typeof src.nodeKey === 'string' ? src.nodeKey : '',
      born: Number(src.born) || t,
      t,
      deleted,
    };
  }
  if (src.kind === 'doc') {
    const title = typeof src.title === 'string' ? src.title : '';
    const blocks = sanitizeBlocks(src.blocks);
    if (!title.trim() && !blocks.length && !deleted) return null;
    return {
      id,
      kind: 'doc',
      title,
      blocks,
      nodeKey: typeof src.nodeKey === 'string' ? src.nodeKey : '',
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
      nodeKey: typeof src.nodeKey === 'string' ? src.nodeKey : '',
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
let docsSnapshot: BoardDoc[] = [];

function rebuild(): void {
  const all = Object.values(items).filter((item) => !item.deleted);
  photosSnapshot = all.filter(isPhoto).sort((a, b) => a.born - b.born);
  notesSnapshot = all
    .filter((item) => item.kind === 'note')
    .sort((a, b) => a.born - b.born) as BoardNote[];
  docsSnapshot = all
    .filter((item) => item.kind === 'doc')
    .sort((a, b) => a.born - b.born) as BoardDoc[];
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

export function useBoardDocs(): BoardDoc[] {
  return useSyncExternalStore(subscribe, () => docsSnapshot, () => docsSnapshot);
}

export function getBoardDoc(id: string | undefined): BoardDoc | null {
  if (!id) return null;
  const item = items[id];
  return item && item.kind === 'doc' && !item.deleted ? item : null;
}

export type AddResult = { ok: true } | { ok: false; message: string };

export function addBoardPhoto(data: string, caption = '', nodeKey = ''): AddResult {
  const id = uuid();
  const now = Date.now();
  items[id] = { id, kind: 'photo', data, caption, nodeKey, born: now, t: now };
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

export function addBoardNote(text: string, color = NOTE_COLORS[0], nodeKey = ''): BoardNote | null {
  const value = text.trim();
  if (!value) return null;
  const id = uuid();
  const now = Date.now();
  const note: BoardNote = { id, kind: 'note', text: value, color, nodeKey, born: now, t: now };
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

/** Create an empty note-document — the file the tree shows as a note. */
export function addBoardDoc(title: string, nodeKey = ''): BoardDoc {
  const id = uuid();
  const now = Date.now();
  const doc: BoardDoc = {
    id,
    kind: 'doc',
    title: title.trim() || 'без названия',
    blocks: [],
    nodeKey,
    born: now,
    t: now,
  };
  items[id] = doc;
  persist();
  return doc;
}

let docTimer: number | undefined;

/** Typing in a note must not rewrite the whole map (photos included) on every
 *  keystroke: update memory and re-render now, write localStorage a moment later. */
function persistSoon(): void {
  rebuild();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT));
  window.clearTimeout(docTimer);
  docTimer = window.setTimeout(() => {
    docTimer = undefined;
    persist();
  }, 600);
}

export function saveBoardDoc(id: string, patch: { title?: string; blocks?: DocBlock[] }): void {
  const cur = items[id];
  if (!cur || cur.kind !== 'doc' || cur.deleted) return;
  items[id] = {
    ...cur,
    title: patch.title !== undefined ? patch.title : cur.title,
    blocks: patch.blocks ?? cur.blocks,
    t: Date.now(),
  };
  persistSoon();
}

/** Write a pending debounced note change right now (blur / page hide). */
export function flushBoard(): void {
  if (docTimer === undefined) return;
  window.clearTimeout(docTimer);
  docTimer = undefined;
  persist();
}

/** Does any sticker/picture/page-document live under this node key? */
export function itemsUnderKey(nodeKey: string): boolean {
  if (!nodeKey) return false;
  const prefix = nodeKey.endsWith('\u001F') ? nodeKey : `${nodeKey}\u001F`;
  return Object.values(items).some((item) => !item.deleted && !!item.nodeKey
    && (item.nodeKey === nodeKey || item.nodeKey.startsWith(prefix)));
}

/** Tombstone the note-documents that lived inside a deleted folder: their tree
 *  nodes are gone, tasks they planned to a day stay (they are real tasks). */
export function removeDocsUnder(nodeKey: string): void {
  if (!nodeKey) return;
  // A category key already ends with the separator, a folder key does not.
  const prefix = nodeKey.endsWith('\u001F') ? nodeKey : `${nodeKey}\u001F`;
  let changed = false;
  for (const item of Object.values(items)) {
    if (item.deleted || item.kind !== 'doc') continue;
    if (item.nodeKey === nodeKey || item.nodeKey.startsWith(prefix)) {
      items[item.id] = { ...item, blocks: [], deleted: true, t: Date.now() };
      changed = true;
    }
  }
  if (changed) persist();
}

/** Tombstone, never a plain delete: the other device may still hold the entry. */
export function removeBoardItem(id: string): void {
  const cur = items[id];
  if (!cur) return;
  if (cur.kind === 'photo') {
    items[id] = { ...cur, data: '', deleted: true, t: Date.now() };
  } else if (cur.kind === 'doc') {
    items[id] = { ...cur, blocks: [], deleted: true, t: Date.now() };
  } else {
    items[id] = { ...cur, text: '', deleted: true, t: Date.now() };
  }
  persist();
}

/** One-time migration: entries created before the dashboard had nodes carry no
 *  `nodeKey`. Attach them to a node instead of letting them vanish. */
export function claimOrphans(nodeKey: string): void {
  if (!nodeKey) return;
  let changed = false;
  for (const item of Object.values(items)) {
    if (item.deleted || item.nodeKey) continue;
    items[item.id] = { ...item, nodeKey, t: Date.now() };
    changed = true;
  }
  if (changed) persist();
}

/** Move the content of a deleted folder up into its parent (or the category),
 *  so notes and pictures do not become invisible when the folder goes away. */
export function rekeyNode(fromKey: string, toKey: string): void {
  if (!fromKey || fromKey === toKey) return;
  const prefix = `${fromKey}\u001F`;
  let changed = false;
  for (const item of Object.values(items)) {
    if (item.deleted || !item.nodeKey) continue;
    if (item.nodeKey === fromKey) {
      items[item.id] = { ...item, nodeKey: toKey, t: Date.now() };
      changed = true;
    } else if (item.nodeKey.startsWith(prefix)) {
      items[item.id] = { ...item, nodeKey: `${toKey}${item.nodeKey.slice(fromKey.length)}`, t: Date.now() };
      changed = true;
    }
  }
  if (changed) persist();
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
    ? { data: item.data, caption: item.caption, born: item.born, nodeKey: item.nodeKey }
    : item.kind === 'doc'
      ? { title: item.title, blocks: item.blocks, born: item.born, nodeKey: item.nodeKey }
      : { text: item.text, color: item.color, born: item.born, nodeKey: item.nodeKey };
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
      nodeKey: typeof payload.nodeKey === 'string' ? payload.nodeKey : '',
      born: Number(payload.born) || undefined,
    });
  }
  if (row.kind === 'doc') {
    return sanitize(base.id, {
      ...base,
      kind: 'doc',
      title: typeof payload.title === 'string' ? payload.title : '',
      blocks: payload.blocks,
      nodeKey: typeof payload.nodeKey === 'string' ? payload.nodeKey : '',
      born: Number(payload.born) || undefined,
    });
  }
  if (row.kind === 'note') {
    return sanitize(base.id, {
      ...base,
      kind: 'note',
      text: typeof payload.text === 'string' ? payload.text : '',
      color: typeof payload.color === 'string' ? payload.color : NOTE_COLORS[0],
      nodeKey: typeof payload.nodeKey === 'string' ? payload.nodeKey : '',
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
  const onHide = () => flushBoard();
  window.addEventListener(NUDGE, kick);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('online', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  const interval = window.setInterval(onVisible, 60_000);
  void syncBoard();
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener(NUDGE, kick);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('online', onVisible);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(interval);
  };
}
