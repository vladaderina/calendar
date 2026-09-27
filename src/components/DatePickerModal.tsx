import { useState } from 'react';
import { addMonths, isSameMonth, isSameDay, parseISO } from 'date-fns';
import { fmt, taskOnDate, monthGrid } from '../utils/date';
import { useTasks } from '../store';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface Props {
  anchor: Date;
  currentStart?: string;
  currentEnd?: string;
  onSelect: (start: string, end: string) => void;
  onClose: () => void;
}

export function DatePickerModal({ anchor, currentStart, currentEnd, onSelect, onClose }: Props) {
  const tasks = useTasks();
  const today = new Date();
  const [month, setMonth] = useState(anchor);
  const [selecting, setSelecting] = useState<'start' | 'end'>('start');
  const [tempStart, setTempStart] = useState(currentStart ?? '');
  const [tempEnd, setTempEnd] = useState(currentEnd ?? '');

  const days = monthGrid(month);

  const handleDayClick = (d: Date) => {
    const iso = fmt.iso(d);
    // Click on the current start clears it and puts us back into 'start' mode.
    if (selecting === 'start' && tempStart === iso) {
      setTempStart('');
      setTempEnd('');
      return;
    }
    // Click on the current end clears it and reverts to picking the end.
    if (selecting === 'end' && tempEnd && iso === tempEnd) {
      setTempEnd('');
      return;
    }
    if (selecting === 'start') {
      // Setting a new start. If it lands after the existing end, the old end
      // is no longer valid — drop it and ask for a fresh end.
      setTempStart(iso);
      if (tempEnd && iso > tempEnd) {
        setTempEnd('');
      }
      setSelecting('end');
    } else {
      // Picking the end. If there's no start yet, treat this click as start.
      if (!tempStart) {
        setTempStart(iso);
        return;
      }
      // Never allow end < start: the earlier date always becomes the start.
      if (iso < tempStart) {
        setTempEnd(tempStart);
        setTempStart(iso);
      } else {
        setTempEnd(iso);
      }
    }
  };

  const clearDates = () => {
    setTempStart('');
    setTempEnd('');
    setSelecting('start');
  };

  const handleSave = () => {
    if (tempStart) {
      onSelect(tempStart, tempEnd || tempStart);
    }
  };

  const isStarted = tempStart ? parseISO(tempStart) : null;
  const isEnded = tempEnd ? parseISO(tempEnd) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="date-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            Выбрать дату {selecting === 'start' ? '(начало)' : '(конец)'}
          </h3>
          <button className="btn ghost" style={{ fontSize: 20 }} onClick={onClose}>×</button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <button className="btn ghost" onClick={() => setMonth((d) => addMonths(d, -1))}>‹</button>
          <span style={{ fontSize: 16, fontWeight: 600 }}>{fmt.monthYear(month)}</span>
          <button className="btn ghost" onClick={() => setMonth((d) => addMonths(d, 1))}>›</button>
        </div>

        <div className="date-picker-grid">
          {WEEKDAYS.map((w) => <div key={w} className="date-picker-weekday">{w}</div>)}
          {days.map((d) => {
            const iso = fmt.iso(d);
            const dayTasks = tasks.filter((t) => t.startDate && taskOnDate(t, d));
            const isOtherMonth = !isSameMonth(d, month);
            const isToday = isSameDay(d, today);
            const isStart = isStarted && isSameDay(d, isStarted);
            const isEnd = isEnded && isSameDay(d, isEnded);
            const inRange = isStarted && isEnded && d >= isStarted && d <= isEnded;

            return (
              <div
                key={iso}
                className={`date-picker-cell ${isOtherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''} ${isStart ? 'start' : ''} ${isEnd ? 'end' : ''} ${inRange && !isStart && !isEnd ? 'in-range' : ''}`}
                onClick={() => !isOtherMonth && handleDayClick(d)}
              >
                <div className="date-picker-day-num">{d.getDate()}</div>
                <div className="date-picker-tasks">
                  {dayTasks.slice(0, 2).map((t) => (
                    <div key={t.id} className="date-picker-task-badge">{t.title.slice(0, 8)}</div>
                  ))}
                  {dayTasks.length > 2 && <div className="date-picker-task-badge">+{dayTasks.length - 2}</div>}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {tempStart && <span>Начало: {tempStart}</span>}
            {tempEnd && <span style={{ marginLeft: 16 }}>Конец: {tempEnd}</span>}
            <button
              className="btn ghost"
              style={{ marginLeft: 12, fontSize: 13 }}
              onClick={() => setSelecting('start')}
              disabled={!tempStart && !tempEnd}
              title="Выбрать заново начало"
            >изменить начало</button>
            {(tempStart || tempEnd) && (
              <button className="btn ghost" style={{ marginLeft: 4, fontSize: 13 }} onClick={clearDates}>очистить</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>отмена</button>
            <button className="btn primary" onClick={handleSave} disabled={!tempStart}>выбрать</button>
          </div>
        </div>
      </div>
    </div>
  );
}
