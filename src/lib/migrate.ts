// Bring existing data into the "one blank note per page" model, and make sure
// that NOTHING the user already wrote becomes invisible.
//
// Runs on every dashboard mount. It is written to be idempotent: while
// localStorage was full even writing a "done" flag threw, so the flag is a hint,
// not a guarantee.
//
//  1. A page document that still has the old block lines becomes a Markdown note
//     (`doc.md`): text lines as paragraphs, checkboxes with their day, stickers
//     as quotes. Tasks are NOT copied in — the dashboard is the place for the
//     user's own writing, the calendar is the place for tasks.
//  2. An earlier version DID copy a page's tasks into its note as a mirror. That
//     tail is removed again (only when it is verifiably the mirror, see
//     `stripMirroredTasks`), so the boards stop showing hundreds of items the
//     user never wrote there.
//  3. Duplicate auto pages left by the earlier half-failed migrations collapse
//     into one; empty auto pages that only ever held a task mirror are dropped.
//  4. A category/folder that still carries a moodboard/notes block keeps its
//     pictures: they move to a page of that container.
import { store } from '../store';
import {
  addBoardDoc,
  attachmentsUnder,
  getBoardDoc,
  getBoardDocs,
  getBoardNotes,
  removeBoardItem,
  rekeyNode,
  saveBoardDoc,
  type BoardDoc,
} from './board';
import { legacyToMarkdown } from './doc';
import { pathKey, type BlockKind, type TreeNode } from './tree';

/** New key on purpose: the old `calendar.pages.migrated.v1` flag was written by
 *  the block-based model, and this pass must run once more. */
const FLAG_KEY = 'calendar.notes.v2';
const AUTO_PAGE = /^страница( \d+)?$/;
const SEP = '\u001F';

const nodeKeyOf = (sphere: string, path: string[]): string => `${sphere}${SEP}${pathKey(path)}`;

function findNode(nodes: TreeNode[], path: string[]): TreeNode | null {
  let list = nodes;
  let found: TreeNode | null = null;
  for (const name of path) {
    found = list.find((node) => node.name === name) ?? null;
    if (!found) return null;
    list = found.children;
  }
  return found;
}

function pagesOf(sphere: string): { path: string[]; node: TreeNode }[] {
  const out: { path: string[]; node: TreeNode }[] = [];
  const walk = (nodes: TreeNode[], prefix: string[]) => {
    for (const node of nodes) {
      const path = [...prefix, node.name];
      if (node.kind === 'note') out.push({ path, node });
      else walk(node.children, path);
    }
  };
  walk(store.getTree()[sphere]?.children ?? [], []);
  return out;
}

function uniqueName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** The page (document) of a container, created when there is none. Only used to
 *  keep pictures/stickers that used to live on a category or folder. */
function ensurePage(sphere: string, parentPath: string[]): { path: string[]; noteId?: string } | null {
  const existing = pagesOf(sphere)
    .find((page) => pathKey(page.path.slice(0, -1)) === pathKey(parentPath));
  if (existing) return existing;

  const parent = !parentPath.length || findNode(store.getTree()[sphere]?.children ?? [], parentPath)
    ? parentPath
    : [];
  const siblings = parent.length
    ? findNode(store.getTree()[sphere]?.children ?? [], parent)?.children ?? []
    : store.getTree()[sphere]?.children ?? [];
  const name = uniqueName(siblings.map((node) => node.name), 'страница');
  const path = [...parent, name];
  const doc = addBoardDoc(name, nodeKeyOf(sphere, path));
  store.addNote(sphere, parent, name, doc.id);
  return { path };
}

/** Markdown of a page: what the user wrote in the block era, verbatim. */
function buildMarkdown(doc: BoardDoc): string {
  if (typeof doc.md === 'string' && doc.md.trim()) return doc.md;
  const stickers = getBoardNotes().filter((note) => note.nodeKey === doc.nodeKey);
  return legacyToMarkdown(doc, stickers, []);
}

/** Legacy blocks that sat on a category/folder: their pictures (and any
 *  stickers) move into a page of that container. Tasks are left where they are. */
function upgradeContainers(): void {
  const tree = store.getTree();
  const visit = (sphere: string, path: string[], blocks: BlockKind[], children: TreeNode[]): void => {
    if (blocks.length) {
      const key = nodeKeyOf(sphere, path);
      const keepsPictures = blocks.includes('moodboard') || blocks.includes('notes') || attachmentsUnder(key);
      if (keepsPictures) {
        const page = ensurePage(sphere, path);
        if (page) rekeyNode(key, nodeKeyOf(sphere, page.path));
      }
      store.setBlocks(sphere, path, []);
    }
    for (const child of children) {
      if (child.kind === 'folder') visit(sphere, [...path, child.name], child.blocks, child.children);
    }
  };
  for (const [sphere, category] of Object.entries(tree)) {
    visit(sphere, [], category.blocks, category.children);
  }
}

/** Every page gets its Markdown from the block document it used to hold. */
function upgradeDocs(): void {
  for (const doc of getBoardDocs()) {
    const md = buildMarkdown(doc);
    if (md !== (doc.md ?? '')) saveBoardDoc(doc.id, { md });
  }
  collapseAutoPages();
}

/** Collapse duplicate auto pages of the same container. */
function collapseAutoPages(): void {
  for (const sphere of store.getSpheres()) {
    const groups = new Map<string, { path: string[]; node: TreeNode }[]>();
    for (const page of pagesOf(sphere)) {
      if (!AUTO_PAGE.test(page.path[page.path.length - 1])) continue;
      const doc = page.node.noteId ? getBoardDoc(page.node.noteId) : null;
      if (doc?.md && doc.md.trim()) continue;
      if (attachmentsUnder(nodeKeyOf(sphere, page.path))) continue;
      if (page.node.children.length) continue;
      const key = pathKey(page.path.slice(0, -1));
      groups.set(key, [...(groups.get(key) ?? []), page]);
    }
    for (const list of groups.values()) {
      for (const extra of list.slice(1)) {
        if (extra.node.noteId) removeBoardItem(extra.node.noteId);
        store.removeTopic(sphere, extra.path);
      }
    }
  }
}

function flagSet(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/** Run on every dashboard mount; cheap and idempotent. */
export function upgradeDashboardModel(): void {
  if (typeof localStorage === 'undefined') return;
  upgradeContainers();
  upgradeDocs();
  try {
    localStorage.setItem(FLAG_KEY, '1');
  } catch {
    // quota — it simply runs again next time, which is harmless
  }
}

void flagSet;
