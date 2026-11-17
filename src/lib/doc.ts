// Glue between a note (Markdown) and the task engine.
//
// A CHECKLIST LINE and a TASK are the same thing the user cares about, but they
// are stored in two different places: the line lives in the note's Markdown, the
// task in the task store (and on the server, where tasks have no "topic" column
// and no idea about a note). The link is the pair (title, planned day) inside
// the page's own topic — no hidden ids, so a note stays readable and survives a
// round-trip through the server.
import type { Task } from '../types';
import type { BoardDoc, BoardNote } from './board';
import { keyPath, pathKey } from './tree';
import { plain, splitDate } from './md';

/** Tasks filed exactly to this page (not to its category or a sibling folder). */
export function tasksOnPage(tasks: Task[], sphere: string, path: string[]): Task[] {
  const key = pathKey(path);
  return tasks.filter((task) => task.sphere === sphere && (task.topic ?? '') === key);
}

/** The task a checklist line stands for, if any. */
export function matchTask(tasks: Task[], text: string, date?: string): Task | undefined {
  const title = plain(text).toLowerCase();
  if (!title) return undefined;
  return tasks.find((task) => plain(task.title).toLowerCase() === title
    && (date ? task.startDate === date : !task.startDate));
}

const DATE_LABEL = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });

export function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const now = new Date();
  const date = new Date(y, m - 1, d);
  const sameYear = date.getFullYear() === now.getFullYear();
  const label = DATE_LABEL.format(date);
  return sameYear ? label : `${label} ${date.getFullYear()}`;
}

/** One-time conversion of the old block document into Markdown. Nothing is
 *  dropped: text blocks become paragraphs, check blocks become checklist lines
 *  (with their day), stickers become quotes, and every task already filed to the
 *  page becomes a checklist line of its own. */
export function legacyToMarkdown(
  doc: BoardDoc,
  stickers: BoardNote[],
  tasks: Task[],
): string {
  const rows: { text: string; check: boolean }[] = [];
  for (const block of doc.blocks ?? []) {
    const text = block.text.trim();
    if (!text) continue;
    if (block.kind === 'check') {
      rows.push({ text: `- [${block.done ? 'x' : ' '}] ${text}${block.date ? ` ^${block.date}` : ''}`, check: true });
    } else {
      rows.push({ text, check: false });
    }
  }

  for (const note of stickers) {
    const text = note.text.trim();
    if (text) rows.push({ text: `> ${text.replace(/\n/g, '\n> ')}`, check: false });
  }

  const strip = (value: string) => plain(value.replace(/\s*\^\d{4}-\d{2}-\d{2}\s*$/, '').replace(/^- \[[ xX]\]\s*/, '')).toLowerCase();
  const seen = new Set(rows.map((row) => strip(row.text)));
  for (const task of tasks) {
    const title = plain(task.title);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    rows.push({
      text: `- [${task.completed ? 'x' : ' '}] ${title}${task.startDate ? ` ^${task.startDate}` : ''}`,
      check: true,
    });
  }

  let out = '';
  rows.forEach((row, index) => {
    const joined = index > 0 && row.check && rows[index - 1].check ? '\n' : '\n\n';
    out += (index ? joined : '') + row.text;
  });
  return out;
}

/** Markdown of a document, converting the legacy blocks on the fly when the
 *  migration has not run yet. */
export function docMarkdown(doc: BoardDoc | null | undefined, stickers: BoardNote[], tasks: Task[]): string {
  if (!doc) return '';
  if (typeof doc.md === 'string') return doc.md;
  return legacyToMarkdown(doc, stickers, tasks);
}

/** Titles of checklist lines that are already inside the note (planned or not). */
export function linedTitles(md: string): Set<string> {
  const out = new Set<string>();
  for (const line of md.split('\n')) {
    const match = line.match(/^\s*[-*+]\s+\[[ xX]\]\s?(.*)$/);
    if (!match) continue;
    const { text } = splitDate(match[1]);
    const key = plain(text).toLowerCase();
    if (key) out.add(key);
  }
  return out;
}

/** A checklist line's identity inside a note: its text without marks or a day. */
export function linkKey(text: string): string {
  return plain(splitDate(text).text).toLowerCase();
}

/** The task a line stands for. `links` maps taskId → the line it was opened
 *  from; a line without a link still matches a task by its title, so notes
 *  written before links existed keep working. */
export function taskOfLine(
  links: Record<string, string> | undefined,
  tasks: Task[],
  text: string,
): Task | undefined {
  const key = linkKey(text);
  if (!key) return undefined;
  for (const [taskId, stored] of Object.entries(links ?? {})) {
    if (stored !== key) continue;
    const task = tasks.find((item) => item.id === taskId);
    if (task) return task;
  }
  return tasks.find((task) => linkKey(task.title) === key);
}

/** Remember which task a line was opened from. */
export function withLink(
  links: Record<string, string> | undefined,
  taskId: string,
  text: string,
): Record<string, string> {
  return { ...(links ?? {}), [taskId]: linkKey(text) };
}

const CHECK_LINE = /^(\s*[-*+]\s+\[)([ xX])(\]\s?)(.*)$/;

/** Make every LINKED line mirror its task: the tick and the day come from the
 *  task, so changing them in the calendar dialog shows up in the note and vice
 *  versa. Lines without a task are left exactly as the user typed them. */
export function applyLinkedTasks(
  md: string,
  links: Record<string, string> | undefined,
  tasks: Task[],
): string {
  if (!md) return md;
  const keys = new Set(Object.values(links ?? {}));
  const byTitle = new Map(tasks.map((task) => [linkKey(task.title), task]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const lineTask = (text: string): Task | undefined => {
    const key = linkKey(text);
    for (const [taskId, stored] of Object.entries(links ?? {})) {
      if (stored === key) {
        const task = byId.get(taskId);
        if (task) return task;
      }
    }
    return keys.size ? byTitle.get(key) : byTitle.get(key);
  };

  let changed = false;
  const out = md.split('\n').map((raw) => {
    const match = CHECK_LINE.exec(raw);
    if (!match) return raw;
    const task = lineTask(match[4]);
    if (!task) return raw;
    const { text } = splitDate(match[4]);
    const done = task.completed ? 'x' : ' ';
    const date = task.startDate ? ` ^${task.startDate}` : '';
    const next = `${match[1]}${done}${match[3]}${text}${date}`;
    if (next !== raw) changed = true;
    return next;
  });
  return changed ? out.join('\n') : md;
}

/** Sphere + path encoded in a `nodeKey`. */
export function nodeKeyParts(nodeKey: string): { sphere: string; path: string[] } {
  const [sphere, ...rest] = nodeKey.split('\u001F');
  return { sphere, path: keyPath(rest.join('\u001F')) };
}
