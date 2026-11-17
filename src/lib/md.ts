// Markdown is the note format. One file, one string — what the user types is
// what is stored, so nothing can be "lost in translation" on the way.
//
// The only dialect extension is the day planner: a checklist line MAY end with
// `^2026-11-20`, which plans that item for that day and creates a real task.
// It is written by the UI (calendar button on the line), never typed by hand.

export interface CheckLine {
  /** Index among ALL check lines of the document, 0-based. */
  index: number;
  text: string;
  done: boolean;
  date?: string;
}

const CHECK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/;
const DATE_RE = /\s+\^(\d{4}-\d{2}-\d{2})\s*$/;

/** Split a check line body into text + planned day. */
export function splitDate(body: string): { text: string; date?: string } {
  const match = body.match(DATE_RE);
  if (!match) return { text: body.trim() };
  const text = body.replace(DATE_RE, '').trim();
  return { text, date: match[1] };
}

/** Every checklist line of the document, in order. */
export function checkLines(md: string): CheckLine[] {
  const out: CheckLine[] = [];
  for (const line of md.split('\n')) {
    const match = line.match(CHECK_RE);
    if (!match) continue;
    const { text, date } = splitDate(match[3]);
    out.push({ index: out.length, text, done: match[2].toLowerCase() === 'x', date });
  }
  return out;
}

export function checkCounts(md: string): { total: number; done: number; planned: number } {
  let total = 0;
  let done = 0;
  let planned = 0;
  for (const line of checkLines(md)) {
    total++;
    if (line.done) done++;
    if (line.date) planned++;
  }
  return { total, done, planned };
}

/** Rewrite ONE check line, keeping the rest of the document byte-identical. */
function editCheckLine(md: string, index: number, edit: (line: CheckLine) => CheckLine): string {
  const lines = md.split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CHECK_RE);
    if (!match) continue;
    seen++;
    if (seen !== index) continue;
    const current = { index, done: match[2].toLowerCase() === 'x', ...splitDate(match[3]) };
    const next = edit(current);
    const indent = match[1] ?? '';
    const box = next.done ? 'x' : ' ';
    const suffix = next.date ? ` ^${next.date}` : '';
    lines[i] = `${indent}- [${box}] ${next.text.trim()}${suffix}`;
    return lines.join('\n');
  }
  return md;
}

export function setDone(md: string, index: number, done: boolean): string {
  return editCheckLine(md, index, (line) => ({ ...line, done }));
}

export function setDate(md: string, index: number, date: string | null): string {
  return editCheckLine(md, index, (line) => ({ ...line, date: date ?? undefined }));
}

export function renameCheck(md: string, index: number, text: string): string {
  return editCheckLine(md, index, (line) => ({ ...line, text }));
}

/** Add a line at the end of the document (a blank line first when the last line
 *  is not blank, so blocks never glue together). */
export function appendLine(md: string, line: string): string {
  const body = md.replace(/\s+$/, '');
  if (!body) return `${line}\n`;
  return `${body}\n${line}\n`;
}

/** Strip inline marks so a task title reads as plain text. */
export function plain(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type Block =
  | { type: 'h'; level: 1 | 2 | 3; text: string }
  | { type: 'p'; text: string }
  | { type: 'quote'; text: string; children?: Block[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'check'; items: { text: string; done: boolean; date?: string; index: number }[] }
  | { type: 'code'; text: string; lang: string }
  | { type: 'hr' }
  | { type: 'img'; alt: string; src: string };

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+(?!\[[ xX]\])(.*)$/;
const OL_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const IMG_ONLY_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Parse the document into display blocks. Check items keep their index so the
 *  renderer can rewrite exactly the line the user clicked. */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let checkIndex = 0;
  let i = 0;

  const flushParagraph = (buffer: string[]) => {
    if (!buffer.length) return;
    const text = buffer.join('\n').trim();
    if (text) out.push({ type: 'p', text });
    buffer.length = 0;
  };

  const paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flushParagraph(paragraph);
      const lang = line.replace(/^\s*```/, '').trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ type: 'code', text: body.join('\n'), lang });
      continue;
    }

    if (!line.trim()) {
      flushParagraph(paragraph);
      i++;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushParagraph(paragraph);
      out.push({ type: 'h', level: heading[1].length as 1 | 2 | 3, text: heading[2].trim() });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      flushParagraph(paragraph);
      out.push({ type: 'hr' });
      i++;
      continue;
    }

    const check = line.match(CHECK_RE);
    if (check) {
      flushParagraph(paragraph);
      const items: { text: string; done: boolean; date?: string; index: number }[] = [];
      while (i < lines.length) {
        const match = lines[i].match(CHECK_RE);
        if (!match) break;
        const { text, date } = splitDate(match[3]);
        items.push({ text, done: match[2].toLowerCase() === 'x', date, index: checkIndex++ });
        i++;
      }
      out.push({ type: 'check', items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph);
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push({ type: 'quote', text: quote.join('\n') });
      continue;
    }

    const ul = line.match(UL_RE);
    if (ul) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length) {
        const match = lines[i].match(UL_RE);
        if (!match) break;
        items.push(match[1].trim());
        i++;
      }
      out.push({ type: 'ul', items });
      continue;
    }

    const ol = line.match(OL_RE);
    if (ol) {
      flushParagraph(paragraph);
      const items: string[] = [];
      while (i < lines.length) {
        const match = lines[i].match(OL_RE);
        if (!match) break;
        items.push(match[2].trim());
        i++;
      }
      out.push({ type: 'ol', items });
      continue;
    }

    const onlyImage = line.trim().match(IMG_ONLY_RE);
    if (onlyImage) {
      flushParagraph(paragraph);
      out.push({ type: 'img', alt: onlyImage[1], src: onlyImage[2].trim() });
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph(paragraph);
  return out;
}

/** Wrap the selected text (or insert a placeholder) and say where the caret goes. */
export function surround(
  text: string,
  start: number,
  end: number,
  before: string,
  after: string,
  placeholder: string,
): { text: string; caret: [number, number] } {
  const selected = text.slice(start, end);
  const body = selected || placeholder;
  const next = `${text.slice(0, start)}${before}${body}${after}${text.slice(end)}`;
  if (selected) return { text: next, caret: [start + before.length, start + before.length + body.length] };
  return { text: next, caret: [start + before.length, start + before.length + body.length] };
}

/** Prefix every line of the selection (list / checkbox / heading). */
export function prefixLines(
  text: string,
  start: number,
  end: number,
  makePrefix: (index: number) => string,
): { text: string; caret: [number, number] } {
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEnd = end >= text.length ? text.length : text.indexOf('\n', end) < 0 ? text.length : text.indexOf('\n', end);
  const slice = text.slice(lineStart, lineEnd);
  const lines = slice.split('\n');
  const prefixed = lines
    .map((line, index) => `${makePrefix(index)}${line.replace(/^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|#{1,3}\s+)?/, '$1')}`)
    .join('\n');
  return {
    text: `${text.slice(0, lineStart)}${prefixed}${text.slice(lineEnd)}`,
    caret: [lineStart, lineStart + prefixed.length],
  };
}

/** yyyy-MM-dd in local time. */
export function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
