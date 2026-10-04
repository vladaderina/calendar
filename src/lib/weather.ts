// Weather integration via Open-Meteo (no API key required).
// Fetches forecast + sunrise/sunset for a date range (up to ~10 days ahead).
// Results are cached 6h by year so the same year isn't re-fetched while
// navigating between weeks. Moscow coordinates by default.
import { format, addDays } from 'date-fns';

export interface DayWeather {
  date: string; // yyyy-MM-dd
  tempMax: number; // °C
  tempMin: number; // °C
  weatherCode: number;
  sunrise: string; // HH:MM local
  sunset: string;  // HH:MM local
}

export const DEFAULT_LAT = 55.7558;
export const DEFAULT_LON = 37.6176;

const CACHE_TTL_MS = 6 * 3600 * 1000; // 6 hours
const cache = new Map<number, { fetchedAt: number; days: DayWeather[] }>();

// Open-Meteo weather codes -> emoji (compact for a 10px cell).
const CODE_MAP: Record<number, string> = {
  0: '☀', 1: '🌤', 2: '⛅', 3: '☁', 45: 'Т', 48: 'Т',
  51: 'м', 53: 'м', 55: '🌧', 56: 'м', 57: 'м',
  61: '🌦', 63: '🌧', 65: '🌧', 66: 'м', 67: '🌧',
  71: 'сн', 73: 'сн', 75: 'сн', 77: 'сн', 80: '🌦', 81: '🌦', 82: '🌦',
  85: 'сн', 86: 'сн', 95: '⛈', 96: '⛈', 99: '⛈',
};

export function describe(code: number): string {
  return CODE_MAP[code] ?? '—';
}

let fetching: Map<string, Promise<DayWeather[]>> = new Map();

// Cache key based on the date range + coords so different weeks aren't confused.
function rangeKey(start: Date, end: Date, lat: number, lon: number): string {
  return `${format(start, 'yyyy-MM-dd')}_${format(end, 'yyyy-MM-dd')}_${lat}_${lon}`;
}

export async function fetchWeatherRange(
  start: Date,
  end: Date,
  lat: number = DEFAULT_LAT,
  lon: number = DEFAULT_LON,
): Promise<DayWeather[]> {
  const key = rangeKey(start, end, lat, lon);
  const now = Date.now();

  // Year-level cache check: if we've fetched data for this year already,
  // filter the cached results to the requested range.
  const year = start.getFullYear();
  const cachedYear = cache.get(year);
  if (cachedYear && now - cachedYear.fetchedAt < CACHE_TTL_MS) {
    const startIso = format(start, 'yyyy-MM-dd');
    const endIso = format(end, 'yyyy-MM-dd');
    return cachedYear.days.filter((d) => d.date >= startIso && d.date <= endIso);
  }

  // De-dup concurrent fetches for the same range.
  if (fetching.has(key)) return fetching.get(key)!;

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: format(start, 'yyyy-MM-dd'),
    end_date: format(end, 'yyyy-MM-dd'),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset',
    timezone: 'Europe/Moscow',
  });

  // Use the dev-server proxy in development; direct URL in production.
  const IS_DEV = import.meta.env.MODE === 'development' || import.meta.env.DEV === true;
  const API_ORIGIN = IS_DEV ? '/api/weather' : 'https://api.open-meteo.com/v1';
  const url = `${API_ORIGIN}/forecast?${params.toString()}`;
  const promise = (async () => {
    let json: any;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`weather HTTP ${res.status}`);
      json = await res.json();
    } catch {
      return [];
    }
    const daily = json.daily ?? {};
    const times: string[] = daily.time ?? [];
    const codes: number[] = daily.weather_code ?? [];
    const tmax: number[] = daily.temperature_2m_max ?? [];
    const tmin: number[] = daily.temperature_2m_min ?? [];
    const sunr: string[] = daily.sunrise ?? [];
    const suns: string[] = daily.sunset ?? [];
    const days: DayWeather[] = times.map((date: string, i: number) => ({
      date,
      tempMax: Math.round(tmax[i] ?? 0),
      tempMin: Math.round(tmin[i] ?? 0),
      weatherCode: codes[i] ?? 0,
      sunrise: toHHMM(sunr[i]),
      sunset: toHHMM(suns[i]),
    }));
    // Cache at the year level for subsequent range requests within 6h.
    cache.set(year, { fetchedAt: now, days });
    return days;
  })();

  fetching.set(key, promise);
  try {
    return await promise;
  } finally {
    fetching.delete(key);
  }
}

// Convenience: fetch weather for a week starting Monday (7 days) plus the
// following week (14 days total) — used by WeekView for the current week
// and the next week when the user navigates.
export function fetchWeekWeather(anchor: Date): Promise<DayWeather[]> {
  const start = startOfWeekISO(anchor);
  const end = addDays(start, 13); // current week + next week = 14 days
  return fetchWeatherRange(start, end);
}

function startOfWeekISO(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1 - day); // Monday
  date.setDate(date.getDate() + diff);
  return date;
}

function toHHMM(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
