// Upgrade the dashboard to the "category → folder → page" model, and keep every
// task reachable afterwards.
//
// Two jobs, both idempotent (they are cheap enough to run on every dashboard
// mount, and the flag cannot be trusted: while localStorage was full — the
// moodboard pictures filled it — even writing the flag threw):
//
//  1. BLOCKS: a category/folder that still holds blocks of its own gets a page
//     which inherits the blocks, the stickers/pictures and the tasks filed
//     directly to the container. Containers never show blocks again.
//  2. REPAIR: pages created by earlier failed runs are collapsed into one, every
//     task is filed to a page (never to a folder), and every page holding tasks
//     gets a tasks block — a task with nowhere to show reads to the user as
//     "задачи потерялись".
import { store } from '../store';
import {
  addBoardDoc,
  attachmentCounts,
  attachmentsUnder,
  getBoardDoc,
  removeBoardItem,
  rekeyNode,
} from './board';
import { keyPath, pathKey, type BlockKind, type TreeNode, type Tree } from './tree';

const FLAG_KEY = 'calendar.pages.migrated.v1';
const AUTO_PAGE = /^страница( \d+)?$/;

interface PageRef {
  path: string[];
  node: TreeNode;
}

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

function pagesOf(tree: Tree, sphere: string): PageRef[] {
  const out: PageRef[] = [];
  const walk = (nodes: TreeNode[], prefix: string[]): void => {
    for (const node of nodes) {
      const path = [...prefix, node.name];
      if (node.kind === 'note') out.push({ path, node });
      else walk(node.children, path);
    }
  };
  walk(tree[sphere]?.children ?? [], []);
  return out;
}

function nodeKeyOf(sphere: string, path: string[]): string {
  return `${sphere}\u001F${pathKey(path)}`;
}

function uniqueName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function siblingNames(sphere: string, parentPath: string[]): string[] {
  const tree = store.getTree();
  if (!parentPath.length) return (tree[sphere]?.children ?? []).map((node) => node.name);
  const parent = findNode(tree[sphere]?.children ?? [], parentPath);
  return (parent?.children ?? []).map((node) => node.name);
}

/** A page the migration itself made: an auto name, an empty document, no
 *  stickers/pictures of its own and at most a tasks block. */
function isAutoEmptyPage(sphere: string, page: PageRef): boolean {
  if (!AUTO_PAGE.test(page.path[page.path.length - 1])) return false;
  const doc = page.node.noteId ? getBoardDoc(page.node.noteId) : null;
  if (doc && doc.blocks.some((block) => block.text.trim())) return false;
  // Stickers/pictures only: the page's own document lives under this key too.
  if (attachmentsUnder(nodeKeyOf(sphere, page.path))) return false;
  return page.node.blocks.every((block) => block === 'tasks');
}

/** The page of a container, creating «страница» when it has none. */
function ensurePage(sphere: string, parentPath: string[]): PageRef | null {
  const tree = store.getTree();
  const parent = !parentPath.length || findNode(tree[sphere]?.children ?? [], parentPath)
    ? parentPath
    : [];
  const existing = pagesOf(store.getTree(), sphere)
    .find((page) => pathKey(page.path.slice(0, -1)) === pathKey(parent));
  if (existing) return existing;
  const name = uniqueName(siblingNames(sphere, parent), 'страница');
  const pagePath = [...parent, name];
  const doc = addBoardDoc(name, nodeKeyOf(sphere, pagePath));
  store.addNote(sphere, parent, name, doc.id);
  const node = findNode(store.getTree()[sphere]?.children ?? [], pagePath);
  return node ? { path: pagePath, node } : null;
}

/** Add blocks to a page by reading its CURRENT state — `PageRef.node` is a
 *  snapshot, and writing [...snapshot.blocks, x] would drop blocks added moments
 *  ago by another step. */
function addBlocks(sphere: string, path: string[], add: BlockKind[]): void {
  const node = findNode(store.getTree()[sphere]?.children ?? [], path);
  if (!node) return;
  const next = [...node.blocks];
  let changed = false;
  for (const block of add) {
    if (!next.includes(block)) {
      next.push(block);
      changed = true;
    }
  }
  if (changed) store.setBlocks(sphere, path, next);
}

function ensureTasksBlock(sphere: string, page: PageRef): void {
  addBlocks(sphere, page.path, ['tasks']);
}

/** A page that keeps pictures or stickers must also SHOW them: the blocks are
 *  what render them, and a page without the block looks empty. */
function ensureAttachmentBlocks(sphere: string, page: PageRef): void {
  const counts = attachmentCounts(nodeKeyOf(sphere, page.path));
  const want: BlockKind[] = [];
  if (counts.photos) want.push('moodboard');
  if (counts.notes) want.push('notes');
  if (want.length) addBlocks(sphere, page.path, want);
}

/** Move the blocks of every container into a page of its own. */
function upgradeBlocks(): void {
  const tree = store.getTree();
  const tasks = store.getTasks();
  let created = 0;

  const visit = (sphere: string, path: string[], blocks: BlockKind[], children: TreeNode[]): void => {
    if (blocks.length) {
      const key = nodeKeyOf(sphere, path);
      const direct = tasks.filter((task) => task.sphere === sphere
        && (path.length ? task.topic === pathKey(path) : !task.topic));
      const worthAPage = direct.length > 0
        || blocks.includes('notes')
        || blocks.includes('moodboard')
        || attachmentsUnder(key);
      if (worthAPage) {
        const page = ensurePage(sphere, path);
        if (page) {
          // Stickers/pictures move first: only the fresh page document then
          // sits under the new key (rekey would re-prefix it otherwise).
          if (attachmentsUnder(key)) rekeyNode(key, nodeKeyOf(sphere, page.path));
          addBlocks(sphere, page.path, blocks);
          for (const task of direct) store.update(task.id, { topic: pathKey(page.path) });
          created++;
        }
      }
      // A container never shows blocks again, with or without a page.
      store.setBlocks(sphere, path, []);
    }
    for (const child of children) {
      if (child.kind === 'folder') visit(sphere, [...path, child.name], child.blocks, child.children);
    }
  };

  for (const [sphere, category] of Object.entries(tree)) {
    visit(sphere, [], category.blocks, category.children);
  }
  if (created) console.info(`[pages] ${created} container(s) now keep their blocks in a page`);
}

/** Collapse duplicate auto pages and make sure no task is filed to something
 *  that cannot show it. */
function repairPages(): void {
  const tree = store.getTree();
  for (const sphere of Object.keys(tree)) {
    // 1. One auto page per container is enough (earlier runs created several).
    const groups = new Map<string, PageRef[]>();
    for (const page of pagesOf(tree, sphere)) {
      if (!isAutoEmptyPage(sphere, page)) continue;
      const key = pathKey(page.path.slice(0, -1));
      groups.set(key, [...(groups.get(key) ?? []), page]);
    }
    for (const list of groups.values()) {
      for (const extra of list.slice(1)) {
        if (extra.node.noteId) removeBoardItem(extra.node.noteId);
        store.removeTopic(sphere, extra.path);
      }
    }

    const fresh = pagesOf(store.getTree(), sphere);

    // 2. Pictures/stickers must stay visible on their page.
    for (const page of fresh) ensureAttachmentBlocks(sphere, page);

    // 3. Every task must point at a page.
    for (const task of store.getTasks()) {
      if (task.sphere !== sphere) continue;
      const parts = keyPath(task.topic);
      const onPage = fresh.find((page) => pathKey(page.path) === pathKey(parts));
      if (onPage) {
        ensureTasksBlock(sphere, onPage);
        continue;
      }
      // The topic names a folder (or nothing at all): file it into that
      // folder's page, creating one when needed.
      const inFolder = fresh.find((page) => pathKey(page.path.slice(0, -1)) === pathKey(parts));
      const target = inFolder ?? ensurePage(sphere, parts);
      if (!target) continue;
      store.update(task.id, { topic: pathKey(target.path) });
      ensureTasksBlock(sphere, target);
    }
  }
}

/** Run on every dashboard mount: both halves are idempotent and cheap. */
export function upgradeDashboardModel(): void {
  if (typeof localStorage === 'undefined') return;
  upgradeBlocks();
  repairPages();
  try {
    localStorage.setItem(FLAG_KEY, '1');
  } catch {
    // quota — it simply runs again next time, which is harmless
  }
}
