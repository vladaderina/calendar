// Palette for the year wheel — deliberately SEPARATE from the task colours.
//
// The task palette (config/colors.ts) names categories of tasks ("Отпуск",
// "Уборка", …) and is shared with the task editor. The wheel paints periods,
// so it has its own list, its own storage key and its own names: renaming a
// wheel colour must never touch a task colour, and the two sets never travel
// in the same settings payload.
//
// The wheel draws these as rounded squares (not circles) so the two palettes
// are never confused on screen either.

export interface WheelColor {
  value: string; // hex
  label: string;
}

const KEY = 'calendar.wheel.colors.v1';
const EVENT = 'wheel-colors-change';

export const DEFAULT_WHEEL_COLORS: WheelColor[] = [
  { value: '#4f7cac', label: 'Учёба' },
  { value: '#5a9367', label: 'Семья' },
  { value: '#b5651d', label: 'Здоровье' },
  { value: '#8d5b9e', label: 'Дом' },
  { value: '#c0504d', label: 'Финансы' },
  { value: '#d4a72c', label: 'Путешествие' },
  { value: '#3f8f8f', label: 'Спорт' },
  { value: '#7a8b99', label: 'Творчество' },
  { value: '#a0724f', label: 'Сад' },
  { value: '#6f8f3f', label: 'Отдых' },
  { value: '#b35c8a', label: 'Проект' },
  { value: '#4a4a6a', label: 'Другое' },
];

export function getWheelColors(): WheelColor[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const seen = new Set<string>();
        const list: WheelColor[] = [];
        for (const item of parsed) {
          if (!item || typeof item.value !== 'string' || !item.value) continue;
          if (seen.has(item.value)) continue;
          seen.add(item.value);
          list.push({ value: item.value, label: typeof item.label === 'string' ? item.label : '' });
        }
        if (list.length > 0) return list;
      }
    }
  } catch {
    // malformed — fall back to the defaults
  }
  return DEFAULT_WHEEL_COLORS.map((c) => ({ ...c }));
}

function save(list: WheelColor[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // ignore quota errors
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT));
}

/** Rename a colour; a hex that is not in the list yet is added to it. */
export function renameWheelColor(value: string, label: string): void {
  const next = getWheelColors();
  const found = next.find((c) => c.value === value);
  if (found) found.label = label.trim();
  else next.push({ value, label: label.trim() });
  save(next);
}

/** Make sure every hex that is actually painted on the wheel has a row. */
export function ensureWheelColors(values: string[]): void {
  const list = getWheelColors();
  let changed = false;
  for (const v of values) {
    if (!v || list.some((c) => c.value === v)) continue;
    list.push({ value: v, label: '' });
    changed = true;
  }
  if (changed) save(list);
}

/** Reorder the palette (drag & drop in the colour column). Unknown values are
 *  appended, so a stored list can never be silently emptied. */
export function reorderWheelColors(orderedValues: string[]): void {
  const current = getWheelColors();
  const map = new Map(current.map((c) => [c.value, c]));
  const out: WheelColor[] = [];
  for (const v of orderedValues) {
    const c = map.get(v);
    if (c) {
      out.push(c);
      map.delete(v);
    }
  }
  map.forEach((c) => out.push(c));
  save(out);
}

export function subscribeWheelColors(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
