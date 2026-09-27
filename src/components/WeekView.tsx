import { useMemo, useState } from 'react';
import type { Task } from '../types';
import { TaskItem } from './TaskItem';
import { fmt, weekDays, taskOnDate, daysUntil, sortByPriority } from '../utils/date';
import { store, useTasks } from '../store';
import { addDays, parseISO, isSameDay } from 'date-fns';

interface Props {
  anchor: Date;
  onEdit: (task: Task) => void;
  onPickDate?: (date: Date) => void;
}

function isBlocked(t: Task, all: Task[]): boolean {
  if (!t.dependsOnTaskId) return false;
  const dep = all.find((x) => x.id === t.dependsOnTaskId);
  return !!dep && !dep.completed;
}

function plural(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'день';
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'дня';
  return 'дней';
}

function QuickAdd({ defaults, onDone }: { defaults: Partial<Task>; onDone: () => void }) {
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = () => {
    const t = val.trim();
    if (t) {
      store.add({ title: t, ...defaults });
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

export function WeekView({ anchor, onEdit, onPickDate }: Props) {
  const tasks = useTasks();
  const days = weekDays(anchor);
  const weekEnd = addDays(days[0], 6);
  const today = new Date();
  const [adding, setAdding] = useState<string | null>(null);

  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const d of days) {
      const iso = fmt.iso(d);
      const list = tasks.filter((t) => t.startDate && !t.unplanned && taskOnDate(t, d));
      map.set(iso, sortByPriority(list));
    }
    return map;
  }, [tasks, days]);

  const otherTasks = useMemo(() => sortByPriority(tasks.filter((t) => {
    if (t.completed) return false;
    if (!t.unplanned) return false;
    if (!t.startDate) return true;
    const d = parseISO(t.startDate);
    return d >= days[0] && d <= weekEnd;
  })), [tasks, days, weekEnd]);

  const soonTasks = useMemo(() => tasks
    .filter((t) => !t.completed && t.startDate && t.reminderDays != null)
    .map((t) => ({ t, days: daysUntil(t.startDate!) }))
    .filter(({ t, days }) => days >= 0 && days <= (t.reminderDays ?? 0))
    .sort((a, b) => a.days - b.days),
    [tasks]);

  // Reorder within a day. If the dragged task lives in another day (or the
  // backlog), first re-date it to THIS day, then position it among peers.
  const reorderInDay = (iso: string, dayTasks: Task[]) =>
    (draggedId: string, targetId: string, place: 'above' | 'below') => {
      const dragged = tasks.find((t) => t.id === draggedId);
      const target = dayTasks.find((t) => t.id === targetId);
      if (!dragged || !target) return;
      if (place === 'above' && target.priority === 'high') return;

      const inThisDay = dayTasks.some((t) => t.id === draggedId);
      if (!inThisDay) {
        store.update(draggedId, { startDate: iso, endDate: iso, unplanned: false });
      }
      const baseIds = inThisDay
        ? dayTasks.map((t) => t.id)
        : [...dayTasks.map((t) => t.id), draggedId];
      const ids = baseIds.filter((id) => id !== draggedId);
      let at = ids.indexOf(targetId);
      if (at < 0) at = ids.length;
      else if (place === 'below') at += 1;
      ids.splice(at, 0, draggedId);
      store.reorder(ids);
    };

  const renderDayCell = (d: Date) => {
    const iso = fmt.iso(d);
    const dayTasks = tasksByDay.get(iso) ?? [];
    const isToday = isSameDay(d, today);
    return (
      <div className="cell" key={iso}>
        <div className={`cell-header ${isToday ? 'today' : ''}`} onClick={() => onPickDate?.(d)}>
          <span className={`cell-title ${isToday ? 'today' : ''}`}>{fmt.dayShort(d)}</span>
          <span className={`cell-weekday ${isToday ? 'today' : ''}`}>{fmt.weekdayShort(d)}</span>
        </div>
        <div
          className="cell-body"
          onClick={() => !adding && setAdding(iso)}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData('text/task-id');
            if (id) store.update(id, { startDate: iso, endDate: iso, unplanned: false });
          }}
        >
          {dayTasks.map((t) => (
            <TaskItem
              key={t.id}
              task={t}
              date={d}
              blocked={isBlocked(t, tasks)}
              onEdit={() => onEdit(t)}
              onReorder={reorderInDay(iso, dayTasks)}
            />
          ))}
          {adding === iso
            ? <QuickAdd defaults={{ startDate: iso, endDate: iso }} onDone={() => setAdding(null)} />
            : <div className="add-line" onClick={(e) => { e.stopPropagation(); setAdding(iso); }} />}
        </div>
      </div>
    );
  };

  const workdays = days.slice(0, 5);
  const [sat, sun] = [days[5], days[6]];
  const OTHER = '__other__';

  return (
    <div className="week-grid">
      {/* Second row: backlog (left), soon, then Sat, Sun (right) */}
      <div className="week-row">
        <div className="cell">
          <div className="cell-header">
            <span className="cell-title muted">ДРУГОЕ</span>
          </div>
          <div
            className="cell-body"
            onClick={() => setAdding(OTHER)}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/task-id');
              // Dropping into "ДРУГОЕ" turns the task into an unplanned backlog item.
              if (id) store.update(id, { unplanned: true, startDate: undefined, endDate: undefined });
            }}
          >
            {otherTasks.map((t) => (
              <TaskItem key={t.id} task={t} blocked={isBlocked(t, tasks)} onEdit={() => onEdit(t)} />
            ))}
            {adding === OTHER
              ? <QuickAdd defaults={{ unplanned: true }} onDone={() => setAdding(null)} />
              : <div className="add-line" onClick={(e) => { e.stopPropagation(); setAdding(OTHER); }} />}
          </div>
        </div>

        <div className="cell">
          <div className="cell-header">
            <span className="cell-title muted">СКОРО</span>
          </div>
          <div className="cell-body no-lines">
            {soonTasks.map(({ t, days }) => (
              <div className="soon-item" key={t.id} onClick={() => onEdit(t)}>
                <span>{t.title}</span>
                <span className="days">{days === 0 ? 'сегодня' : `${days} ${plural(days)}`}</span>
              </div>
            ))}
            {soonTasks.length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 14, paddingTop: 8 }}>—</div>
            )}
          </div>
        </div>

        {renderDayCell(sat)}
        {renderDayCell(sun)}
      </div>

      {/* First row: Пн–Пт */}
      <div className="week-row">
        {workdays.map(renderDayCell)}
      </div>
    </div>
  );
}
