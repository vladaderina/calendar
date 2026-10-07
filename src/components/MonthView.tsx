import { useEffect, useMemo, useRef, useState } from 'react';
import { addMonths, isSameMonth, isSameDay, startOfMonth } from 'date-fns';
import type { Task } from '../types';
import { TaskItem } from './TaskItem';
import { fmt, monthGrid, taskOnDate, sortByPriority } from '../utils/date';
import { store, useTasks } from '../store';

interface Props {
  anchor: Date;
  onEdit: (task: Task, editingDate?: string) => void;
  onPickDate?: (date: Date) => void;
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function AddIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function MonthView({ anchor, onEdit, onPickDate }: Props) {
  const tasks = useTasks();
  const today = new Date();
  const anchorRef = useRef<HTMLDivElement>(null);

  // Inline task creation: when set, the day cell shows input line.
  const [editingDay, setEditingDay] = useState<Date | null>(null);
  const [inputValue, setInputValue] = useState('');

  const months = useMemo(() => {
    const start = startOfMonth(anchor);
    return Array.from({ length: 36 }, (_, i) => addMonths(start, i - 12));
  }, [anchor]);

  useEffect(() => { anchorRef.current?.scrollIntoView({ block: 'start' }); }, []);

  const coloredTasks = (d: Date) =>
    sortByPriority(
      tasks.filter((t) => t.startDate && !t.unplanned && taskOnDate(t, d) && t.color)
    );

  const startEditing = (d: Date) => {
    if (editingDay && isSameDay(editingDay, d)) {
      setEditingDay(null);
      return;
    }
    setEditingDay(d);
    setInputValue('');
    // Focus the input after the editor renders.
    setTimeout(() => {
      const cell = document.querySelector<HTMLElement>(`[data-day="${fmt.iso(d)}"]`);
      cell?.querySelector<HTMLInputElement>('input.inline-task-input')?.focus();
    }, 0);
  };

  const handleAddTask = () => {
    if (!editingDay) return;
    const title = inputValue.trim();
    if (title) {
      const iso = fmt.iso(editingDay);
      store.add({
        title,
        startDate: iso,
        endDate: iso,
        priority: 'low',
      });
    }
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setEditingDay(null);
      setInputValue('');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTask();
    }
  };

  // Close the inline editor when clicking outside its cell.
  useEffect(() => {
    if (!editingDay) return;
    const iso = fmt.iso(editingDay);
    const handler = (e: MouseEvent) => {
      const cell = document.querySelector<HTMLElement>(`[data-day="${iso}"]`);
      if (cell && !cell.contains(e.target as Node)) {
        setEditingDay(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editingDay]);

  // Escape key closes the inline editor globally.
  useEffect(() => {
    if (!editingDay) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditingDay(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [editingDay]);

  return (
    <div className="month-scroll">
      {months.map((m) => {
        const isAnchor = isSameMonth(m, anchor);
        const days = monthGrid(m);
        return (
          <div className="month-block" key={fmt.iso(m)} ref={isAnchor ? anchorRef : undefined}>
            <div className="month-block-title">{fmt.monthYear(m)}</div>
            <div className="month-grid">
              {WEEKDAYS.map((w) => <div key={w} className="month-weekday">{w}</div>) }
              {days.map((d) => {
                const dayIso = fmt.iso(d);
                const isEditing = editingDay ? isSameDay(editingDay, d) : false;
                const dayTasks = sortByPriority(tasks.filter((t) => t.startDate && !t.unplanned && taskOnDate(t, d)));
                const colors = coloredTasks(d);
                const cls = [
                  'month-cell',
                  !isSameMonth(d, m) && 'other-month',
                  isSameDay(d, today) && 'today',
                  isEditing && 'month-cell-editing',
                ].filter(Boolean).join(' ');
                return (
                  <div className={cls} key={dayIso} data-day={dayIso}>
                    <div className="month-cell-head">
                      <span className="day-num" onDoubleClick={() => onPickDate?.(d)}>{d.getDate()}</span>
                      <button className="add-task-btn" onClick={() => startEditing(d)} title="Добавить задачу">
                        <AddIcon />
                      </button>
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
                      {/* Existing tasks for this day (max 5 visible) */}
                      {dayTasks.slice(0, 5).map((t) => (
                        <TaskItem key={t.id} task={t} date={d} onEdit={() => onEdit(t, dayIso)} />
                      ))}
                      {dayTasks.length > 5 && (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>+{dayTasks.length - 5}</span>
                      )}
                      {/* Inline task editor - shows only ONE input */}
                      {isEditing && (
                        <div className="inline-task-editor">
                          <input
                            className="inline-task-input"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Новая задача…"
                            autoComplete="off"
                          />
                        </div>
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