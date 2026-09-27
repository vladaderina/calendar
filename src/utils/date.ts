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
    return s.charAt(0).toUpperCase() + s.slice(1);
  },
  monthOnly: (d: Date) => format(d, 'LLLL', { locale: ru }).toUpperCase(),
  full: (d: Date) => format(d, 'd MMMM yyyy', { locale: ru }),
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
  }
  return false;
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
    if (a.order != null && b.order != null) return a.order - b.order;
    const pa = PRIORITY_WEIGHT[a.priority] ?? 1;
    const pb = PRIORITY_WEIGHT[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function daysUntil(iso: string): number {
  return differenceInCalendarDays(parseISO(iso), new Date());
}

export { addDays, addMonths, addWeeks, addYears, isSameDay, parseISO };
