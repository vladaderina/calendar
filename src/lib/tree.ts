// The dashboard's category tree: category (level 1) → folders (2, 3) and
// NOTES — files that sit inside a category or a folder, like Obsidian.
//
// Every node owns its own BLOCKS. A new category or folder starts EMPTY — the
// user adds "задачи", "заметки" or "мудборд" herself, which is what she asked
// for ("при создании новой категории или подкатегории по умолчанию там нет
// никаких блоков, их можно только добавить"). Only nodes migrated from the old
// flat topic list get a tasks block, so the existing categories do not look
// broken the day this ships.
//
// Tasks do NOT reference node ids: `task.topic` holds the NAMES of the path
// joined by U+001F. A single name is a path of length 1, so every task stored
// before this rework stays valid, and renaming a node rewrites the prefix of
// the paths under it.
import { v4 as uuid } from 'uuid';

export type BlockKind = 'tasks' | 'notes' | 'moodboard';

export const BLOCK_LABEL: Record<BlockKind, string> = {
  tasks: 'задачи',
  notes: 'стикеры',
  moodboard: 'мудборд',
};

/** Short hint under each block button in the "+ блок" menu. */
export const BLOCK_HINT: Record<BlockKind, string> = {
  tasks: 'список задач этой папки',
  notes: 'быстрые записи-карточки',
  moodboard: 'картинки и фото',
};

export type NodeKind = 'folder' | 'note';

export interface TreeNode {
  id: string;
  name: string;
  /**
 * `folder` — a container: nothing is written inside it, it only holds folders
 * and pages. `note` — a PAGE: the only place with content (checklist, blocks,
 * stickers, photos); it is always a leaf.
 */
  kind: NodeKind;
  blocks: BlockKind[];
  children: TreeNode[];
  /** For `kind === 'note'`: id of the document in `lib/board`. */
  noteId?: string;
}

export interface CategoryTree {
  /** Blocks of the category itself (the root of the tree = the category). */
  blocks: BlockKind[];
  children: TreeNode[];
}

export type Tree = Record<string, CategoryTree>;

/** Category = level 1, so two nested folders (and notes) fit under it. */
export const MAX_LEVEL = 3;

/** May a FOLDER be created inside a node at `path`? (category → folder → folder) */
export const canAddChild = (path: string[]): boolean => path.length + 1 <= MAX_LEVEL - 1;

/** May a PAGE be created inside a node at `path`? Pages are leaves, so they also
 *  fit into the last folders: category → folder → folder → page. A category
 *  itself only holds folders (the user's rule), so its pages come only from the
 *  legacy migration. */
export const canAddPage = (path: string[]): boolean => path.length + 1 <= MAX_LEVEL;

/** Categories (level 1) hold folders only; folders hold folders and pages. */
export const canHoldPages = (path: string[]): boolean => path.length >= 1;

const SEP = '\u001F';

export const pathKey = (path: string[]): string => path.join(SEP);

export const keyPath = (key?: string | null): string[] =>
  key ? key.split(SEP).map((part) => part.trim()).filter(Boolean) : [];

export const pathLabel = (path: string[]): string => path[path.length - 1] ?? '';

/** Does a task filed under `topicKey` belong to the node at `path`? */
export function inSubtree(topicKey: string | undefined, path: string[]): boolean {
  if (!path.length) return true;
  const prefix = pathKey(path);
  const key = topicKey ?? '';
  return key === prefix || key.startsWith(`${prefix}${SEP}`);
}

export const emptyCategory = (): CategoryTree => ({ blocks: [], children: [] });

export const newNode = (name: string, blocks: BlockKind[] = []): TreeNode => ({
  id: uuid(),
  name: name.trim(),
  kind: 'folder',
  blocks: [...blocks],
  children: [],
});

/** A page is a leaf: the title here, the checklist and the blocks inside the
 *  linked document. */
export const newNoteNode = (title: string, noteId: string, blocks: BlockKind[] = []): TreeNode => ({
  id: uuid(),
  name: title.trim(),
  kind: 'note',
  blocks: [...blocks],
  children: [],
  noteId,
});

export function isBlockKind(value: unknown): value is BlockKind {
  return value === 'tasks' || value === 'notes' || value === 'moodboard';
}

function normBlocks(raw: unknown, fallback: BlockKind[]): BlockKind[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out: BlockKind[] = [];
  for (const value of raw) {
    if (isBlockKind(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

function normNodes(raw: unknown, legacyBlocks: BlockKind[]): TreeNode[] {
  if (!Array.isArray(raw)) return [];
  const out: TreeNode[] = [];
  for (const item of raw) {
    const name = typeof item === 'string'
      ? item.trim()
      : (item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string'
        ? String((item as Record<string, unknown>).name).trim()
        : '');
    if (!name || out.some((node) => node.name === name)) continue;
    if (typeof item === 'string') {
      out.push({ id: uuid(), name, kind: 'folder', blocks: [...legacyBlocks], children: [] });
      continue;
    }
    const src = item as Record<string, unknown>;
    const kind: NodeKind = src.kind === 'note' ? 'note' : 'folder';
    out.push({
      id: typeof src.id === 'string' && src.id ? src.id : uuid(),
      name,
      kind,
      // A page owns blocks, a folder's blocks are legacy (migrated into a page).
      blocks: normBlocks(src.blocks, kind === 'note' ? [] : legacyBlocks),
      children: kind === 'note' ? [] : normNodes(src.children, legacyBlocks),
      noteId: kind === 'note' && typeof src.noteId === 'string' && src.noteId ? src.noteId : undefined,
    });
  }
  return out;
}

/**
 * Accept everything that has ever been stored: the old flat `{ sphere: [name] }`,
 * an array of node objects, and the current `{ sphere: { blocks, children } }`.
 */
export function normalizeTree(raw: unknown, legacyBlocks: BlockKind[] = ['tasks']): Tree {
  const out: Tree = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [sphere, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = sphere.trim();
    if (!name) continue;
    if (Array.isArray(value)) {
      out[name] = { blocks: [...legacyBlocks], children: normNodes(value, legacyBlocks) };
    } else if (value && typeof value === 'object') {
      const src = value as Record<string, unknown>;
      out[name] = {
        blocks: normBlocks(src.blocks, legacyBlocks),
        children: normNodes(src.children, legacyBlocks),
      };
    }
  }
  return out;
}

/** Flat list of every folder in a category, with its path (level order). */
export function flatten(nodes: TreeNode[], prefix: string[] = []): { path: string[]; node: TreeNode }[] {
  const out: { path: string[]; node: TreeNode }[] = [];
  for (const node of nodes) {
    const path = [...prefix, node.name];
    out.push({ path, node });
    out.push(...flatten(node.children, path));
  }
  return out;
}

export function nodeAt(nodes: TreeNode[], path: string[]): TreeNode | null {
  if (!path.length) return null;
  let list = nodes;
  let found: TreeNode | null = null;
  for (const name of path) {
    found = list.find((node) => node.name === name) ?? null;
    if (!found) return null;
    list = found.children;
  }
  return found;
}

export function mapNode(nodes: TreeNode[], path: string[], fn: (node: TreeNode) => TreeNode): TreeNode[] {
  if (!path.length) return nodes;
  const [head, ...rest] = path;
  return nodes.map((node) => {
    if (node.name !== head) return node;
    return rest.length ? { ...node, children: mapNode(node.children, rest, fn) } : fn(node);
  });
}

export function insertNode(nodes: TreeNode[], parentPath: string[], child: TreeNode): TreeNode[] {
  if (!parentPath.length) return [...nodes, child];
  return mapNode(nodes, parentPath, (node) => ({ ...node, children: [...node.children, child] }));
}

export function removeNodeAt(nodes: TreeNode[], path: string[]): TreeNode[] {
  if (!path.length) return nodes;
  const [head, ...rest] = path;
  return nodes
    .filter((node) => !(node.name === head && !rest.length))
    .map((node) => (node.name === head ? { ...node, children: removeNodeAt(node.children, rest) } : node));
}

export function reorderLevel(nodes: TreeNode[], parentPath: string[], orderedIds: string[]): TreeNode[] {
  const apply = (list: TreeNode[]): TreeNode[] => {
    const byId = new Map(list.map((node) => [node.id, node]));
    const next = orderedIds.map((id) => byId.get(id)).filter((node): node is TreeNode => !!node);
    // Only a complete permutation is a reorder; anything else is ignored.
    if (next.length !== list.length) return list;
    return next;
  };
  if (!parentPath.length) return apply(nodes);
  return mapNode(nodes, parentPath, (node) => ({ ...node, children: apply(node.children) }));
}

/** Rewrite the name prefix of every path under (and including) `from`. */
export function renamePrefix(topicKey: string | undefined, from: string[], to: string[]): string | undefined {
  if (!topicKey) return topicKey;
  const parts = keyPath(topicKey);
  if (from.length > parts.length) return topicKey;
  for (let i = 0; i < from.length; i++) {
    if (parts[i] !== from[i]) return topicKey;
  }
  return pathKey([...to, ...parts.slice(from.length)]);
}

function mergeNodes(base: TreeNode[], extra: TreeNode[]): TreeNode[] {
  const out = [...base];
  for (const node of extra) {
    const at = out.findIndex((candidate) => candidate.name === node.name);
    if (at < 0) {
      out.push(node);
      continue;
    }
    const blocks = [...out[at].blocks];
    for (const block of node.blocks) if (!blocks.includes(block)) blocks.push(block);
    out[at] = { ...out[at], blocks, children: mergeNodes(out[at].children, node.children) };
  }
  return out;
}

/** Union of two trees, per category and per folder — a backup or a fetch must
 *  never wipe folders/blocks the other device has. */
export function mergeTree(base: Tree, extra: Tree): Tree {
  const out: Tree = { ...base };
  for (const [sphere, category] of Object.entries(extra)) {
    const cur = out[sphere];
    if (!cur) {
      out[sphere] = category;
      continue;
    }
    const blocks = [...cur.blocks];
    for (const block of category.blocks) if (!blocks.includes(block)) blocks.push(block);
    out[sphere] = { blocks, children: mergeNodes(cur.children, category.children) };
  }
  return out;
}

/** A path is valid when every level exists and it is not deeper than allowed. */
export function pathExists(tree: Tree, sphere: string, path: string[]): boolean {
  if (!sphere || path.length > MAX_LEVEL - 1) return false;
  if (!path.length) return !!tree[sphere];
  return nodeAt(tree[sphere]?.children ?? [], path) !== null;
}
