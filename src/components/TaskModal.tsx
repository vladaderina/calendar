import { useState, useEffect, useRef } from 'react';
import type { Task, Recurrence, Priority } from '../types';
import { store, useTasks, useSpheres } from '../store';
import { DatePickerModal } from './DatePickerModal';
import { RecurringDeleteModal } from './RecurringDeleteModal';

const COLORS = ['#0a0a0a', '#e74c3c', '#f39c12', '#f1c40f', '#27ae60', '#3498db', '#9b59b6', '#e91e63'];

interface Props {
  initial?: Partial<Task>;
  editingId?: string;
  onClose: () => void;
}

export function TaskModal({ initial, editingId, onClose }: Props) {
  const allTasks = useTasks();
  const spheres = useSpheres();

  const [title, setTitle] = useState(initial?.title ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [startDate, setStartDate] = useState(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');
  const [sphere, setSphere] = useState<string>(initial?.sphere ?? '');
  const [recurrence, setRecurrence] = useState<Recurrence>(initial?.recurrence ?? 'none');
  const [reminderDays, setReminderDays] = useState<string>(
    initial?.reminderDays != null ? String(initial.reminderDays) : ''
  );
  const [color, setColor] = useState(initial?.color ?? '');
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 'low');
  const [unplanned, setUnplanned] = useState(initial?.unplanned ?? false);
  const [dependsOnTaskId, setDependsOnTaskId] = useState(initial?.dependsOnTaskId ?? '');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showRecurringDelete, setShowRecurringDelete] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !showDatePicker) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, showDatePicker]);

  const save = () => {
    if (!title.trim()) return;
    // Assigning a concrete date takes the task out of the "ДРУГОЕ" backlog.
    const isUnplanned = startDate ? false : unplanned;
    const payload = {
      title: title.trim(),
      notes: notes.trim() || undefined,
      startDate: startDate || undefined,
      endDate: endDate || startDate || undefined,
      sphere: sphere || undefined,
      recurrence,
      reminderDays: reminderDays ? Number(reminderDays) : undefined,
      color: color || undefined,
      priority,
      unplanned: isUnplanned,
      dependsOnTaskId: dependsOnTaskId || undefined,
    };
    if (editingId) store.update(editingId, payload);
    else store.add(payload);
    onClose();
  };

  const del = () => {
    if (!editingId) return;
    // Recurring tasks get the "which occurrences?" prompt.
    if (recurrence !== 'none') {
      setShowRecurringDelete(true);
      return;
    }
    store.remove(editingId);
    onClose();
  };

  const handleRecurringDelete = (mode: 'single' | 'following' | 'all') => {
    if (!editingId) return;
    const anchorDate = startDate || new Date().toISOString().slice(0, 10);
    if (mode === 'all') store.remove(editingId);
    else if (mode === 'single') store.removeOccurrence(editingId, anchorDate);
    else store.removeThisAndFollowing(editingId, anchorDate);
    setShowRecurringDelete(false);
    onClose();
  };

  if (showDatePicker) {
    return (
      <DatePickerModal
        anchor={startDate ? new Date(startDate) : new Date()}
        currentStart={startDate}
        currentEnd={endDate}
        onSelect={(start, end) => {
          setStartDate(start);
          setEndDate(end);
          // Picking a real date removes the backlog flag.
          if (start) setUnplanned(false);
          setShowDatePicker(false);
        }}
        onClose={() => setShowDatePicker(false)}
      />
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{editingId ? 'Редактировать' : 'Новая задача'}</h2>
          {editingId && (
            <button className="btn danger" style={{ fontSize: 14, padding: '4px 8px' }} onClick={del}>×</button>
          )}
        </div>

        <div className="field">
          <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Название задачи"
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && save()}
            className="task-title-input" />
        </div>

        <div className="field">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Добавить дополнительные заметки..."
            className="task-notes-textarea"
            rows={2} />
        </div>

        <div className="field">
          <label>Сфера</label>
          <select value={sphere} onChange={(e) => setSphere(e.target.value)}>
            <option value="">—</option>
            {spheres.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Планирование</label>
          <button className="btn ghost" style={{ textAlign: 'left', padding: '8px 11px', width: '100%' }} onClick={() => setShowDatePicker(true)}>
            {startDate && endDate && startDate !== endDate ? `${startDate} — ${endDate}` : startDate ? startDate : 'выбрать дату…'}
          </button>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Приоритет</label>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              <option value="low">низкий</option>
              <option value="normal">обычный</option>
              <option value="high">высокий</option>
            </select>
          </div>
          <div className="field">
            <label>Повтор</label>
            <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)}>
              <option value="none">без повтора</option>
              <option value="daily">ежедневно</option>
              <option value="weekly">еженедельно</option>
              <option value="monthly">ежемесячно</option>
              <option value="yearly">ежегодно</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label>Напоминание (дней до начала)</label>
          <input type="number" min="0" value={reminderDays}
            onChange={(e) => setReminderDays(e.target.value)} />
        </div>

        <div className="field">
          <label>После выполнения задачи</label>
          <select value={dependsOnTaskId} onChange={(e) => setDependsOnTaskId(e.target.value)}>
            <option value="">— независимая —</option>
            {allTasks
              .filter((t) => t.id !== editingId && !t.completed)
              .map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </div>

        <div className="field">
          <label>Цвет</label>
          <div className="color-picker">
            <div className={`color-swatch ${!color ? 'selected' : ''}`}
              style={{ background: 'transparent', border: '2px dashed #ccc' }}
              onClick={() => setColor('')} />
            {COLORS.map((c) => (
              <div key={c}
                className={`color-swatch ${color === c ? 'selected' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)} />
            ))}
          </div>
        </div>

        <div className="checkbox-row">
          <input id="unplanned" type="checkbox" checked={startDate ? false : unplanned}
            disabled={!!startDate}
            onChange={(e) => setUnplanned(e.target.checked)} />
          <label htmlFor="unplanned" style={startDate ? { opacity: 0.5 } : undefined}>
            Незапланированная (в бэклог «ДРУГОЕ»)
          </label>
        </div>

        <div className="modal-actions">
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>отмена</button>
            <button className="btn primary" onClick={save}>сохранить</button>
          </div>
        </div>
      </div>

      {showRecurringDelete && (
        <RecurringDeleteModal
          onChoice={handleRecurringDelete}
          onClose={() => setShowRecurringDelete(false)}
        />
      )}
    </div>
  );
}
