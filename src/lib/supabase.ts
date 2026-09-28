import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { Task } from '../types';

declare const __SUPABASE_URL__: string | undefined;
declare const __SUPABASE_ANON_KEY__: string | undefined;

const url = typeof __SUPABASE_URL__ !== 'undefined' ? __SUPABASE_URL__ : (import.meta as any)?.env?.VITE_SUPABASE_URL;
const anonKey = typeof __SUPABASE_ANON_KEY__ !== 'undefined' ? __SUPABASE_ANON_KEY__ : (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY;

// Supabase is used only when the project is configured (.env filled).
// Otherwise the app falls back to localStorage (existing behaviour).
export const isSupabaseAvailable = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = isSupabaseAvailable
  ? createClient(url, anonKey)
  : null;

// Convert a local Task to the DB-shaped row and back, keeping field name
// parity with the schema in supabase/migrations/20240927_tasks_schema.sql
// (snake_case columns; camelCase Task fields on the client).
type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  notes?: string;
  start_date?: string;
  end_date?: string;
  sphere?: string;
  recurrence: string;
  reminder_days?: number;
  color?: string;
  priority: string;
  unplanned: boolean;
  order?: number;
  completed: boolean;
  completed_at?: string;
  completed_dates?: string[];
  excluded_dates?: string[];
  recurrence_until?: string;
  depends_on_task_id?: string;
  created_at: string;
};

export function toTaskRow(t: Task, userId: string): TaskRow {
  return {
    id: t.id,
    user_id: userId,
    title: t.title,
    notes: t.notes,
    start_date: t.startDate,
    end_date: t.endDate,
    sphere: t.sphere,
    recurrence: t.recurrence,
    reminder_days: t.reminderDays,
    color: t.color,
    priority: t.priority,
    unplanned: t.unplanned,
    order: t.order,
    completed: t.completed,
    completed_at: t.completedAt,
    completed_dates: t.completedDates,
    excluded_dates: t.excludedDates,
    recurrence_until: t.recurrenceUntil,
    depends_on_task_id: t.dependsOnTaskId,
    created_at: t.createdAt,
  };
}

export function fromTaskRow(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    startDate: r.start_date,
    endDate: r.end_date,
    sphere: r.sphere,
    recurrence: (r.recurrence ?? 'none') as Task['recurrence'],
    reminderDays: r.reminder_days,
    color: r.color,
    priority: (r.priority ?? 'low') as Task['priority'],
    unplanned: r.unplanned,
    order: r.order,
    completed: r.completed,
    completedAt: r.completed_at,
    completedDates: r.completed_dates,
    excludedDates: r.excluded_dates,
    recurrenceUntil: r.recurrence_until,
    dependsOnTaskId: r.depends_on_task_id,
    createdAt: r.created_at ?? new Date().toISOString(),
  };
}

export type { User };
