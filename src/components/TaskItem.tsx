import { useRef, useState } from 'react';
import type { Task } from '../types';
import { store } from '../store';
import { useTasks } from '../store';
import { RecurringDeleteModal } from './RecurringDeleteModal';
import { isDoneOn } from '../utils/date';

function SubtaskCounter({ parentId }: { parentId: string }) {
  const tasks = useTasks();
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent?.subtaskIds?.length) return null;
  let done = 0;
  let total = 0;
  for (const id of parent.subtaskIds) {
    const sub = tasks.find((t) => t.id === id);
    if (!sub) continue;
    total++;
    if (sub.completed) done++;
  }
  return (
    <span className="subtask-count" title={`${done} из ${total} подзадач выполнены`}>
      {done}/{total}
    </span>
  );
}

interface Props {
  task: Task;
  date?: Date;
  onEdit?: () => void;
  /** Show recurrence-confirmation prompt before deleting. Omit to delete
   *  immediately (used by views that can't pass a selected date). */
  selectedDate?: string;
  /** Optional override: receives the event so callers can keep focus. */
  onMouseEnter?: () => void;
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

function dateIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Minimal outline trash icon — just the bin silhouette (no inner lines).
function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M5 6l2 15h10l2-15" />
      <path d="M9 6V4a3 3 0 0 1 3-3h2a3 3 0 0 1 3 3v2" />
    </svg>
  );
}

// Pencil — the touch replacement for right-click-to-edit.
function PencilIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

// Left click = complete / uncomplete. Right click = open editor.
// The trash icon (visible on row hover) deletes with a recurrence confirmation.
//
// Touch devices have no right-click, so they get two extra affordances: a
// long-press on the row opens the editor, and a pencil button that is always
// visible there (there is no hover to reveal controls on a phone).
export function TaskItem({ task, date, onEdit, selectedDate, onReorder }: Props) {
  const hl = !!task.color;
  const bg = task.color ? toHighlight(task.color) : undefined;
  const [over, setOver] = useState<null | 'top' | 'bottom'>(null);
  const [hover, setHover] = useState(false);
  const [showRecurDelete, setShowRecurDelete] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const didLongPress = useRef(false);

  const done = date ? isDoneOn(task, date) : task.completed;

  const cancelLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const startLongPress = () => {
    if (!onEdit) return;
    didLongPress.current = false;
    cancelLongPress();
    longPressTimer.current = window.setTimeout(() => {
      didLongPress.current = true;
      onEdit();
    }, 500);
  };

  const cls = [
    'task',
    hl && 'hl',
    done && 'completed',
    task.unplanned && !done && 'unplanned',
    over && `drop-${over}`,
  ]
    .filter(Boolean)
    .join(' ');

  const toggle = () => {
    if (date) store.toggleComplete(task.id, dateIso(date));
    else store.toggleComplete(task.id);
  };

  const deleteSelf = () => {
    if (task.recurrence !== 'none') {
      setShowRecurDelete(true);
      return;
    }
    // Delete the task and all its INCOMPLETED subtasks recursively
    store.removeWithSubtasks(task.id);
  };

  const handleRecurringDelete = (mode: 'single' | 'following' | 'all') => {
    const anchorDate = (date ? dateIso(date) : null) || selectedDate || new Date().toISOString().slice(0, 10);
    if (mode === 'all') store.remove(task.id);
    else if (mode === 'single') store.removeOccurrence(task.id, anchorDate);
    else store.removeThisAndFollowing(task.id, anchorDate);
    setShowRecurDelete(false);
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
      onClick={(e) => {
        e.stopPropagation();
        // A long-press already opened the editor — don't also toggle done.
        if (didLongPress.current) {
          didLongPress.current = false;
          return;
        }
        toggle();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onEdit?.();
      }}
      onTouchStart={startLongPress}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
      onTouchCancel={cancelLongPress}
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
      }}
      onMouseEnter={() => {
        setHover(true);
        // Notify parent (e.g. cell-body) that a child is hovered, in case it
        // manages global drag state.
      }}
      onMouseLeave={() => setHover(false)}
      onDragLeave={(e) => {
        // Only clear when the pointer actually leaves this element's box.
        const r = e.currentTarget.getBoundingClientRect();
        const x = e.clientX,
          y = e.clientY;
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
      {task.recurrence !== 'none' && (
        <span className="recur-icon" title="повторяется">
          ↻
        </span>
      )}
      <span className="title">{task.title}</span>
      {task.priority === 'high' && <span className="meta">!</span>}
      {!task.subtaskOf && task.subtaskIds && task.subtaskIds.length > 0 && (
        <SubtaskCounter parentId={task.id} />
      )}
      {/* Trash icon: grey by default, black on row hover. Click opens the
          recurrence confirmation (or deletes immediately for non-recurring). */}
      <button
        type="button"
        className={`task-trash ${hover ? 'hover' : ''}`}
        title="Удалить"
        onClick={(e) => {
          e.stopPropagation();
          deleteSelf();
        }}
        aria-label="Удалить задачу"
      >
        <TrashIcon />
      </button>

      {/* Touch-only edit affordance: no hover means no way to reach the
          editor otherwise, since right-click doesn't exist on a phone. */}
      {onEdit && (
        <button
          type="button"
          className="task-edit-btn"
          title="Изменить"
          onClick={(e) => {
            e.stopPropagation();
            cancelLongPress();
            onEdit();
          }}
          aria-label="Изменить задачу"
        >
          <PencilIcon />
        </button>
      )}

      {showRecurDelete && (
        <RecurringDeleteModal
          onChoice={handleRecurringDelete}
          onClose={() => setShowRecurDelete(false)}
        />
      )}
    </div>
  );
}
