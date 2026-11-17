// One-time migration to the "category → folder → page" model.
//
// Until now a category or a folder could hold blocks (задачи/стикеры/мудборд)
// itself. The rule is now: containers hold nothing — only a PAGE has content.
// Rather than hide the existing blocks (the user's tasks would look lost), every
// container that still has blocks AND something in them gets a «страница» child
// which inherits the blocks, the stickers/pictures and the tasks filed directly
// to the container. Containers with an empty block list just drop the block.
import { store } from '../store';
import { addBoardDoc, itemsUnderKey, rekeyNode } from './board';
import { pathKey, type BlockKind, type TreeNode } from './tree';

const FLAG_KEY = 'calendar.pages.migrated.v1';

function uniqueName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function migrateBlocksToPages(): void {
  if (typeof localStorage === 'undefined') return;
  if (localStorage.getItem(FLAG_KEY)) return;

  const tree = store.getTree();
  const tasks = store.getTasks();
  let created = 0;

  const visit = (sphere: string, path: string[], blocks: BlockKind[], children: TreeNode[]): void => {
    const key = `${sphere}\u001F${pathKey(path)}`;
    const pathKeyValue = pathKey(path);
    // Tasks filed directly to this container (category: no topic at all).
    const direct = tasks.filter((task) => task.sphere === sphere
      && (path.length ? task.topic === pathKeyValue : !task.topic));

    if (blocks.length) {
      const worthAPage = direct.length > 0
        || blocks.includes('notes')
        || blocks.includes('moodboard')
        || itemsUnderKey(key);
      if (worthAPage) {
        const name = uniqueName(children.map((child) => child.name), 'страница');
        const pagePath = [...path, name];
        const pageKey = `${sphere}\u001F${pathKey(pagePath)}`;
        // Stickers/pictures move first, so only the new page document remains
        // to be written under the new key.
        rekeyNode(key, pageKey);
        const doc = addBoardDoc(name, pageKey);
        store.addNote(sphere, path, name, doc.id);
        store.setBlocks(sphere, pagePath, blocks);
        for (const task of direct) store.update(task.id, { topic: pathKey(pagePath) });
        created++;
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

  localStorage.setItem(FLAG_KEY, '1');
  if (created) console.info(`[migrate] ${created} page(s) created from legacy blocks`);
}
