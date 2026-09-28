import { useRef, useState } from 'react';
import type { Task } from '../types';
import { TaskItem } from './TaskItem';
import { fmt, taskOnDate, sortByPriority } from '../utils/date';
import { store, useTasks } from '../store';
import { isSameDay } from 'date-fns';

interface Props {
  anchor: Date;
  onEdit: (task: Task) => void;
}

export function DayView({ anchor, onEdit }: Props) {
  const tasks = useTasks();
  const iso = fmt.iso(anchor);
  const isToday = isSameDay(anchor, new Date());
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Day cell: only dated, promoted tasks. Tasks tagged "ДРУГОЕ" (unplanned=true)
  // with a date range belong to the "ДРУГОЕ" section in WeekView only.
  const dayTasks = sortByPriority(tasks.filter((t) => t.startDate && !t.unplanned && taskOnDate(t, anchor)));

  const reorderInDay = (draggedId: string, targetId: string, place: 'above' | 'below') => {
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

  const submit = () => {
    const t = val.trim();
    if (t) {
      store.add({ title: t, startDate: iso, endDate: iso });
      setVal('');
      inputRef.current?.focus();
    } else {
      setAdding(false);
    }
  };

  return (
    <div className="day-view">
      <div className={`day-header ${isToday ? 'today' : ''}`}>
        {isToday && <span className="today-label">Сегодня</span>}
      </div>
      <div className="day-list">
        {dayTasks.map((t) => (
          <TaskItem key={t.id} task={t} date={anchor} onEdit={() => onEdit(t, iso)} onReorder={reorderInDay} />
        ))}
        {adding ? (
          <input
            ref={inputRef}
            autoFocus
            className="quick-add"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              else if (e.key === 'Escape') { setVal(''); setAdding(false); }
            }}
          />
        ) : (
          <div className="add-line" onClick={() => setAdding(true)}>
            {dayTasks.length === 0 ? 'ничего не запланировано — нажмите чтобы добавить' : '+ добавить задачу'}
          </div>
        )}
      </div>
    </div>
  );
}
