// End-to-end test of the category (sphere) sync rules in src/store.ts against
// an in-memory PostgREST stand-in. Runs the REAL store module — the same code
// the browser runs — so "the category came back" is reproduced or not on the
// actual sync path, not on a copy of it.
//
//   npm run test:sync            (vite build test config + node test/run.mjs)
import { start, state, USER_ID } from './mock-server.mjs';

const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok   ${label}`); return; }
  console.log(`  FAIL ${label}\n        expected ${e}\n        actual   ${a}`);
  failures.push(label);
}
const names = () => state.spheres.map((r) => r.name).sort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Browser-ish globals the store touches at import time ──────────────────
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

const server = await start(4599);
const mod = await import('./dist/store.mjs');
const store = mod.store;
const spheres = () => JSON.parse(mod.buildBackupJson()).spheres;
const settle = async (ms = 700) => { await sleep(ms); };

const signed = await mod.signInWithPassword('test@example.com', 'secret123');
if (!signed.ok) { console.log('sign-in failed:', signed); process.exit(1); }
await mod.initAuth();

console.log('\n1. rename keeps one category (old row must be deleted)');
store.addSphere('Работа');
await settle();
check('server rows before rename', names(), ['Работа']);
store.renameSphere('Работа', 'Служба');
await settle();
check('server rows after rename', names(), ['Служба']);
await mod.pullFromServer();
check('local after rename + pull', spheres().sort(), ['Служба']);

console.log('\n2. deleted category is not resurrected by a stale device');
store.removeSphere('Служба');
await settle();
check('server rows after delete', names(), []);
await mod.pullFromServer();
check('local stays empty after pull', spheres(), []);

// A stale tab/device re-uploads its old list after our DELETE landed.
state.spheres.push({ user_id: USER_ID, name: 'Служба', order: 0 });
console.log('   (stale device re-uploaded "Служба")');
await mod.pullFromServer();
check('local ignores the resurrected row', spheres(), []);
await settle(1200);
check('server re-deleted the resurrected row', names(), []);

console.log('\n3. new category with the same name is not deleted again');
store.addSphere('Служба');
await settle();
check('server rows after re-create', names(), ['Служба']);
await mod.pullFromServer();
check('local after re-create + pull', spheres(), ['Служба']);

console.log('\n4. rename onto an existing category merges instead of duplicating');
store.addSphere('Личное');
await settle();
store.renameSphere('Личное', 'Служба');
await settle();
check('server rows after merge-rename', names(), ['Служба']);
check('local has no duplicate', spheres(), ['Служба']);
await mod.pullFromServer();
check('local after merge-rename + pull', spheres(), ['Служба']);

console.log('\n5. a normal second category still syncs');
store.addSphere('Дом');
await settle();
check('server rows', names(), ['Дом', 'Служба']);
await mod.pullFromServer();
check('local after pull', spheres().sort(), ['Дом', 'Служба']);

console.log('\n6. the dashboard tree is never derived from tasks');
store.addSphere('Автоматизация');
await settle();
store.add({ title: 'Домашний сервер', sphere: 'Автоматизация', topic: 'Здоровье', unplanned: true });
await settle();
// History: a task whose `topic` had no tab used to create a folder, which put
// surprise folders/pages next to the real ones on the dashboard. The tree is
// now exactly what the user made.
check('a task topic makes no folder', store.getTopics()['Автоматизация'], []);
await mod.pullFromServer();
check('a pull makes no folder either', store.getTopics()['Автоматизация'], []);
// A folder the user creates is kept across a pull, and deleting it stays deleted.
store.addTopic('Автоматизация', 'Здоровье');
await settle();
check('user folder appears', store.getTopics()['Автоматизация'], ['Здоровье']);
await mod.pullFromServer();
check('user folder survives a pull', store.getTopics()['Автоматизация'], ['Здоровье']);
store.removeTopic('Автоматизация', 'Здоровье');
await settle();
check('deleted folder stays gone', store.getTopics()['Автоматизация'], []);
check('its tasks moved to Основное',
  store.getTasks().filter((t) => t.sphere === 'Автоматизация').map((t) => t.topic ?? 'Основное'),
  ['Основное']);

console.log('\n7. a delete survives losing this browser (new profile learns it from the account)');
// History: the delete lived only in this browser's localStorage and expired
// after a day, so the next stale re-upload stood everywhere. The intent now
// travels in the user_settings row, which every device reads.
state.spheres.push({ user_id: USER_ID, name: 'Дачные дела', order: 9 });
await mod.pullFromServer();
check('this device adopted the stale category', spheres().includes('Дачные дела'), true);
store.removeSphere('Дачные дела');
await settle(1200);
check('its row is gone from the server', names().includes('Дачные дела'), false);
check('the intent is stored in user_settings', /#cat:/.test(state.settings?.last_view ?? ''), true);

// A fresh browser profile: no tombstones, no spheres — only the account row.
mem.clear();
state.spheres.push({ user_id: USER_ID, name: 'Дачные дела', order: 9 }); // stale device re-uploads
const mod2 = await import('./dist/store.mjs?device=2');
await mod2.signInWithPassword('test@example.com', 'secret123');
await mod2.initAuth();
await mod2.pullFromServer();
await settle(1500);
check(
  'fresh device does not show the deleted category',
  JSON.parse(mod2.buildBackupJson()).spheres.includes('Дачные дела'),
  false,
);
check('fresh device re-deleted the stale row', names().includes('Дачные дела'), false);

console.log('\n8. re-creating the category later revives it on every device');
store.addSphere('Дачные дела');
await settle(1200);
check('server row is back after re-create', names().includes('Дачные дела'), true);
// Third profile, again with nothing local: it must learn BOTH facts (deleted,
// then re-created) and show the category.
mem.clear();
const mod3 = await import('./dist/store.mjs?device=3');
await mod3.signInWithPassword('test@example.com', 'secret123');
await mod3.initAuth();
await mod3.pullFromServer();
await settle(1500);
check(
  'fresh device shows the re-created category',
  JSON.parse(mod3.buildBackupJson()).spheres.includes('Дачные дела'),
  true,
);
check('and the row survives', names().includes('Дачные дела'), true);
check(
  'the re-creation is recorded in the account intent (#cat:.r)',
  /"r":\{[^}]*Дачные дела/.test(state.settings?.last_view ?? ''),
  true,
);

console.log('\n9. creating a name with no local memory of the old delete keeps it');
store.removeSphere('Дом');
await settle(1200);
check('Дом is deleted on the server', names().includes('Дом'), false);
mem.clear();
const mod4 = await import('./dist/store.mjs?device=4');
mod4.store.addSphere('Дом'); // typed on a profile that has never synced
await mod4.signInWithPassword('test@example.com', 'secret123');
await mod4.initAuth();
await mod4.pullFromServer();
await settle(1500);
check(
  'the just-created name survives the pull',
  JSON.parse(mod4.buildBackupJson()).spheres.includes('Дом'),
  true,
);
check('and it is back on the server', names().includes('Дом'), true);

server.close();
console.log(`\n${failures.length === 0 ? 'PASS' : `FAILED: ${failures.join('; ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
