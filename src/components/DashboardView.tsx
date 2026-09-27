import { useState } from 'react';
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
      store.add({ title: t, sphere });
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

import { useRef } from 'react';

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

export function DashboardView({ onEdit }: Props) {
  const tasks = useTasks();
  const spheres = useSpheres();
  const [addingIn, setAddingIn] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [newSphere, setNewSphere] = useState('');
  const [creating, setCreating] = useState(false);

  // Unplanned (backlog) tasks: show them, including completed (just dimmed, not deleted).
  const bySphere = new Map<string, Task[]>();
  for (const s of spheres) bySphere.set(s, []);
  for (const t of tasks) {
    if (!t.unplanned) continue;
    if (!t.sphere || !bySphere.has(t.sphere)) continue;
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
            <div className="sphere-tasks">
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
