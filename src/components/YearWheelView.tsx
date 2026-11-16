import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  addDays, addMonths, differenceInCalendarDays, endOfMonth, format, getDaysInMonth,
  parseISO, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { ru } from 'date-fns/locale';
import { fmt } from '../utils/date';
import {
  addWheelNote, getWheelNote, getWheelNotes, planWheelNote, removeWheelNote,
  subscribeWheelNotes, unplanWheelNote, updateWheelNote, type WheelNote,
} from '../lib/wheelNotes';
import {
  getWeekMark, getWheelMarks, setWeekNote, subscribeWheel, type WheelMarks,
} from '../lib/wheel';

/**
 * Круг года — «фактический» год.
 *
 * The circle always starts at TODAY and runs exactly one year forward, so
 * every week on it is in the future and nothing is in the past. Today sits at
 * the top; the next 1 January is a marked boundary inside the circle. The
 * window can be slid one month at a time with ‹ › — backwards into the past,
 * or forward past the one-year horizon — and a "сейчас" button returns to the
 * default year-ahead view.
 *
 * Three columns around the circle:
 *   · left  — notes with no date yet: colourless, drag (or point) them onto a
 *             week to place them, and a random colour is assigned;
 *   · centre— the wheel itself: every placed note sits on its week as a small
 *             coloured dot that can be picked (several at once) to highlight it
 *             here and in the right column. There are no colour categories on
 *             the wheel any more (the user removed them);
 *   · right — the placed notes, sorted by date and grouped into month blocks
 *             with the interval each note covers.
 *
 * These notes are the user's OWN list — they are NOT tasks. They never appear
 * in the planner, the dashboard or any task list, and tasks never appear here:
 * separate storage (lib/wheelNotes) and a separate settings segment.
 */

const SIZE = 640;
const C = SIZE / 2;
const R_OUT = 226;
const R_IN = 152;
// Month band just outside the week ring: one arc per month.
const R_M0 = 230;
const R_M1 = 242;
// Month names sit at the MIDDLE of their month.
const R_LABEL = 262;
// Year boundary labels sit slightly further out, so a month name at the same
// angle can never collide with them.
const R_YEAR = 286;
// How many note dots fit into one week sector before the rest are counted.
const MAX_DOTS = 3;
// Dots of one week are stacked along the radius; the step is wide enough that
// two dots — and the picked one's thicker outline — never touch.
const DOT_R = 3.8;
const DOT_STEP = 13;
const DOT_TOP = R_OUT - 12;

interface Props {
  onOpenWeek: (d: Date) => void;
}

function xy(r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(rad), C + r * Math.sin(rad)];
}

function sectorPath(a0: number, a1: number, r0 = R_IN, r1 = R_OUT): string {
  const [x0, y0] = xy(r1, a0);
  const [x1, y1] = xy(r1, a1);
  const [x2, y2] = xy(r0, a1);
  const [x3, y3] = xy(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r1} ${r1} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)} A ${r0} ${r0} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}

/** ISO week number (1..53). */
function isoWeekNumber(d: Date): number {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7; // Mon = 0
  t.setDate(t.getDate() - day + 3); // Thursday of this week
  const firstThursday = new Date(t.getFullYear(), 0, 4);
  const fday = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - fday + 3);
  return 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

const MONTHS_IN_WINDOW = 12;
const MONTH_SHORT = ['янв', 'фев', 'март', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTH_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** "12 ноя" or "12–18 ноя" or "12 ноя – 3 дек" — the interval a note covers. */
function noteSpan(n: WheelNote): string {
  if (!n.startDate) return '—';
  const s = parseISO(n.startDate);
  const e = parseISO(n.endDate ?? n.startDate);
  if (fmt.iso(s) === fmt.iso(e) || e < s) return fmt.dayShort(s);
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${s.getDate()}–${e.getDate()} ${MONTH_SHORT[s.getMonth()]}`;
  }
  return `${fmt.dayShort(s)} – ${fmt.dayShort(e)}`;
}

function monthBlockKey(d: Date): string {
  return `${MONTH_FULL[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * The interval shown inside ONE month card. A note that runs over a month
 * boundary appears in every month it covers; the month it starts in shows the
 * whole interval, the following months show how much of the note is left.
 */
function monthSpan(n: WheelNote, from: Date, to: Date): string {
  if (!n.startDate) return '—';
  const s = parseISO(n.startDate);
  const e = parseISO(n.endDate ?? n.startDate);
  const wholeHere = s >= from && e <= to;
  if (wholeHere) return noteSpan(n);
  const startsBefore = s < from;
  const endsAfter = e > to;
  if (startsBefore && endsAfter) return 'весь месяц';
  if (startsBefore) return `до ${fmt.dayShort(e)}`;
  return noteSpan(n);
}

const NOTE_FALLBACK_COLOR = '#8d9199';

export function YearWheelView({ onOpenWeek }: Props) {
  const today = useMemo(() => new Date(), []);
  const todayStart = useMemo(() => startOfDay(today), [today]);
  const todayKey = useMemo(() => fmt.iso(startOfWeek(today, { weekStartsOn: 1 })), [today]);

  const [shiftMonths, setShiftMonths] = useState(0);
  const [notes, setNotes] = useState<WheelNote[]>(() => getWheelNotes());
  const [marks, setMarks] = useState<WheelMarks>(() => getWheelMarks());
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  // Notes highlighted on the wheel (several at once).
  const [pickedNotes, setPickedNotes] = useState<string[]>([]);
  // A note waiting for a week to be dropped on.
  const [armedNote, setArmedNote] = useState<string | null>(null);
  // Inline rename of a note.
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [newNote, setNewNote] = useState('');
  // The range currently being dragged out on the ring.
  const [range, setRange] = useState<{ i0: number; i1: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const noteTimer = useRef<number | null>(null);

  useEffect(() => subscribeWheel(() => setMarks(getWheelMarks())), []);
  useEffect(() => subscribeWheelNotes(() => setNotes(getWheelNotes())), []);

  // ── The window: today → +1 year, slid by whole months ───────────────
  const windowStart = useMemo(() => addMonths(today, shiftMonths), [today, shiftMonths]);
  const windowEnd = useMemo(() => addMonths(windowStart, MONTHS_IN_WINDOW), [windowStart]);
  const daysInWindow = useMemo(
    () => differenceInCalendarDays(windowEnd, windowStart),
    [windowStart, windowEnd],
  );
  const angleOf = (d: Date) => (differenceInCalendarDays(d, windowStart) / daysInWindow) * 360;

  // Week sectors are real ISO weeks, clipped to the window: the first week
  // starts exactly at the top (today), the last one ends exactly there too.
  const sectors = useMemo(() => {
    const list: { start: Date; a0: number; a1: number; month: number }[] = [];
    const first = startOfWeek(windowStart, { weekStartsOn: 1 });
    const last = startOfWeek(addDays(windowEnd, -1), { weekStartsOn: 1 });
    for (let w = first; w <= last; w = addDays(w, 7)) {
      const a0 = Math.max(0, angleOf(w));
      const a1 = Math.min(360, angleOf(addDays(w, 7)));
      if (a1 - a0 < 0.05) continue;
      const month = startOfMonth(w < windowStart ? windowStart : w).getMonth();
      list.push({ start: w, a0, a1, month });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowStart.getTime(), daysInWindow]);

  // ── Months: band arcs + a name at the MIDDLE of each month ──────────
  const months = useMemo(() => {
    const out: {
      a0: number; a1: number; label: string; month: number; midDeg: number; midInside: boolean;
    }[] = [];
    let m = startOfMonth(windowStart);
    while (m < windowEnd) {
      const next = startOfMonth(addDays(endOfMonth(m), 1));
      const mid = new Date(m.getFullYear(), m.getMonth(), Math.ceil(getDaysInMonth(m) / 2));
      const midDeg = angleOf(mid);
      out.push({
        a0: Math.max(0, angleOf(m)),
        a1: Math.min(360, angleOf(next)),
        label: format(m, 'LLL', { locale: ru }).replace('.', ''),
        month: m.getMonth(),
        midDeg,
        midInside: midDeg >= 0 && midDeg < 360,
      });
      m = next;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowStart.getTime(), daysInWindow]);

  // New-year boundaries inside the window.
  const yearMarks = useMemo(() => {
    const out: { deg: number; year: number }[] = [];
    const lastYear = windowEnd.getFullYear();
    for (let y = windowStart.getFullYear(); y <= lastYear; y++) {
      const jan1 = new Date(y, 0, 1);
      const deg = angleOf(jan1);
      if (deg >= 0 && deg < 360) out.push({ deg, year: y });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowStart.getTime(), daysInWindow]);

  // ── Placed notes per week (the dots on the ring) ────────────────────
  const placedNotes = useMemo(() => notes.filter((n) => n.startDate), [notes]);

  const weekNotes = useMemo(() => {
    const map = new Map<string, WheelNote[]>();
    for (const s of sectors) {
      const weekStart = fmt.iso(s.start);
      const weekEnd = fmt.iso(addDays(s.start, 6));
      const list = placedNotes.filter((n) => {
        const from = n.startDate!;
        const to = n.endDate && n.endDate > from ? n.endDate : from;
        return from <= weekEnd && to >= weekStart;
      });
      map.set(weekStart, list);
    }
    return map;
  }, [placedNotes, sectors]);

  // ── The two lists beside the circle ─────────────────────────────────
  const unplaced = useMemo(
    () => notes.filter((n) => !n.startDate).sort((a, b) => a.t - b.t),
    [notes],
  );

  const placed = useMemo(() => {
    const todayIso = fmt.iso(todayStart);
    return notes
      .filter((n) => {
        if (!n.startDate) return false;
        const to = n.endDate && n.endDate > n.startDate ? n.endDate : n.startDate;
        return to >= todayIso; // past periods belong to history, not a planner
      })
      .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.t - b.t);
  }, [notes, todayStart]);

  const monthBlocks = useMemo(() => {
    const map = new Map<
      string,
      { key: string; sort: number; from: Date; to: Date; notes: WheelNote[] }
    >();
    for (const n of placed) {
      const s = parseISO(n.startDate!);
      const e = parseISO(n.endDate ?? n.startDate!);
      // A note stretched over several months belongs to EVERY month it covers,
      // so it shows up in each of those blocks on the right.
      const lastM = startOfMonth(e > s ? e : s);
      for (let m = startOfMonth(s); m <= lastM; m = addMonths(m, 1)) {
        const to = endOfMonth(m);
        if (to < todayStart) continue; // that month is already over
        const key = monthBlockKey(m);
        if (!map.has(key)) {
          map.set(key, { key, sort: m.getFullYear() * 100 + m.getMonth(), from: m, to, notes: [] });
        }
        map.get(key)!.notes.push(n);
      }
    }
    for (const b of map.values()) {
      b.notes.sort((x, y) => (x.startDate ?? '').localeCompare(y.startDate ?? '') || x.t - y.t);
    }
    return [...map.values()].sort((a, b) => a.sort - b.sort);
  }, [placed, todayStart]);

  // ── Geometry helpers: pointer → week index ──────────────────────────
  const angleAt = (clientX: number, clientY: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = ((clientX - rect.left) / rect.width) * SIZE;
    const y = ((clientY - rect.top) / rect.height) * SIZE;
    const dx = x - C;
    const dy = y - C;
    if (Math.hypot(dx, dy) < 46) return null; // dead zone in the middle
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI; // 0 = top, clockwise
    if (deg < 0) deg += 360;
    return deg;
  };

  const weekIndexAt = (deg: number): number => {
    if (sectors.length === 0) return -1;
    for (let i = 0; i < sectors.length; i++) {
      if (deg >= sectors[i].a0 && deg < sectors[i].a1) return i;
    }
    return deg >= (sectors[sectors.length - 1]?.a1 ?? 0) ? sectors.length - 1 : 0;
  };

  // ── Dragging on the ring ──────────────────────────────────────────────
  // One gesture, two meanings:
  //   place   — a note is armed: drop it over the dragged range (this is how a
  //             note is stretched across several weeks in one go);
  //   stretch — a dot of a note already on the circle is dragged: the note's
  //             end follows the pointer, so it can be lengthened/shortened.
  type DragKind = 'place' | 'stretch';
  interface DragState { kind: DragKind; anchor: number; last: number; noteId?: string }

  const dragRef = useRef<DragState | null>(null);
  const [dragKind, setDragKind] = useState<DragKind | null>(null);
  // A press on a note dot: a tap selects it, a drag stretches it.
  const pressRef = useRef<{ id: string; x: number; y: number; anchor: number; dragging: boolean } | null>(null);
  const interactive = Boolean(armedNote) || dragKind !== null;

  const beginDrag = (state: DragState, e: ReactPointerEvent<Element>) => {
    dragRef.current = { ...state, last: state.anchor };
    setDragKind(state.kind);
    setRange({ i0: state.anchor, i1: state.anchor });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const deg = angleAt(e.clientX, e.clientY);
    if (deg == null) return;
    const idx = weekIndexAt(deg);
    if (idx < 0) return;

    // A note is armed: the click places it, the drag stretches it.
    if (armedNote) {
      beginDrag({ kind: 'place', anchor: idx, last: idx, noteId: armedNote }, e);
      return;
    }
    setSelectedWeek(fmt.iso(sectors[idx].start));
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const deg = angleAt(e.clientX, e.clientY);
    if (deg == null) return;
    const idx = weekIndexAt(deg);
    if (idx < 0) return;
    d.last = idx;
    setRange((r) => (r && r.i1 === idx ? r : { i0: d.anchor, i1: idx }));
  };

  const finishDrag = () => {
    const d = dragRef.current;
    pressRef.current = null;
    if (!d) return;
    dragRef.current = null;
    const lo = Math.min(d.anchor, d.last);
    const hi = Math.max(d.anchor, d.last);
    if (d.kind === 'place' && d.noteId) {
      placeNote(d.noteId, sectors[lo].start, sectors[hi].start);
      setArmedNote(null);
    } else if (d.kind === 'stretch' && d.noteId) {
      const from = startOfWeek(sectors[lo].start, { weekStartsOn: 1 });
      const to = addDays(startOfWeek(sectors[hi].start, { weekStartsOn: 1 }), 6);
      planWheelNote(d.noteId, fmt.iso(from), fmt.iso(to));
    }
    setRange(null);
    setDragKind(null);
  };

  useEffect(() => {
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    return () => {
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
  });

  // ── Placing a note on a week, or across a range of weeks ─────────────
  const placeNote = (noteId: string, fromWeek: Date, toWeek?: Date) => {
    const n = getWheelNote(noteId);
    if (!n) return;
    const monday = startOfWeek(fromWeek, { weekStartsOn: 1 });
    let end: Date;
    if (toWeek) {
      // An explicit range: the whole of the last week belongs to the note.
      end = addDays(startOfWeek(toWeek, { weekStartsOn: 1 }), 6);
    } else {
      // A note that already had a length keeps it; a fresh one takes the week.
      const len = n.startDate && n.endDate
        ? Math.max(0, differenceInCalendarDays(parseISO(n.endDate), parseISO(n.startDate)))
        : 6;
      end = addDays(monday, Math.max(0, len));
    }
    planWheelNote(noteId, fmt.iso(monday), fmt.iso(end));
    setPickedNotes((prev) => (prev.includes(noteId) ? prev : [...prev, noteId]));
  };

  /** The week index a note starts in (falls back to the pressed week). */
  const noteWeekIndex = (note: WheelNote, fallback: number): number => {
    if (!note.startDate) return fallback;
    const monday = fmt.iso(startOfWeek(parseISO(note.startDate), { weekStartsOn: 1 }));
    const i = sectors.findIndex((s) => fmt.iso(s.start) === monday);
    return i >= 0 ? i : fallback;
  };

  // A press on a note dot: a tap selects the note, a drag STRETCHES it.
  const onDotDown = (e: ReactPointerEvent<SVGCircleElement>, note: WheelNote) => {
    e.stopPropagation();
    const deg = angleAt(e.clientX, e.clientY);
    const idx = deg == null ? -1 : weekIndexAt(deg);
    pressRef.current = {
      id: note.id,
      x: e.clientX,
      y: e.clientY,
      anchor: noteWeekIndex(note, idx < 0 ? 0 : idx),
      dragging: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onDotMove = (e: ReactPointerEvent<SVGCircleElement>, note: WheelNote) => {
    const pr = pressRef.current;
    if (!pr || pr.id !== note.id) return;
    if (pr.dragging) return; // from here the SVG-level handler grows the range
    if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < 6) return;
    pr.dragging = true;
    beginDrag({ kind: 'stretch', anchor: pr.anchor, last: pr.anchor, noteId: note.id }, e);
  };

  const onDotUp = (_e: ReactPointerEvent<SVGCircleElement>, note: WheelNote) => {
    const pr = pressRef.current;
    pressRef.current = null;
    if (!pr) return;
    if (pr.dragging) finishDrag();
    else toggleNote(note.id);
  };

  const onStageDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onStageDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/wheel-note-id');
    if (!id) return;
    const deg = angleAt(e.clientX, e.clientY);
    if (deg == null) return;
    const idx = weekIndexAt(deg);
    if (idx < 0) return;
    placeNote(id, sectors[idx].start);
    setArmedNote(null);
  };

  const toggleNote = (id: string) => {
    setPickedNotes((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // ── Notes: create / rename / delete ─────────────────────────────────
  const addNote = () => {
    const created = addWheelNote(newNote);
    if (!created) return;
    setNewNote('');
    setArmedNote(created.id);
  };

  const startEditing = (n: WheelNote) => {
    setEditingNote(n.id);
    setEditDraft(n.title);
  };

  const commitEditing = () => {
    if (!editingNote) return;
    updateWheelNote(editingNote, { title: editDraft });
    setEditingNote(null);
  };

  const deleteNote = (id: string) => {
    removeWheelNote(id);
    setPickedNotes((prev) => prev.filter((x) => x !== id));
    if (armedNote === id) setArmedNote(null);
    if (editingNote === id) setEditingNote(null);
  };

  // ── Selected week: comment editing ──────────────────────────────────
  useEffect(() => {
    setNoteDraft(selectedWeek ? getWeekMark(selectedWeek)?.note ?? '' : '');
  }, [selectedWeek]);

  const changeNote = (value: string) => {
    setNoteDraft(value);
    if (!selectedWeek) return;
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    const key = selectedWeek;
    noteTimer.current = window.setTimeout(() => setWeekNote(key, value), 450);
  };

  const flushNote = () => {
    if (noteTimer.current) {
      window.clearTimeout(noteTimer.current);
      noteTimer.current = null;
    }
    if (selectedWeek) setWeekNote(selectedWeek, noteDraft);
  };

  const selectedDate = selectedWeek ? parseISO(selectedWeek) : null;
  const picked = new Set(pickedNotes);
  // Colour of the drag overlay: the colour of the note being placed/stretched.
  const dragNote = dragRef.current?.noteId ? getWheelNote(dragRef.current.noteId) : undefined;
  const rangeColor = dragNote?.color || 'var(--accent)';

  const thisYear = today.getFullYear();
  const daysToNext = differenceInCalendarDays(new Date(thisYear + 1, 0, 1), today);
  const todayDeg = angleOf(today);
  const todayVisible = todayDeg >= 0 && todayDeg < 360;
  const shiftLabel = shiftMonths === 0
    ? 'год вперёд'
    : shiftMonths < 0 ? `−${-shiftMonths} мес` : `+${shiftMonths} мес`;

  // While a range is being dragged the centre shows its dates instead of the
  // window info — that is the "when do I stop" read-out.
  const rangeInfo = (() => {
    if (!range) return null;
    const lo = Math.min(range.i0, range.i1);
    const hi = Math.max(range.i0, range.i1);
    const s0 = sectors[lo];
    const s1 = sectors[hi];
    if (!s0 || !s1) return null;
    const from = s0.start;
    const to = addDays(s1.start, 6);
    const weeks = hi - lo + 1;
    const days = differenceInCalendarDays(to, from) + 1;
    return {
      kicker: dragKind === 'place' ? 'ставлю заметку' : 'растягиваю заметку',
      big: from.getMonth() === to.getMonth()
        ? `${from.getDate()}–${to.getDate()} ${MONTH_SHORT[from.getMonth()]}`
        : `${fmt.dayShort(from)} – ${fmt.dayShort(to)}`,
      sub: `${weeks} ${weeks === 1 ? 'неделя' : weeks < 5 ? 'недели' : 'недель'} · ${days} дн.`,
    };
  })();

  const centreKicker = shiftMonths === 0
    ? 'сегодня'
    : shiftMonths < 0 ? 'окно назад' : 'окно вперёд';
  const centreBig = shiftMonths === 0
    ? format(today, 'd MMMM', { locale: ru })
    : format(windowStart, 'd MMMM', { locale: ru });
  const centreSub = shiftMonths === 0
    ? `неделя ${isoWeekNumber(today)} · до ${thisYear + 1} — ${daysToNext} дн.`
    : `окно: ${format(windowStart, 'd MMM yyyy', { locale: ru })} — ${format(addDays(windowEnd, -1), 'd MMM yyyy', { locale: ru })}`;

  return (
    <div className="wheel">
      <div className="wheel-bar">
        <button type="button" className="wheel-shift-btn" onClick={() => setShiftMonths((v) => v - 1)} aria-label="Раньше на месяц">‹</button>
        <span className="wheel-shift-label">{shiftLabel}</span>
        <button type="button" className="wheel-shift-btn" onClick={() => setShiftMonths((v) => v + 1)} aria-label="Позже на месяц">›</button>
        {shiftMonths !== 0 && (
          <button type="button" className="wheel-now-btn" onClick={() => setShiftMonths(0)}>
            сейчас
          </button>
        )}
      </div>

      <div className="wheel-workspace">
        {/* ── Left: notes without a date (never coloured) ─────────────── */}
        <aside className="wheel-side wheel-side-left" aria-label="Мои заметки без даты">
          <div className="wheel-side-head">
            <span>мои заметки</span>
            <span className="wheel-side-count">{unplaced.length}</span>
          </div>
          <div className="wheel-note-add">
            <input
              value={newNote}
              placeholder="+ заметка"
              onChange={(e) => setNewNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }}
            />
            <button type="button" onClick={addNote} disabled={!newNote.trim()} aria-label="Добавить заметку">+</button>
          </div>
          <div className="wheel-side-list">
            {unplaced.length === 0 && <div className="wheel-side-empty">пока нет заметок</div>}
            {unplaced.map((n) => (
              <div
                key={n.id}
                className={`wheel-backlog-item ${armedNote === n.id ? 'armed' : ''}`}
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/wheel-note-id', n.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => setArmedNote(armedNote === n.id ? null : n.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setArmedNote(armedNote === n.id ? null : n.id);
                  }
                }}
                title={n.title}
              >
                {editingNote === n.id ? (
                  <input
                    className="wheel-note-input"
                    value={editDraft}
                    autoFocus
                    onChange={(e) => setEditDraft(e.target.value)}
                    onBlur={commitEditing}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') commitEditing();
                      if (e.key === 'Escape') setEditingNote(null);
                    }}
                  />
                ) : (
                  <span className="wheel-backlog-title">{n.title}</span>
                )}
                <span className="wheel-note-actions">
                  <button type="button" title="Переименовать" aria-label="Переименовать"
                    onClick={(e) => { e.stopPropagation(); startEditing(n); }}>✎</button>
                  <button type="button" title="Удалить" aria-label="Удалить"
                    onClick={(e) => { e.stopPropagation(); deleteNote(n.id); }}>×</button>
                </span>
              </div>
            ))}
          </div>
          <p className="wheel-side-hint">
            {armedNote
              ? 'ткните неделю — или протяните по кругу на несколько недель'
              : 'ткните заметку, затем неделю; потяните за точку на круге — растянется'}
          </p>
        </aside>

        {/* ── Centre: the wheel ──────────────────────────────────────── */}
        <div
          className="wheel-stage"
          onDragOver={onStageDragOver}
          onDrop={onStageDrop}
        >
          <svg
            ref={svgRef}
            className={`wheel-svg ${interactive ? 'painting' : ''} ${armedNote ? 'placing' : ''} ${dragKind === 'stretch' ? 'stretching' : ''}`}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
          >
            <circle cx={C} cy={C} r={R_OUT} fill="none" stroke="var(--line)" strokeWidth="1" />
            <circle cx={C} cy={C} r={R_IN} fill="none" stroke="var(--line)" strokeWidth="1" />

            {/* Month band */}
            {months.map((m) => {
              const bandGap = 1.1;
              const a0 = m.a0 + bandGap / 2;
              const a1 = m.a1 - bandGap / 2;
              if (a1 <= a0) return null;
              const current = m.month === today.getMonth() && windowStart.getFullYear() === thisYear && shiftMonths === 0;
              return (
                <path
                  key={`band${m.month}-${m.a0}`}
                  d={sectorPath(a0, a1, R_M0, R_M1)}
                  fill={current ? 'var(--accent)' : '#0a0a0a'}
                  fillOpacity={current ? 0.55 : m.month % 2 === 0 ? 0.1 : 0.22}
                  pointerEvents="none"
                />
              );
            })}

            {sectors.map((s) => {
              const key = fmt.iso(s.start);
              const isSelected = selectedWeek === key;
              const isThisWeek = key === todayKey && shiftMonths === 0;
              const list = weekNotes.get(key) ?? [];
              const tint = s.month % 2 === 0 ? '#f4f5f7' : '#dde1e7';
              // With notes picked, everything that is not one of them steps back.
              const dim = picked.size > 0 && !list.some((n) => picked.has(n.id));
              const span = s.a1 - s.a0;
              const gap = Math.min(0.7, span * 0.1);
              const a0 = s.a0 + gap / 2;
              const a1 = s.a1 - gap / 2;
              const dots = list.slice(0, MAX_DOTS);
              const extra = list.length - dots.length;
              const midDeg = (s.a0 + s.a1) / 2;
              return (
                <g key={key}>
                  <path
                    key={key}
                    data-week={key}
                    d={sectorPath(a0, a1, R_IN, R_OUT)}
                    fill={tint}
                    fillOpacity={dim ? 0.16 : 1}
                    stroke={isSelected ? 'var(--ink)' : isThisWeek ? 'var(--accent)' : '#ffffff'}
                    strokeWidth={isSelected ? 2.2 : isThisWeek ? 1.6 : 1}
                    strokeOpacity={dim ? 0.35 : 1}
                    className="wheel-sector"
                  >
                    <title>
                      {`${fmt.dayShort(s.start)} – ${fmt.dayShort(addDays(s.start, 6))}, ${isoWeekNumber(s.start)}-я неделя`}
                      {marks[key]?.note ? ` · ${marks[key]?.note}` : ''}
                      {list.length > 0 ? ` · заметок: ${list.length}` : ''}
                    </title>
                  </path>

                  {/* Note dots: stacked along the radius so a week with several
                      notes still fits inside its own sector. */}
                  {dots.map((note, i) => {
                    const [cx, cy] = xy(DOT_TOP - i * DOT_STEP, midDeg);
                    const on = picked.has(note.id);
                    return (
                      <circle
                        key={note.id}
                        cx={cx}
                        cy={cy}
                        r={on ? DOT_R + 1.2 : DOT_R}
                        fill={note.color || NOTE_FALLBACK_COLOR}
                        stroke={on ? '#0a0a0a' : '#ffffff'}
                        strokeWidth={on ? 2 : 1.4}
                        className="wheel-task-dot"
                        onPointerDown={(e) => onDotDown(e, note)}
                        onPointerMove={(e) => onDotMove(e, note)}
                        onPointerUp={(e) => onDotUp(e, note)}
                      >
                        <title>{`${note.title} · ${noteSpan(note)} · потяните, чтобы растянуть`}</title>
                      </circle>
                    );
                  })}
                  {extra > 0 && (() => {
                    const [cx, cy] = xy(DOT_TOP - MAX_DOTS * DOT_STEP, midDeg);
                    return (
                      <text
                        x={cx}
                        y={cy}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize="9"
                        fontWeight="700"
                        fill="var(--ink)"
                        fillOpacity={dim ? 0.3 : 0.75}
                        pointerEvents="none"
                      >
                        +{extra}
                      </text>
                    );
                  })()}
                </g>
              );
            })}

            {/* Picked tasks: their weeks are outlined and flagged outside the
                ring, so several selections stay readable side by side. */}
            {picked.size > 0 && sectors.map((s) => {
              const list = weekNotes.get(fmt.iso(s.start)) ?? [];
              const hit = list.find((n) => picked.has(n.id));
              if (!hit) return null;
              const c = hit.color || NOTE_FALLBACK_COLOR;
              return (
                <g key={`pick-${s.start.getTime()}`} pointerEvents="none">
                  <path d={sectorPath(s.a0, s.a1, R_IN, R_OUT)} fill="none" stroke={c} strokeWidth="3.4" />
                  <path d={sectorPath(s.a0 + 0.35, s.a1 - 0.35, R_OUT + 2, R_OUT + 9)} fill={c} />
                </g>
              );
            })}

            {/* The range being dragged out */}
            {range && (() => {
              const lo = Math.min(range.i0, range.i1);
              const hi = Math.max(range.i0, range.i1);
              const s0 = sectors[lo];
              const s1 = sectors[hi];
              if (!s0 || !s1) return null;
              const c = rangeColor;
              return (
                <g pointerEvents="none">
                  <path
                    d={sectorPath(s0.a0, s1.a1, R_IN, R_OUT)}
                    fill={c}
                    fillOpacity={0.42}
                    stroke={c}
                    strokeWidth="2.6"
                  />
                  {[s0.a0, s1.a1].map((deg) => {
                    const [x1, y1] = xy(R_IN - 6, deg);
                    const [x2, y2] = xy(R_OUT + 4, deg);
                    return (
                      <line key={`edge${deg}`} x1={x1} y1={y1} x2={x2} y2={y2}
                        stroke={c} strokeWidth="3.2" strokeLinecap="round" />
                    );
                  })}
                </g>
              );
            })()}

            {/* Month dividers on top of the paint, with a white halo so a
                saturated week cannot hide the structure of the year. */}
            {months.map((m, i) => {
              if (m.a0 <= 0.01) return null;
              const [x1, y1] = xy(R_IN, m.a0);
              const [x2, y2] = xy(R_OUT, m.a0);
              return (
                <g key={`div${i}`} pointerEvents="none">
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ffffff" strokeOpacity="0.85" strokeWidth="3.6" />
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0a0a0a" strokeOpacity="0.5" strokeWidth="1.6" />
                </g>
              );
            })}

            {/* New year inside the window */}
            {yearMarks.map((y) => {
              const [x1, y1] = xy(R_IN - 8, y.deg);
              const [x2, y2] = xy(R_M1 + 4, y.deg);
              const [tx, ty] = xy(R_YEAR, y.deg);
              return (
                <g key={`y${y.year}`} pointerEvents="none">
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0a0a0a" strokeOpacity="0.6" strokeWidth="2.2" strokeDasharray="6 5" />
                  <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle" fontSize="20" fontWeight="700" fill="#8d9199">
                    {y.year}
                  </text>
                </g>
              );
            })}

            {/* Month names — one per month, at the middle of the month */}
            {months.map((m, i) => {
              if (!m.midInside) return null;
              const [lx, ly] = xy(R_LABEL, m.midDeg);
              const current = m.month === today.getMonth() && shiftMonths === 0;
              return (
                <text
                  key={`m${i}`}
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={current ? '22' : '20'}
                  fontWeight={current ? '700' : '400'}
                  fill={current ? 'var(--ink)' : '#8d9199'}
                  pointerEvents="none"
                >
                  {m.label}
                </text>
              );
            })}

            {todayVisible && (
              <g pointerEvents="none">
                <line
                  x1={xy(R_IN - 18, todayDeg)[0]}
                  y1={xy(R_IN - 18, todayDeg)[1]}
                  x2={xy(R_OUT - 3, todayDeg)[0]}
                  y2={xy(R_OUT - 3, todayDeg)[1]}
                  stroke="var(--accent)"
                  strokeWidth="3"
                />
                <circle cx={xy(R_IN - 26, todayDeg)[0]} cy={xy(R_IN - 26, todayDeg)[1]} r="4.5" fill="var(--accent)" />
              </g>
            )}
          </svg>

          <div className={`wheel-center ${rangeInfo ? 'range' : ''}`}>
            <div className="wheel-center-week">{rangeInfo ? rangeInfo.kicker : centreKicker}</div>
            <div className="wheel-center-big">{rangeInfo ? rangeInfo.big : centreBig}</div>
            <div className="wheel-center-sub">{rangeInfo ? rangeInfo.sub : centreSub}</div>
          </div>
        </div>

        {/* ── Right: placed notes, month by month ────────────────────── */}
        <aside className="wheel-side wheel-side-right" aria-label="Мои заметки по датам">
          <div className="wheel-side-head">
            <span>заметки по датам</span>
            <span className="wheel-side-count">{placed.length}</span>
          </div>
          <div className="wheel-side-list">
            {monthBlocks.length === 0 && <div className="wheel-side-empty">пока ничего не расставлено</div>}
            {monthBlocks.map((block) => (
              <section className="wheel-plan-card" key={block.key}>
                <h4 className="wheel-plan-month">
                  {block.key}
                  <span>{block.notes.length}</span>
                </h4>
                {block.notes.map((n) => {
                  const on = picked.has(n.id);
                  return (
                    <div
                      key={n.id}
                      className={`wheel-plan-row ${on ? 'active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleNote(n.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleNote(n.id);
                        }
                      }}
                      title={`${n.title} · ${noteSpan(n)}`}
                    >
                      <span className="wheel-plan-dot" style={{ background: n.color || NOTE_FALLBACK_COLOR }} />
                      {editingNote === n.id ? (
                        <input
                          className="wheel-note-input"
                          value={editDraft}
                          autoFocus
                          onChange={(e) => setEditDraft(e.target.value)}
                          onBlur={commitEditing}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitEditing();
                            if (e.key === 'Escape') setEditingNote(null);
                          }}
                        />
                      ) : (
                        <span className="wheel-plan-title">{n.title}</span>
                      )}
                      <span className="wheel-plan-date">{monthSpan(n, block.from, block.to)}</span>
                      <span className="wheel-note-actions">
                        <button type="button" title="Вернуть в заметки без даты" aria-label="Убрать даты"
                          onClick={(e) => { e.stopPropagation(); unplanWheelNote(n.id); }}>↩</button>
                        <button type="button" title="Переименовать" aria-label="Переименовать"
                          onClick={(e) => { e.stopPropagation(); startEditing(n); }}>✎</button>
                        <button type="button" title="Удалить" aria-label="Удалить"
                          onClick={(e) => { e.stopPropagation(); deleteNote(n.id); }}>×</button>
                      </span>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
          {pickedNotes.length > 0 && (
            <button type="button" className="wheel-side-clear" onClick={() => setPickedNotes([])}>
              снять выделение ({pickedNotes.length})
            </button>
          )}
        </aside>
      </div>

      {selectedDate && selectedWeek && (
        <div className="wheel-panel">
          <div className="wheel-panel-head">
            <strong>Неделя {isoWeekNumber(selectedDate)}</strong>
            <span className="wheel-panel-dates">
              {fmt.dayShort(selectedDate)} – {fmt.dayShort(addDays(selectedDate, 6))}
            </span>
            <button type="button" className="wheel-panel-close" onClick={() => { flushNote(); setSelectedWeek(null); }} aria-label="Закрыть">×</button>
          </div>
          <div className="wheel-panel-colors">
            <button
              type="button"
              className="wheel-clear"
              onClick={() => { setWeekNote(selectedWeek, ''); setNoteDraft(''); }}
            >
              очистить комментарий
            </button>
            <button type="button" className="wheel-open-week" onClick={() => onOpenWeek(selectedDate)}>
              открыть неделю →
            </button>
          </div>
          <textarea
            className="wheel-note"
            rows={2}
            placeholder="комментарий к неделе…"
            value={noteDraft}
            onChange={(e) => changeNote(e.target.value)}
            onBlur={flushNote}
          />
        </div>
      )}
    </div>
  );
}
