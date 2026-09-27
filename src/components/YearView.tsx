import { useEffect, useMemo, useRef } from 'react';
import { isSameMonth, isSameDay, format, addMonths } from 'date-fns';
import { ru } from 'date-fns/locale';
import { monthGrid, fmt, taskOnDate } from '../utils/date';
import { useTasks } from '../store';

interface Props {
  anchor: Date;
  onPickDate: (d: Date) => void;
}

const WEEKDAYS = ['П', 'В', 'С', 'Ч', 'П', 'С', 'В'];

// Continuous month strip, grouped by year; starts at anchor month
export function YearView({ anchor, onPickDate }: Props) {
  const tasks = useTasks();
  const today = new Date();
  const anchorRef = useRef<HTMLDivElement>(null);

  const months = useMemo(() => {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    return Array.from({ length: 36 }, (_, i) => addMonths(start, i - 12));
  }, [anchor]);

  useEffect(() => { anchorRef.current?.scrollIntoView({ block: 'start' }); }, []);

  const byYear = new Map<number, Date[]>();
  for (const m of months) {
    const y = m.getFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(m);
  }
  const years = Array.from(byYear.keys()).sort((a, b) => a - b);

  return (
    <div className="year-scroll">
      {years.map((y) => (
        <div className="year-block" key={y}>
          <div className="year-block-title">{y}</div>
          <div className="year-grid">
            {byYear.get(y)!.map((monthAnchor) => {
              const days = monthGrid(monthAnchor);
              const isCurrent = isSameMonth(monthAnchor, today);
              const isAnchorMonth = isSameMonth(monthAnchor, anchor);
              return (
                <div className={`year-month ${isCurrent ? 'current' : ''}`}
                  key={fmt.iso(monthAnchor)}
                  ref={isAnchorMonth ? anchorRef : undefined}>
                  <h3>{format(monthAnchor, 'LLLL', { locale: ru })}</h3>
                  <div className="mini-month">
                    {WEEKDAYS.map((w, k) => (
                      <div key={`w${k}`} style={{ color: 'var(--muted)', fontSize: 10, textAlign: 'center' }}>{w}</div>
                    ))}
                    {days.map((d) => {
                      const has = tasks.some((t) => t.startDate && taskOnDate(t, d));
                      const cls = [
                        'mini-day',
                        !isSameMonth(d, monthAnchor) && 'other',
                        has && 'has-tasks',
                        isSameDay(d, today) && 'today',
                      ].filter(Boolean).join(' ');
                      return (
                        <div className={cls} key={fmt.iso(d)} onClick={() => onPickDate(d)}>
                          {d.getDate()}
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
  );
}
