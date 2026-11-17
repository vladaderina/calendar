// A note-document: the file the tree shows as a note.
//
// The body is a list of lines (paragraphs and checklist items). A checklist
// line can be PLANNED to a concrete day; that creates an ordinary Task with
// `startDate = endDate = <day>`, so all the existing planning logic — day and
// week views, backlog, completion, reminders — keeps working unchanged. The
// line remembers the task id, and its tick follows the task (a task completed
// in the day view shows up ticked here, and ticking here completes the task).
import { useEffect, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { store, useTasks } from '../store';
import { fmt, parseISO } from '../utils/date';
import { flushBoard, saveBoardDoc, type BoardDoc, type DocBlock } from '../lib/board';

interface Props {
  doc: BoardDoc;
  /** Category of the note — planned lines become tasks of that category. */
  sphere: string;
  /** Folder the note lives in; a planned line is filed there. */
  topic: string | undefined;
  /** Rename the tree node when the title is committed (on blur). */
  onTitleChange: (title: string) => void;
}

const blank = (kind: 'text' | 'check' = 'text'): DocBlock => ({ id: uuid(), kind, text: '' });

/** «1 пункт / 2 пункта / 5 пунктов» — cheap, no library. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function NoteEditor({ doc, sphere, topic, onTitleChange }: Props) {
  const tasks = useTasks();
  const [title, setTitle] = useState(doc.title);
  // A brand-new note starts with an empty CHECKLIST point: notes here are
  // mostly lists of things to do; «+ текст» is one click away otherwise.
  const [rows, setRows] = useState<DocBlock[]>(() => (doc.blocks.length ? doc.blocks : [blank('check')]));
  const [focusId, setFocusId] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const blocksReady = useRef(false);
  const titleReady = useRef(false);
  // The last title the TREE knows. `doc.title` is already the saved one by the
  // time the field blurs, so comparing with it would swallow the rename.
  const treeTitle = useRef(doc.title);

  useEffect(() => {
    if (!focusId) return;
    const el = inputs.current.get(focusId);
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
    setFocusId(null);
  }, [focusId, rows]);

  useEffect(() => {
    if (!blocksReady.current) {
      blocksReady.current = true;
      return;
    }
    saveBoardDoc(doc.id, { blocks: rows });
  }, [rows, doc.id]);

  useEffect(() => {
    if (!titleReady.current) {
      titleReady.current = true;
      return;
    }
    saveBoardDoc(doc.id, { title });
  }, [title, doc.id]);

  const taskOf = (row: DocBlock) => (row.taskId ? tasks.find((task) => task.id === row.taskId) : undefined);

  const setRow = (id: string, patch: Partial<DocBlock>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const toggle = (row: DocBlock) => {
    const task = taskOf(row);
    const next = !(row.done || task?.completed);
    // The task is the shared truth: the day view sees the same tick.
    if (task) store.toggleComplete(task.id);
    setRow(row.id, { done: next });
  };

  const plan = (row: DocBlock, date: string) => {
    if (!date) {
      clearPlan(row);
      return;
    }
    const existing = taskOf(row);
    if (existing) {
      // Re-planning moves the task instead of creating a second copy.
      store.update(existing.id, { startDate: date, endDate: date, unplanned: false });
      setRow(row.id, { date });
      return;
    }
    const task = store.add({
      title: row.text.trim() || 'пункт со страницы',
      startDate: date,
      endDate: date,
      sphere,
      topic,
      priority: 'normal',
      unplanned: false,
    });
    setRow(row.id, { taskId: task.id, date });
  };

  const clearPlan = (row: DocBlock) => {
    const task = taskOf(row);
    // A finished task is history, not a plan: un-planning only drops the link
    // then, it does not delete the record of work done.
    if (task && !task.completed) store.remove(task.id);
    setRow(row.id, { taskId: undefined, date: undefined });
  };

  const insertAfter = (at: number, kind: 'text' | 'check') => {
    const row = blank(kind);
    setRows((prev) => [...prev.slice(0, at + 1), row, ...prev.slice(at + 1)]);
    setFocusId(row.id);
  };

  const removeAt = (at: number) => {
    const previous = rows[at - 1] ?? rows[at + 1];
    setRows((prev) => (prev.length === 1 ? [{ ...prev[0], text: '' }] : prev.filter((_, i) => i !== at)));
    if (previous) setFocusId(previous.id);
  };

  const onChange = (row: DocBlock, value: string, at: number) => {
    // Typing "- ", "[] " or "- [ ] " at the start turns the line into a checkbox.
    const marker = /^(?:-\s*\[[ xX]?\]\s*|-\s+|\[\s?\]\s*)/.exec(value);
    if (marker && row.kind === 'text') {
      setRows((prev) => prev.map((item, i) => (
        i === at ? { ...item, kind: 'check', text: value.slice(marker[0].length) } : item
      )));
      return;
    }
    setRow(row.id, { text: value });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, row: DocBlock, at: number) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      insertAfter(at, row.kind);
      return;
    }
    if (event.key === 'Backspace' && !row.text && rows.length > 1) {
      event.preventDefault();
      removeAt(at);
    }
  };

  const planned = rows.filter((row) => row.kind === 'check' && row.taskId).length;

  return (
    <div className="note-editor">
      <input
        className="note-title"
        value={title}
        placeholder="название страницы"
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => {
          const value = title.trim();
          if (!value) {
            setTitle(doc.title);
            return;
          }
          if (value !== treeTitle.current) {
            treeTitle.current = value;
            onTitleChange(value);
          }
          flushBoard();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />

      <div className="note-rows">
        {rows.map((row, at) => {
          const task = taskOf(row);
          const checked = row.kind === 'check' && (row.done === true || task?.completed === true);
          return (
            <div className={`note-row ${row.kind}`} key={row.id}>
              {row.kind === 'check' ? (
                <button
                  type="button"
                  className={`note-box ${checked ? 'on' : ''}`}
                  onClick={() => toggle(row)}
                  aria-label={checked ? 'Снять отметку' : 'Отметить пункт'}
                  title={task ? 'Связано с задачей этого дня' : 'Отметить'}
                />
              ) : (
                <span className="note-dot" aria-hidden />
              )}
              <input
                ref={(el) => {
                  if (el) inputs.current.set(row.id, el);
                  else inputs.current.delete(row.id);
                }}
                className={`note-line ${checked ? 'done' : ''}`}
                value={row.text}
                placeholder={row.kind === 'check' ? 'пункт' : 'текст'}
                onChange={(event) => onChange(row, event.target.value, at)}
                onKeyDown={(event) => onKeyDown(event, row, at)}
                onBlur={() => flushBoard()}
              />
              {row.kind === 'check' && (
                <span className="note-plan">
                  <label className={`note-date-chip ${row.date ? 'set' : ''}`} title={row.date ? 'Перенести на другой день' : 'Поставить в план на день'}>
                    <span className="note-date-text">{row.date ? fmt.dayShort(parseISO(row.date)) : '📅'}</span>
                    <input
                      type="date"
                      value={row.date ?? ''}
                      onChange={(event) => plan(row, event.currentTarget.value)}
                      onClick={(event) => {
                        const el = event.currentTarget as HTMLInputElement & { showPicker?: () => void };
                        try {
                          el.showPicker?.();
                        } catch {
                          // some browsers refuse showPicker outside a gesture
                        }
                      }}
                    />
                  </label>
                  {row.taskId && (
                    <button
                      type="button"
                      className="note-unplan"
                      onClick={() => clearPlan(row)}
                      title="Убрать из плана"
                      aria-label="Убрать из плана"
                    >×</button>
                  )}
                </span>
              )}
              <button
                type="button"
                className="note-row-del"
                onClick={() => removeAt(at)}
                title="Удалить строку"
                aria-label="Удалить строку"
              >×</button>
            </div>
          );
        })}
      </div>

      <div className="note-actions">
        <button type="button" className="note-add" onClick={() => insertAfter(rows.length - 1, 'check')}>+ пункт</button>
        <button type="button" className="note-add" onClick={() => insertAfter(rows.length - 1, 'text')}>+ текст</button>
        <span className="note-hint">
          {planned
            ? `${planned} ${plural(planned, 'пункт', 'пункта', 'пунктов')} в плане — они в задачах на своих днях`
            : 'дата справа от пункта ставит его задачей на этот день'}
        </span>
      </div>
    </div>
  );
}
