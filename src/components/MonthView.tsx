import { useEffect, useMemo, useRef } from 'react';
import { addMonths, isSameMonth, isSameDay, startOfMonth } from 'date-fns';
import type { Task } from '../types';
import { TaskItem } from './TaskItem';
import { fmt, monthGrid, taskOnDate, sortByPriority } from '../utils/date';
import { useTasks } from '../store';

interface Props {
  anchor: Date;
  onEdit: (task: Task) => void;
  onPickDate?: (date: Date) => void;
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function MonthView({ anchor, onEdit, onPickDate }: Props) {
  const tasks = useTasks();
  const today = new Date();
  const anchorRef = useRef<HTMLDivElement>(null);

  const months = useMemo(() => {
    const start = startOfMonth(anchor);
    return Array.from({ length: 36 }, (_, i) => addMonths(start, i - 12));
  }, [anchor]);

  useEffect(() => { anchorRef.current?.scrollIntoView({ block: 'start' }); }, []);

  return (
    <div className="month-scroll">
      {months.map((m) => {
        const isAnchor = isSameMonth(m, anchor);
        const days = monthGrid(m);
        return (
          <div className="month-block" key={fmt.iso(m)} ref={isAnchor ? anchorRef : undefined}>
            <div className="month-block-title">{fmt.monthYear(m)}</div>
            <div className="month-grid">
              {WEEKDAYS.map((w) => <div key={w} className="month-weekday">{w}</div>)}
              {days.map((d) => {
                const dayTasks = sortByPriority(tasks.filter((t) => t.startDate && !t.unplanned && taskOnDate(t, d)));
                const cls = [
                  'month-cell',
                  !isSameMonth(d, m) && 'other-month',
                  isSameDay(d, today) && 'today',
                ].filter(Boolean).join(' ');
                return (
                  <div className={cls} key={fmt.iso(d)}>
                    <span className="day-num" onClick={() => onPickDate?.(d)}>{d.getDate()}</span>
                    <div style={{ flex: 1 }}>
                      {dayTasks.slice(0, 4).map((t) => (
                        <TaskItem key={t.id} task={t} date={d} onEdit={() => onEdit(t)} />
                      ))}
                      {dayTasks.length > 4 && (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>+{dayTasks.length - 4}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
