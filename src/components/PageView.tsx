// A PAGE is a blank note, like Notion: one Markdown document, an optional cover,
// pictures, text with headings/links, and checklist lines that turn into real
// tasks the moment you plan them for a day.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { store, useTasks } from '../store';
import { addBoardPhoto, hydrateBoard, removeBoardItem, saveBoardDoc, useBoardNotes } from '../lib/board';
import type { BoardDoc, BoardPhoto } from '../lib/board';
import type { Task } from '../types';
import { applyLinkedTasks, docMarkdown, taskOfLine, tasksOnPage, withLink } from '../lib/doc';
import { checkCounts, checkLines, plain, prefixLines, setDone, surround } from '../lib/md';
import { pathKey } from '../lib/tree';
import { fileToDataUrl } from '../lib/image';
import { MarkdownView } from './MarkdownView';

interface Props {
  sphere: string;
  path: string[];
  doc: BoardDoc;
  photos: BoardPhoto[];
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Opens the calendar's own task dialog (day, note, colour, repeat, backlog). */
  onEdit: (task: Task) => void;
}

const GOAL_TEMPLATE = `## Чего я хочу

Опиши результат так, будто он уже есть.

## Зачем мне это

Что изменится, когда получится.

## Шаги

- [ ] первый шаг

## Вдохновение

`;

export function PageView({ sphere, path, doc, photos, onRename, onDelete, onEdit }: Props) {
  const tasks = useTasks();
  const stickers = useBoardNotes();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [draft, setDraft] = useState(() => applyLinkedTasks(docMarkdown(doc, stickers, []), doc.links, tasks));
  const [draftTitle, setDraftTitle] = useState(path[path.length - 1] ?? doc.title);
  const [lightbox, setLightbox] = useState<BoardPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // What the note says once every LINKED line has taken its tick and day from
  // its task. A line the user typed herself (no task) comes through untouched.
  const stored = useMemo(
    () => applyLinkedTasks(docMarkdown(doc, stickers, []), doc.links, tasks),
    [doc, stickers, tasks],
  );

  // Another device (or the migration) changed the note while we were looking.
  useEffect(() => {
    if (mode === 'view') setDraft(stored);
  }, [stored, doc.id, mode]);

  useEffect(() => {
    setDraftTitle(path[path.length - 1] ?? doc.title);
  }, [path, doc.id, doc.title]);

  // Autosave: typing must feel local, the store only needs the end result.
  useEffect(() => {
    if (draft === (doc.md ?? '')) return;
    const timer = window.setTimeout(() => saveBoardDoc(doc.id, { md: draft }), 300);
    return () => window.clearTimeout(timer);
  }, [draft, doc.id, doc.md]);

  const counts = useMemo(() => checkCounts(draft), [draft]);
  const lines = useMemo(() => checkLines(draft), [draft]);
  const pageTasks = useMemo(() => tasksOnPage(tasks, sphere, path), [tasks, sphere, path]);
  const percent = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;

  const save = (next: string) => {
    setDraft(next);
    saveBoardDoc(doc.id, { md: next });
  };

  const toggle = (index: number, done: boolean) => {
    const line = lines[index];
    if (!line) return;
    save(setDone(draft, index, done));
    // A linked line drives its task; an unlinked one is just a note item.
    const task = taskOfLine(doc.links, pageTasks, line.text);
    if (task) store.update(task.id, { completed: done, completedAt: done ? new Date().toISOString() : undefined });
  };

  /** «→ задача»: open the item as a real task, in the calendar's own dialog, so
   *  everything a task has is available — day picked in the calendar, note,
   *  colour, repeat, backlog. The line stays in the note and follows the task. */
  const openTask = (index: number) => {
    const line = lines[index];
    if (!line) return;
    const linked = taskOfLine(doc.links, pageTasks, line.text);
    if (linked) {
      onEdit(linked);
      return;
    }
    const made = store.add({
      title: plain(line.text) || 'новый пункт',
      sphere,
      topic: pathKey(path),
      startDate: line.date,
      endDate: line.date,
      unplanned: !line.date,
    });
    // `store.add` always starts a task open: a line ticked before it became a
    // task must be closed explicitly.
    if (line.done) store.update(made.id, { completed: true, completedAt: new Date().toISOString() });
    saveBoardDoc(doc.id, { links: withLink(doc.links, made.id, line.text) });
    onEdit(made);
  };

  const addItem = () => {
    const body = draft.replace(/\s+$/, '');
    const last = body.slice(body.lastIndexOf('\n') + 1);
    // Keep one checklist block together when the note already ends with items.
    const next = /^\s*[-*+]\s+\[[ xX]\]/.test(last) ? `${body}\n- [ ] ` : `${body}\n\n- [ ] `;
    save(next);
    setMode('edit');
    window.setTimeout(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(next.length, next.length);
    }, 30);
  };

  const wrap = (before: string, after: string, placeholder: string) => {
    const area = areaRef.current;
    if (!area) return;
    const result = surround(draft, area.selectionStart, area.selectionEnd, before, after, placeholder);
    save(result.text);
    window.setTimeout(() => {
      area.focus();
      area.setSelectionRange(result.caret[0], result.caret[1]);
    }, 0);
  };

  const linePrefix = (make: (index: number) => string) => {
    const area = areaRef.current;
    if (!area) return;
    const result = prefixLines(draft, area.selectionStart, area.selectionEnd, make);
    save(result.text);
    window.setTimeout(() => {
      area.focus();
      area.setSelectionRange(result.caret[0], result.caret[1]);
    }, 0);
  };

  const insert = (text: string) => {
    const area = areaRef.current;
    const at = area ? area.selectionStart : draft.length;
    const end = area ? area.selectionEnd : draft.length;
    const next = `${draft.slice(0, at)}${text}${draft.slice(end)}`;
    save(next);
    window.setTimeout(() => {
      if (!area) return;
      area.focus();
      area.setSelectionRange(at + text.length, at + text.length);
    }, 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const area = event.currentTarget;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      wrap('**', '**', 'жирный');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      wrap('*', '*', 'курсив');
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      setMode((value) => (value === 'edit' ? 'view' : 'edit'));
      return;
    }
    if (event.key === 'Enter') {
      const upto = draft.slice(0, area.selectionStart);
      const current = upto.slice(upto.lastIndexOf('\n') + 1);
      const check = current.match(/^(\s*)([-*+])\s+\[[ xX]\]\s?(.*)$/);
      const bullet = current.match(/^(\s*)([-*+])\s+(.*)$/);
      if (check && check[3].trim()) {
        event.preventDefault();
        insert(`\n${check[1]}${check[2]} [ ] `);
        return;
      }
      if (bullet && bullet[3].trim()) {
        event.preventDefault();
        insert(`\n${bullet[1]}${bullet[2]} `);
      }
    }
  };

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      for (const file of files) {
        const data = await fileToDataUrl(file);
        if (!data) continue;
        addBoardPhoto(data, '', `${sphere}\u001F${pathKey(path)}`);
      }
      await hydrateBoard();
    } finally {
      setBusy(false);
    }
  };

  const cover = photos[0];

  return (
    <article className="pg">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={onFiles}
      />

      <header className={`pg-head${cover ? ' has-cover' : ''}`}>
        {cover && (
          <button type="button" className="pg-cover" onClick={() => setLightbox(cover)}>
            {cover.data
              ? <img src={cover.data} alt="" />
              : <span className="pg-cover-wait">загружаю фото…</span>}
          </button>
        )}
        <div className="pg-title-row">
          <input
            className="pg-title"
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={() => {
              const next = draftTitle.trim();
              if (next && next !== path[path.length - 1]) onRename(next);
              else setDraftTitle(path[path.length - 1] ?? doc.title);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setDraftTitle(path[path.length - 1] ?? doc.title);
                event.currentTarget.blur();
              }
            }}
            aria-label="название страницы"
          />
          <div className="pg-actions">
            <button
              type="button"
              className={`pg-btn${mode === 'edit' ? ' is-on' : ''}`}
              onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
            >
              {mode === 'edit' ? 'готово' : 'изменить'}
            </button>
            <button type="button" className="pg-icon" onClick={() => fileRef.current?.click()} title="добавить фото">
              {busy ? '…' : '🖼'}
            </button>
            <button type="button" className="pg-icon pg-danger" onClick={onDelete} title="удалить страницу">
              🗑
            </button>
          </div>
        </div>

        <div className="pg-meta">
          {counts.total > 0 ? (
            <>
              <div className="pg-bar" title={`${counts.done} из ${counts.total}`}>
                <span style={{ width: `${percent}%` }} />
              </div>
              <span className="pg-meta-text">{counts.done}/{counts.total} пунктов</span>
            </>
          ) : (
            <span className="pg-meta-text">пустая страница — начни с заголовка или пункта</span>
          )}
        </div>
      </header>

      {photos.length > 0 && (
        <div className="pg-gallery">
          {photos.map((photo, index) => (
            <figure key={photo.id} className={`pg-thumb${index === 0 && cover ? ' is-cover' : ''}`}>
              {index === 0 && cover && <span className="pg-thumb-badge">обложка</span>}
              <button type="button" onClick={() => setLightbox(photo)}>
                {photo.data ? <img src={photo.data} alt={photo.caption} /> : <span>…</span>}
              </button>
              <button
                type="button"
                className="pg-thumb-x"
                title="удалить фото"
                onClick={() => {
                  if (!window.confirm('Удалить это фото?')) return;
                  removeBoardItem(photo.id);
                }}
              >
                ×
              </button>
            </figure>
          ))}
          <button type="button" className="pg-thumb-add" onClick={() => fileRef.current?.click()}>
            <span>＋</span>
            фото
          </button>
        </div>
      )}

      {mode === 'edit' ? (
        <div className="pg-editor">
          <div className="pg-toolbar">
            <button type="button" onClick={() => linePrefix(() => '## ')} title="заголовок">H2</button>
            <button type="button" onClick={() => wrap('**', '**', 'жирный')} title="жирный"><b>Ж</b></button>
            <button type="button" onClick={() => wrap('*', '*', 'курсив')} title="курсив"><i>К</i></button>
            <button type="button" onClick={() => wrap('[', '](https://)', 'ссылка')} title="ссылка">🔗</button>
            <span className="pg-tool-sep" />
            <button type="button" onClick={() => linePrefix(() => '- ')} title="список">•</button>
            <button type="button" onClick={() => linePrefix(() => '- [ ] ')} title="пункт с галочкой">☑</button>
            <button type="button" onClick={() => linePrefix(() => '> ')} title="цитата">❝</button>
            <button type="button" onClick={() => insert('\n---\n')} title="разделитель">—</button>
            <span className="pg-tool-sep" />
            <button type="button" onClick={() => insert(`\n![](${photos[0] ? `photo:${photos[0].id}` : ''})\n`)} title="фото из галереи">
              🖼+
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} title="загрузить фото">⬆</button>
          </div>
          <textarea
            ref={areaRef}
            className="pg-area"
            value={draft}
            spellCheck
            placeholder="Пиши как в обычной заметке. «- [ ] » — пункт, который можно запланировать на день."
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={Math.max(14, draft.split('\n').length + 2)}
          />
          <p className="pg-hint">
            Markdown: <code>## заголовок</code> · <code>**жирный**</code> · <code>- пункт</code> ·
            <code>- [ ] пункт</code> · <code>^2026-11-20</code> — день. Ctrl+Enter — посмотреть.
          </p>
        </div>
      ) : (
        <>
          <MarkdownView
            md={draft}
            photos={photos}
            onToggle={toggle}
            onOpenTask={openTask}
            onOpenImage={(src) => {
              const photo = photos.find((item) => item.id === src.replace('photo:', ''));
              if (photo) setLightbox(photo);
            }}
            empty={(
              <div className="pg-empty">
                <p>Здесь пока пусто. Это чистый лист: заголовки, текст, фото и пункты, которые
                  становятся задачами.</p>
                <div className="pg-empty-actions">
                  <button type="button" className="pg-cta" onClick={() => { setDraft(GOAL_TEMPLATE); setMode('edit'); }}>
                    шаблон цели
                  </button>
                  <button type="button" className="pg-cta" onClick={() => setMode('edit')}>писать</button>
                  <button type="button" className="pg-cta" onClick={() => fileRef.current?.click()}>фото</button>
                </div>
              </div>
            )}
          />
          <div className="pg-foot">
            <button type="button" className="pg-add-line" onClick={addItem}>＋ пункт</button>
            <span className="pg-foot-hint">у пункта «→ задача» открывает задачу со всеми её полями</span>
          </div>
        </>
      )}

      {lightbox && (
        <div className="pg-lightbox" onClick={() => setLightbox(null)}>
          <button type="button" className="pg-lightbox-x" onClick={() => setLightbox(null)}>×</button>
          {lightbox.data
            ? <img src={lightbox.data} alt={lightbox.caption} onClick={(event) => event.stopPropagation()} />
            : <span className="pg-cover-wait">загружаю фото…</span>}
          {lightbox.caption && <p>{lightbox.caption}</p>}
        </div>
      )}

    </article>
  );
}
