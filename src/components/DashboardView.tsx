import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type { Task } from '../types';
import { TaskItem } from './TaskItem';
import { retryLocalPersist, store, useSpheres, useTasks, useTopics } from '../store';
import { sortByPriority } from '../utils/date';
import {
  BLOCK_HINT,
  BLOCK_LABEL,
  canAddChild,
  canAddPage,
  canHoldPages,
  inSubtree,
  keyPath,
  nodeAt,
  pathKey,
  type BlockKind,
  type TreeNode,
} from '../lib/tree';
import {
  NOTE_COLORS,
  addBoardDoc,
  addBoardNote,
  addBoardPhoto,
  claimOrphans,
  removeBoardItem,
  removeDocsUnder,
  rekeyNode,
  saveBoardDoc,
  startBoardSync,
  syncBoard,
  updateBoardNote,
  updateBoardPhoto,
  hydrateBoard,
  useBoardDocs,
  useBoardNotes,
  useBoardPhotos,
} from '../lib/board';
import { NoteEditor } from './NoteEditor';
import { fileToDataUrl } from '../lib/image';
import { upgradeDashboardModel } from '../lib/migrate';

interface Props {
  onEdit: (task: Task) => void;
}

type Selection = { sphere: string; path: string[] };

const SEP = '\u001F';

/** Identity of a dashboard node: its category plus the folder path. */
const nodeKeyOf = (sphere: string, path: string[]): string => `${sphere}${SEP}${pathKey(path)}`;

function reorderIds(ids: string[], draggedId: string, targetId: string): string[] {
  const next = ids.filter((id) => id !== draggedId);
  let at = next.indexOf(targetId);
  if (at < 0) at = next.length;
  else at += 1;
  next.splice(at, 0, draggedId);
  return next;
}

function makeReorderInNode(tasks: Task[], sphere: string, topic: string | undefined, list: Task[]) {
  return (draggedId: string, targetId: string, place: 'above' | 'below') => {
    const dragged = tasks.find((task) => task.id === draggedId);
    if (dragged && (dragged.unplanned || dragged.sphere !== sphere || dragged.topic !== topic)) {
      store.update(draggedId, { sphere, topic, unplanned: false });
    }
    const ids = list.map((task) => task.id).filter((id) => id !== draggedId);
    let index = ids.indexOf(targetId);
    if (index < 0) index = ids.length;
    else if (place === 'below') index += 1;
    ids.splice(index, 0, draggedId);
    store.reorder(ids);
  };
}

function QuickAdd({ sphere, topic, onDone }: { sphere: string; topic: string | undefined; onDone: () => void }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const allTasks = useTasks();
  const query = value.trim().toLowerCase();
  const suggestions = query
    ? Array.from(new Set(allTasks.map((task) => task.title)))
      .filter((title) => title.toLowerCase().includes(query))
      .slice(0, 5)
    : [];

  const submit = () => {
    const title = value.trim();
    if (title) {
      store.add({ title, sphere, topic, unplanned: true });
      setValue('');
      inputRef.current?.focus();
    } else {
      onDone();
    }
  };

  return (
    <div className="quick-add-wrap">
      <input
        ref={inputRef}
        autoFocus
        className="quick-add"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={submit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          else if (event.key === 'Escape') onDone();
        }}
      />
      {suggestions.length > 0 && (
        <div className="quick-add-suggestions">
          {suggestions.map((suggestion) => (
            <div
              key={suggestion}
              className="search-suggestion"
              onMouseDown={(event) => { event.preventDefault(); setValue(suggestion); }}
            >
              <span className="suggestion-title">{suggestion}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A sticky note: click the text to edit, ✕ to remove, the dot to recolour. */
function NoteCard({ id, text, color }: { id: string; text: string; color: string }) {
  const cycleColor = () => {
    const at = NOTE_COLORS.indexOf(color);
    updateBoardNote(id, { color: NOTE_COLORS[(at + 1) % NOTE_COLORS.length] });
  };
  return (
    <div className="dash-note" style={{ background: color }}>
      <div
        className="dash-note-text"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={(event) => {
          const next = event.currentTarget.textContent ?? '';
          if (next.trim() !== text) updateBoardNote(id, { text: next });
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.currentTarget.textContent = text;
            event.currentTarget.blur();
          }
        }}
      >
        {text}
      </div>
      <div className="dash-note-actions">
        <button type="button" className="dash-note-color" onClick={cycleColor} aria-label="Сменить цвет" title="Сменить цвет" />
        <button type="button" className="dash-note-del" onClick={() => removeBoardItem(id)} aria-label="Удалить заметку" title="Удалить">×</button>
      </div>
    </div>
  );
}

function BlockHead({
  title,
  count,
  actions,
  onRemove,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  onRemove: () => void;
}) {
  return (
    <header className="dash-block-head">
      <span className="dash-block-title">{title}</span>
      {typeof count === 'number' && count > 0 && <span className="dash-block-count">{count}</span>}
      <div className="dash-block-actions">
        {actions}
        <button type="button" className="dash-block-remove" onClick={onRemove} title="Убрать блок" aria-label="Убрать блок">×</button>
      </div>
    </header>
  );
}

export function DashboardView({ onEdit }: Props) {
  const tasks = useTasks();
  const spheres = useSpheres();
  const tree = useTopics();
  const photos = useBoardPhotos();
  const notes = useBoardNotes();
  const docs = useBoardDocs();

  const [sel, setSel] = useState<Selection>(() => ({ sphere: spheres[0] ?? '', path: [] }));
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    spheres[0] ? { [nodeKeyOf(spheres[0], [])]: true } : {},
  );
  const [adding, setAdding] = useState<{ sphere: string; path: string[]; kind: 'folder' | 'note' } | null>(null);
  const [draftName, setDraftName] = useState('');
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [overNode, setOverNode] = useState<string | null>(null);
  const dragRef = useRef<{ kind: 'category' | 'folder'; id: string; name: string; sphere: string; parentPath: string[] } | null>(null);

  const [noteDraft, setNoteDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [boardError, setBoardError] = useState('');
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => startBoardSync(), []);

  useEffect(() => {
    if (!boardError) return;
    const id = window.setTimeout(() => setBoardError(''), 6000);
    return () => window.clearTimeout(id);
  }, [boardError]);

  // Entries made before the dashboard had nodes carry no nodeKey: park them in
  // the first category so nothing disappears.
  useEffect(() => {
    if (!spheres.length) return;
    claimOrphans(nodeKeyOf(spheres[0], []));
  }, [spheres]);

  // Old categories/folders kept blocks of their own; containers hold nothing
  // now, so those blocks move into a «страница» child. Runs once the picture
  // bytes have been moved out of localStorage (otherwise the writes hit the
  // quota) and again whenever the task list grows — a task that arrives from
  // the server without a page would be invisible.
  useEffect(() => {
    let cancelled = false;
    void hydrateBoard().then(() => {
      if (cancelled) return;
      retryLocalPersist();
      upgradeDashboardModel();
    });
    return () => { cancelled = true; };
  }, [tasks.length, spheres.length]);

  // Keep the selection valid when categories/folders vanish (deleted here or
  // on the other device).
  useEffect(() => {
    if (!spheres.length) {
      if (sel.sphere) setSel({ sphere: '', path: [] });
      return;
    }
    if (!spheres.includes(sel.sphere)) {
      setSel({ sphere: spheres[0], path: [] });
      return;
    }
    if (!sel.path.length) return;
    let path = sel.path;
    while (path.length && !nodeAt(tree[sel.sphere]?.children ?? [], path)) path = path.slice(0, -1);
    if (path.length !== sel.path.length) setSel({ sphere: sel.sphere, path });
  }, [spheres, tree, sel.sphere, sel.path]);

  const counts = useMemo(() => {
    const bySphere: Record<string, number> = {};
    const byNode: Record<string, number> = {};
    for (const task of tasks) {
      if (task.startDate || !task.sphere || task.completed) continue;
      bySphere[task.sphere] = (bySphere[task.sphere] ?? 0) + 1;
      const parts = keyPath(task.topic);
      for (let i = 1; i <= parts.length; i++) {
        const key = nodeKeyOf(task.sphere, parts.slice(0, i));
        byNode[key] = (byNode[key] ?? 0) + 1;
      }
    }
    return { bySphere, byNode };
  }, [tasks]);

  const category = tree[sel.sphere];
  const current: TreeNode | null = sel.path.length ? nodeAt(category?.children ?? [], sel.path) : null;
  const isNote = current?.kind === 'note';
  const noteDoc = isNote ? docs.find((item) => item.id === current?.noteId) ?? null : null;
  // Blocks live ONLY on a page (a category or a folder writes nothing).
  const blocks: BlockKind[] = isNote ? (current?.blocks ?? []) : [];
  const nodeKey = nodeKeyOf(sel.sphere, sel.path);
  const topicKey = sel.path.length ? pathKey(sel.path) : undefined;

  const nodeNotes = useMemo(() => notes.filter((note) => note.nodeKey === nodeKey), [notes, nodeKey]);
  const nodePhotos = useMemo(() => photos.filter((photo) => photo.nodeKey === nodeKey), [photos, nodeKey]);
  const list = useMemo(
    () => sortByPriority(tasks.filter((task) => {
      if (task.startDate || !task.sphere || task.completed) return false;
      if (task.sphere !== sel.sphere) return false;
      return inSubtree(task.topic, sel.path);
    })),
    [tasks, sel.sphere, sel.path],
  );

  const canNest = (path: string[]) => canAddChild(path);
  // A category holds folders only; pages appear from the first folder down.
  const canPage = (path: string[]) => canHoldPages(path) && canAddPage(path);

  const select = (sphere: string, path: string[]) => {
    setSel({ sphere, path });
    setAddingTask(false);
    setPaletteOpen(false);
    setRenaming(false);
    setConfirmDelete(false);
    setAdding(null);
    setExpanded((prev) => {
      const next = { ...prev, [nodeKeyOf(sphere, [])]: true };
      for (let i = 1; i <= path.length; i++) next[nodeKeyOf(sphere, path.slice(0, i))] = true;
      return next;
    });
  };

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const startAdd = (sphere: string, parentPath: string[], kind: 'folder' | 'note' = 'folder') => {
    if (kind === 'note' ? !canPage(parentPath) : !canAddChild(parentPath)) return;
    setAdding({ sphere, path: parentPath, kind });
    setDraftName('');
    setExpanded((prev) => {
      const next = { ...prev };
      for (let i = 0; i <= parentPath.length; i++) next[nodeKeyOf(sphere, parentPath.slice(0, i))] = true;
      return next;
    });
  };

  const commitAdd = () => {
    if (!adding) return;
    const kind = adding.kind;
    const name = kind === 'note' ? (draftName.trim() || 'без названия') : draftName.trim();
    if (name) {
      const siblings = adding.path.length
        ? (nodeAt(tree[adding.sphere]?.children ?? [], adding.path)?.children ?? [])
        : (tree[adding.sphere]?.children ?? []);
      if (!siblings.some((node) => node.name === name)) {
        if (kind === 'note') {
          // The checklist lives in a document; the tree only keeps the title.
          const nodeKey = nodeKeyOf(adding.sphere, [...adding.path, name]);
          const item = addBoardDoc(name, nodeKey);
          store.addNote(adding.sphere, adding.path, name, item.id);
        } else {
          store.addTopic(adding.sphere, name, adding.path);
        }
        select(adding.sphere, [...adding.path, name]);
      }
    }
    setAdding(null);
    setDraftName('');
  };

  const commitCategory = () => {
    const name = newCategory.trim();
    if (name && !spheres.includes(name)) {
      store.addSphere(name);
      select(name, []);
    }
    setNewCategory('');
    setCreatingCategory(false);
  };

  const addBlock = (kind: BlockKind) => {
    store.setBlocks(sel.sphere, sel.path, [...blocks, kind]);
    setPaletteOpen(false);
  };

  const removeBlock = (kind: BlockKind) => {
    store.setBlocks(sel.sphere, sel.path, blocks.filter((block) => block !== kind));
  };

  const commitRename = (value: string) => {
    const name = value.trim();
    setRenaming(false);
    if (!name || !sel.sphere) return;
    if (!sel.path.length) {
      if (name !== sel.sphere) {
        store.renameSphere(sel.sphere, name);
        setSel((prev) => ({ ...prev, sphere: name }));
      }
      return;
    }
    if (name === sel.path[sel.path.length - 1]) return;
    const node = nodeAt(tree[sel.sphere]?.children ?? [], sel.path);
    const nextPath = [...sel.path.slice(0, -1), name];
    const oldKey = nodeKeyOf(sel.sphere, sel.path);
    store.renameTopic(sel.sphere, sel.path, name);
    if (node?.kind === 'note') {
      if (node.noteId) saveBoardDoc(node.noteId, { title: name });
    }
    // Stickers, pictures and documents are keyed by the PATH OF NAMES: without
    // this the renamed folder (or note) would lose all of them.
    rekeyNode(oldKey, nodeKeyOf(sel.sphere, nextPath));
    setSel((prev) => ({ ...prev, path: nextPath }));
  };

  const deleteSelected = () => {
    setConfirmDelete(false);
    if (!sel.sphere) return;
    if (!sel.path.length) {
      // The notes inside the category go with it; their planned tasks stay.
      removeDocsUnder(nodeKeyOf(sel.sphere, []));
      store.removeSphere(sel.sphere);
      setSel({ sphere: '', path: [] });
      return;
    }
    const node = nodeAt(tree[sel.sphere]?.children ?? [], sel.path);
    const key = nodeKeyOf(sel.sphere, sel.path);
    store.removeTopic(sel.sphere, sel.path);
    if (node?.kind === 'note') {
      if (node.noteId) removeBoardItem(node.noteId);
    } else {
      // Note-documents inside the deleted folder go with it (the tasks they
      // planned to a day stay — those are real tasks now); stickers and
      // pictures move one level up instead of becoming unreachable.
      removeDocsUnder(key);
      rekeyNode(key, nodeKeyOf(sel.sphere, sel.path.slice(0, -1)));
    }
    setSel({ sphere: sel.sphere, path: sel.path.slice(0, -1) });
  };

  const submitNote = () => {
    if (!noteDraft.trim()) return;
    addBoardNote(noteDraft, NOTE_COLORS[nodeNotes.length % NOTE_COLORS.length], nodeKey);
    setNoteDraft('');
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    setBoardError('');
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        const data = await fileToDataUrl(file);
        const result = addBoardPhoto(data, '', nodeKey);
        if (!result.ok) {
          setBoardError(result.message);
          break;
        }
      }
    } catch {
      setBoardError('не получилось прочитать фото');
    } finally {
      setUploading(false);
    }
  };

  const dropTask = (event: DragEvent, sphere: string, path: string[]): boolean => {
    const taskId = event.dataTransfer.getData('text/task-id');
    if (!taskId) return false;
    store.update(taskId, {
      sphere,
      topic: path.length ? pathKey(path) : undefined,
      unplanned: false,
    });
    return true;
  };

  /** `acceptTask` is true only on a page: tasks are filed to pages now, so a
   *  category or folder must not swallow a dragged task. */
  const rowDragProps = (payload: {
    kind: 'category' | 'folder';
    id: string;
    name: string;
    sphere: string;
    parentPath: string[];
    acceptTask?: boolean;
  }) => ({
    draggable: true,
    onDragStart: (event: DragEvent) => {
      dragRef.current = payload;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/node-id', payload.id);
    },
    onDragEnd: () => {
      dragRef.current = null;
      setOverNode(null);
    },
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes('text/task-id')) {
        if (!payload.acceptTask) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setOverNode(payload.id);
        return;
      }
      const active = dragRef.current;
      if (!active || active.id === payload.id || active.kind !== payload.kind) return;
      if (
        active.kind === 'folder'
        && (active.sphere !== payload.sphere || pathKey(active.parentPath) !== pathKey(payload.parentPath))
      ) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setOverNode(payload.id);
    },
    onDragLeave: (event: DragEvent) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const { clientX: x, clientY: y } = event;
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
        setOverNode((prev) => (prev === payload.id ? null : prev));
      }
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // The path is built from NAMES (tasks reference names), never from ids.
      const path = payload.kind === 'category' ? [] : [...payload.parentPath, payload.name];
      if (payload.acceptTask && dropTask(event, payload.sphere, path)) {
        setOverNode(null);
        return;
      }
      const active = dragRef.current;
      if (active && active.kind === payload.kind && active.id !== payload.id) {
        if (active.kind === 'category') {
          setOverNode(null);
          dragRef.current = null;
          store.reorderSpheres(reorderIds(spheres, active.id, payload.id));
          return;
        }
        if (active.sphere === payload.sphere) {
          const siblings = (nodeAt(tree[payload.sphere]?.children ?? [], active.parentPath)?.children ?? [])
            .map((node) => node.id);
          store.reorderTopics(payload.sphere, reorderIds(siblings, active.id, payload.id), active.parentPath);
        }
      }
      dragRef.current = null;
      setOverNode(null);
    },
  });

  const renderFolders = (sphere: string, nodes: TreeNode[], parentPath: string[], depth: number): ReactNode => (
    <>
      {nodes.map((node) => {
        const path = [...parentPath, node.name];
        const key = nodeKeyOf(sphere, path);
        const note = node.kind === 'note';
        const open = !note && !!expanded[key];
        const active = sel.sphere === sphere && pathKey(sel.path) === pathKey(path);
        const count = counts.byNode[key] ?? 0;
        const can = !note && canNest(path);
        return (
          <div className="dash-node" key={node.id}>
            <div
              className={[
                'dash-node-row',
                'dash-folder-row',
                active ? 'active' : '',
                overNode === node.id ? 'drop' : '',
              ].join(' ')}
              style={{ paddingLeft: 4 + depth * 10 }}
              onClick={() => select(sphere, path)}
              {...rowDragProps({
              kind: 'folder',
              id: node.id,
              name: node.name,
              sphere,
              parentPath,
              acceptTask: note,
            })}
            >
              {note ? (
                <span className="dash-note-glyph" aria-hidden>
                  <svg width="11" height="12" viewBox="0 0 12 13">
                    <path d="M2.5 1.5h4l3 3v7h-7z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                    <path d="M6.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : node.children.length === 0 ? (
                // No children yet → no arrow at all (the user's rule).
                <span className="dash-chev-empty" aria-hidden />
              ) : (
                <button
                  type="button"
                  className={`dash-chev ${open ? 'open' : ''}`}
                  onClick={(event) => { event.stopPropagation(); toggle(key); }}
                  aria-label={open ? 'Свернуть' : 'Показать вложенные папки'}
                  title={open ? 'Свернуть' : 'Вложенные папки'}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                    <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              <span className="dash-node-name">{node.name}</span>
              {count > 0 && <span className="dash-node-count">{count}</span>}
              {can && (
                <button
                  type="button"
                  className="dash-node-plus"
                  onClick={(event) => { event.stopPropagation(); startAdd(sphere, path); }}
                  aria-label="Вложенная папка"
                  title="Вложенная папка"
                >+</button>
              )}
            </div>
            {open && !note && node.children.length > 0 && renderFolders(sphere, node.children, path, depth + 1)}
            {open && !note && adding && adding.sphere === sphere && pathKey(adding.path) === pathKey(path) && (
              <input
                autoFocus
                className="dash-sub-input"
                style={{ marginLeft: 8 + (depth + 1) * 10 }}
                value={draftName}
                placeholder="папка"
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={commitAdd}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitAdd();
                  if (event.key === 'Escape') { setAdding(null); setDraftName(''); }
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );

  const blockKinds: BlockKind[] = ['tasks', 'notes', 'moodboard'];
  const missing = blockKinds.filter((kind) => !blocks.includes(kind));
  const photo = (value: string | null) => nodePhotos.find((item) => item.id === value);

  const renderBlocks = () => (
            <div className="dash-blocks">
              {blocks.map((kind) => {
                if (kind === 'tasks') {
                  return (
                    <section className="dash-block dash-block-tasks" key="tasks">
                      <BlockHead title="задачи" count={list.length} onRemove={() => removeBlock('tasks')} />
                      <div
                        className="sphere-tasks"
                        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                        onDrop={(event) => {
                          event.preventDefault();
                          dropTask(event, sel.sphere, sel.path);
                        }}
                      >
                        {list.map((task) => (
                          <TaskItem
                            key={task.id}
                            task={task}
                            onEdit={() => onEdit(task)}
                            onReorder={makeReorderInNode(tasks, sel.sphere, topicKey, list)}
                          />
                        ))}
                        {addingTask ? (
                          <QuickAdd sphere={sel.sphere} topic={topicKey} onDone={() => setAddingTask(false)} />
                        ) : (
                          <div className="add-line" onClick={() => setAddingTask(true)}>+ задача</div>
                        )}
                        {!list.length && !addingTask && (
                          <div className="dash-hint-line">в этом месте пока нет задач</div>
                        )}
                      </div>
                    </section>
                  );
                }
                if (kind === 'notes') {
                  return (
                    <section className="dash-block dash-block-notes" key="notes">
                      <BlockHead title="стикеры" count={nodeNotes.length} onRemove={() => removeBlock('notes')} />
                      <div className="dash-note-new">
                        <textarea
                          value={noteDraft}
                          placeholder="новая карточка — Enter, чтобы добавить"
                          rows={2}
                          onChange={(event) => setNoteDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault();
                              submitNote();
                            }
                          }}
                        />
                        <button type="button" className="dash-note-add" onClick={submitNote} disabled={!noteDraft.trim()} aria-label="Добавить заметку">+</button>
                      </div>
                      <div className="dash-note-list">
                        {nodeNotes.map((note) => (
                          <NoteCard key={note.id} id={note.id} text={note.text} color={note.color} />
                        ))}
                        {!nodeNotes.length && <div className="dash-hint-line">заметки, которые жалко потерять</div>}
                      </div>
                    </section>
                  );
                }
                return (
                  <section className="dash-block dash-block-board" key="moodboard">
                    <BlockHead
                      title="мудборд"
                      count={nodePhotos.length}
                      onRemove={() => removeBlock('moodboard')}
                      actions={(
                        <>
                          <label className="dash-board-add">
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              onChange={(event) => {
                                const files = event.currentTarget.files;
                                void onFiles(files);
                                event.currentTarget.value = '';
                              }}
                            />
                            {uploading ? 'добавляю…' : '+ фото'}
                          </label>
                          <button type="button" className="dash-muted" onClick={() => void syncBoard()} title="Обновить мудборд и заметки">⟳</button>
                        </>
                      )}
                    />
                    {nodePhotos.length ? (
                      <div className="dash-board-grid">
                        {nodePhotos.map((item) => (
                          <figure className="dash-photo" key={item.id}>
                            <img src={item.data} alt={item.caption || 'фото мудборда'} onClick={() => setLightbox(item.id)} />
                            <button type="button" className="dash-photo-del" onClick={() => removeBoardItem(item.id)} aria-label="Удалить фото" title="Удалить">×</button>
                            <input
                              className="dash-photo-caption"
                              defaultValue={item.caption}
                              placeholder="подпись"
                              onBlur={(event) => updateBoardPhoto(item.id, { caption: event.currentTarget.value })}
                              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                            />
                          </figure>
                        ))}
                      </div>
                    ) : (
                      <label className="dash-board-empty">
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(event) => {
                            const files = event.currentTarget.files;
                            void onFiles(files);
                            event.currentTarget.value = '';
                          }}
                        />
                        <span>здесь собираются картинки, которые тебе нравятся</span>
                        <span className="dash-board-empty-cta">{uploading ? 'добавляю…' : '+ добавить фото'}</span>
                      </label>
                    )}
                    {boardError && <div className="dash-board-status">{boardError}</div>}
                  </section>
                );
              })}

              {!blocks.length && (
                <div className="dash-empty">
                  <div className="dash-empty-title">пока здесь пусто</div>
                  <div className="dash-empty-text">
                    страница пустая — добавь блок: задачи, стикеры или мудборд.
                  </div>
                  <div className="dash-empty-actions">
                    {blockKinds.map((kind) => (
                      <button key={kind} type="button" className="dash-empty-btn" onClick={() => addBlock(kind)}>
                        <span className="dash-empty-name">{BLOCK_LABEL[kind]}</span>
                        <span className="dash-empty-hint">{BLOCK_HINT[kind]}</span>
                      </button>
                    ))}

                  </div>
                </div>
              )}
            </div>
  );

  return (
    <div className="dashboard">
      <aside className="dash-rail" aria-label="Категории и папки">
        <div className="dash-rail-head">
          <span>категории</span>
          <button type="button" className="dash-rail-add" onClick={() => setCreatingCategory(true)} aria-label="Новая категория" title="Новая категория">+</button>
        </div>

        <div className="dash-rail-list">
          {spheres.map((sphere) => {
            const open = !!expanded[nodeKeyOf(sphere, [])];
            const active = sel.sphere === sphere && !sel.path.length;
            const count = counts.bySphere[sphere] ?? 0;
            return (
              <div className="dash-node" key={sphere}>
                <div
                  className={[
                    'dash-node-row',
                    active ? 'active' : '',
                    overNode === sphere ? 'drop' : '',
                  ].join(' ')}
                  onClick={() => select(sphere, [])}
                  {...rowDragProps({ kind: 'category', id: sphere, name: sphere, sphere, parentPath: [] })}
                >
                  {(tree[sphere]?.children.length ?? 0) > 0 ? (
                    <button
                      type="button"
                      className={`dash-chev ${open ? 'open' : ''}`}
                      onClick={(event) => { event.stopPropagation(); toggle(nodeKeyOf(sphere, [])); }}
                      aria-label={open ? 'Свернуть папки' : 'Показать папки'}
                      title={open ? 'Свернуть' : 'Папки'}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                        <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  ) : (
                    <span className="dash-chev-empty" aria-hidden />
                  )}
                  <span className="dash-node-name">{sphere}</span>
                  {count > 0 && <span className="dash-node-count">{count}</span>}
                  {canNest([]) && (
                    <button
                      type="button"
                      className="dash-node-plus"
                      onClick={(event) => { event.stopPropagation(); startAdd(sphere, []); }}
                      aria-label="Папка в категории"
                      title="Папка в категории"
                    >+</button>
                  )}
                </div>
                {open && renderFolders(sphere, tree[sphere]?.children ?? [], [], 1)}
                {open && adding && adding.sphere === sphere && !adding.path.length && (
                  <input
                    autoFocus
                    className="dash-sub-input"
                    value={draftName}
                    placeholder="папка"
                    onChange={(event) => setDraftName(event.target.value)}
                    onBlur={commitAdd}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitAdd();
                      if (event.key === 'Escape') { setAdding(null); setDraftName(''); }
                    }}
                  />
                )}
              </div>
            );
          })}

          {creatingCategory && (
            <input
              autoFocus
              className="dash-rail-input"
              value={newCategory}
              placeholder="категория"
              onChange={(event) => setNewCategory(event.target.value)}
              onBlur={commitCategory}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitCategory();
                if (event.key === 'Escape') { setNewCategory(''); setCreatingCategory(false); }
              }}
            />
          )}

          {!spheres.length && !creatingCategory && (
            <button type="button" className="dash-rail-empty" onClick={() => setCreatingCategory(true)}>
              пока пусто — создай первую категорию
            </button>
          )}
        </div>

        <div className="dash-rail-hint">
          категория держит папки, папка — страницы, а всё содержимое живёт
          на странице. пункт страницы можно поставить в план на конкретный день.
        </div>
      </aside>

      <div className="dash-main">
        <section className="dash-page">
          <header className="dash-page-head">
            {sel.sphere ? (
              <>
                <div className="dash-crumbs">
                  {renaming ? (
                    <input
                      autoFocus
                      className="dash-rename"
                      defaultValue={sel.path.length ? sel.path[sel.path.length - 1] : sel.sphere}
                      onBlur={(event) => commitRename(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') {
                          event.currentTarget.value = sel.path.length ? sel.path[sel.path.length - 1] : sel.sphere;
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="dash-crumb"
                        onClick={() => (sel.path.length ? select(sel.sphere, []) : setRenaming(true))}
                        title={sel.path.length ? 'К категории' : 'Переименовать категорию'}
                      >
                        {sel.sphere}
                      </button>
                      {sel.path.map((name, at) => {
                        const path = sel.path.slice(0, at + 1);
                        const last = at === sel.path.length - 1;
                        return (
                          <span className="dash-crumb-group" key={`${name}-${at}`}>
                            <span className="dash-crumb-sep">/</span>
                            <button
                              type="button"
                              className={`dash-crumb ${last ? 'last' : ''}`}
                              onClick={() => (last ? setRenaming(true) : select(sel.sphere, path))}
                              title={last ? 'Переименовать' : 'К этой папке'}
                            >
                              {name}
                            </button>
                          </span>
                        );
                      })}
                    </>
                  )}
                </div>

                {isNote && <span className="dash-page-count">{list.length}</span>}

                <div className="dash-page-actions">
                  {isNote && missing.length > 0 && (
                    <div className="dash-add-wrap">
                      <button
                        type="button"
                        className="dash-add-block"
                        onClick={() => setPaletteOpen((prev) => !prev)}
                        aria-expanded={paletteOpen}
                      >
                        + блок
                      </button>
                      {paletteOpen && (
                        <>
                          <div className="dash-palette-backdrop" onClick={() => setPaletteOpen(false)} />
                          <div className="dash-palette" role="menu">
                            {missing.map((kind) => (
                              <button
                                key={kind}
                                type="button"
                                className="dash-palette-item"
                                role="menuitem"
                                onClick={() => addBlock(kind)}
                              >
                                <span className="dash-palette-name">{BLOCK_LABEL[kind]}</span>
                                <span className="dash-palette-hint">{BLOCK_HINT[kind]}</span>
                              </button>
                            ))}
                            {canNest(sel.path) && (
                              <button
                                type="button"
                                className="dash-palette-item"
                                role="menuitem"
                                onClick={() => { setPaletteOpen(false); startAdd(sel.sphere, sel.path); }}
                              >
                                <span className="dash-palette-name">папка</span>
                                <span className="dash-palette-hint">вложенная папка внутри этой</span>
                              </button>
                            )}

                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {confirmDelete ? (
                    <>
                      <button type="button" className="dash-danger" onClick={deleteSelected}>
                        {sel.path.length
                          ? (isNote ? 'удалить страницу' : 'удалить папку')
                          : 'удалить категорию'}
                      </button>
                      <button type="button" className="dash-cancel" onClick={() => setConfirmDelete(false)}>отмена</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="dash-delete"
                      onClick={() => setConfirmDelete(true)}
                      title="Удалить"
                      aria-label="Удалить"
                    >
                      <svg width="11" height="12" viewBox="0 0 12 13" aria-hidden>
                        <path d="M1.5 3.2h9M4.2 3.2V1.6h3.6v1.6M2.9 3.2l.7 8.2h4.8l.7-8.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      удалить
                    </button>
                  )}
                </div>
              </>
            ) : (
              <span className="dash-panel-title">дашборд</span>
            )}
          </header>

          {sel.sphere ? (
            isNote ? (
              noteDoc ? (
                <>
                <NoteEditor
                  key={noteDoc.id}
                  doc={noteDoc}
                  sphere={sel.sphere}
                  topic={pathKey(sel.path)}
                  onTitleChange={commitRename}
                />
                {renderBlocks()}
                </>
              ) : (
                <div className="dash-hint-line">
                  эта страница не найдена — возможно, её удалили на другом устройстве
                </div>
              )
            ) : (
              <div className="dash-container">
                <div className="dash-container-text">
                  {sel.path.length
                    ? 'в папке ничего не пишется: она только держит страницы'
                    : 'категория держит только папки — всё содержимое живёт на страницах'}
                </div>
                <div className="dash-container-actions">
                  {canNest(sel.path) && (
                    <button type="button" className="dash-primary" onClick={() => startAdd(sel.sphere, sel.path)}>
                      + папка
                    </button>
                  )}
                  {canPage(sel.path) && (
                    <button type="button" className="dash-primary" onClick={() => startAdd(sel.sphere, sel.path, 'note')}>
                      + страница
                    </button>
                  )}
                </div>
                {(sel.path.length ? (current?.children ?? []) : (category?.children ?? [])).length > 0 ? (
                  <div className="dash-children">
                    {(sel.path.length ? (current?.children ?? []) : (category?.children ?? [])).map((child) => (
                      <button
                        type="button"
                        className="dash-child"
                        key={child.id}
                        onClick={() => select(sel.sphere, [...sel.path, child.name])}
                      >
                        <span className={`dash-child-icon ${child.kind}`} aria-hidden>
                          {child.kind === 'note' ? '▤' : '▸'}
                        </span>
                        <span className="dash-child-name">{child.name}</span>
                        <span className="dash-child-kind">{child.kind === 'note' ? 'страница' : 'папка'}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="dash-container-empty">пока пусто — создай первую</div>
                )}
              </div>
            )
          ) : (
            <div className="dash-hint-line">создай категорию слева — внутри неё собираются блоки</div>
          )}
        </section>
      </div>

      {lightbox && photo(lightbox) && (
        <div className="dash-lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Фото мудборда">
          <img src={photo(lightbox)!.data} alt={photo(lightbox)!.caption || 'фото мудборда'} />
          {photo(lightbox)!.caption && <div className="dash-lightbox-caption">{photo(lightbox)!.caption}</div>}
          <button type="button" className="dash-lightbox-close" onClick={() => setLightbox(null)} aria-label="Закрыть">×</button>
        </div>
      )}
    </div>
  );
}
