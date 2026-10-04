import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { isSameMonth, isSameDay, format, addMonths, startOfMonth } from 'date-fns';
import { ru } from 'date-fns/locale';
import { monthGrid, fmt, taskOnDate, sortByPriority, isNonWorkingDay, isHoliday } from '../utils/date';
import { useTasks } from '../store';
import { ChevronIcon } from './icons/ChevronIcon';
import { getColors } from '../config/colors';

interface Props {
  anchor: Date;
  onPickDate: (d: Date) => void;
  onZoomIn?: () => void;
}

const WEEKDAYS = ['П', 'В', 'С', 'Ч', 'П', 'С', 'В'];

// Year view: a compact month strip centered on the anchor month (±18 months,
// i.e. about 3 years). The strip is bounded so switching to the year view is
// instant. A production-calendar pass greys out weekends and public holidays,
// and a color filter lets you show only tasks of selected colors (with a
// tooltip on each swatch explaining what it stands for).
export function YearView({ anchor, onPickDate, onZoomIn }: Props) {
  const tasks = useTasks();
  const today = new Date();
  const [, setRefresh] = useState(0);
  useEffect(() => {
    const h = () => setRefresh((n) => n + 1);
    window.addEventListener('colors-change', h);
    return () => window.removeEventListener('colors-change', h);
  }, []);

  // --- Color filter: empty set == show all colors. ---
  const [activeColors, setActiveColors] = useState<Set<string>>(new Set());
  const allOn = activeColors.size === 0;
  const toggleColor = (c: string) => {
    const next = new Set(activeColors);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setActiveColors(next);
  };
  const clearColors = () => setActiveColors(new Set());

  // Continuous month strip centered on the anchor, ±18 months.
  const months = useMemo(() => {
    const start = startOfMonth(addMonths(anchor, -18));
    return Array.from({ length: 36 }, (_, i) => addMonths(start, i));
  }, [anchor]);

  // Group months by year for sticky headers.
  const byYear = new Map<number, Date[]>();
  for (const m of months) {
    const y = m.getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(m);
  }
  const yearList = Array.from(byYear.keys()).sort((a, b) => a - b);

  // Scroll the anchor month into view on mount / anchor change.
  const anchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    anchorRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [anchor]);

  // Collect colors used by tasks that appear IN the calendar (planned tasks).
  // Tasks in the backlog (unplanned=true) even if dated, don't appear on day cells,
  // so their colors shouldn't show in the year view filter.
  const usedColors = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (t.color && t.startDate && !t.unplanned) set.add(t.color);
    }
    return set;
  }, [tasks]);
  const coloredTasks = (d: Date): { colors: string[]; count: number } => {
    let ts = sortByPriority(
      tasks.filter((t) => t.startDate && !t.unplanned && taskOnDate(t, d))
    );
    if (!allOn) {
      ts = ts.filter((t) => t.color && activeColors.has(t.color));
    }
    const colored = ts.filter((t) => t.color).map((t) => t.color!);
    const max = 4; // cap bands so the cell doesn't get cluttered
    return {
      colors: colored.slice(0, max),
      count: ts.length,
    };
  };

  // Build a vertical multi-band background from up to 4 colors.
  // Colors are lightly tinted (~20-25% opacity) so the day number stays legible.
  const dayBg = (colors: string[]): CSSProperties | undefined => {
    if (colors.length === 0) return undefined;
    if (colors.length === 1) {
      return { backgroundColor: `${colors[0]}22` };
    }
    const step = 100 / colors.length;
    const gradient = colors
      .map((c, i) => `${c}33 ${i * step}%, ${c}33 ${(i + 1) * step}%`)
      .join(', ');
    return {
      backgroundImage: `linear-gradient(to bottom, ${gradient})`,
    };
  };

  return (
    <>
      <div className="year-color-filter-sticky">
        <div className="year-color-filter" role="group" aria-label="Фильтр цветов">
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Фильтр:</span>
          <button
            className={`year-color-btn ${allOn ? 'active' : ''}`}
            onClick={clearColors}
            aria-pressed={allOn}
            title="Все цвета"
            style={{
              width: 34, height: 34, fontSize: 11,
              background: allOn ? 'var(--ink)' : 'var(--line)',
              color: allOn ? 'white' : 'var(--muted)',
            }}
          >Все</button>
          {getColors().filter((c) => usedColors.has(c.value)).map((c) => {
            const sel = activeColors.has(c.value);
            return (
              <div key={c.value} className="year-color-item">
                <button
                  className={`year-color-btn ${sel ? 'active' : ''}`}
                  onClick={() => toggleColor(c.value)}
                  aria-pressed={sel}
                  title={c.label}
                  style={{
                    width: 40, height: 40, borderRadius: '50%',
                    background: c.value,
                    color: sel ? 'var(--ink)' : 'rgba(0,0,0,0.3)',
                    borderColor: sel ? 'var(--ink)' : 'transparent',
                  }}
                >{sel ? '✓' : ' '}</button>
                <span
                  className="year-color-label"
                  title={c.label}
                >{c.label}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="year-scroll">
        <div className="year-zoom-bar">
          <button className="btn ghost" onClick={onZoomIn} aria-label="К месяцам">
            <ChevronIcon dir="left" /> месяцы
          </button>
        </div>
        {yearList.map((y) => (
        <div className="year-block" key={y}>
          <div className="year-block-title">{y}</div>
          <div className="year-grid-single">
            {byYear.get(y)!.map((monthAnchor) => {
              const days = monthGrid(monthAnchor);
              const isCurrent = isSameMonth(monthAnchor, today);
              const isAnchorMonth = isSameMonth(monthAnchor, anchor);
              return (
                <div
                  className={`year-month ${isCurrent ? 'current' : ''}`}
                  key={fmt.iso(monthAnchor)}
                  ref={isAnchorMonth ? anchorRef : undefined}
                >
                  <h3>{format(monthAnchor, 'LLLL', { locale: ru })}</h3>
                  <div className="mini-month">
                    {WEEKDAYS.map((w, k) => (
                      <div key={`w${k}`} className="min-weekday">
                        {w}
                      </div>
                    ))}
                    {days.map((d) => {
                      const sameMonth = isSameMonth(d, monthAnchor);
                      const isToday = isSameDay(d, today);
                      const nonWorking = isNonWorkingDay(d);
                      const holiday = isHoliday(d);
                      const { colors, count } = coloredTasks(d);
                      const cls = [
                        'mini-day',
                        !sameMonth && 'other',
                        isToday && 'today',
                        nonWorking && sameMonth && 'non-working',
                        holiday && sameMonth && 'holiday',
                        count > 0 && 'has-tasks',
                      ]
                        .filter(Boolean)
                        .join(' ');
                      return (
                        <div
                          className={cls}
                          key={fmt.iso(d)}
                          onClick={() => onPickDate(d)}
                          style={
                            sameMonth && colors.length > 0 ? dayBg(colors) : undefined
                          }
                          title={count > 0 ? `${count} задач` : undefined}
                        >
                          <span className="day-num">{d.getDate()}</span>
                          {count > 0 && <span className="mini-day-badge">{count}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
    </>
  );
}
