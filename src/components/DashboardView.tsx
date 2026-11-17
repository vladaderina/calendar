// The dashboard: a goal board for the spheres of life.
//
// Structure the user asked for: spheres → folders/pages → ONE blank note per
// page, written in Markdown, where a checklist line can be planned to a day and
// becomes a real calendar task. There are no "blocks" any more — a page is a
// page, and the note is the whole content.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '../types';
import { retryLocalPersist, store, useSpheres, useTasks, useTopics } from '../store';
import {
  canAddChild,
  canAddPage,
  keyPath,
  nodeAt,
  pathKey,
  type TreeNode,
} from '../lib/tree';
import {
  addBoardDoc,
  claimOrphans,
  hydrateBoard,
  removeDocsUnder,
  rekeyNode,
  startBoardSync,
  syncBoard,
  useBoardDocs,
  useBoardNotes,
  useBoardPhotos,
  type BoardDoc,
  type BoardPhoto,
} from '../lib/board';
import { applyLinkedTasks, docMarkdown } from '../lib/doc';
import { checkCounts } from '../lib/md';
import { upgradeDashboardModel } from '../lib/migrate';
import { restoreLostNotes } from '../lib/restore';
import { PageView } from './PageView';

interface Props {
  onEdit: (task: Task) => void;
}

type Selection = { sphere: string; path: string[] };

const SEP = '\u001F';
const nodeKeyOf = (sphere: string, path: string[]): string => `${sphere}${SEP}${pathKey(path)}`;

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function todayLabel(): string {
  const now = new Date();
  return `${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'доброй ночи';
  if (hour < 12) return 'доброе утро';
  if (hour < 18) return 'добрый день';
  return 'добрый вечер';
}

interface Stats {
  done: number;
  total: number;
  planned: number;
  pages: number;
}

const EMPTY_STATS: Stats = { done: 0, total: 0, planned: 0, pages: 0 };

function InlineInput({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The field is created by a click on the «＋ папка» / «＋ страница» button. The
  // browser finishes that click AFTER React mounted the input and focused it, so
  // a blur arrives immediately with an empty value — treating it as «cancel»
  // made the field vanish before anything could be typed (a folder «appeared»
  // only after a reload, or not at all). Ignore blur for the first moments and
  // put the caret back.
  const settled = useRef(false);
  useEffect(() => {
    const id = window.setTimeout(() => { settled.current = true; }, 350);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <input
      ref={inputRef}
      className="dsh-new-input"
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (!settled.current) {
          inputRef.current?.focus();
          return;
        }
        if (value.trim()) onSubmit(value);
        else onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (value.trim()) onSubmit(value);
          else onCancel();
        } else if (event.key === 'Escape') {
          onCancel();
        }
      }}
    />
  );
}

function Progress({ stats }: { stats: Stats }) {
  if (!stats.total) return null;
  const percent = Math.round((stats.done / stats.total) * 100);
  return (
    <span className="dsh-progress" title={`${stats.done} из ${stats.total} пунктов`}>
      <span className="dsh-progress-bar"><span style={{ width: `${percent}%` }} /></span>
      <span className="dsh-progress-num">{percent}%</span>
    </span>
  );
}

export function DashboardView({ onEdit }: Props) {
  const spheres = useSpheres();
  const tasks = useTasks();
  const tree = useTopics();
  const docs = useBoardDocs();
  const photos = useBoardPhotos();
  const notes = useBoardNotes();

  const [sel, setSel] = useState<Selection>({ sphere: '', path: [] });
  const [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState(false);
  const [creating, setCreating] = useState<{ sphere: string; parent: string[]; kind: 'folder' | 'page' } | null>(null);
  const [addingSphere, setAddingSphere] = useState(false);
  const [confirmKey, setConfirmKey] = useState('');
  const [pageConfirm, setPageConfirm] = useState(false);
  const [toast, setToast] = useState('');
  const sideRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => startBoardSync(), []);

  useEffect(() => {
    if (!spheres.length) return;
    claimOrphans(nodeKeyOf(spheres[0], []));
  }, [spheres]);

  // Pictures out of localStorage first (the quota is what breaks saving), then
  // the conversion of the old block-documents into Markdown notes.
  useEffect(() => {
    let cancelled = false;
    void hydrateBoard().then(() => {
      if (cancelled) return;
      retryLocalPersist();
      // Notes wiped by an earlier build first, then the model upgrade — the
      // upgrade must see the restored text, never the other way round.
      restoreLostNotes();
      upgradeDashboardModel();
    });
    return () => { cancelled = true; };
  }, [tasks.length, spheres.length, docs.length]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Keep the selection on something that still exists.
  useEffect(() => {
    if (!sel.sphere) return;
    if (!spheres.includes(sel.sphere)) {
      setSel({ sphere: '', path: [] });
      return;
    }
    if (!sel.path.length) return;
    let path = sel.path;
    while (path.length && !nodeAt(tree[sel.sphere]?.children ?? [], path)) path = path.slice(0, -1);
    if (path.length !== sel.path.length) setSel({ sphere: sel.sphere, path });
  }, [spheres, tree, sel.sphere, sel.path]);

  const docByKey = useMemo(() => {
    const map = new Map<string, BoardDoc>();
    for (const doc of docs) map.set(doc.nodeKey, doc);
    return map;
  }, [docs]);

  /** Progress of a container = every page document beneath it. */
  const statsUnder = useMemo(() => {
    const byKey = new Map<string, Stats>();
    for (const doc of docs) {
      const counts = checkCounts(applyLinkedTasks(docMarkdown(doc, notes, []), doc.links, tasks));
      const parts = doc.nodeKey.split(SEP);
      const sphere = parts[0];
      const names = keyPath(parts.slice(1).join(SEP));
      for (let depth = 0; depth <= names.length; depth++) {
        const key = depth === 0 ? `${sphere}${SEP}` : `${sphere}${SEP}${pathKey(names.slice(0, depth))}`;
        const cur = byKey.get(key) ?? { ...EMPTY_STATS };
        cur.done += counts.done;
        cur.total += counts.total;
        cur.planned += counts.planned;
        if (depth === names.length) cur.pages += 1;
        byKey.set(key, cur);
      }
    }
    return byKey;
  }, [docs, notes, tasks]);

  const statsOf = (sphere: string, path: string[]): Stats => (path.length
    ? statsUnder.get(nodeKeyOf(sphere, path)) ?? EMPTY_STATS
    : statsUnder.get(`${sphere}${SEP}`) ?? EMPTY_STATS);

  /** The picture that represents a sphere/folder: the first one beneath it. */
  const coverOf = useMemo(() => {
    const map = new Map<string, BoardPhoto>();
    for (const photo of photos) {
      if (!photo.nodeKey) continue;
      const parts = photo.nodeKey.split(SEP);
      const sphere = parts[0];
      const names = keyPath(parts.slice(1).join(SEP));
      for (let depth = 0; depth <= names.length; depth++) {
        const key = depth === 0 ? `${sphere}${SEP}` : `${sphere}${SEP}${pathKey(names.slice(0, depth))}`;
        if (!map.has(key)) map.set(key, photo);
      }
    }
    return map;
  }, [photos]);


  const allPages = useMemo(() => {
    const out: { sphere: string; path: string[]; node: TreeNode }[] = [];
    const walk = (sphere: string, nodes: TreeNode[], prefix: string[]) => {
      for (const node of nodes) {
        const path = [...prefix, node.name];
        if (node.kind === 'note') out.push({ sphere, path, node });
        else walk(sphere, node.children, path);
      }
    };
    for (const [sphere, category] of Object.entries(tree)) walk(sphere, category.children, []);
    return out;
  }, [tree]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const rows: { sphere: string; path: string[]; label: string; kind: 'folder' | 'page' | 'category' }[] = [];
    for (const [sphere, category] of Object.entries(tree)) {
      if (sphere.toLowerCase().includes(q)) rows.push({ sphere, path: [], label: sphere, kind: 'category' });
      const walk = (nodes: TreeNode[], prefix: string[]) => {
        for (const node of nodes) {
          const path = [...prefix, node.name];
          const doc = docByKey.get(nodeKeyOf(sphere, path));
          const inText = doc ? docMarkdown(doc, notes, []).toLowerCase().includes(q) : false;
          if (node.name.toLowerCase().includes(q) || inText) {
            rows.push({ sphere, path, label: node.name, kind: node.kind === 'note' ? 'page' : 'folder' });
          }
          walk(node.children, path);
        }
      };
      walk(category.children, []);
    }
    return rows.slice(0, 40);
  }, [query, tree, docByKey, notes, tasks]);

  const recent = useMemo(() => docs
    .filter((doc) => !doc.deleted)
    .sort((a, b) => b.t - a.t)
    .slice(0, 4)
    .map((doc) => {
      const parts = doc.nodeKey.split(SEP);
      return { doc, sphere: parts[0], path: keyPath(parts.slice(1).join(SEP)) };
    })
    .filter((row) => row.path.length > 0), [docs]);

  const selectedNode = useMemo(() => (sel.sphere && sel.path.length
    ? nodeAt(tree[sel.sphere]?.children ?? [], sel.path)
    : null), [tree, sel]);

  const open = (sphere: string, path: string[]) => {
    setSel({ sphere, path });
    setSheet(false);
    setQuery('');
    setPageConfirm(false);
    if (path.length) {
      setExpanded((list) => Array.from(new Set([...list, sphere, `${sphere}${SEP}${pathKey(path)}`])));
    }
  };

  const openCategory = (sphere: string) => {
    setSel({ sphere, path: [] });
    setSheet(false);
    setQuery('');
    setConfirmKey('');
  };

  const goHome = () => {
    setSel({ sphere: '', path: [] });
    setSheet(false);
    setQuery('');
  };

  const createNode = (sphere: string, parent: string[], kind: 'folder' | 'page', name: string) => {
    const title = name.trim();
    setCreating(null);
    if (!title) return;
    if (kind === 'folder') {
      store.addTopic(sphere, title, parent);
      setExpanded((list) => Array.from(new Set([...list, sphere, `${sphere}${SEP}${pathKey(parent)}`])));
      return;
    }
    const path = [...parent, title];
    const doc = addBoardDoc(title, nodeKeyOf(sphere, path));
    store.addNote(sphere, parent, title, doc.id);
    open(sphere, path);
  };

  const removeNode = (sphere: string, path: string[]) => {
    const key = nodeKeyOf(sphere, path);
    if (!path.length) {
      removeDocsUnder(key);
      store.removeSphere(sphere);
      if (sel.sphere === sphere) goHome();
      return;
    }
    removeDocsUnder(key);
    // Pictures and stickers of a deleted page/folder move one level up instead
    // of becoming unreachable orphans.
    rekeyNode(key, nodeKeyOf(sphere, path.slice(0, -1)));
    store.removeTopic(sphere, path);
    if (sel.sphere === sphere && pathKey(sel.path).startsWith(pathKey(path))) {
      setSel({ sphere, path: path.slice(0, -1) });
    }
  };

  const renameNode = (sphere: string, path: string[], name: string) => {
    const next = name.trim();
    if (!next || next === path[path.length - 1]) return;
    const fromKey = nodeKeyOf(sphere, path);
    const toPath = [...path.slice(0, -1), next];
    store.renameTopic(sphere, path, next);
    rekeyNode(fromKey, nodeKeyOf(sphere, toPath));
    if (sel.sphere === sphere && pathKey(sel.path) === pathKey(path)) setSel({ sphere, path: toPath });
  };

  const pageDoc = useMemo(() => {
    if (!selectedNode || selectedNode.kind !== 'note' || !sel.sphere) return null;
    const key = nodeKeyOf(sel.sphere, sel.path);
    const existing = docByKey.get(key);
    if (existing) return existing;
    if (selectedNode.noteId) {
      const byId = docs.find((doc) => doc.id === selectedNode.noteId);
      if (byId) return byId;
    }
    return null;
  }, [selectedNode, sel, docByKey, docs]);

  // A page node that lost its document gets a fresh one, linked for good.
  useEffect(() => {
    if (!sel.sphere || !selectedNode || selectedNode.kind !== 'note' || pageDoc) return;
    const key = nodeKeyOf(sel.sphere, sel.path);
    const created = addBoardDoc(sel.path[sel.path.length - 1] ?? 'заметка', key);
    store.setNoteId(sel.sphere, sel.path, created.id);
  }, [sel, selectedNode, pageDoc]);

  const pagePhotos = photos.filter((photo) => photo.nodeKey === nodeKeyOf(sel.sphere, sel.path));

  const renderRow = (sphere: string, node: TreeNode, path: string[], depth: number): ReactNode => {
    const key = `${sphere}${SEP}${pathKey(path)}`;
    const isOpen = expanded.includes(key);
    const cover = coverOf.get(key);
    const active = sel.sphere === sphere && pathKey(sel.path) === pathKey(path);
    const isPage = node.kind === 'note';
    const toggle = () => setExpanded((list) => (isOpen ? list.filter((item) => item !== key) : [...list, key]));
    return (
      <div key={key} className="dsh-branch">
        <div
          className={`dsh-row${active ? ' is-active' : ''}${isPage ? ' is-page' : ''}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {!isPage && (
            <button
              type="button"
              className={`dsh-chev${node.children.length ? '' : ' is-idle'}`}
              onClick={toggle}
              aria-label={isOpen ? 'свернуть' : 'развернуть'}
            >
              {node.children.length ? (isOpen ? '▾' : '▸') : '·'}
            </button>
          )}
          {isPage && (
            cover?.data
              ? <span className="dsh-row-thumb" style={{ backgroundImage: `url(${cover.data})` }} />
              : <span className="dsh-row-thumb is-empty">▤</span>
          )}
          <button
            type="button"
            className="dsh-row-name"
            onClick={() => (isPage ? open(sphere, path) : toggle())}
          >
            {node.name}
          </button>
        </div>
        {!isPage && isOpen && (
          <div className="dsh-children">
            {node.children.map((child) => renderRow(sphere, child, [...path, child.name], depth + 1))}
            {creating && creating.sphere === sphere && pathKey(creating.parent) === pathKey(path) && (
              <div className="dsh-new-row" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>
                <InlineInput
                  placeholder={creating.kind === 'folder' ? 'название папки' : 'название страницы'}
                  onSubmit={(value) => createNode(sphere, path, creating.kind, value)}
                  onCancel={() => setCreating(null)}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const treeBody = (
    <>
      <button type="button" className={`dsh-home-link${!sel.sphere ? ' is-active' : ''}`} onClick={goHome}>
        <span className="dsh-home-dot" />
        Дашборд
      </button>

      {query.trim() ? (
        <div className="dsh-results">
          {searchResults.length === 0 && <p className="dsh-muted">ничего не найдено</p>}
          {searchResults.map((row) => (
            <button
              key={`${row.sphere}${SEP}${pathKey(row.path)}`}
              type="button"
              className="dsh-result"
              onClick={() => (row.kind === 'category' ? openCategory(row.sphere) : open(row.sphere, row.path))}
            >
              <span className={`dsh-result-kind is-${row.kind}`}>
                {row.kind === 'page' ? '▤' : row.kind === 'folder' ? '▸' : '◆'}
              </span>
              <span className="dsh-result-name">{row.label}</span>
              <span className="dsh-result-crumb">
                {row.path.length > 1 ? row.path.slice(0, -1).join(' / ') : row.sphere}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="dsh-tree">
          {spheres.map((sphere) => {
            const category = tree[sphere];
            const isOpen = expanded.includes(sphere);
            const stats = statsOf(sphere, []);
            const active = sel.sphere === sphere && !sel.path.length;
            return (
              <div key={sphere} className="dsh-cat">
                <div className={`dsh-row dsh-row-cat${active ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className="dsh-chev"
                    onClick={() => setExpanded((list) => (isOpen ? list.filter((item) => item !== sphere) : [...list, sphere]))}
                    aria-label={isOpen ? 'свернуть' : 'развернуть'}
                  >
                    {(category?.children ?? []).length ? (isOpen ? '▾' : '▸') : '·'}
                  </button>
                  <button type="button" className="dsh-row-name" onClick={() => openCategory(sphere)}>
                    {sphere}
                  </button>
                  {stats.total > 0 && <span className="dsh-row-count">{stats.done}/{stats.total}</span>}
                </div>
                {isOpen && (
                  <div className="dsh-children">
                    {(category?.children ?? []).map((node) => renderRow(sphere, node, [node.name], 1))}
                    {creating && creating.sphere === sphere && !creating.parent.length && (
                      <div className="dsh-new-row" style={{ paddingLeft: '22px' }}>
                        <InlineInput
                          placeholder={creating.kind === 'folder' ? 'название папки' : 'название страницы'}
                          onSubmit={(value) => createNode(sphere, [], creating.kind, value)}
                          onCancel={() => setCreating(null)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {addingSphere && (
            <div className="dsh-new-row">
              <InlineInput
                placeholder="название сферы"
                onSubmit={(value) => {
                  setAddingSphere(false);
                  const name = value.trim();
                  if (!name) return;
                  store.addSphere(name);
                  setExpanded((list) => Array.from(new Set([...list, name])));
                  openCategory(name);
                }}
                onCancel={() => setAddingSphere(false)}
              />
            </div>
          )}
        </div>
      )}
    </>
  );

  const containerChildren = sel.path.length
    ? nodeAt(tree[sel.sphere]?.children ?? [], sel.path)?.children ?? []
    : tree[sel.sphere]?.children ?? [];

  const cover = sel.sphere ? coverOf.get(nodeKeyOf(sel.sphere, sel.path)) : undefined;
  const creatingHere = creating && creating.sphere === sel.sphere
    && pathKey(creating.parent) === pathKey(sel.path)
    ? creating.kind
    : null;

  const listCommon = {
    sphere: sel.sphere,
    basePath: sel.path,
    statsOf: (path: string[]) => statsOf(sel.sphere, path),
    coverOf: (path: string[]) => coverOf.get(nodeKeyOf(sel.sphere, path)),
    onOpenPage: (path: string[]) => open(sel.sphere, path),
    onOpenFolder: (path: string[]) => open(sel.sphere, path),
    creating: creatingHere,
    onCreate: (value: string) => createNode(sel.sphere, sel.path, creating?.kind ?? 'page', value),
    onCancelCreate: () => setCreating(null),
    onAddPage: () => setCreating({ sphere: sel.sphere, parent: sel.path, kind: 'page' }),
    onAddFolder: () => setCreating({ sphere: sel.sphere, parent: sel.path, kind: 'folder' }),
  };

  return (
    <div className="dsh">
      <aside className="dsh-side" ref={sideRef}>
        <div className="dsh-side-head">
          <div className="dsh-side-title">сферы жизни</div>
          <button type="button" className="dsh-side-add" title="новая сфера" onClick={() => setAddingSphere(true)}>＋</button>
        </div>
        <input
          className="dsh-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="искать страницу или текст…"
        />
        <div className="dsh-side-body">{treeBody}</div>
        <div className="dsh-side-foot">
          <button
            type="button"
            className="dsh-sync"
            onClick={() => { void syncBoard(); setToast('обновляю заметки и фото…'); }}
            title="обновить с сервера"
          >
            ⟳
          </button>
          <span>{allPages.length} стр. · {photos.length} фото</span>
        </div>
      </aside>

      <div className="dsh-main">
        <div className="dsh-mobile-bar">
          <button type="button" className="dsh-mobile-btn" onClick={() => setSheet(true)} aria-label="разделы">☰</button>
          <button
            type="button"
            className="dsh-mobile-title"
            onClick={() => {
              if (sel.path.length > 1) setSel({ sphere: sel.sphere, path: sel.path.slice(0, -1) });
              else if (sel.path.length === 1) openCategory(sel.sphere);
              else if (sel.sphere) goHome();
            }}
          >
            {sel.path.length ? '← назад' : sel.sphere || 'Дашборд'}
          </button>
          <button
            type="button"
            className="dsh-mobile-btn"
            onClick={() => setSheet(true)}
            aria-label="поиск"
          >
            ⌕
          </button>
        </div>

        {sheet && (
          <div className="dsh-sheet" role="dialog" aria-modal="true">
            <div className="dsh-sheet-head">
              <span>куда перейти</span>
              <button type="button" className="dsh-mobile-btn" onClick={() => setSheet(false)}>×</button>
            </div>
            <input
              className="dsh-search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="искать страницу или текст…"
            />
            <div className="dsh-side-body">{treeBody}</div>
            <button type="button" className="dsh-sheet-add" onClick={() => setAddingSphere(true)}>＋ новая сфера</button>
          </div>
        )}

        {!sel.sphere && (
          <section className="dsh-home">
            <header className="dsh-home-head">
              <p className="dsh-home-date">{todayLabel()}</p>
              <h1 className="dsh-home-title">{greeting()}</h1>
            </header>

            {recent.length > 0 && (
              <section className="dsh-panel">
                <div className="dsh-panel-head"><h2>продолжить</h2></div>
                <div className="dsh-recent">
                  {recent.map(({ doc, sphere, path }) => (
                    <button key={doc.id} type="button" className="dsh-recent-card" onClick={() => open(sphere, path)}>
                      <span className="dsh-recent-kind">{circleFor(doc, path, sphere)}</span>
                      <span className="dsh-recent-name">{path[path.length - 1]}</span>
                      <span className="dsh-recent-crumb">
                        {sphere}{path.length > 1 ? ` / ${path.slice(0, -1).join(' / ')}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section className="dsh-panel">
              <div className="dsh-panel-head">
                <h2>сферы</h2>
                <button type="button" className="dsh-ghost" onClick={() => setAddingSphere(true)}>＋ сфера</button>
              </div>
              <div className="dsh-cards">
                {spheres.map((sphere) => {
                  const st = statsOf(sphere, []);
                  const pic = coverOf.get(`${sphere}${SEP}`);
                  return (
                    <button key={sphere} type="button" className="dsh-card" onClick={() => openCategory(sphere)}>
                      <span
                        className={`dsh-card-cover${pic?.data ? '' : ' is-empty'}`}
                        style={pic?.data ? { backgroundImage: `url(${pic.data})` } : undefined}
                      >
                        {!pic?.data && <span>{(sphere[0] ?? '?').toUpperCase()}</span>}
                      </span>
                      <span className="dsh-card-body">
                        <span className="dsh-card-name">{sphere}</span>
                        <span className="dsh-card-meta">
                          {st.pages ? `${st.pages} ${st.pages === 1 ? 'страница' : st.pages < 5 ? 'страницы' : 'страниц'}` : 'пусто'}
                        </span>
                      </span>
                    </button>
                  );
                })}
                <button type="button" className="dsh-card dsh-card-add" onClick={() => setAddingSphere(true)}>
                  <span className="dsh-card-cover is-empty">＋</span>
                  <span className="dsh-card-body">
                    <span className="dsh-card-name">новая сфера</span>
                    <span className="dsh-card-meta">например «здоровье»</span>
                  </span>
                </button>
              </div>
            </section>
          </section>
        )}

        {sel.sphere && !sel.path.length && (
          <section className="dsh-section">
            <header
              className={`dsh-sec-head${cover?.data ? ' has-cover' : ''}`}
              style={cover?.data ? { backgroundImage: `url(${cover.data})` } : undefined}
            >
              <div className="dsh-sec-veil">
                <input
                  className="dsh-sec-title"
                  key={sel.sphere}
                  defaultValue={sel.sphere}
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (next && next !== sel.sphere) {
                      store.renameSphere(sel.sphere, next);
                      rekeyNode(nodeKeyOf(sel.sphere, []), nodeKeyOf(next, []));
                      setSel({ sphere: next, path: [] });
                    } else {
                      event.target.value = sel.sphere;
                    }
                  }}
                  onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                  aria-label="название сферы"
                />
              </div>
            </header>

            <div className="dsh-sec-actions">
              <button type="button" className="dsh-cta" onClick={() => setCreating({ sphere: sel.sphere, parent: [], kind: 'page' })}>
                ＋ страница
              </button>
              <button type="button" className="dsh-cta is-quiet" onClick={() => setCreating({ sphere: sel.sphere, parent: [], kind: 'folder' })}>
                ＋ папка
              </button>
              <span className="dsh-spacer" />
              {confirmKey === `cat:${sel.sphere}` ? (
                <>
                  <button type="button" className="dsh-danger" onClick={() => { removeNode(sel.sphere, []); setConfirmKey(''); }}>
                    удалить сферу и всё внутри
                  </button>
                  <button type="button" className="dsh-ghost" onClick={() => setConfirmKey('')}>отмена</button>
                </>
              ) : (
                <button type="button" className="dsh-ghost" onClick={() => setConfirmKey(`cat:${sel.sphere}`)}>удалить</button>
              )}
            </div>

            <ContainerList
              {...listCommon}
              items={containerChildren}
              empty="Пока пусто. Создай страницу — например «Здоровье: цель на год» — и напиши в ней, чего хочешь и какими шагами."
            />
          </section>
        )}

        {sel.sphere && sel.path.length > 0 && selectedNode?.kind === 'folder' && (
          <section className="dsh-section">
            <nav className="dsh-crumbs">
              <button type="button" className="dsh-crumb" onClick={() => openCategory(sel.sphere)}>{sel.sphere}</button>
              {sel.path.slice(0, -1).map((name, index) => (
                <button key={name} type="button" className="dsh-crumb" onClick={() => open(sel.sphere, sel.path.slice(0, index + 1))}>
                  {name}
                </button>
              ))}
              <span className="dsh-crumb is-here">{sel.path[sel.path.length - 1]}</span>
            </nav>

            <header className="dsh-folder-head">
              <input
                className="dsh-folder-title"
                key={pathKey(sel.path)}
                defaultValue={sel.path[sel.path.length - 1]}
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  const current = sel.path[sel.path.length - 1];
                  if (!next || next === current) {
                    event.target.value = current;
                    return;
                  }
                  store.renameTopic(sel.sphere, sel.path, next);
                  rekeyNode(nodeKeyOf(sel.sphere, sel.path), nodeKeyOf(sel.sphere, [...sel.path.slice(0, -1), next]));
                  const path = [...sel.path.slice(0, -1), next];
                  setSel({ sphere: sel.sphere, path });
                  setToast('папка переименована');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    event.currentTarget.value = sel.path[sel.path.length - 1];
                    event.currentTarget.blur();
                  }
                }}
                aria-label="название папки"
              />
            </header>

            <div className="dsh-sec-actions">
              {canAddPage(sel.path) && (
                <button type="button" className="dsh-cta" onClick={() => setCreating({ sphere: sel.sphere, parent: sel.path, kind: 'page' })}>
                  ＋ страница
                </button>
              )}
              {canAddChild(sel.path) && (
                <button
                  type="button"
                  className="dsh-cta is-quiet"
                  onClick={() => setCreating({ sphere: sel.sphere, parent: sel.path, kind: 'folder' })}
                >
                  ＋ папка
                </button>
              )}
              <span className="dsh-spacer" />
              {confirmKey === `node:${pathKey(sel.path)}` ? (
                <>
                  <button type="button" className="dsh-danger" onClick={() => { removeNode(sel.sphere, sel.path); setConfirmKey(''); }}>
                    удалить папку
                  </button>
                  <button type="button" className="dsh-ghost" onClick={() => setConfirmKey('')}>отмена</button>
                </>
              ) : (
                <button type="button" className="dsh-ghost" onClick={() => setConfirmKey(`node:${pathKey(sel.path)}`)}>удалить</button>
              )}
            </div>

            <ContainerList
              {...listCommon}
              items={containerChildren}
              empty="В папке пока нет страниц. Добавь страницу — и пиши в ней план."
            />
          </section>
        )}

        {sel.sphere && sel.path.length > 0 && selectedNode?.kind === 'note' && pageDoc && (
          <section className="dsh-section dsh-section-page">
            <nav className="dsh-crumbs">
              <button
                type="button"
                className="dsh-crumb dsh-crumb-back"
                title={sel.path.length > 1 ? sel.path[sel.path.length - 2] : sel.sphere}
                onClick={() => (sel.path.length > 1 ? open(sel.sphere, sel.path.slice(0, -1)) : openCategory(sel.sphere))}
              >
                ←
              </button>
              <button type="button" className="dsh-crumb" onClick={() => openCategory(sel.sphere)}>{sel.sphere}</button>
              {sel.path.slice(0, -1).map((name, index) => (
                <button
                  key={name}
                  type="button"
                  className="dsh-crumb"
                  onClick={() => open(sel.sphere, sel.path.slice(0, index + 1))}
                >
                  · {name}
                </button>
              ))}
              <span className="dsh-crumb is-here">{sel.path[sel.path.length - 1]}</span>
            </nav>
            <PageView
              sphere={sel.sphere}
              path={sel.path}
              doc={pageDoc}
              photos={pagePhotos}
              onRename={(name) => renameNode(sel.sphere, sel.path, name)}
              onEdit={onEdit}
              onDelete={() => {
                if (!pageConfirm) {
                  setPageConfirm(true);
                  setToast('нажми 🗑 ещё раз, чтобы удалить страницу');
                  window.setTimeout(() => setPageConfirm(false), 4000);
                  return;
                }
                setPageConfirm(false);
                removeNode(sel.sphere, sel.path);
                setToast('страница удалена');
              }}
            />
          </section>
        )}

        {toast && <div className="dsh-toast">{toast}</div>}
      </div>
    </div>
  );
}

function circleFor(doc: BoardDoc, path: string[], sphere: string): string {
  const counts = checkCounts(doc.md ?? '');
  if (counts.total) return `${counts.done}/${counts.total}`;
  return (path[path.length - 1] ?? sphere).slice(0, 1).toUpperCase();
}

function ContainerList({
  items,
  basePath,
  statsOf,
  coverOf,
  onOpenPage,
  onOpenFolder,
  creating,
  onCreate,
  onCancelCreate,
  onAddPage,
  onAddFolder,
  empty,
}: {
  sphere: string;
  basePath: string[];
  items: TreeNode[];
  statsOf: (path: string[]) => Stats;
  coverOf: (path: string[]) => BoardPhoto | undefined;
  onOpenPage: (path: string[]) => void;
  onOpenFolder: (path: string[]) => void;
  creating: 'folder' | 'page' | null;
  onCreate: (value: string) => void;
  onCancelCreate: () => void;
  onAddPage: () => void;
  onAddFolder: () => void;
  empty: string;
}) {
  if (!items.length && !creating) {
    return (
      <div className="dsh-list-empty">
        <p className="dsh-empty">{empty}</p>
        <div className="dsh-sec-actions">
          <button type="button" className="dsh-cta" onClick={onAddPage}>＋ страница</button>
          <button type="button" className="dsh-cta is-quiet" onClick={onAddFolder}>＋ папка</button>
        </div>
      </div>
    );
  }
  return (
    <div className="dsh-list" data-creating={String(creating)}>
      {creating && (
        <div className="dsh-new-row">
          <InlineInput
            placeholder={creating === 'folder' ? 'название папки' : 'название страницы'}
            onSubmit={onCreate}
            onCancel={onCancelCreate}
          />
        </div>
      )}
      {items.map((node) => {
        const path = [...basePath, node.name];
        const isPage = node.kind === 'note';
        const pic = coverOf(path);
        const stats = statsOf(path);
        return (
          <button
            key={node.id}
            type="button"
            className="dsh-item"
            onClick={() => (isPage ? onOpenPage(path) : onOpenFolder(path))}
          >
            {pic?.data ? (
              <span className="dsh-item-thumb" style={{ backgroundImage: `url(${pic.data})` }} />
            ) : (
              <span className={`dsh-item-thumb is-empty${isPage ? ' is-page' : ''}`}>{isPage ? '▤' : '▸'}</span>
            )}
            <span className="dsh-item-body">
              <span className="dsh-item-name">{node.name}</span>
              <span className="dsh-item-meta">
                {isPage
                  ? (stats.total ? `${stats.done} из ${stats.total} пунктов` : 'пустая страница')
                  : `${node.children.filter((child) => child.kind === 'note').length} стр.`}
              </span>
              <Progress stats={stats} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
