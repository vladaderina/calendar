// Task color palette — curated, pretty, and varied.
// Each entry: hex value + short label used in tooltips / the year-view
// color filter. The palette is fixed (no user additions) but labels are
// persisted to localStorage so the user can rename them.
//
// Categories include the user's named ones plus sensible extras.
export interface TaskColor {
  value: string; // hex, e.g. "#27ae60"
  label: string;  // short name, e.g. "Отпуск"
  unnamed?: boolean; // если true — цвет нельзя выбрать, но можно задать имя
}

export const DEFAULT_COLORS: TaskColor[] = [
  { value: '#27ae60', label: 'Отпуск' },
  { value: '#2980b9', label: 'Сашин отпуск' },
  { value: '#e74c3c', label: 'Дни рождения' },
  { value: '#f1c40f', label: 'Праздники' },
  { value: '#a1887f', label: 'Уборка' },
  { value: '#ffb74d', label: 'Тренировки' },
  { value: '#8e44ad', label: 'Хобби' },
  { value: '#1abc9c', label: 'Поездка' },
  { value: '#ff8a65', label: 'Бизнес' },
  { value: '#34495e', label: 'Работа' },
  { value: '#f8bbd9', label: 'Спа / Уход' },
  { value: '#1a1a1a', label: 'Желания' },
  { value: '#9b59b6', label: '', unnamed: true },
  { value: '#34c759', label: '', unnamed: true },
  { value: '#af52de', label: '', unnamed: true },
  { value: '#ff2d55', label: '', unnamed: true },
];

export const NO_COLOR = { value: '', label: 'Нет цвета' };

const STORAGE_KEY = 'calendar.colors.v1';

export function getColors(): TaskColor[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Merge: start from DEFAULT_COLORS, override labels from storage
      // if the color values still match. This keeps new defaults appearing
      // even if the user has an old stored palette.
      const merged = DEFAULT_COLORS.map((def) => {
        const stored = parsed.find((p: TaskColor) => p.value === def.value);
        if (!stored) return def;
        // Carry the stored label AND the disabled flag (unnamed: true), so a
        // color the user removed stays unavailable after a reload.
        return { ...def, label: stored.label, unnamed: stored.unnamed };
      });
      return merged;
    }
  } catch {
    // malformed -> fall back
  }
  return DEFAULT_COLORS;
}

export function saveColors(colors: TaskColor[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
    window.dispatchEvent(new CustomEvent('colors-change'));
  } catch {
    // ignore quota errors
  }
}

// Renamed a color's label (label-only mutation; value is fixed).
export function renameColor(value: string, label: string): void {
  saveColors(getColors().map((c) => (c.value === value ? { ...c, label } : c)));
}

// Removed: addColor — the palette is now fixed/curated.
// Kept for backward compat with TaskModal imports (no-op).
export function addColor(_value: string, _label: string): void {
  // no-op: palette is fixed
}

// Deactivate a color: clears its label and marks it unnamed so it can no
// longer be picked. The swatch stays in the picker (dimmed, with a "…"
// placeholder) so the user can assign it a name again later.
export function removeColor(value: string): void {
  saveColors(getColors().map((c) => (c.value === value ? { ...c, label: '', unnamed: true } : c)));
}
