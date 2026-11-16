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

/** Colours a task may be given automatically: everything the user can pick. */
function assignableColors(): TaskColor[] {
  const pool = getColors().filter((c) => c.value && !c.unnamed && c.label.trim() !== '');
  return pool.length > 0 ? pool : DEFAULT_COLORS.filter((c) => !c.unnamed);
}

/** A RANDOM colour from the palette — used when a wheel note gets planned. */
export function randomPaletteColor(): string {
  const pool = assignableColors();
  return pool[Math.floor(Math.random() * pool.length)].value;
}


const STORAGE_KEY = 'calendar.colors.v1';
const CUSTOM_KEY = 'calendar.colors.customized.v1';

// True when this palette is exactly the built-in one (same colours, same order,
// same labels).
export function isDefaultPalette(colors: TaskColor[]): boolean {
  if (colors.length !== DEFAULT_COLORS.length) return false;
  return colors.every((c, i) => {
    const d = DEFAULT_COLORS[i];
    return Boolean(d)
      && c.value === d.value
      && (c.label ?? '') === (d.label ?? '')
      && Boolean(c.unnamed) === Boolean(d.unnamed);
  });
}

// Did the USER make this palette (renamed / reordered / deactivated a colour)?
//
// Only a customised palette may be uploaded. Without this rule every device
// whose localStorage had no palette yet — a second browser profile, a cleared
// cache, the app opened from a different address (localStorage is per origin) —
// uploaded the built-in palette on its first save and wiped the real one
// everywhere: names AND their order reverted to the defaults, which is exactly
// how this was reported.
export function colorsCustomized(): boolean {
  try {
    if (localStorage.getItem(CUSTOM_KEY) === '1') return true;
  } catch {
    return false;
  }
  // Evidence beats the flag for data written before it existed: a palette that
  // differs from the built-in one can only have been made by the user. Marking
  // it here also lets a device that still holds the real palette push it back
  // and restore the other devices.
  if (!isDefaultPalette(getColors())) {
    markColorsCustomized();
    return true;
  }
  return false;
}

function markColorsCustomized(): void {
  try {
    localStorage.setItem(CUSTOM_KEY, '1');
  } catch {
    // ignore
  }
}

export function getColors(): TaskColor[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: TaskColor[] = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Build map of parsed items by color value
        const parsedMap = new Map<string, TaskColor>();
        parsed.forEach((p) => {
          if (p && p.value) parsedMap.set(p.value, p);
        });

        // Use stored order for colors present in stored array
        const result: TaskColor[] = [];
        const seen = new Set<string>();

        parsed.forEach((p) => {
          if (p && p.value && !seen.has(p.value)) {
            seen.add(p.value);
            const def = DEFAULT_COLORS.find((d) => d.value === p.value);
            // If label is present, it's not unnamed unless explicitly true
            const hasLabel = Boolean(p.label && p.label.trim());
            const unnamed = hasLabel ? (p.unnamed === true ? true : false) : true;
            result.push({
              value: p.value,
              label: p.label ?? def?.label ?? '',
              unnamed,
            });
          }
        });

        // Append any DEFAULT_COLORS that were missing from stored
        DEFAULT_COLORS.forEach((def) => {
          if (!seen.has(def.value)) {
            seen.add(def.value);
            result.push({ ...def });
          }
        });

        return result;
      }
    }
  } catch {
    // malformed -> fall back
  }
  return DEFAULT_COLORS;
}

export function saveColors(colors: TaskColor[], notifyStore = true): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
    window.dispatchEvent(new CustomEvent('colors-change'));
    if (notifyStore) {
      window.dispatchEvent(new CustomEvent('colors-sync-request'));
    }
  } catch {
    // ignore quota errors
  }
}

// Renamed a color's label (when label is non-empty, remove unnamed flag).
export function renameColor(value: string, label: string): void {
  const trimmed = label.trim();
  markColorsCustomized();
  saveColors(
    getColors().map((c) => {
      if (c.value !== value) return c;
      if (trimmed) {
        return { ...c, label: trimmed, unnamed: false };
      }
      return { ...c, label: '', unnamed: true };
    })
  );
}

// Reorder colors by an array of values
export function reorderColors(orderedValues: string[]): void {
  markColorsCustomized();
  const current = getColors();
  const map = new Map(current.map((c) => [c.value, c]));
  const result: TaskColor[] = [];
  orderedValues.forEach((val) => {
    const c = map.get(val);
    if (c) {
      result.push(c);
      map.delete(val);
    }
  });
  // Append any leftover colors
  map.forEach((c) => result.push(c));
  saveColors(result);
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
  markColorsCustomized();
  saveColors(getColors().map((c) => (c.value === value ? { ...c, label: '', unnamed: true } : c)));
}
