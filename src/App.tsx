import { useState } from 'react';
import { addDays, addMonths, addWeeks, addYears } from 'date-fns';
import type { View, Task } from './types';
import { fmt } from './utils/date';
import { WeekView } from './components/WeekView';
import { MonthView } from './components/MonthView';
import { DayView } from './components/DayView';
import { YearView } from './components/YearView';
import { DashboardView } from './components/DashboardView';
import { store } from './store';
import { TaskModal } from './components/TaskModal';
import { SearchModal } from './components/SearchModal';
import { ChevronIcon } from './icons/ChevronIcon';

// Inline SVG icons for the top nav.
const DashboardIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="7" height="7" rx="1.3" />
    <rect x="14" y="3" width="7" height="7" rx="1.3" />
    <rect x="3" y="14" width="7" height="7" rx="1.3" />
    <rect x="14" y="14" width="7" height="7" rx="1.3" />
  </svg>
);
const CalendarIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
    <path d="M3 9h18" />
    <path d="M8 3v3.5M16 3v3.5" />
  </svg>
);
const SearchIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);
// Bigger, bolder chevrons for the nav arrows (imported from ./icons/ChevronIcon).

export default function App() {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(new Date());
  const [modal, setModal] = useState<{ initial?: Partial<Task>; editingId?: string; editingDate?: string } | null>(null);
  const [showSearchModal, setShowSearchModal] = useState(false);

  const shift = (dir: 1 | -1) => {
    switch (view) {
      case 'day': setAnchor((d) => addDays(d, dir)); break;
      case 'week': setAnchor((d) => addWeeks(d, dir)); break;
      case 'month': setAnchor((d) => addMonths(d, dir)); break;
      case 'year': setAnchor((d) => addYears(d, dir)); break;
    }
  };

  const title = (() => {
    switch (view) {
      case 'dashboard': return 'Дашборд';
      case 'day': return fmt.full(anchor);
      case 'week':
      case 'month': return fmt.monthYear(anchor);
      case 'year': return String(anchor.getFullYear());
    }
  })();

  const goToWeek = () => setView('week');

  const openEdit = (t: Task, editingDate?: string) => {
    setModal({ initial: t, editingId: t.id, editingDate });
    setShowSearchModal(false);
  };

  const isCalendarView = view !== 'dashboard';

  const clearAll = () => {
    if (window.confirm('Удалить все задачи? Это действие нельзя отменить.')) {
      localStorage.removeItem('calendar.tasks.v1');
      localStorage.removeItem('calendar.spheres.v1');
      store.clearAll();
      window.location.reload();
    }
  };

  return (
    <div className="app">
      <div className="paper">
        <div className="header">
          <div className="header-title">
            {(view === 'day' || view === 'month') && (
              <button className="back-btn" onClick={goToWeek}>‹</button>
            )}
            {(view === 'day' || view === 'dashboard') && (
              <h1>{title}</h1>
            )}
            {view === 'week' && (
              <h1 className="clickable" onClick={() => setView('month')}>{title}</h1>
            )}
            {view === 'year' && (
              <h1>{title}</h1>
            )}
            {view === 'dashboard' && (
              <button className="clear-all-btn" title="Удалить все задачи" onClick={clearAll}>
                🗑
              </button>
            )}
          </div>
          <div className="header-controls">
            <button
              className={`view-icon-btn ${view === 'dashboard' ? 'active' : ''}`}
              onClick={() => setView('dashboard')}
              title="Дашборд"
              aria-label="Дашборд"
            ><DashboardIcon /></button>
            <button
              className={`view-icon-btn ${isCalendarView ? 'active' : ''}`}
              onClick={() => setView('week')}
              title="Календарь"
              aria-label="Календарь"
            ><CalendarIcon /></button>
            {view !== 'dashboard' && view !== 'day' && view !== 'month' && view !== 'year' && (
              <button className="today-btn" onClick={() => setAnchor(new Date())}>сегодня</button>
            )}
            <button className="nav-btn-search" onClick={() => setShowSearchModal(true)} title="Поиск" aria-label="Поиск"><SearchIcon /></button>
            {view !== 'dashboard' && (
              <>
                <button className="nav-btn-arrow" onClick={() => shift(-1)} aria-label="Назад"><ChevronIcon dir="left" /></button>
                <button className="nav-btn-arrow" onClick={() => shift(1)} aria-label="Вперёд"><ChevronIcon dir="right" /></button>
              </>
            )}
          </div>
        </div>

        <div className="content">
          {view === 'dashboard' && <DashboardView onEdit={openEdit} />}
          {view === 'day' && <DayView anchor={anchor} onEdit={openEdit} />}
          {view === 'week' && <WeekView anchor={anchor} onEdit={openEdit} onPickDate={(d) => { setAnchor(d); setView('day'); }} />}
          {view === 'month' && <MonthView key={fmt.iso(anchor)} anchor={anchor} onEdit={openEdit} onPickDate={(d) => { setAnchor(d); setView('day'); }} onZoomOut={() => setView('year')} />}
          {view === 'year' && <YearView key={fmt.iso(anchor)} anchor={anchor} onPickDate={(d) => { setAnchor(d); setView('day'); }} onZoomIn={() => setView('month')} />}
        </div>
      </div>

      {modal && (
        <TaskModal
          initial={modal.initial}
          editingId={modal.editingId}
          selectedDate={modal.editingDate}
          onClose={() => setModal(null)}
        />
      )}

      {showSearchModal && (
        <SearchModal
          onClose={() => setShowSearchModal(false)}
          onEdit={openEdit}
        />
      )}
    </div>
  );
}
