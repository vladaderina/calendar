import {
  addDays, addMonths, addWeeks, addYears,
  differenceInCalendarDays, endOfMonth, endOfWeek, format,
  isSameDay, parseISO, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { ru } from 'date-fns/locale';
import type { Task } from '../types';

export const fmt = {
  iso: (d: Date) => format(d, 'yyyy-MM-dd'),
  dayShort: (d: Date) => format(d, 'd MMM', { locale: ru }),
  weekdayShort: (d: Date) => {
    const s = format(d, 'EEEEEE', { locale: ru });
    return s.charAt(0).toUpperCase() + s.slice(1);
  },
  monthYear: (d: Date) => {
    const s = format(d, 'LLLL yyyy', { locale: ru });
    // small-caps in CSS handles the casing visually; here we keep it readable.
    return s.charAt(0).toUpperCase() + s.slice(1);
  },
  monthOnly: (d: Date) => format(d, 'LLLL', { locale: ru }).toUpperCase(),
  full: (d: Date) => format(d, 'd MMMM yyyy', { locale: ru }),
  // "Вт, 22 сент. 2026" — compact date with weekday, for the task modal header.
  dayFull: (d: Date) => {
    const s = format(d, 'EEEEEE, d MMM yyyy', { locale: ru });
    return s.charAt(0).toUpperCase() + s.slice(1);
  },
};

export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor, { weekStartsOn: 1 });
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function monthGrid(anchor: Date): Date[] {
  const start = startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 });
  const days: Date[] = [];
  let cur = start;
  while (cur <= end) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

// Does the task appear on a given date (respecting recurrence)?
export function taskOnDate(t: Task, date: Date): boolean {
  if (!t.startDate) return false;
  const d = startOfDay(date);
  const iso = format(d, 'yyyy-MM-dd');
  // A recurring occurrence explicitly deleted ("только эта") never shows.
  if (t.excludedDates?.includes(iso)) return false;

  const start = startOfDay(parseISO(t.startDate));
  const end = startOfDay(parseISO(t.endDate ?? t.startDate));
  if (d >= start && d <= end) return true;
  if (t.recurrence === 'none') return false;
  if (d < start) return false;
  // Series cut off by "эта и все последующие".
  if (t.recurrenceUntil && iso > t.recurrenceUntil) return false;
  switch (t.recurrence) {
    case 'daily': return true;
    case 'weekly': return d.getDay() === start.getDay();
    case 'monthly': return d.getDate() === start.getDate();
    case 'yearly': return d.getDate() === start.getDate() && d.getMonth() === start.getMonth();
    case 'weekdays': {
      if (!t.recurrenceDays || t.recurrenceDays.length === 0) return false;
      // JS getDay(): 0 (Sun) … 6 (Sat). Our Weekday: 1 (Mon) … 7 (Sun).
      const jsDay = d.getDay();
      const weekday = jsDay === 0 ? 7 : jsDay;
      return t.recurrenceDays.includes(weekday as any);
    }
    case 'yearDays': {
      if (!t.yearDates) return false;
      return t.yearDates.includes(iso);
    }
  }
  return false;
}

// ── One-pass day index ────────────────────────────────────────────────────
// A month grid asks "which tasks fall on this day?" for ~1500 days in a row.
// Calling taskOnDate per cell re-parses every task's dates on every call (and
// the grid re-renders on each keystroke elsewhere), which is what made the
// month view lag. This builds the answer once instead: every task is parsed
// once and expanded over the days it actually covers.
const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));
const isoOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

interface IndexDay {
  iso: string;
  ms: number;
  dow: number;   // JS getDay(): 0 = Sunday
  dom: number;   // 1..31
  month: number; // 0..11
}

/** Tasks per day for the inclusive range [from, to], keyed by 'yyyy-MM-dd'.
 *  Same rules as `taskOnDate`, but each task is parsed once. Mirrors the month
 *  grid's filter: dated tasks that are promoted out of the backlog. */
export function taskDayIndex(tasks: Task[], from: Date, to: Date): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  const fromMs = startOfDay(from).getTime();
  const toMs = startOfDay(to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return out;

  const days: IndexDay[] = [];
  for (let d = new Date(fromMs); d.getTime() <= toMs; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    days.push({ iso: isoOf(d), ms: d.getTime(), dow: d.getDay(), dom: d.getDate(), month: d.getMonth() });
  }
  // First index whose day is >= ms (days are sorted and contiguous).
  const lower = (ms: number) => {
    let lo = 0;
    let hi = days.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid].ms < ms) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  const add = (iso: string, t: Task) => {
    const arr = out.get(iso);
    if (arr) arr.push(t); else out.set(iso, [t]);
  };

  for (const t of tasks) {
    if (!t.startDate || t.unplanned) continue;
    const start = startOfDay(parseISO(t.startDate));
    const end = startOfDay(parseISO(t.endDate ?? t.startDate));
    const startMs = start.getTime();
    const endMs = end.getTime();
    if (endMs < fromMs) continue; // entirely before the window

    const rec = t.recurrence && t.recurrence !== 'none' ? t.recurrence : null;
    const excluded = t.excludedDates?.length ? new Set(t.excludedDates) : null;
    const until = t.recurrenceUntil ?? null;
    const startDow = start.getDay();
    const startDom = start.getDate();
    const startMonth = start.getMonth();

    for (let i = Math.max(0, lower(startMs)); i < days.length; i++) {
      const day = days[i];
      if (excluded?.has(day.iso)) continue;
      if (day.ms <= endMs) { add(day.iso, t); continue; }
      if (!rec || day.ms < startMs) break;
      if (until && day.iso > until) break;
      switch (rec) {
        case 'daily':
          add(day.iso, t);
          break;
        case 'weekly':
          if (day.dow === startDow) add(day.iso, t);
          break;
        case 'monthly':
          if (day.dom === startDom) add(day.iso, t);
          break;
        case 'yearly':
          if (day.dom === startDom && day.month === startMonth) add(day.iso, t);
          break;
        case 'weekdays': {
          const weekday = day.dow === 0 ? 7 : day.dow;
          if (t.recurrenceDays?.includes(weekday as never)) add(day.iso, t);
          break;
        }
        case 'yearDays':
          if (t.yearDates?.includes(day.iso)) add(day.iso, t);
          break;
      }
    }
  }
  return out;
}

// Determines if a task with `sameDayOnly` should be hidden when showCompleted is OFF:
// - Not sameDayOnly: never hidden by this rule.
// - Must match its scheduled occurrence date (taskOnDate). If it doesn't fall on this day, it shouldn't show.
// - If date is today: visible only if today is actually one of its scheduled occurrence days!
// - If date is in the past: visible only if it was scheduled for that date AND completed.
// - If date is in the future: hidden unless toggle is ON.
export function isSameDayHidden(t: Task, date?: Date): boolean {
  if (!t.sameDayOnly || !date) return false;
  // If the task does not even occur on this date per its schedule/recurrence, hide it!
  if (!taskOnDate(t, date)) return true;

  const d = startOfDay(date);
  const today = startOfDay(new Date());
  if (d.getTime() === today.getTime()) {
    // On today, it shows only because it actually occurs on today!
    return false;
  }
  if (d.getTime() < today.getTime()) {
    // Past: visible only if completed on that date
    return !isDoneOn(t, d);
  }
  // Future: hidden
  return true;
}

// Is the task considered "done" on this specific date?
// Recurring tasks track completion per-occurrence in completedDates.
export function isDoneOn(t: Task, date: Date): boolean {
  if (t.recurrence !== 'none') {
    const iso = format(startOfDay(date), 'yyyy-MM-dd');
    return !!t.completedDates?.includes(iso);
  }
  return !!t.completed;
}

const PRIORITY_WEIGHT: Record<string, number> = { high: 0, normal: 1, low: 2 };
export function sortByPriority<T extends { priority: string; createdAt: string; order?: number }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => {
    const pa = PRIORITY_WEIGHT[a.priority] ?? 1;
    const pb = PRIORITY_WEIGHT[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    // Same priority: order within the group, then createdAt as a tiebreaker.
    if (a.order != null && b.order != null) return a.order - b.order;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function daysUntil(iso: string): number {
  return differenceInCalendarDays(parseISO(iso), new Date());
}

// Find the next occurrence date (yyyy-MM-dd) on or after today for a task,
// honoring recurrence rules, exclusions, and recurrenceUntil. Returns null
// when there are no upcoming (or today's) occurrences left.
export function nextOccurrence(t: Task): string | null {
  if (!t.startDate) return null;
  const today = startOfDay(new Date());
  let cursor = today;
  // Walk forward day by day; most series have frequent enough occurrences
  // (daily/weekly/monthly) that this is bounded and cheap.
  let guard = 0;
  while (cursor <= addYears(today, 2) && guard < 1000) {
    const iso = format(cursor, 'yyyy-MM-dd');
    if (taskOnDate(t, cursor)) {
      // A recurrence occurrence can be explicitly excluded ("only this one").
      // taskOnDate already checks excludedDates, but double-check safety:
      if (!t.excludedDates?.includes(iso)) return iso;
    }
    cursor = addDays(cursor, 1);
    guard++;
  }
  return null;
}

export { addDays, addMonths, addWeeks, addYears, isSameDay, parseISO };

// --- Production calendar (Russian holidays / weekends) ---
// Fixed-date public holidays of Russia (month is 0-based in JS Date).
// According to Art. 112 Labor Code of RF:
// 1, 2, 3, 4, 5, 6 and 8 January — New Year holidays (Новогодние каникулы)
// 7 January — Christmas (Рождество Христово)
// 23 February — Defender of the Fatherland Day
// 8 March — International Women's Day
// 1 May — Spring and Labour Day
// 9 May — Victory Day
// 12 June — Russia Day
// 4 November — Unity Day
const FIXED_HOLIDAYS: ReadonlyArray<[number, number]> = [
  [0, 1],   // 1 Jan — New Year
  [0, 2],   // 2 Jan — New Year holidays
  [0, 3],   // 3 Jan — New Year holidays
  [0, 4],   // 4 Jan — New Year holidays
  [0, 5],   // 5 Jan — New Year holidays
  [0, 6],   // 6 Jan — New Year holidays
  [0, 7],   // 7 Jan — Christmas
  [0, 8],   // 8 Jan — New Year holidays
  [1, 23],  // 23 Feb — Defender of the Fatherland Day
  [2, 8],   // 8 Mar — International Women's Day
  [4, 1],   // 1 May — Spring and Labour Day
  [4, 9],   // 9 May — Victory Day
  [5, 12],  // 12 Jun — Russia Day
  [10, 4],  // 4 Nov — Unity Day
];

// Returns true for weekends (Sat/Sun) and fixed public holidays.
export function isNonWorkingDay(d: Date): boolean {
  const day = d.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return true;
  const idx = FIXED_HOLIDAYS.findIndex(([m, dayNum]) => m === d.getMonth() && dayNum === d.getDate());
  return idx >= 0;
}

// True only for official fixed public holidays (not weekends).
export function isHoliday(d: Date): boolean {
  return FIXED_HOLIDAYS.some(([m, dayNum]) => m === d.getMonth() && dayNum === d.getDate());
}
