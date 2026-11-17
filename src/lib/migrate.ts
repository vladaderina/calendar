// Bring existing data into the "one blank note per page" model, and make sure
// that NOTHING the user already has becomes invisible.
//
// Runs on every dashboard mount. It is written to be idempotent: while
// localStorage was full even writing a "done" flag threw, so the flag is a hint,
// not a guarantee.
//
//  1. A page document that still has the old block lines becomes a Markdown note
//     (`doc.md`) — text lines as paragraphs, checkboxes with their day, stickers
//     as quotes, and every task already filed to the page as a checklist line.
//  2. A task filed to something that cannot show it (a category, a folder, or
//     nothing) is pulled into a page of its own and written as a checklist line,
//     so it is visible in the dashboard again.
//  3. Duplicate auto pages left by the earlier half-failed migrations collapse
//     into one.
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
} from './board';
import { legacyToMarkdown, linedTitles, nodeKeyParts, tasksOnPage } from './doc';
import { plain } from './md';
import { pathKey, type BlockKind, type TreeNode } from './tree';

/** New key on purpose: the old `calendar.pages.migrated.v1` flag was written by
 *  the block-based model, and this pass must run once more. */
const FLAG_KEY = 'calendar.notes.v1';
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

/** The page (document) of a container, created when there is none. */
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

/** Markdown of a document, with every task of the page represented by a line. */
function buildMarkdown(docId: string, sphere: string, path: string[]): string {
  const doc = getBoardDoc(docId);
  if (!doc) return '';
  const tasks = tasksOnPage(store.getTasks(), sphere, path);
  const stickers = getBoardNotes().filter((note) => note.nodeKey === doc.nodeKey);
  const base = typeof doc.md === 'string' && doc.md.trim() ? doc.md : legacyToMarkdown(doc, stickers, tasks);
  const lined = linedTitles(base);
  const missing = tasks.filter((task) => !lined.has(plain(task.title).toLowerCase()));
  if (!missing.length) return base;
  const tail = missing
    .map((task) => `- [${task.completed ? 'x' : ' '}] ${plain(task.title)}${task.startDate ? ` ^${task.startDate}` : ''}`)
    .join('\n');
  const body = base.replace(/\s+$/, '');
  return body ? `${body}\n\n${tail}\n` : `${tail}\n`;
}

/** Legacy blocks that sat on a category/folder: their tasks (and any stickers or
 *  pictures) move into a page of that container. */
function upgradeContainers(): void {
  const tree = store.getTree();
  const visit = (sphere: string, path: string[], blocks: BlockKind[], children: TreeNode[]): void => {
    if (blocks.length) {
      const key = nodeKeyOf(sphere, path);
      const direct = store.getTasks().filter((task) => task.sphere === sphere
        && (path.length ? (task.topic ?? '') === pathKey(path) : !task.topic));
      const hasStuff = direct.length > 0
        || blocks.includes('moodboard')
        || blocks.includes('notes')
        || attachmentsUnder(key);
      if (hasStuff) {
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

/** Every page gets its Markdown. */
function upgradeDocs(): void {
  // 1. Documents → Markdown.
  for (const doc of getBoardDocs()) {
    const { sphere, path } = nodeKeyParts(doc.nodeKey);
    if (!sphere || !path.length) continue;
    const md = buildMarkdown(doc.id, sphere, path);
    if (md !== (doc.md ?? '')) saveBoardDoc(doc.id, { md });
  }

  // 2. Tasks on a folder (or nowhere) must land on a page — but only while the
  // model is being upgraded. Doing it on EVERY mount would resurrect a page the
  // user has just deleted, because its tasks (deliberately kept) would look
  // homeless again: deleting a page must feel like deleting it.
  if (!flagSet()) collectTasks();
  collapseAutoPages();
}

/** Pull every task that has no page into the page of its container. */
export function collectTasks(sphereFilter?: string): void {
  for (const task of store.getTasks()) {
    const sphere = task.sphere;
    if (!sphere || (sphereFilter && sphere !== sphereFilter)) continue;
    const parts = task.topic ? task.topic.split(SEP) : [];
    const onPage = parts.length
      ? getBoardDocs().some((doc) => doc.nodeKey === nodeKeyOf(sphere, parts))
      : false;
    if (onPage) continue;
    const target = ensurePage(sphere, parts);
    if (!target) continue;
    const key = nodeKeyOf(sphere, target.path);
    const doc = getBoardDocs().find((item) => item.nodeKey === key);
    if (!doc) continue;
    const md = buildMarkdown(doc.id, sphere, target.path);
    if (!linedTitles(md).has(plain(task.title).toLowerCase())) {
      const body = md.replace(/\s+$/, '');
      saveBoardDoc(doc.id, {
        md: `${body ? `${body}\n\n` : ''}- [${task.completed ? 'x' : ' '}] ${plain(task.title)}${task.startDate ? ` ^${task.startDate}` : ''}\n`,
      });
    }
    store.update(task.id, { topic: pathKey(target.path) });
  }
}

/** Append the tasks filed directly to a container into its page (creating the
 *  page when the container has none). Used by the «собрать в страницу» button:
 *  deleting a page keeps its tasks, and this is how they come back. */
export function adoptContainerTasks(sphere: string, path: string[]): void {
  const key = pathKey(path);
  const tasks = store.getTasks().filter((task) => task.sphere === sphere && (task.topic ?? '') === key);
  if (!tasks.length) return;
  const target = ensurePage(sphere, path);
  if (!target) return;
  const pageKey = nodeKeyOf(sphere, target.path);
  const doc = getBoardDocs().find((item) => item.nodeKey === pageKey);
  if (!doc) return;
  let md = buildMarkdown(doc.id, sphere, target.path);
  for (const task of tasks) {
    if (linedTitles(md).has(plain(task.title).toLowerCase())) continue;
    const body = md.replace(/\s+$/, '');
    md = `${body ? `${body}\n\n` : ''}- [${task.completed ? 'x' : ' '}] ${plain(task.title)}${task.startDate ? ` ^${task.startDate}` : ''}\n`;
  }
  saveBoardDoc(doc.id, { md });
  for (const task of tasks) store.update(task.id, { topic: pathKey(target.path) });
}

/** Collapse duplicate auto pages of the same container. */
function collapseAutoPages(): void {
  const spheres = store.getSpheres();
  for (const sphere of spheres) {
    const groups = new Map<string, { path: string[]; node: TreeNode }[]>();
    for (const page of pagesOf(sphere)) {
      if (!AUTO_PAGE.test(page.path[page.path.length - 1])) continue;
      const doc = page.node.noteId ? getBoardDoc(page.node.noteId) : null;
      if (doc?.md && doc.md.trim()) continue;
      if (attachmentsUnder(nodeKeyOf(sphere, page.path))) continue;
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