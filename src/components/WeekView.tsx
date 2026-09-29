import { useMemo, useState } from 'react';
import type { Task } from '../types';
import { TaskItem } from './TaskItem';
import { fmt, weekDays, taskOnDate, daysUntil, sortByPriority, nextOccurrence } from '../utils/date';
import { store, useTasks } from '../store';
import { addDays, differenceInCalendarDays, format, parseISO, isSameDay } from 'date-fns';

interface Props {
  anchor: Date;
  onEdit: (task: Task, editingDate?: string) => void;
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
  const today = new Date();
  const [adding, setAdding] = useState<string | null>(null);

  // Day-cell tasks: dated tasks that are PROMOTED (unplanned=false), i.e.
  // scheduled straight onto a day. Tasks still tagged "ДРУГОЕ" (unplanned=true)
  // with a date range live ONLY in the "ДРУГОЕ" panel below — not here.
  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const d of days) {
      const iso = fmt.iso(d);
      const list = tasks.filter((t) => t.startDate && !t.unplanned && taskOnDate(t, d));
      map.set(iso, sortByPriority(list));
    }
    return map;
  }, [tasks, days]);

  // "ДРУГОЕ" backlog:
  //  (a) no-date tasks written here manually (with or without a sphere), OR
  //  (b) tasks that HAVE a planned date range but are still tagged "ДРУГОЕ"
  //      (unplanned=true) — they surface here for the week their range starts
  //      instead of in the day cells, until the user drops them onto a day.
  // Tasks that are dated AND promoted (unplanned=false) belong in day cells.
  const otherTasks = useMemo(() => sortByPriority(tasks.filter((t) => {
    // "ДРУГОЕ":
    //  - no-date tasks written here manually WITHOUT a category, OR
    //  - dated tasks kept in the backlog (unplanned=true) instead of day cells.
    // Tasks WITHOUT a date that DO have a category belong on the dashboard.
    if (t.startDate && !t.unplanned) return false; // scheduled → day cells
    if (!t.startDate && t.sphere) return false;    // categorized backlog → dashboard
    // Dated-but-backlog task: show HERE only while its range overlaps the
    // current week (also shown on its day-cells). Outside the range window it
    // disappears from both views.
    if (t.startDate && t.unplanned) return days.some((d) => taskOnDate(t, d));
    return true;
  })), [tasks, days]);

  // СКОРО: upcoming dated tasks that are PROMOTED (out of the ДРУГОЕ backlog)
  // and not yet completed. Tasks still tagged "ДРУГОЕ" (unplanned) are shown
  // only in the ДРУГОЕ panel, not here.
  const soonTasks = useMemo(() => {
    return tasks
      .filter((t) => !t.completed && t.startDate && !t.unplanned && t.reminderDays != null)
      .map((t) => {
        const occ = nextOccurrence(t);
        if (!occ) return null;
        return { t, days: daysUntil(occ) };
      })
      .filter((r): r is { t: Task; days: number } => r !== null && r.days >= 0 && r.days <= (r.t.reminderDays ?? 0))
      .sort((a, b) => a.days - b.days);
  }, [tasks]);

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
            if (!id) return;
            const t = tasks.find((x) => x.id === id);
            if (!t) return;
            if (t.unplanned && t.startDate) {
              // Dated "ДРУГОЕ" task: promote it out of the backlog and
              // collapse its planned range onto this single dropped day.
              store.update(id, { startDate: iso, endDate: iso, unplanned: false });
            } else if (t.unplanned) {
              // Pure backlog task: snap it onto this day.
              store.update(id, { startDate: iso, endDate: iso, unplanned: false });
            } else if (!t.startDate) {
              // No date at all: assign this day.
              store.update(id, { startDate: iso, endDate: iso });
            } else {
              // Already dated & promoted: move it to the dropped day.
              // - single-day task (startDate == endDate): snap to the new day.
              // - ranged task: preserve the span length, re-based at the
              //   dropped day (e.g. Mon–Wed dropped on Fri → Fri–Sun).
              const t0 = parseISO(t.startDate);
              const n0 = parseISO(t.endDate ?? t.startDate);
              const spanDays = differenceInCalendarDays(n0, t0);
              const newStart = parseISO(iso);
              const newEnd = addDays(newStart, spanDays);
              store.update(id, {
                startDate: format(newStart, 'yyyy-MM-dd'),
                endDate: format(newEnd, 'yyyy-MM-dd'),
              });
            }
          }}
        >
          {dayTasks.map((t) => (
            <TaskItem
              key={t.id}
              task={t}
              date={d}
              blocked={isBlocked(t, tasks)}
              onEdit={() => onEdit(t, fmt.iso(d))}
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
      {/* First row: Mon–Fri */}
      <div className="week-row">{workdays.map(renderDayCell)}</div>

      {/* Bottom row: Sat, Sun (left); backlog + soon (right) */}
      <div className="week-row bottom-row">
        {renderDayCell(sat)}
        {renderDayCell(sun)}

        <div className="cell">
          <div className="cell-header">
            <span className="cell-title muted">БЭКЛОГ</span>
          </div>
          <div
            className="cell-body"
            onClick={() => setAdding(OTHER)}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/task-id');
              // Dropping into "ДРУГОЕ" tags the task as backlog (unplanned=true).
              // The date range (if any) is preserved so the task surfaces in
              // "ДРУГОЕ" for the week its range starts. Dragged onto a day-cell
              // it is promoted out of ДРУГОЕ (unplanned=false).
              if (id) store.update(id, { unplanned: true, sphere: undefined });
            }}
          >
            {otherTasks.map((t) => (
              <TaskItem key={t.id} task={t} blocked={isBlocked(t, tasks)} onEdit={() => onEdit(t, t.startDate)} />
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
      </div>
    </div>
  );
}
