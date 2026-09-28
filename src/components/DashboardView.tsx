import { useRef, useState } from 'react';
import type { Task } from '../types';
import { TaskItem } from './TaskItem';
import { store, useTasks, useSpheres } from '../store';
import { sortByPriority } from '../utils/date';

interface Props {
  onEdit: (task: Task) => void;
}

function isBlocked(t: Task, all: Task[]): boolean {
  if (!t.dependsOnTaskId) return false;
  const dep = all.find((x) => x.id === t.dependsOnTaskId);
  return !!dep && !dep.completed;
}

function QuickAdd({ sphere, onDone }: { sphere: string; onDone: () => void }) {
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = () => {
    const t = val.trim();
    if (t) {
      // New card from the dashboard is a backlog item: no date, unplanned.
      store.add({ title: t, sphere, unplanned: true });
      setVal('');
      inputRef.current?.focus();
    } else {
      onDone();
    }
  };
  const allTasks = useTasks();
  const q = val.trim().toLowerCase();
  const suggestions = q
    ? Array.from(new Set(allTasks.map((t) => t.title)))
        .filter((title) => title.toLowerCase().includes(q))
        .slice(0, 5)
    : [];
  return (
    <div className="quick-add-wrap">
      <input ref={inputRef} autoFocus className="quick-add" placeholder=""
        value={val} onChange={(e) => setVal(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') onDone(); }} />
      {suggestions.length > 0 && (
        <div className="quick-add-suggestions">
          {suggestions.map((s) => (
            <div
              key={s}
              className="search-suggestion"
              onMouseDown={(e) => { e.preventDefault(); setVal(s); }}
            >
              <span className="suggestion-title">{s}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EditableName({ value, onChange, onDelete }: { value: string; onChange: (v: string) => void; onDelete: () => void }) {
  return (
    <div className="sphere-title-inner">
      <span className="name" contentEditable suppressContentEditableWarning spellCheck={false}
        onBlur={(e) => {
          const v = e.currentTarget.textContent?.trim() ?? '';
          if (v && v !== value) onChange(v);
          else e.currentTarget.textContent = value;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); }
          if (e.key === 'Escape') { (e.currentTarget as HTMLElement).textContent = value; (e.currentTarget as HTMLElement).blur(); }
        }}
      >{value}</span>
      <button className="delete-sphere" onClick={onDelete}>×</button>
    </div>
  );
}

export function DashboardView({ onEdit, onClearAll }: Props) {
  const tasks = useTasks();
  const spheres = useSpheres();
  const [addingIn, setAddingIn] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [newSphere, setNewSphere] = useState('');
  const [creating, setCreating] = useState(false);

  // Backlog = tasks with no concrete date. Completed ones stay visible (dimmed).
  // Dashboard (backlog by category): tasks with a known sphere and no date.
  const bySphere = new Map<string, Task[]>();
  for (const s of spheres) bySphere.set(s, []);
  for (const t of tasks) {
    if (t.startDate) continue;
    if (!t.sphere || !spheres.includes(t.sphere)) continue;
    bySphere.get(t.sphere)!.push(t);
  }

  const commitNewSphere = () => {
    const v = newSphere.trim();
    if (v && !spheres.includes(v)) store.addSphere(v);
    setNewSphere('');
    setCreating(false);
  };

  return (
    <div className="dashboard">
      {spheres.map((s) => {
        const list = sortByPriority(bySphere.get(s) ?? []);
        return (
          <div className="sphere-block" key={s}>
            <div className="sphere-title">
              {editingName === s ? (
                <EditableName
                  value={s}
                  onChange={(v) => { store.renameSphere(s, v); setEditingName(null); }}
                  onDelete={() => { store.removeSphere(s); setEditingName(null); }}
                />
              ) : (
                <div className="sphere-title-inner">
                  <span className="name" onClick={() => setEditingName(s)}>{s}</span>
                  <button className="delete-sphere" onClick={() => setEditingName(s)}>×</button>
                </div>
              )}
            </div>
            <div
              className="sphere-tasks"
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/task-id');
                // Dropping a backlog task onto a category assigns it to that
                // sphere and promotes it out of the "ДРУГОЕ" backlog.
                if (id) store.update(id, { sphere: s, unplanned: false });
              }}
            >
              {list.map((t) => (
                <TaskItem key={t.id} task={t} blocked={isBlocked(t, tasks)} onEdit={() => onEdit(t)} />
              ))}
              {addingIn === s && <QuickAdd sphere={s} onDone={() => setAddingIn(null)} />}
              {addingIn !== s && (
                <div className="add-line" onClick={() => setAddingIn(s)} />
              )}
            </div>
          </div>
        );
      })}

      <div className="sphere-block new-sphere-block">
        {creating ? (
          <div className="sphere-title">
            <input
              autoFocus
              className="new-sphere-input"
              placeholder="название категории"
              value={newSphere}
              onChange={(e) => setNewSphere(e.target.value)}
              onBlur={commitNewSphere}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNewSphere();
                if (e.key === 'Escape') { setNewSphere(''); setCreating(false); }
              }}
            />
          </div>
        ) : (
          <div className="new-sphere-btn" onClick={() => setCreating(true)}>
            + категория
          </div>
        )}
      </div>
    </div>
  );
}
