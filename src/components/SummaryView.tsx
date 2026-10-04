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

// A compact date label for grouped tasks: "дд месяц", or — for multi-day
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

type Scope = 'planned' | 'backlog' | 'done';

export function SummaryView({ onEdit }: Props) {
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

  // Completed = everything done (recurring or plain), grouped by completion
  // date when available, otherwise start date.
  const done = useMemo(() => sortByPriority(tasks.filter((t): t is Task => {
    if (!t.completed) return false;
    return true;
  })), [tasks]);

  const list = scope === 'planned' ? planned : scope === 'backlog' ? backlog : done;

  // For completed tasks we group by completedAt, otherwise by the main date.
  const groupKey = (t: Task): { key: string; sort: number } => {
    if (scope === 'done' && t.completedAt) {
      const d = new Date(t.completedAt + 'T00:00:00');
      return { key: monthYearKey(d), sort: monthSort(d) };
    }
    const d = mainDate(t);
    return { key: d ? monthYearKey(d) : 'Без даты', sort: d ? monthSort(d) : -1 };
  };

  // Bucket by month key, sort months ascending, sort tasks inside by date.
  const grouped = useMemo(() => {
    const map = new Map<string, { sort: number; tasks: Task[] }>();
    for (const t of list) {
      const { key, sort } = groupKey(t);
      if (!map.has(key)) map.set(key, { sort, tasks: [] });
      map.get(key)!.tasks.push(t);
    }
    return Array.from(map.values())
      .sort((a, b) => a.sort - b.sort)
      .map((g) => {
        const anyDated = g.tasks.find((t) => mainDate(t) || (t.completedAt && scope === 'done'));
        const key = anyDated ? groupKey(anyDated).key : 'Без даты';
        return { key, tasks: sortByPriority(g.tasks) };
      });
  }, [scope, planned, backlog, done]);

  const handleReorder = (grp: Task[]) =>
    (draggedId: string, targetId: string, place: 'above' | 'below') => {
      const ids = grp.map((t) => t.id).filter((id) => id !== draggedId);
      let at = ids.indexOf(targetId);
      if (at < 0) at = ids.length;
      else if (place === 'below') at += 1;
      ids.splice(at, 0, draggedId);
      store.reorder(ids);
    };

  const counts = { planned: planned.length, backlog: backlog.length, done: done.length };

  return (
    <div className="planned-list">
      <div className="planned-list-header">
        <div className="summary-scopes" role="group" aria-label="Секции">
          <button
            className={`btn ${scope === 'planned' ? 'primary' : 'ghost'}`}
            onClick={() => setScope('planned')}
          >запланированные</button>
          <button
            className={`btn ${scope === 'backlog' ? 'primary' : 'ghost'}`}
            onClick={() => setScope('backlog')}
          >бэклог</button>
          <button
            className={`btn ${scope === 'done' ? 'primary' : 'ghost'}`}
            onClick={() => setScope('done')}
          >выполненные</button>
        </div>
        <span style={{ color: 'var(--muted)', fontSize: 14, whiteSpace: 'nowrap' }}>
          всего: {counts.planned} / {counts.backlog} / {counts.done}
        </span>
      </div>

      {grouped.length === 0 && (
        <div className="planned-empty">
          {scope === 'planned'
            ? 'Нет запланированных задач — всё в бэклоге или уже выполнено'
            : scope === 'backlog'
            ? 'Бэклог пуст — перетащите сюда задачи, чтобы отложить их'
            : 'Нет выполненных задач'}
        </div>
      )}

      {grouped.map((g) => (
        <div className="planned-month" key={g.key}>
          <h3
            className="planned-month-title"
            onClick={() => toggleMonth(g.key)}
            aria-expanded={collapsed[g.key] !== true}
          >
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
                    <span className="planned-date">{d ? dateLabel(t) : scope === 'done' && t.completedAt ? `${new Date(t.completedAt).getDate()} ${shortMonth(new Date(t.completedAt).getMonth())}` : '—'}</span>
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
