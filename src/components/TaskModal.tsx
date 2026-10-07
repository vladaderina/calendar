import { useState, useEffect, useRef } from 'react';
import type { Task, Recurrence, Priority, Sphere, Weekday } from '../types';
import { store, useSpheres } from '../store';
import { DatePickerModal } from './DatePickerModal';
import { fmt } from '../utils/date';
import { parseISO } from 'date-fns';
import { getColors, renameColor, removeColor, NO_COLOR } from '../config/colors';

const PRIORITY_ORDER: Priority[] = ['low', 'normal', 'high'];
const PRIORITY_LABEL: Record<Priority, string> = { low: 'низкий', normal: 'обычный', high: 'высокий' };
const RECURRENCE_ORDER: Recurrence[] = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'weekdays', 'yearDays'];
const RECURRENCE_LABEL: Record<Recurrence, string> = {
  none: 'не повторять',
  daily: 'ежедневно',
  weekly: 'еженедельно',
  monthly: 'ежемесячно',
  yearly: 'ежегодно',
  weekdays: 'по дням недели',
  yearDays: 'в конкретные даты',
};
const REMINDER_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'не напоминать' },
  { value: 0, label: 'в день задачи' },
  { value: 1, label: 'за 1 день' },
  { value: 2, label: 'за 2 дня' },
  { value: 3, label: 'за 3 дня' },
  { value: 7, label: 'за неделю' },
  { value: 30, label: 'за месяц' },
];

type Popover = 'color' | 'priority' | 'recurrence' | 'sphere' | 'reminder' | null;

/* ---------- inline icons (stroke = currentColor) ---------- */
const BellIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
    <path d="M10.3 20a2 2 0 0 0 3.4 0" />
  </svg>
);
const RepeatIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M17 2.5l3.5 3.5L17 9.5" />
    <path d="M3.5 11V9.5a3.5 3.5 0 0 1 3.5-3.5h13" />
    <path d="M7 21.5L3.5 18 7 14.5" />
    <path d="M20.5 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4" />
  </svg>
);
const TagIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20.6 12.6l-8 8a2 2 0 0 1-2.8 0l-6.4-6.4a2 2 0 0 1-.6-1.4V5a2 2 0 0 1 2-2h7.8a2 2 0 0 1 1.4.6l6.6 6.6a2 2 0 0 1 0 2.4z" />
    <circle cx="7.8" cy="7.8" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);
const PriorityBars = ({ level, filled }: { level?: Priority; filled?: boolean }) => {
  const on = level === 'high' ? 3 : level === 'normal' ? 2 : level === 'low' ? 1 : filled ? 2 : 0;
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="15" width="4" height="6" rx="1" fill="currentColor" opacity={on >= 1 ? 1 : 0.28} />
      <rect x="10" y="10" width="4" height="11" rx="1" fill="currentColor" opacity={on >= 2 ? 1 : 0.28} />
      <rect x="17" y="4" width="4" height="17" rx="1" fill="currentColor" opacity={on >= 3 ? 1 : 0.28} />
    </svg>
  );
};
const Check = () => <span className="check">✓</span>;
const WEEKDAYS: string[] = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface Props {
  initial?: Partial<Task>;
  editingId?: string;
  selectedDate?: string;
  onClose: () => void;
}

// Store subtask as { id, title }
interface Subtask {
  id: string;
  title: string;
}

export function TaskModal({ initial, editingId, selectedDate, onClose }: Props) {
  const spheres = useSpheres();

  const [title, setTitle] = useState(initial?.title ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [startDate, setStartDate] = useState(initial?.startDate ?? selectedDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? selectedDate ?? '');
  const [sphere, setSphere] = useState<Sphere>(initial?.sphere ?? '');
  const [recurrence, setRecurrence] = useState<Recurrence>(initial?.recurrence ?? 'none');
  const [recurrenceDays, setRecurrenceDays] = useState<Weekday[]>(initial?.recurrenceDays ?? []);
  const [yearDates, setYearDates] = useState<string[]>(initial?.yearDates ?? []);
  const [reminderDays, setReminderDays] = useState<number | null>(initial?.reminderDays ?? null);
  const [color, setColor] = useState(initial?.color ?? '');
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? 'normal');
  const [unplanned, setUnplanned] = useState(initial?.unplanned ?? false);
  
  // Store subtasks as objects with id and title
  const initSubtasks = (): Subtask[] => {
    if (editingId) {
      const parent = store.getById(editingId);
      if (parent?.subtaskIds) {
        return parent.subtaskIds
          .map((id) => {
            const sub = store.getById(id);
            return sub ? { id, title: sub.title } : null;
          })
          .filter((s): s is Subtask => s !== null);
      }
    }
    return [];
  };
  
  const [subtasks, setSubtasks] = useState<Subtask[]>(initSubtasks);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [open, setOpen] = useState<Popover>(null);
  const [newSphere, setNewSphere] = useState('');
  const [, setColorRefresh] = useState(0);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const newSubtaskRef = useRef<HTMLInputElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = () => setColorRefresh((n) => n + 1);
    window.addEventListener('colors-change', h);
    return () => window.removeEventListener('colors-change', h);
  }, []);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  // Escape closes the popover first, then the modal.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (open) setOpen(null);
      else if (!showDatePicker && !showYearPicker) onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, showDatePicker, open]);

  // Click outside the toolbar closes the open popover.
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!toolsRef.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const toggle = (p: Exclude<Popover, null>) => setOpen((cur) => (cur === p ? null : p));

  // Check if this is creating a new task or editing existing
  const isEditing = !!editingId;

  const save = () => {
    if (!title.trim()) return;
    const payload = {
      title: title.trim(),
      notes: notes.trim() || undefined,
      startDate: startDate || undefined,
      endDate: endDate && endDate !== startDate ? endDate : undefined,
      sphere: sphere || undefined,
      recurrence,
      recurrenceDays: recurrence === 'weekdays' ? recurrenceDays : undefined,
      yearDates: recurrence === 'yearDays' ? yearDates : undefined,
      reminderDays: reminderDays ?? undefined,
      color: color || undefined,
      priority,
      unplanned,
    };
    if (isEditing) {
      store.update(editingId, payload);
      const parent = store.getById(editingId);
      
      // Handle deleted subtasks
      const currentSubtaskIds = new Set(subtasks.map((s) => s.id));
      const existingSubtaskIds = new Set(parent?.subtaskIds ?? []);
      const deletedIds = [...existingSubtaskIds].filter((id) => !currentSubtaskIds.has(id));
      deletedIds.forEach((id) => store.removeSubtask(editingId!, id));
      
      // Propagate parent dates to existing subtasks
      const today = new Date().toISOString().slice(0, 10);
      const parentEnd = parent?.endDate ?? parent?.startDate ?? '';
      subtasks.forEach((s) => {
        store.update(s.id, {
          startDate: today,
          endDate: parentEnd,
          unplanned: true,
        });
      });
      
      // Create only NEW subtasks
      const newTitles = subtasks.filter((s) => !existingSubtaskIds.has(s.id)).map((s) => s.title);
      if (newTitles.length) store.addSubtasks(editingId!, newTitles);
    } else {
      const parent = store.add(payload);
      const titles = subtasks.map((s) => s.title);
      if (titles.length) store.addSubtasks(parent.id, titles);
    }
    onClose();
  };

  const onPickDate = (start: string, end: string) => {
    setStartDate(start);
    setEndDate(end);
    setShowDatePicker(false);
  };

  const onPickYearDate = (start: string) => {
    // Toggle individual date: select if not present, deselect if present.
    // Called on every day click in singleDate mode (multi-select toggle).
    if (!yearDates.includes(start)) {
      setYearDates([...yearDates, start].sort());
    } else {
      setYearDates(yearDates.filter((d) => d !== start));
    }
    if (recurrence !== 'yearDays') setRecurrence('yearDays');
  };

  const dateLabel = (() => {
    if (!startDate) return 'Выбрать дату...';
    const s = parseISO(startDate);
    if (endDate && endDate !== startDate) return `${fmt.dayShort(s)} — ${fmt.dayShort(parseISO(endDate))}`;
    return fmt.dayFull(s);
  })();

  if (showYearPicker) {
    return (
      <DatePickerModal
        anchor={startDate ? parseISO(startDate) : new Date()}
        currentStart={yearDates.length > 0 ? yearDates[yearDates.length - 1] : undefined}
        onSelect={onPickYearDate}
        onClose={() => { setShowYearPicker(false); setOpen('recurrence'); }}
        singleDate
        selectedDates={yearDates}
      />
    );
  }

  if (showDatePicker) {
    return (
      <DatePickerModal
        anchor={startDate ? parseISO(startDate) : new Date()}
        currentStart={startDate}
        currentEnd={endDate}
        onSelect={onPickDate}
        onClose={() => setShowDatePicker(false)}
      />
    );
  }

  // Handle removing a subtask from local state
  const handleRemoveSubtask = (idx: number) => {
    setSubtasks(subtasks.filter((_, i) => i !== idx));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal task-modal" onClick={(e) => e.stopPropagation()}>

        {/* Top row: date on the left (opens the calendar), tools on the right */}
        <div className="task-modal-top">
          <button
            className={`date-btn ${startDate ? '' : 'empty'}`}
            onClick={() => setShowDatePicker(true)}
            title="Открыть календарь"
          >
            {dateLabel}
          </button>

          <div className="task-modal-tools" ref={toolsRef}>
            {/* Category */}
            <div className="tool-wrap">
              <button
                className={`tool-btn cat-btn ${sphere ? 'active' : ''}`}
                onClick={() => toggle('sphere')}
                title="Категория"
                aria-label="Категория"
              >
                <TagIcon />
                {sphere && <span className="sphere-tag">{sphere}</span>}
              </button>
              {open === 'sphere' && (
                <div className="popover">
                  <div className="pop-title">Категория</div>
                  <button className={`pop-item ${!sphere ? 'selected' : ''}`} onClick={() => { setSphere(''); setOpen(null); }}>
                    <span>без категории</span>{!sphere && <Check />}
                  </button>
                  <div className="pop-sep" />
                  {spheres.map((s) => (
                    <button key={s} className={`pop-item ${sphere === s ? 'selected' : ''}`}
                      onClick={() => { setSphere(s); setOpen(null); }}><span>{s}</span>{sphere === s && <Check />}</button>
                  ))}
                  <div className="pop-sep" />
                  <div className="pop-input-row">
                    <input value={newSphere} placeholder="новая категория"
                      onChange={(e) => setNewSphere(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        const n = newSphere.trim();
                        if (!n) return;
                        store.addSphere(n);
                        setSphere(n.toUpperCase());
                        setNewSphere('');
                        setOpen(null);
                      }} />
                    <button onClick={() => {
                      const n = newSphere.trim();
                      if (!n) return;
                      store.addSphere(n);
                      setSphere(n.toUpperCase());
                      setNewSphere('');
                      setOpen(null);
                    }}>ок</button>
                  </div>
                </div>
              )}
            </div>

            {/* Reminder */}
            <div className="tool-wrap">
              <button
                className={`tool-btn ${reminderDays != null ? 'active' : ''}`}
                onClick={() => toggle('reminder')}
                title={reminderDays != null ? `Напоминание: за ${reminderDays} дн.` : 'Напоминание'}
                aria-label="Напоминание"
              >
                <BellIcon filled={reminderDays != null} />
              </button>
              {open === 'reminder' && (
                <div className="popover">
                  <div className="pop-title">Напоминание</div>
                  {REMINDER_OPTIONS.map((o) => (
                    <button key={String(o.value)}
                      className={`pop-item ${reminderDays === o.value ? 'selected' : ''}`}
                      onClick={() => { setReminderDays(o.value); setOpen(null); }}
                    ><span>{o.label}</span>{reminderDays === o.value && <Check />}</button>
                  ))}
                  <div className="pop-sep" />
                  <div className="pop-input-row">
                    <input type="number" min="0" placeholder="своё число дней"
                      value={REMINDER_OPTIONS.some((o) => o.value === reminderDays) ? '' : String(reminderDays ?? '')}
                      onChange={(e) => setReminderDays(e.target.value === '' ? null : Number(e.target.value))} />
                  </div>
                </div>
              )}
            </div>

            {/* Recurrence */}
            <div className="tool-wrap">
              <button
                className={`tool-btn ${recurrence !== 'none' ? 'active' : ''}`}
                onClick={() => toggle('recurrence')}
                title={recurrence === 'none' ? 'Повтор' : `Повтор: ${RECURRENCE_LABEL[recurrence]}`}
                aria-label="Повтор"
              >
                <RepeatIcon />
              </button>
              {open === 'recurrence' && (
                <div className="popover pop-recurrence">
                  <div className="pop-title">Повтор</div>
                  {RECURRENCE_ORDER.map((r) => (
                    <div key={r}>
                      <button className={`pop-item ${recurrence === r ? 'selected' : ''}`}
                        onClick={() => {
                          setRecurrence(r);
                          if (r !== 'weekdays') setRecurrenceDays([]);
                          if (r !== 'yearDays') setYearDates([]);
                          if (r === 'weekdays' || r === 'yearDays') setOpen('recurrence');
                          else setOpen(null);
                        }}
                      >
                        <span>{RECURRENCE_LABEL[r]}</span>{recurrence === r && <Check />}
                      </button>
                      {r === 'weekdays' && (
                        <div className="weekday-picker">
                          {WEEKDAYS.map((label, i) => {
                            const day = (i + 1) as Weekday;
                            const on = recurrenceDays.includes(day);
                            return (
                              <button key={day}
                                className={`weekday-swatch ${on ? 'on' : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (recurrence !== 'weekdays') setRecurrence('weekdays');
                                  setRecurrenceDays(on
                                    ? recurrenceDays.filter((d) => d !== day)
                                    : [...recurrenceDays, day].sort((a, b) => a - b));
                                }}
                                title={label} aria-label={label}>{label}</button>
                            );
                          })}
                        </div>
                      )}
                      {r === 'yearDays' && (
                        <div className="year-date-picker">
                          {yearDates.length === 0 ? (
                            <button className="pop-item" onClick={(e) => { e.stopPropagation(); setShowYearPicker(true); }}><span>+ дата</span></button>
                          ) : yearDates.map((d, idx) => (
                            <button key={idx} className="pop-item"
                              onClick={(e) => { e.stopPropagation(); setYearDates(yearDates.filter((_, i) => i !== idx)); }}
                            ><span>{d}</span><span style={{ color: 'var(--muted)', marginLeft: 8 }}>✕</span></button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Priority */}
            <div className="tool-wrap">
              <button
                className={`tool-btn ${priority !== 'normal' ? 'active' : ''}`}
                onClick={() => toggle('priority')}
                title={`Приоритет: ${PRIORITY_LABEL[priority]}`}
                aria-label="Приоритет"
              >
                <PriorityBars level={priority} />
              </button>
              {open === 'priority' && (
                <div className="popover">
                  <div className="pop-title">Приоритет</div>
                  {PRIORITY_ORDER.map((p) => (
                    <button key={p} className={`pop-item ${priority === p ? 'selected' : ''}`}
                      onClick={() => { setPriority(p); setOpen(null); }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><PriorityBars level={p} />{PRIORITY_LABEL[p]}</span>{priority === p && <Check />}</button>
                  ))}
                </div>
              )}
            </div>

            {/* Color */}
            <div className="tool-wrap">
              <button className="tool-btn" onClick={() => toggle('color')} title="Цвет задачи" aria-label="Цвет задачи">
                <span className={`tool-color-dot ${color ? '' : 'none'}`}
                  style={color ? { background: color, borderColor: color } : undefined} />
              </button>
              {open === 'color' && (
                <div className="popover pop-color">
                  <div className="pop-title">Цвет задачи</div>
                  <div
                    className={`color-swatch none ${!color ? 'selected' : ''}`}
                    onClick={() => { setColor(''); setOpen(null); }}
                    title={NO_COLOR.label}
                  />
                  <div className="pop-sep" />
                  {getColors().map((c) => (
                    <div key={c.value} className="color-row">
                      <button
                        className={`color-swatch-btn ${color === c.value ? 'selected' : ''}`}
                        onClick={() => {
                          const isUnnamed = !c.label || c.unnamed;
                          if (!isUnnamed) { setColor(c.value); setOpen(null); }
                          else setEditingLabel(c.value);
                        }}
                        title={c.label || 'Нажмите чтобы задать имя'}
                        style={{
                          background: c.value,
                          borderColor: color === c.value ? 'var(--ink)' : (!c.label || c.unnamed) ? 'var(--muted)' : 'transparent',
                          opacity: (!c.label || c.unnamed) ? 0.5 : 1,
                        }}
                      >
                        {color === c.value && <span className="color-check">✓</span>}
                      </button>
                      {editingLabel === c.value ? (
                        <input
                          ref={labelInputRef}
                          className="color-label-edit"
                          defaultValue={c.label}
                          autoFocus
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v) renameColor(c.value, v);
                            setEditingLabel(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.currentTarget.blur(); }
                            if (e.key === 'Escape') { setEditingLabel(null); }
                          }}
                        />
                      ) : (
                        <span
                          className={`color-label ${(!c.label || c.unnamed) ? 'unnamed' : ''}`}
                          title={c.label || 'Нажмите чтобы задать имя'}
                          onClick={() => setEditingLabel(c.value)}
                        >{c.label || '…'}</span>
                      )}
                      {/* Deactivate: clears the name and disables the color.
                          Re-naming it (click the label) makes it usable again. */}
                      <button
                        type="button"
                        className="color-row-del"
                        title="Убрать название (цвет станет недоступен)"
                        aria-label="Убрать название цвета"
                        onClick={(e) => { e.stopPropagation(); removeColor(c.value); }}
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
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

        {/* Subtask inputs — circles + lines, with individual delete */}
        <div className="subtask-inputs">
          {subtasks.map((subtask, i) => (
            <div key={subtask.id || i} className="subtask-input-row">
              <span className="subtask-dot" />
              <input
                className="subtask-input"
                value={subtask.title}
                onChange={(e) => {
                  const next = [...subtasks];
                  next[i] = { ...subtask, title: e.target.value };
                  setSubtasks(next);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !subtasks[i + 1]) {
                    const newId = crypto.randomUUID();
                    setSubtasks([...subtasks, { id: newId, title: '' }]);
                    // Focus the newly added input after state update
                    setTimeout(() => (newSubtaskRef as any).current?.focus(), 0);
                  }
                }}
                ref={i === subtasks.length - 1 && subtasks[subtasks.length - 1].title === '' ? newSubtaskRef : undefined}
              />
              {subtasks.length > 0 && (
                <button
                  type="button"
                  className="subtask-remove"
                  onClick={(e) => { e.stopPropagation(); handleRemoveSubtask(i); }}
                  title="Удалить подзадачу"
                >✕</button>
              )}
            </div>
          ))}
          {subtasks.length === 0 && (
            <button
              className="subtask-add"
              type="button"
              onClick={() => {
                const newId = crypto.randomUUID();
                setSubtasks([{ id: newId, title: '' }]);
                // Focus the newly added input
                setTimeout(() => (newSubtaskRef as any).current?.focus(), 0);
              }}
            >
              + подзадача
            </button>
          )}
        </div>

        {/* Backlog toggle at the bottom */}
        <label className="backlog-row">
          <input type="checkbox" checked={unplanned}
            onChange={(e) => setUnplanned(e.target.checked)} />
          <span className="backlog-label">Бэклог</span>
        </label>

        <div className="modal-actions">
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>отмена</button>
            <button className="btn primary" onClick={save}>сохранить</button>
          </div>
        </div>
      </div>
    </div>
  );
}