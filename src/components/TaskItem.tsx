import { useState } from 'react';
import type { Task } from '../types';
import { store } from '../store';
import { isDoneOn } from '../utils/date';

interface Props {
  task: Task;
  date?: Date;
  blocked?: boolean;
  onEdit?: () => void;
  onReorder?: (draggedId: string, targetId: string, place: 'above' | 'below') => void;
}

// Convert a hex color to a soft "highlighter" tone
function toHighlight(hex: string): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c: number) => Math.round(c * 0.35 + 255 * 0.65);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Left click = complete / uncomplete. Right click = open editor.
export function TaskItem({ task, date, blocked, onEdit, onReorder }: Props) {
  const hl = !!task.color;
  const bg = task.color ? toHighlight(task.color) : undefined;
  const [over, setOver] = useState<null | 'top' | 'bottom'>(null);

  const done = date ? isDoneOn(task, date) : task.completed;

  const cls = [
    'task',
    hl && 'hl',
    done && 'completed',
    task.unplanned && !done && 'unplanned',
    blocked && 'blocked',
    over && `drop-${over}`,
  ].filter(Boolean).join(' ');

  const toggle = () => {
    if (date) store.toggleComplete(task.id, dateIso(date));
    else store.toggleComplete(task.id);
  };

  // Compute drop location live from the pointer against this element's box,
  // so state flicker from dragEnter/Leave on child nodes can't corrupt it.
  const locate = (e: React.DragEvent<HTMLDivElement>): 'above' | 'below' => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? 'above' : 'below';
  };

  return (
    <div
      className={cls}
      style={hl ? ({ ['--hl' as any]: bg } as any) : undefined}
      onClick={(e) => { e.stopPropagation(); toggle(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onEdit?.(); }}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/json', JSON.stringify(task));
        e.dataTransfer.setData('text/task-id', task.id);
      }}
      onDragEnter={(e) => {
        if (!onReorder) return;
        e.preventDefault();
      }}
      onDragOver={(e) => {
        if (!onReorder) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const place = locate(e);
        // A top-priority task is a wall: nothing can be dropped above it.
        if (place === 'above' && task.priority === 'high') {
          if (over !== null) setOver(null);
          return;
        }
        const next = place === 'above' ? 'top' : 'bottom';
        if (over !== next) setOver(next);
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves this element's box.
        const r = e.currentTarget.getBoundingClientRect();
        const x = e.clientX, y = e.clientY;
        if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) {
          setOver(null);
        }
      }}
      onDragEnd={() => setOver(null)}
      onDrop={(e) => {
        setOver(null);
        if (!onReorder) return;
        e.preventDefault();
        e.stopPropagation();
        const draggedId = e.dataTransfer.getData('text/task-id');
        if (!draggedId || draggedId === task.id) return;
        const place = locate(e);
        if (place === 'above' && task.priority === 'high') return;
        onReorder(draggedId, task.id, place);
      }}
    >
      {task.recurrence !== 'none' && <span className="recur-icon" title="повторяется">↻</span>}
      <span className="title">{task.title}</span>
      {task.priority === 'high' && <span className="meta">!</span>}
    </div>
  );
}

function dateIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
