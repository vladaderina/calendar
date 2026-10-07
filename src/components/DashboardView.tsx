import { useEffect, useRef, useState } from 'react';
import type { Task } from '../types';
import { DEFAULT_TOPIC } from '../types';
import { TaskItem } from './TaskItem';
import { store, useSpheres, useTasks, useTopics } from '../store';
import { sortByPriority } from '../utils/date';

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

function EditableName({ value, onChange, onDelete }: { value: string; onChange: (value: string) => void; onDelete: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="sphere-title-inner">
      <span
        className="name"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={(event) => {
          const next = event.currentTarget.textContent?.trim() ?? '';
          if (next && next !== value) onChange(next);
          else event.currentTarget.textContent = value;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); (event.currentTarget as HTMLElement).blur(); }
          if (event.key === 'Escape') { (event.currentTarget as HTMLElement).textContent = value; (event.currentTarget as HTMLElement).blur(); }
        }}
      >
        {value}
      </span>
      {confirmDelete ? (
        <>
          <button
            className="delete-sphere confirm"
            type="button"
            onClick={onDelete}
            aria-label="Подтвердить удаление"
            title="Удалить категорию и её топики"
          >удалить</button>
          <button
            className="delete-sphere"
            type="button"
            onClick={() => setConfirmDelete(false)}
            aria-label="Отмена"
            title="Отмена"
          >×</button>
        </>
      ) : (
        <button
          className="delete-sphere"
          type="button"
          onClick={() => setConfirmDelete(true)}
          aria-label="Удалить категорию"
          title="Удалить категорию"
        >×</button>
      )}
    </div>
  );
}

export function DashboardView({ onEdit }: Props) {
  const tasks = useTasks();
  const spheres = useSpheres();
  const topics = useTopics();
  const [activeSphere, setActiveSphere] = useState(spheres[0] ?? '');
  const [activeTopic, setActiveTopic] = useState('Основное');
  const [addingTask, setAddingTask] = useState(false);
  const [editingSphere, setEditingSphere] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [creatingSphere, setCreatingSphere] = useState(false);
  const [creatingTopic, setCreatingTopic] = useState(false);
  const [newSphere, setNewSphere] = useState('');
  const [newTopic, setNewTopic] = useState('');
  // Drag-and-drop state for reordering the category (top) and topic (inner) tabs.
  const [dragSphere, setDragSphere] = useState<string | null>(null);
  const [overSphere, setOverSphere] = useState<string | null>(null);
  const [dragTopic, setDragTopic] = useState<string | null>(null);
  const [overTopic, setOverTopic] = useState<string | null>(null);
  const [confirmDeleteSphere, setConfirmDeleteSphere] = useState(false);

  useEffect(() => {
    if (!spheres.length) return;
    if (!spheres.includes(activeSphere)) setActiveSphere(spheres[0]);
  }, [activeSphere, spheres]);

  const sphereTopics = [DEFAULT_TOPIC, ...(topics[activeSphere] ?? [])];
  useEffect(() => {
    if (!sphereTopics.includes(activeTopic)) setActiveTopic(sphereTopics[0]);
  }, [activeTopic, sphereTopics]);

  const list = sortByPriority(tasks.filter((task) => {
    if (task.startDate || task.sphere !== activeSphere) return false;
    return (task.topic || 'Основное') === activeTopic;
  }));

  const selectSphere = (sphere: string) => {
    setActiveSphere(sphere);
    setActiveTopic(DEFAULT_TOPIC);
    setAddingTask(false);
    setEditingSphere(false);
    setEditingTopic(false);
  };

  const commitSphere = () => {
    const name = newSphere.trim();
    if (name && !spheres.includes(name)) {
      store.addSphere(name);
      setActiveSphere(name);
      setActiveTopic('Основное');
    }
    setNewSphere('');
    setCreatingSphere(false);
  };

  const commitTopic = () => {
    const name = newTopic.trim();
    if (name) {
      store.addTopic(activeSphere, name);
      setActiveTopic(name);
    }
    setNewTopic('');
    setCreatingTopic(false);
  };

  // Reorder a tab list by re-splicing the visible order. `list` is the full
  // current order (for spheres it is `spheres`, for topics the sphere's topics).
  const reorderList = (list: string[]) =>
    (dragged: string, target: string, place: 'above' | 'below') => {
      if (dragged === target) return;
      const ids = list.filter((id) => id !== dragged);
      let at = ids.indexOf(target);
      if (at < 0) at = ids.length;
      else if (place === 'below') at += 1;
      ids.splice(at, 0, dragged);
      return ids;
    };

  const tabDropProps = (
    list: string[],
    value: string,
    place: 'sphere' | 'topic',
  ) => {
    const isSphere = place === 'sphere';
    const dragged = isSphere ? dragSphere : dragTopic;
    const setDragged = isSphere ? setDragSphere : setDragTopic;
    const setOver = isSphere ? setOverSphere : setOverTopic;
    return {
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', value);
        setDragged(value);
      },
      onDragEnd: () => {
        setDragged(null);
        setOver(null);
      },
      onDragOver: (event: React.DragEvent) => {
        if (!dragged || dragged === value) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setOver(value);
      },
      onDragLeave: (event: React.DragEvent) => {
        const r = event.currentTarget.getBoundingClientRect();
        const { clientX: x, clientY: y } = event;
        if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) setOver(null);
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (!dragged || dragged === value) return;
        const r = event.currentTarget.getBoundingClientRect();
        const after = event.clientX > r.left + r.width / 2;
        const ids = reorderList(list)(dragged, value, after ? 'below' : 'above');
        if (ids) {
          if (isSphere) store.reorderSpheres(ids);
          else store.reorderTopics(activeSphere, ids);
        }
        setOver(null);
      },
    };
  };

  return (
    <div className="dashboard">
      <div className="dashboard-sphere-tabs" role="tablist" aria-label="Категории">
        {spheres.map((sphere) => (
          <button
            key={sphere}
            type="button"
            className={`dashboard-tab ${sphere === activeSphere ? 'active' : ''} ${overSphere === sphere ? 'drop-target' : ''} ${dragSphere === sphere ? 'dragging' : ''}`}
            onClick={() => selectSphere(sphere)}
            role="tab"
            aria-selected={sphere === activeSphere}
            {...tabDropProps(spheres, sphere, 'sphere')}
          >
            {sphere}
          </button>
        ))}
        {creatingSphere ? (
          <input
            autoFocus
            className="dashboard-tab-input"
            value={newSphere}
            placeholder="категория"
            onChange={(event) => setNewSphere(event.target.value)}
            onBlur={commitSphere}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitSphere();
              if (event.key === 'Escape') { setNewSphere(''); setCreatingSphere(false); }
            }}
          />
        ) : (
          <button type="button" className="dashboard-add-tab" onClick={() => setCreatingSphere(true)} aria-label="Новая категория">+</button>
        )}
      </div>

      {activeSphere && (
        <div className="dashboard-list">
          <section className="sphere-block">
            <header className="sphere-title">
              {editingSphere ? (
                <EditableName
                  value={activeSphere}
                  onChange={(name) => { store.renameSphere(activeSphere, name); setActiveSphere(name); setEditingSphere(false); }}
                  onDelete={() => { store.removeSphere(activeSphere); setEditingSphere(false); setConfirmDeleteSphere(false); }}
                />
              ) : (
                <div className="sphere-title-inner">
                  <span className="name" onClick={() => setEditingSphere(true)}>{activeSphere}</span>
                  {confirmDeleteSphere ? (
                    <>
                      <button
                        className="delete-sphere confirm"
                        type="button"
                        onClick={() => { store.removeSphere(activeSphere); setConfirmDeleteSphere(false); }}
                        title="Удалить категорию и её топики"
                      >удалить</button>
                      <button
                        className="delete-sphere"
                        type="button"
                        onClick={() => setConfirmDeleteSphere(false)}
                        aria-label="Отмена"
                      >×</button>
                    </>
                  ) : (
                    <button
                      className="delete-sphere"
                      type="button"
                      onClick={() => setConfirmDeleteSphere(true)}
                      aria-label="Удалить категорию"
                      title="Удалить категорию"
                    >×</button>
                  )}
                </div>
              )}
            </header>

            <div className="dashboard-topic-tabs" role="tablist" aria-label="Топики">
              {sphereTopics.map((topic) => (
                <button
                  key={topic}
                  type="button"
                  className={`dashboard-topic-tab ${topic === activeTopic ? 'active' : ''} ${overTopic === topic ? 'drop-target' : ''} ${dragTopic === topic ? 'dragging' : ''}`}
                  onClick={() => { setActiveTopic(topic); setAddingTask(false); setEditingTopic(false); }}
                  role="tab"
                  aria-selected={topic === activeTopic}
                  {...(topic === DEFAULT_TOPIC
                    ? {}
                    : tabDropProps(sphereTopics.filter((t) => t !== DEFAULT_TOPIC), topic, 'topic'))}
                >
                  {topic}
                </button>
              ))}
              {creatingTopic ? (
                <input
                  autoFocus
                  className="dashboard-topic-input"
                  value={newTopic}
                  placeholder="топик"
                  onChange={(event) => setNewTopic(event.target.value)}
                  onBlur={commitTopic}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitTopic();
                    if (event.key === 'Escape') { setNewTopic(''); setCreatingTopic(false); }
                  }}
                />
              ) : (
                <button type="button" className="dashboard-add-topic" onClick={() => setCreatingTopic(true)} aria-label="Новый топик">+</button>
              )}
              {activeTopic !== 'Основное' && (
                <button type="button" className="dashboard-topic-settings" onClick={() => setEditingTopic(!editingTopic)} aria-label="Настроить топик">···</button>
              )}
            </div>

            {editingTopic && activeTopic !== 'Основное' && (
              <div className="topic-edit-row">
                <input
                  autoFocus
                  defaultValue={activeTopic}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      const name = event.currentTarget.value.trim();
                      if (name) { store.renameTopic(activeSphere, activeTopic, name); setActiveTopic(name); }
                      setEditingTopic(false);
                    }
                    if (event.key === 'Escape') setEditingTopic(false);
                  }}
                  onBlur={(event) => {
                    const name = event.currentTarget.value.trim();
                    if (name && name !== activeTopic) { store.renameTopic(activeSphere, activeTopic, name); setActiveTopic(name); }
                  }}
                />
                <button type="button" onClick={() => { store.removeTopic(activeSphere, activeTopic); setActiveTopic('Основное'); setEditingTopic(false); }}>удалить топик</button>
              </div>
            )}

            <div
              className="sphere-tasks"
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData('text/task-id');
                if (id) store.update(id, { sphere: activeSphere, topic: activeTopic === DEFAULT_TOPIC ? undefined : activeTopic, unplanned: false });
              }}
            >
              {list.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  onEdit={() => onEdit(task)}
                  onReorder={makeReorderInTopic(tasks, activeSphere, activeTopic, list)}
                />
              ))}
              {addingTask ? (
                <QuickAdd sphere={activeSphere} topic={activeTopic} onDone={() => setAddingTask(false)} />
              ) : (
                <div className="add-line" onClick={() => setAddingTask(true)} />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
