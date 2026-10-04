import { useMemo, useState } from 'react';
import type { Task } from '../types';
import { useTasks, store } from '../store';
import { sortByPriority, nextOccurrence } from '../utils/date';
import { TaskItem } from './TaskItem';
import { ChevronIcon } from './icons/ChevronIcon';

interface Props {
  onEdit: (task: Task, editingDate?: string) => void;
}

function mainDate(t: Task): Date | null {
  if (t.recurrence !== 'none') {
    const iso = nextOccurrence(t);
    if (!iso) return null;
    return new Date(iso + 'T00:00:00');
  }
  if (!t.startDate) return null;
  return new Date(t.startDate + 'T00:00:00');
}

// A compact date label for grouped planned tasks: "дд месяц" or — for multi-day
// ranges — "дд–дд месяц".
function dateLabel(t: Task): string {
  const start = mainDate(t);
  if (!start) return '—';
  const s = `${start.getDate()} ${shortMonth(start.getMonth())}`;
  if (t.endDate && t.endDate !== t.startDate) {
    const e = new Date(t.endDate + 'T00:00:00');
    if (e.getMonth() === start.getMonth()) {
      return `${start.getDate()}–${e.getDate()} ${shortMonth(start.getMonth())}`;
    }
    return `${s} – ${e.getDate()} ${shortMonth(e.getMonth())}`;
  }
  return s;
}

function shortMonth(m: number): string {
  const names = ['янв', 'фев', 'март', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return names[m] ?? '';
}
function monthYearKey(date: Date): string {
  const names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  return `${names[date.getMonth()]} ${date.getFullYear()}`;
}
function monthSort(date: Date): number {
  return date.getFullYear() * 100 + date.getMonth();
}

type Scope = 'planned' | 'backlog';

export function PlannedListView({ onEdit }: Props) {
  const tasks = useTasks();
  const [scope, setScope] = useState<Scope>('planned');
  // Per-month collapse state. Default: all expanded (false).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleMonth = (key: string) =>
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  // Planned = dated & promoted (lands on day-cells in WeekView).
  // Recurring tasks only show if a future occurrence exists.
  const planned = useMemo(() => {
    const list = tasks.filter((t): t is Task => {
      if (!t.startDate || t.unplanned || t.completed) return false;
      if (t.recurrence !== 'none') return !!nextOccurrence(t);
      return true;
    });
    return sortByPriority(list);
  }, [tasks]);

  // Backlog = no-date tasks, OR dated-but-unplanned (tagged "ДРУГОЕ").
  const backlog = useMemo(() => sortByPriority(tasks.filter((t): t is Task => {
    if (t.completed) return false;
    if (!t.startDate && !t.sphere) return true; // pure no-date backlog
    if (t.startDate && t.unplanned) return true; // dated but kept in backlog
    return false;
  })), [tasks]);

  const list = scope === 'planned' ? planned : backlog;

  // Bucket by month key, sort months ascending, sort tasks inside by date.
  const grouped = useMemo(() => {
    const map = new Map<string, { sort: number; tasks: Task[] }>();
    for (const t of list) {
      const d = mainDate(t);
      // No-date backlog tasks → their own "Без даты" bucket at the top.
      const key = d ? monthYearKey(d) : 'Без даты';
      const sort = d ? monthSort(d) : -1;
      if (!map.has(key)) map.set(key, { sort, tasks: [] });
      map.get(key)!.tasks.push(t);
    }
    return Array.from(map.values())
      .sort((a, b) => a.sort - b.sort)
      .map((g) => {
        // Reconstruct the month key from any non-empty task's date (or 'Без даты').
        const anyDated = g.tasks.find((t) => mainDate(t));
        const key = anyDated ? monthYearKey(mainDate(anyDated)!) : 'Без даты';
        return { key, tasks: sortByPriority(g.tasks) };
      });
  }, [scope, planned, backlog]);

  const handleReorder = (grp: Task[]) =>
    (draggedId: string, targetId: string, place: 'above' | 'below') => {
      const ids = grp.map((t) => t.id).filter((id) => id !== draggedId);
      let at = ids.indexOf(targetId);
      if (at < 0) at = ids.length;
      else if (place === 'below') at += 1;
      ids.splice(at, 0, draggedId);
      store.reorder(ids);
    };

  return (
    <div className="planned-list">
      {/* Scope tabs: planned vs backlog */}
      <div className="planned-tabs" role="group" aria-label="Вкладки">
        <button
          className={`btn ${scope === 'planned' ? 'primary' : 'ghost'}`}
          onClick={() => setScope('planned')}
        >запланированные</button>
        <button
          className={`btn ${scope === 'backlog' ? 'primary' : 'ghost'}`}
          onClick={() => setScope('backlog')}
        >бэклог</button>
        <span style={{ color: 'var(--muted)', fontSize: 14, marginLeft: 'auto' }}>{list.length} задач</span>
      </div>

      {grouped.length === 0 && (
        <div className="planned-empty">
          {scope === 'planned'
            ? 'Нет запланированных задач — всё в бэклоге или уже выполнено'
            : 'Бэклог пуст — перетащите сюда задачи, чтобы отложить их'}
        </div>
      )}

      {grouped.map((g) => (
        <div className="planned-month" key={g.key}>
          <h3 className="planned-month-title" onClick={() => toggleMonth(g.key)} aria-expanded={collapsed[g.key] !== true}>
            <ChevronIcon dir={collapsed[g.key] ? 'left' : 'down'} style={{ marginRight: 6 }} />
            {g.key}
            <span style={{ color: 'var(--muted)', fontWeight: 500, marginLeft: 'auto' }}>{g.tasks.length} задач</span>
          </h3>
          {collapsed[g.key] !== true && (
            <div className="planned-month-days">
              {g.tasks.map((t) => {
                const d = mainDate(t);
                return (
                  <div
                    className="planned-task-row"
                    key={t.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleReorder(g.tasks)(
                        e.dataTransfer.getData('text/task-id'),
                        t.id,
                        'below'
                      );
                    }}
                  >
                    <span className="planned-date">{d ? dateLabel(t) : '—'}</span>
                    <TaskItem
                      task={t}
                      date={d ?? undefined}
                      onEdit={() => onEdit(t, t.startDate)}
                      onReorder={handleReorder(g.tasks)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
