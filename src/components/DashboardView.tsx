import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../types';
import { DEFAULT_TOPIC } from '../types';
import { TaskItem } from './TaskItem';
import { store, useSpheres, useTasks, useTopics } from '../store';
import { sortByPriority } from '../utils/date';
import {
  NOTE_COLORS,
  addBoardNote,
  addBoardPhoto,
  removeBoardItem,
  startBoardSync,
  syncBoard,
  updateBoardNote,
  updateBoardPhoto,
  useBoardNotes,
  useBoardPhotos,
} from '../lib/board';
import { fileToDataUrl } from '../lib/image';

interface Props {
  onEdit: (task: Task) => void;
}

function makeReorderInTopic(tasks: Task[], sphere: string, topic: string, list: Task[]) {
  return (draggedId: string, targetId: string, place: 'above' | 'below') => {
    const dragged = tasks.find((task) => task.id === draggedId);
    const topicValue = topic === DEFAULT_TOPIC ? undefined : topic;
    if (dragged && (dragged.unplanned || dragged.sphere !== sphere || dragged.topic !== topicValue)) {
      store.update(draggedId, { sphere, topic: topicValue, unplanned: false });
    }
    const ids = list.map((task) => task.id).filter((id) => id !== draggedId);
    let index = ids.indexOf(targetId);
    if (index < 0) index = ids.length;
    else if (place === 'below') index += 1;
    ids.splice(index, 0, draggedId);
    store.reorder(ids);
  };
}

function QuickAdd({ sphere, topic, onDone }: { sphere: string; topic: string; onDone: () => void }) {
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
      store.add({ title, sphere, topic: topic === DEFAULT_TOPIC ? undefined : topic, unplanned: true });
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

type Selection = { sphere: string; topic: string | null };
type DragKind = 'sphere' | 'topic';
type DragPayload = { kind: DragKind; value: string; sphere: string };

export function DashboardView({ onEdit }: Props) {
  const tasks = useTasks();
  const spheres = useSpheres();
  const topics = useTopics();
  const photos = useBoardPhotos();
  const notes = useBoardNotes();

  const [sel, setSel] = useState<Selection>(() => ({ sphere: spheres[0] ?? '', topic: null }));
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    spheres[0] ? { [spheres[0]]: true } : {},
  );
  const [addingTask, setAddingTask] = useState(false);
  const [creatingSphere, setCreatingSphere] = useState(false);
  const [newSphere, setNewSphere] = useState('');
  const [creatingTopic, setCreatingTopic] = useState(false);
  const [newTopic, setNewTopic] = useState('');
  const [renameTarget, setRenameTarget] = useState<DragKind | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<'sphere' | 'topic' | null>(null);

  // Drag state: categories/topics reorder, tasks can be dropped on a node.
  const dragRef = useRef<DragPayload | null>(null);
  const [dragging, setDragging] = useState<{ kind: DragKind; value: string } | null>(null);
  const [over, setOver] = useState<{ kind: DragKind; value: string } | null>(null);

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

  // Keep the selection valid when categories/topics come and go (another
  // device may delete them while this tab is open).
  useEffect(() => {
    if (!spheres.length) {
      if (sel.sphere) setSel({ sphere: '', topic: null });
      return;
    }
    if (!spheres.includes(sel.sphere)) setSel({ sphere: spheres[0], topic: null });
  }, [spheres, sel.sphere]);

  useEffect(() => {
    if (!sel.sphere || !sel.topic) return;
    const list = topics[sel.sphere] ?? [];
    if (sel.topic !== DEFAULT_TOPIC && !list.includes(sel.topic)) {
      setSel({ sphere: sel.sphere, topic: null });
    }
  }, [topics, sel.sphere, sel.topic]);

  const counts = useMemo(() => {
    const bySphere: Record<string, number> = {};
    const byTopic: Record<string, number> = {};
    for (const task of tasks) {
      if (task.startDate || !task.sphere || task.completed) continue;
      bySphere[task.sphere] = (bySphere[task.sphere] ?? 0) + 1;
      const key = `${task.sphere}\u0000${task.topic || DEFAULT_TOPIC}`;
      byTopic[key] = (byTopic[key] ?? 0) + 1;
    }
    return { bySphere, byTopic };
  }, [tasks]);

  const topicCount = (sphere: string, topic: string) => counts.byTopic[`${sphere}\u0000${topic}`] ?? 0;

  const list = sortByPriority(tasks.filter((task) => {
    if (task.startDate || !task.sphere || task.completed) return false;
    if (task.sphere !== sel.sphere) return false;
    if (sel.topic !== null) return (task.topic || DEFAULT_TOPIC) === sel.topic;
    return true;
  }));

  const select = (sphere: string, topic: string | null) => {
    setSel({ sphere, topic });
    setAddingTask(false);
    setConfirmDelete(null);
    setRenameTarget(null);
    setCreatingTopic(false);
    setExpanded((prev) => ({ ...prev, [sphere]: true }));
  };

  const toggleExpanded = (sphere: string) =>
    setExpanded((prev) => ({ ...prev, [sphere]: !prev[sphere] }));

  const commitSphere = () => {
    const name = newSphere.trim();
    if (name && !spheres.includes(name)) {
      store.addSphere(name);
      setSel({ sphere: name, topic: null });
      setExpanded((prev) => ({ ...prev, [name]: true }));
    }
    setNewSphere('');
    setCreatingSphere(false);
  };

  const commitTopic = (sphere: string) => {
    const name = newTopic.trim();
    if (name) {
      store.addTopic(sphere, name);
      setSel({ sphere, topic: name });
    }
    setNewTopic('');
    setCreatingTopic(false);
  };

  const reorderList = (list: string[]) =>
    (dragged: string, target: string, place: 'above' | 'below') => {
      if (dragged === target) return undefined;
      const ids = list.filter((id) => id !== dragged);
      let at = ids.indexOf(target);
      if (at < 0) at = ids.length;
      else if (place === 'below') at += 1;
      ids.splice(at, 0, dragged);
      return ids;
    };

  const nodeDragProps = (payload: DragPayload) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      dragRef.current = payload;
      setDragging({ kind: payload.kind, value: payload.value });
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(`text/${payload.kind}-node`, payload.value);
    },
    onDragEnd: () => {
      dragRef.current = null;
      setDragging(null);
      setOver(null);
    },
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes('text/task-id')) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setOver({ kind: payload.kind, value: payload.value });
        return;
      }
      const active = dragRef.current;
      if (!active || active.kind !== payload.kind || active.value === payload.value) return;
      if (active.kind === 'topic' && active.sphere !== payload.sphere) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      setOver({ kind: payload.kind, value: payload.value });
    },
    onDragLeave: (event: React.DragEvent) => {
      const r = event.currentTarget.getBoundingClientRect();
      const { clientX: x, clientY: y } = event;
      if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) {
        setOver((prev) => (prev?.kind === payload.kind && prev.value === payload.value ? null : prev));
      }
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const taskId = event.dataTransfer.getData('text/task-id');
      if (taskId) {
        store.update(taskId, {
          sphere: payload.sphere,
          topic: payload.kind === 'topic' && payload.value !== DEFAULT_TOPIC ? payload.value : undefined,
          unplanned: false,
        });
        setOver(null);
        return;
      }
      const active = dragRef.current;
      if (active) {
        if (active.kind === 'sphere' && payload.kind === 'sphere') {
          const ids = reorderList(spheres)(active.value, payload.value, 'below');
          if (ids) store.reorderSpheres(ids);
        } else if (active.kind === 'topic' && payload.kind === 'topic' && active.sphere === payload.sphere) {
          const ids = reorderList(topics[payload.sphere] ?? [])(active.value, payload.value, 'below');
          if (ids) store.reorderTopics(payload.sphere, ids);
        }
      }
      dragRef.current = null;
      setDragging(null);
      setOver(null);
    },
  });

  const isOver = (kind: DragKind, value: string) => over?.kind === kind && over.value === value;

  const commitRename = (value: string) => {
    const name = value.trim();
    if (!name || !sel.sphere) {
      setRenameTarget(null);
      return;
    }
    if (renameTarget === 'sphere' && name !== sel.sphere) {
      store.renameSphere(sel.sphere, name);
      setSel((prev) => ({ ...prev, sphere: name }));
      setExpanded((prev) => ({ ...prev, [name]: true }));
    }
    if (renameTarget === 'topic' && sel.topic && name !== sel.topic) {
      store.renameTopic(sel.sphere, sel.topic, name);
      setSel((prev) => ({ ...prev, topic: name }));
    }
    setRenameTarget(null);
  };

  const deleteSelected = () => {
    if (confirmDelete === 'topic' && sel.topic) {
      store.removeTopic(sel.sphere, sel.topic);
      setSel({ sphere: sel.sphere, topic: null });
    } else if (confirmDelete === 'sphere' && sel.sphere) {
      store.removeSphere(sel.sphere);
      setSel({ sphere: '', topic: null });
    }
    setConfirmDelete(null);
  };

  const submitNote = () => {
    if (!noteDraft.trim()) return;
    const color = NOTE_COLORS[notes.length % NOTE_COLORS.length];
    addBoardNote(noteDraft, color);
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
        const result = addBoardPhoto(data);
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

  const quickTopic = sel.topic ?? DEFAULT_TOPIC;
  const photo = (value: string | null) => photos.find((item) => item.id === value);

  return (
    <div className="dashboard">
      <aside className="dash-rail" aria-label="Категории">
        <div className="dash-rail-head">
          <span>категории</span>
          <button type="button" className="dash-rail-add" onClick={() => setCreatingSphere(true)} aria-label="Новая категория" title="Новая категория">+</button>
        </div>

        <div className="dash-rail-list">
          {spheres.map((sphere) => {
            const open = !!expanded[sphere];
            const active = sel.sphere === sphere && sel.topic === null;
            const sphereTopics = topics[sphere] ?? [];
            return (
              <div className="dash-node" key={sphere}>
                <div
                  className={[
                    'dash-node-row',
                    active ? 'active' : '',
                    isOver('sphere', sphere) ? 'drop' : '',
                    dragging?.kind === 'sphere' && dragging.value === sphere ? 'dragging' : '',
                  ].join(' ')}
                  onClick={() => select(sphere, null)}
                  {...nodeDragProps({ kind: 'sphere', value: sphere, sphere })}
                >
                  <button
                    type="button"
                    className={`dash-chev ${open ? 'open' : ''}`}
                    onClick={(event) => { event.stopPropagation(); toggleExpanded(sphere); }}
                    aria-label={open ? 'Свернуть подкатегории' : 'Показать подкатегории'}
                    title={open ? 'Свернуть' : 'Подкатегории'}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <span className="dash-node-name">{sphere}</span>
                  {(counts.bySphere[sphere] ?? 0) > 0 && (
                    <span className="dash-node-count">{counts.bySphere[sphere]}</span>
                  )}
                </div>

                {open && (
                  <div className="dash-sub">
                    {[DEFAULT_TOPIC, ...sphereTopics].map((topic) => (
                      <button
                        key={topic}
                        type="button"
                        className={[
                          'dash-sub-row',
                          sel.sphere === sphere && sel.topic === topic ? 'active' : '',
                          isOver('topic', topic) && sel.sphere === sphere ? 'drop' : '',
                          dragging?.kind === 'topic' && dragging.value === topic ? 'dragging' : '',
                        ].join(' ')}
                        onClick={() => select(sphere, topic)}
                        {...(topic === DEFAULT_TOPIC ? {} : nodeDragProps({ kind: 'topic', value: topic, sphere }))}
                      >
                        <span className="dash-sub-name">{topic}</span>
                        {topicCount(sphere, topic) > 0 && (
                          <span className="dash-sub-count">{topicCount(sphere, topic)}</span>
                        )}
                      </button>
                    ))}
                    {creatingTopic && sel.sphere === sphere ? (
                      <input
                        autoFocus
                        className="dash-sub-input"
                        value={newTopic}
                        placeholder="подкатегория"
                        onChange={(event) => setNewTopic(event.target.value)}
                        onBlur={() => commitTopic(sphere)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitTopic(sphere);
                          if (event.key === 'Escape') { setNewTopic(''); setCreatingTopic(false); }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="dash-sub-add"
                        onClick={() => { select(sphere, null); setCreatingTopic(true); }}
                      >
                        + подкатегория
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {creatingSphere && (
            <input
              autoFocus
              className="dash-rail-input"
              value={newSphere}
              placeholder="категория"
              onChange={(event) => setNewSphere(event.target.value)}
              onBlur={commitSphere}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitSphere();
                if (event.key === 'Escape') { setNewSphere(''); setCreatingSphere(false); }
              }}
            />
          )}

          {!spheres.length && !creatingSphere && (
            <button type="button" className="dash-rail-empty" onClick={() => setCreatingSphere(true)}>
              пока пусто — создай первую категорию
            </button>
          )}
        </div>

        <div className="dash-rail-hint">перетащи задачу на категорию или подкатегорию, чтобы перенести</div>
      </aside>

      <div className="dash-main">
        <section className="dash-panel dash-tasks">
          <header className="dash-panel-head">
            {sel.sphere ? (
              <>
                {renameTarget === 'sphere' ? (
                  <input
                    autoFocus
                    className="dash-rename"
                    defaultValue={sel.sphere}
                    onBlur={(event) => commitRename(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                      if (event.key === 'Escape') { event.currentTarget.value = sel.sphere; event.currentTarget.blur(); }
                    }}
                  />
                ) : (
                  <button type="button" className="dash-crumb" onClick={() => setRenameTarget('sphere')} title="Переименовать">
                    {sel.sphere}
                  </button>
                )}
                {sel.topic && (
                  <>
                    <span className="dash-crumb-sep">/</span>
                    {renameTarget === 'topic' ? (
                      <input
                        autoFocus
                        className="dash-rename"
                        defaultValue={sel.topic}
                        onBlur={(event) => commitRename(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur();
                          if (event.key === 'Escape') { event.currentTarget.value = sel.topic ?? ''; event.currentTarget.blur(); }
                        }}
                      />
                    ) : (
                      <button type="button" className="dash-crumb" onClick={() => setRenameTarget('topic')} title="Переименовать">
                        {sel.topic}
                      </button>
                    )}
                  </>
                )}
                <span className="dash-panel-count">{list.length}</span>
                <div className="dash-panel-actions">
                  {confirmDelete ? (
                    <>
                      <button type="button" className="dash-danger" onClick={deleteSelected}>
                        {confirmDelete === 'topic' ? 'удалить подкатегорию' : 'удалить категорию'}
                      </button>
                      <button type="button" className="dash-muted" onClick={() => setConfirmDelete(null)}>отмена</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="dash-muted"
                      onClick={() => setConfirmDelete(sel.topic ? 'topic' : 'sphere')}
                    >
                      {sel.topic ? 'удалить' : 'удалить категорию'}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <span className="dash-panel-title">задачи</span>
            )}
          </header>

          {sel.sphere ? (
            <div
              className="sphere-tasks"
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData('text/task-id');
                if (!id) return;
                store.update(id, {
                  sphere: sel.sphere,
                  topic: sel.topic && sel.topic !== DEFAULT_TOPIC ? sel.topic : undefined,
                  unplanned: false,
                });
              }}
            >
              {list.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  onEdit={() => onEdit(task)}
                  onReorder={makeReorderInTopic(tasks, sel.sphere, quickTopic, list)}
                />
              ))}
              {addingTask ? (
                <QuickAdd sphere={sel.sphere} topic={quickTopic} onDone={() => setAddingTask(false)} />
              ) : (
                <div className="add-line" onClick={() => setAddingTask(true)}>+ задача</div>
              )}
              {!list.length && !addingTask && (
                <div className="dash-hint-line">
                  {sel.topic ? 'в этой подкатегории пока пусто' : 'в этой категории пока нет задач'}
                </div>
              )}
            </div>
          ) : (
            <div className="dash-hint-line">создай категорию слева — задачи собираются в неё</div>
          )}
        </section>

        <section className="dash-panel dash-notes">
          <header className="dash-panel-head">
            <span className="dash-panel-title">заметки</span>
            <span className="dash-panel-count">{notes.length}</span>
          </header>
          <div className="dash-note-new">
            <textarea
              value={noteDraft}
              placeholder="новая заметка — Enter, чтобы добавить"
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
            {notes.map((note) => (
              <NoteCard key={note.id} id={note.id} text={note.text} color={note.color} />
            ))}
            {!notes.length && <div className="dash-hint-line">заметки, которые жалко потерять</div>}
          </div>
        </section>

        <section className="dash-panel dash-board">
          <header className="dash-panel-head">
            <span className="dash-panel-title">мудборд</span>
            <span className="dash-panel-count">{photos.length}</span>
            <div className="dash-panel-actions">
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
            </div>
          </header>

          {photos.length ? (
            <div className="dash-board-grid">
              {photos.map((item) => (
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
