import { useEffect, useMemo, useRef } from 'react';
import { addMonths, isSameMonth, isSameDay, startOfMonth } from 'date-fns';
import type { Task } from '../types';
import { TaskItem } from './TaskItem';
import { fmt, monthGrid, taskOnDate, sortByPriority } from '../utils/date';
import { useTasks } from '../store';
import { ChevronIcon } from './icons/ChevronIcon';

interface Props {
  anchor: Date;
  onEdit: (task: Task, editingDate?: string) => void;
  onPickDate?: (date: Date) => void;
  onZoomOut?: () => void;
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function MonthView({ anchor, onEdit, onPickDate, onZoomOut }: Props) {
  const tasks = useTasks();
  const today = new Date();
  const anchorRef = useRef<HTMLDivElement>(null);

  const months = useMemo(() => {
    const start = startOfMonth(anchor);
    return Array.from({ length: 36 }, (_, i) => addMonths(start, i - 12));
  }, [anchor]);

  useEffect(() => { anchorRef.current?.scrollIntoView({ block: 'start' }); }, []);

  const coloredTasks = (d: Date) =>
    sortByPriority(
      tasks.filter((t) => t.startDate && !t.unplanned && taskOnDate(t, d) && t.color)
    );

  return (
    <div className="month-scroll">
      <div className="month-zoom-bar">
        <button className="btn ghost" aria-label="Назад" onClick={() => onZoomOut?.()}>
          <ChevronIcon dir="left" />
        </button>
        <button className="btn primary-soft" aria-label="Увеличить" onClick={() => onZoomOut?.()}>
          Свернуть к году
        </button>
      </div>
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
                const colors = coloredTasks(d);
                const cls = [
                  'month-cell',
                  !isSameMonth(d, m) && 'other-month',
                  isSameDay(d, today) && 'today',
                ].filter(Boolean).join(' ');
                return (
                  <div className={cls} key={fmt.iso(d)}>
                    <div className="month-cell-head">
                      <span className="day-num" onClick={() => onPickDate?.(d)}>{d.getDate()}</span>
                      {colors.length > 0 && (
                        <div className="day-dots" aria-label="цветные задачи">
                          {colors.slice(0, 4).map((t) => (
                            <span key={t.id} className="day-dot" style={{ background: t.color, borderColor: t.color }} />
                          ))}
                          {colors.length > 4 && (
                            <span className="day-plus" style={{ color: 'var(--muted)' }}>+{colors.length - 4}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{ flex: 1, minHeight: 0 }}>
                      {dayTasks.slice(0, 4).map((t) => (
                        <TaskItem key={t.id} task={t} date={d} onEdit={() => onEdit(t, fmt.iso(d))} />
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
