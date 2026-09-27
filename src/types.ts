export type Sphere = string;

export const DEFAULT_SPHERES: string[] = [
  'ИЗУЧЕНИЕ', 'ТВОРЧЕСТВО', 'ОТДЫХ/РАЗВЛЕЧЕНИЯ', 'ДУХОВНОСТЬ',
  'ПУТЕШЕСТВИЯ', 'ОТНОШЕНИЯ', 'ЗДОРОВЬЕ', 'КАРЬЕРА',
  'ЦИФРА', 'КОНТЕНТ', 'БЫТ', 'СОЦИУМ',
];

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export type Priority = 'low' | 'normal' | 'high';

export interface Task {
  id: string;
  title: string;
  notes?: string;
  startDate?: string;
  endDate?: string;
  sphere?: Sphere;
  recurrence: Recurrence;
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
  dependsOnTaskId?: string;
  createdAt: string;
}

export type View = 'dashboard' | 'day' | 'week' | 'month' | 'year';
