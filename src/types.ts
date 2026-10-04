export type Sphere = string;

export const DEFAULT_SPHERES: string[] = [
  'ИЗУЧЕНИЕ', 'ТВОРЧЕСТВО', 'ОТДЫХ/РАЗВЛЕЧЕНИЯ', 'ДУХОВНОСТЬ',
  'ПУТЕШЕСТВИЯ', 'ОТНОШЕНИЯ', 'ЗДОРОВЬЕ', 'КАРЬЕРА',
  'ЦИФРА', 'КОНТЕНТ', 'БЫТ', 'СОЦИУМ', 'РАЗНОЕ',
];

// Recurrence: built-in presets + two free-form modes.
//  - "weekdays"  → repeats on the weekdays listed in `recurrenceDays` (1=Mon..7=Sun)
//  - "yearDays"  → repeats on the specific dates listed in `yearDates` (yyyy-MM-dd)
export type Recurrence =
  | 'none'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'weekdays'
  | 'yearDays';
export type Priority = 'low' | 'normal' | 'high';

/** Days of week for `recurrence === "weekdays"`. 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Task {
  id: string;
  title: string;
  notes?: string;
  startDate?: string;
  endDate?: string;
  sphere?: Sphere;
  recurrence: Recurrence;
  /** Weekdays to repeat on (Mon=1 … Sun=7). Used with `recurrence: 'weekdays'`. */
  recurrenceDays?: Weekday[];
  /** Specific yyyy-MM-dd dates to repeat on. Used with `recurrence: 'yearDays'`. */
  yearDates?: string[];
  reminderDays?: number;
  color?: string;
  priority: Priority;
  unplanned: boolean;
  order?: number;
  completed: boolean;
  completedAt?: string;
  // For recurring tasks: specific occurrence dates (yyyy-MM-dd) marked done.
  completedDates?: string[];
  // For recurring tasks: occurrence dates removed via "только эта".
  excludedDates?: string[];
  // For recurring tasks: last active date (used by "эта и все последующие").
  recurrenceUntil?: string;
  /** Subtask IDs (ordered). Subtasks are themselves Task records with */
  /** `subtaskOf` pointing back to this task's id. */
  subtaskIds?: string[];
  /** If set, this task is a subtask of the task with this id. */
  subtaskOf?: string;
  createdAt: string;
}

export type View = 'dashboard' | 'day' | 'week' | 'month' | 'year' | 'planned' | 'analytics';