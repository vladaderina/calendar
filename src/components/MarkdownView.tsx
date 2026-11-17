// Renders the note's Markdown. Nothing here is editable except the two things
// that make a note a working tool: the checkbox of a checklist line, and the day
// a line is planned for.
import type { ReactNode } from 'react';
import type { BoardPhoto } from '../lib/board';
import { humanDate } from '../lib/doc';
import { parseBlocks } from '../lib/md';
import type { Block } from '../lib/md';

interface Props {
  md: string;
  photos?: BoardPhoto[];
  onToggle?: (index: number, done: boolean) => void;
  onOpenTask?: (index: number) => void;
  onOpenImage?: (src: string) => void;
  /** Rendered while the note is still empty. */
  empty?: ReactNode;
}

const INLINE_RE = /(!\[[^\]]*\]\([^)]*\))|(\[[^\]]+\]\([^)]*\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(`[^`]+`)|((?:https?:\/\/|www\.)[^\s<)]+)/g;

function Photo({ src, photos }: { src: string; photos: BoardPhoto[] }) {
  if (src.startsWith('photo:')) {
    const photo = photos.find((item) => item.id === src.slice(6));
    if (!photo?.data) return <span className="md-photo-missing">фото недоступно</span>;
    return <img className="md-img" src={photo.data} alt={photo.caption} />;
  }
  return <img className="md-img" src={src} alt="" loading="lazy" />;
}

function inline(text: string, photos: BoardPhoto[], onOpenImage?: (src: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  const push = (node: ReactNode) => out.push(<span key={key++}>{node}</span>);

  for (const match of text.matchAll(INLINE_RE)) {
    const at = match.index ?? 0;
    if (at > last) push(text.slice(last, at));
    const token = match[0];

    if (token.startsWith('![')) {
      const parts = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (parts) {
        const src = parts[2].trim();
        push(
          <button
            type="button"
            className="md-img-btn"
            onClick={() => onOpenImage?.(src)}
            title="открыть фото"
          >
            <Photo src={src} photos={photos} />
          </button>,
        );
      } else push(token);
    } else if (token.startsWith('[')) {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (parts) {
        const href = parts[2].trim();
        push(
          <a className="md-link" href={href} target="_blank" rel="noreferrer noopener">
            {inline(parts[1], photos, onOpenImage)}
          </a>,
        );
      } else push(token);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      push(<strong>{inline(token.slice(2, -2), photos, onOpenImage)}</strong>);
    } else if (token.startsWith('~~')) {
      push(<s>{inline(token.slice(2, -2), photos, onOpenImage)}</s>);
    } else if (token.startsWith('`')) {
      push(<code className="md-code">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      push(<em>{inline(token.slice(1, -1), photos, onOpenImage)}</em>);
    } else {
      const href = token.startsWith('www.') ? `https://${token}` : token;
      push(
        <a className="md-link" href={href} target="_blank" rel="noreferrer noopener">{token}</a>,
      );
    }
    last = at + token.length;
  }
  if (last < text.length) push(text.slice(last));
  return out;
}

function DateChip({ date, onClear }: { date: string; onClear?: () => void }) {
  return (
    <span className="md-date">
      <span className="md-date-dot" />
      {humanDate(date)}
      {onClear && (
        <button type="button" className="md-date-x" onClick={onClear} title="снять с плана">×</button>
      )}
    </span>
  );
}

function PlanButton({ date, onOpen }: { date?: string; onOpen?: () => void }) {
  if (!onOpen) return date ? <DateChip date={date} /> : null;
  return (
    <span className="md-plan">
      <button
        type="button"
        className={`md-plan-btn${date ? ' is-set' : ''}`}
        onClick={onOpen}
        title={date ? `${humanDate(date)} — открыть задачу` : 'открыть как задачу: день, заметка, цвет, повтор'}
      >
        {date ? humanDate(date) : '→ задача'}
      </button>
    </span>
  );
}

function BlockView({
  block,
  photos,
  onToggle,
  onOpenTask,
  onOpenImage,
}: {
  block: Block;
  photos: BoardPhoto[];
  onToggle?: (index: number, done: boolean) => void;
  onOpenTask?: (index: number) => void;
  onOpenImage?: (src: string) => void;
}) {
  switch (block.type) {
    case 'h': {
      const Tag = (`h${block.level + 1}`) as 'h2' | 'h3' | 'h4';
      return <Tag className={`md-heading md-heading-${block.level}`}>{inline(block.text, photos, onOpenImage)}</Tag>;
    }
    case 'p':
      return <p className="md-p">{inline(block.text, photos, onOpenImage)}</p>;
    case 'quote':
      return <blockquote className="md-quote">{inline(block.text, photos, onOpenImage)}</blockquote>;
    case 'ul':
      return (
        <ul className="md-ul">
          {block.items.map((item, index) => (
            <li key={index}>{inline(item, photos, onOpenImage)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="md-ol">
          {block.items.map((item, index) => (
            <li key={index}>{inline(item, photos, onOpenImage)}</li>
          ))}
        </ol>
      );
    case 'check':
      return (
        <div className="md-checks">
          {block.items.map((item) => (
            <div key={item.index} className={`md-check${item.done ? ' is-done' : ''}`}>
              <button
                type="button"
                className="md-check-box"
                aria-pressed={item.done}
                onClick={() => onToggle?.(item.index, !item.done)}
                title={item.done ? 'отметить невыполненным' : 'выполнено'}
              >
                {item.done ? '✓' : ''}
              </button>
              <span className="md-check-text">{inline(item.text, photos, onOpenImage)}</span>
              <PlanButton date={item.date} onOpen={() => onOpenTask?.(item.index)} />
            </div>
          ))}
        </div>
      );
    case 'code':
      return (
        <pre className="md-pre">
          <code>{block.text}</code>
        </pre>
      );
    case 'hr':
      return <hr className="md-hr" />;
    case 'img':
      return (
        <button type="button" className="md-img-btn md-img-wide" onClick={() => onOpenImage?.(block.src)}>
          <Photo src={block.src} photos={photos} />
          {block.alt && <span className="md-img-cap">{block.alt}</span>}
        </button>
      );
    default:
      return null;
  }
}

export function MarkdownView({ md, photos = [], onToggle, onOpenTask, onOpenImage, empty }: Props) {
  const blocks = parseBlocks(md);
  if (!blocks.length) return <div className="md md-empty">{empty}</div>;
  return (
    <div className="md">
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          photos={photos}
          onToggle={onToggle}
          onOpenTask={onOpenTask}
          onOpenImage={onOpenImage}
        />
      ))}
    </div>
  );
}
