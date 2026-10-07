import { useState, useRef, useEffect } from 'react';
import { addDays, addMonths, addWeeks, addYears, format } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { View, Task } from './types';
import { fmt } from './utils/date';
import { WeekView } from './components/WeekView';
import { MonthView } from './components/MonthView';
import { DayView } from './components/DayView';
import { YearView } from './components/YearView';
import { DashboardView } from './components/DashboardView';
import { PlannedListView } from './components/PlannedListView';
import { AnalyticsView } from './components/AnalyticsView';
import { store, useLastView, useJournal, pullRemoteTasks } from './store';
import { initSupabase } from './store';
import { TaskModal } from './components/TaskModal';
import { SearchModal } from './components/SearchModal';
import { ChevronIcon } from './icons/ChevronIcon';
import { AuthGate } from './components/AuthGate';

// Inline SVG icons for the top nav.
const DashboardIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="7" height="7" rx="1.3" />
    <rect x="14" y="3" width="7" height="7" rx="1.3" />
    <rect x="3" y="14" width="7" height="7" rx="1.3" />
    <rect x="14" y="14" width="7" height="7" rx="1.3" />
  </svg>
);
const MonthViewIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 5h18" />
    <rect x="4" y="8" width="14" height="10" rx="1" />
  </svg>
);
const YearViewIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 5h18" />
    <path d="M4 9h3v3H4zM9 9h3v3H9zM14 9h3v3H9zM4 14h3v3H4zM9 14h3v3H4zM14 14h3v3h-3z" />
  </svg>
);
const SearchIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);
const AnalyticsIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 3v18h18M9 12l2-2 4 4-2 2-4-4z" />
  </svg>
);
const WeekViewIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="4" y="4" width="14" height="14" rx="1" />
    <path d="M4 9h14M9 4v5M14 4v5" />
  </svg>
);
const JournalIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 9h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" />
    <line x1="12" y1="5" x2="12" y2="9" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const RefreshIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M23 4v6h-6" />
    <path d="M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" />
  </svg>
);

function AppContent() {
  // View comes from the store (persisted in localStorage + Supabase)
  const view = useLastView() as View;
  const setViewPersisted = (next: View) => {
    store.saveView(next);
  };
  const [anchor, setAnchor] = useState(new Date());
  const [modal, setModal] = useState<{ initial?: Partial<Task>; editingId?: string; selectedDate?: string } | null>(null);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [journalActive, setJournalActive] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const journalData = useJournal();
  const [journalText, setJournalText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const journalSectionRef = useRef<HTMLDivElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);

  // Initialize Supabase when component mounts
  useEffect(() => {
    void initSupabase();
  }, []);

  const shift = (dir: 1 | -1) => {
    switch (view) {
      case 'day': setAnchor((d) => addDays(d, dir)); break;
      case 'week': setAnchor((d) => addWeeks(d, dir)); break;
      case 'month': setAnchor((d) => addMonths(d, dir)); break;
      case 'year': setAnchor((d) => addYears(d, dir)); break;
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await pullRemoteTasks();
    } finally {
      setIsRefreshing(false);
    }
  };

  const title = (() => {
    switch (view) {
      case 'dashboard': return 'ДАШБОРД';
      case 'day': return 'ДЕНЬ';
      case 'week': return 'НЕДЕЛЯ';
      case 'month': return 'МЕСЯЦ';
      case 'year': return 'ГОД';
      case 'planned': return 'ЗАПЛАНИРОВАННЫЕ';
      case 'analytics': return 'АНАЛИТИКА';
    }
  })();

  const subtitle = (() => {
    switch (view) {
      case 'day': return fmt.full(anchor);
      case 'week':
      case 'month': return fmt.monthYear(anchor);
      case 'year': return format(anchor, 'yyyy', { locale: ru });
      default: return '';
    }
  })();

  // "Calendar section" = any date-grid view (week/day/month/year), used by the
  // mobile bottom tab bar to light up the week icon. Dashboard/notes excluded.
  const isCalendarSection =
    view === 'week' || view === 'day' || view === 'month' || view === 'year';

  const goToWeek = () => {
    setViewPersisted('week')
    setAnchor(new Date());
  };

  const openEdit = (t: Task, editingDate?: string) => {
    setModal({ initial: t, editingId: t.id, selectedDate: editingDate });
    setShowSearchModal(false);
  };

  // Load empty journal text when journal is opened (user types fresh content)
  useEffect(() => {
    if (journalActive) {
      setJournalText('');
      textareaRef.current?.focus();
    }
  }, [journalActive]);

  // Save journal on blur or when deactivated
  useEffect(() => {
    if (!journalActive && journalText) {
      store.saveJournalEntry(fmt.iso(anchor), journalText);
    }
  }, [journalActive, journalText, anchor]);

  // Handle click outside to close journal (the mobile nav's notes button
  // toggles it, so taps there must NOT count as "outside")
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideJournal = journalSectionRef.current?.contains(target) ?? false;
      const insideMobileNav = mobileNavRef.current?.contains(target) ?? false;
      if (!insideJournal && !insideMobileNav) {
        setJournalActive(false);
      }
    };
    if (journalActive) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [journalActive]);

  const handleJournalChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJournalText(e.target.value);
  };

  const handleJournalKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Auto-save on Enter (without shift), clear input but keep editor open
      e.preventDefault();
      if (journalText.trim()) {
        const dateKey = fmt.iso(anchor);
        const existing = journalData[dateKey] || '';
        // Append to existing journal entry for the day
        const newText = existing ? existing + '\n\n' + journalText.trim() : journalText.trim();
        store.saveJournalEntry(dateKey, newText);
        setJournalText('');
        // Keep the editor open for more notes
      }
    } else if (e.key === 'Escape') {
      setJournalActive(false);
    }
  };

  const toggleJournal = () => {
    if (journalActive) {
      setJournalActive(false);
    } else {
      setJournalActive(true);
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
            {(view === 'planned') && (
              <button className="back-btn" onClick={() => setViewPersisted('week')}>‹</button>
            )}
            {(view === 'analytics') && (
              <button className="back-btn" onClick={() => setViewPersisted('week')}>‹</button>
            )}
            <h1 className={subtitle ? 'has-subtitle' : ''}>{title}</h1>
            {subtitle && (
              <div className="view-subtitle" title={subtitle}>{subtitle}</div>
            )}
          </div>

          <div className="view-switcher-fixed" role="group" aria-label="Переключить вид">
            <button
              className={`view-switcher-btn ${view === 'dashboard' ? 'active' : ''}`}
              onClick={() => setViewPersisted('dashboard')}
              title="Дашборд"
              aria-label="Дашборд"
            >
              <DashboardIcon />
            </button>
            <button
              className={`view-switcher-btn ${view === 'week' ? 'active' : ''}`}
              onClick={() => setViewPersisted('week')}
              title="Неделя"
              aria-label="Неделя"
            >
              <WeekViewIcon />
            </button>
            <button
              className={`view-switcher-btn ${view === 'month' ? 'active' : ''}`}
              onClick={() => setViewPersisted('month')}
              title="Месяц"
              aria-label="Месяц"
            >
              <MonthViewIcon />
            </button>
            <button
              className={`view-switcher-btn ${view === 'year' ? 'active' : ''}`}
              onClick={() => { setAnchor(new Date()); setViewPersisted('year'); }}
              title="Год"
              aria-label="Год"
            >
              <YearViewIcon />
            </button>
            <button
              className={`view-switcher-btn ${view === 'analytics' ? 'active' : ''}`}
              onClick={() => setViewPersisted('analytics')}
              title="Аналитика"
              aria-label="Аналитика"
            >
              <AnalyticsIcon />
            </button>
          </div>

          <div className="header-controls">
            {view === 'dashboard' && (
              <>
                <button className="today-btn" onClick={() => setAnchor(new Date())}>сегодня</button>
                <button className="nav-btn-search" onClick={() => setShowSearchModal(true)} title="Поиск" aria-label="Поиск"><SearchIcon /></button>
              </>
            )}
            {view === 'planned' && (
              <>
                <button className="today-btn" onClick={() => setAnchor(new Date())}>сегодня</button>
                <button className="nav-btn-search" onClick={() => setShowSearchModal(true)} title="Поиск" aria-label="Поиск"><SearchIcon /></button>
              </>
            )}
            {view === 'analytics' && (
              <>
                <button className="nav-btn-search" onClick={() => setShowSearchModal(true)} title="Поиск" aria-label="Поиск"><SearchIcon /></button>
              </>
            )}
            {view !== 'dashboard' && view !== 'planned' && view !== 'analytics' && (
              <>
                <button className="today-btn" onClick={() => setAnchor(new Date())}>сегодня</button>
                <button className="nav-btn-search" onClick={() => setShowSearchModal(true)} title="Поиск" aria-label="Поиск"><SearchIcon /></button>
                <button className={`nav-btn-arrow nav-btn-refresh ${isRefreshing ? 'refreshing' : ''}`} onClick={handleRefresh} disabled={isRefreshing} title="Обновить" aria-label="Обновить"><RefreshIcon /></button>
                <button className="nav-btn-arrow" onClick={() => shift(-1)} aria-label="Назад"><ChevronIcon dir="left" /></button>
                <button className="nav-btn-arrow" onClick={() => shift(1)} aria-label="Вперёд"><ChevronIcon dir="right" /></button>
              </>
            )}
          </div>
        </div>

        <div className="content">
          {view === 'dashboard' && <DashboardView onEdit={openEdit} />}
          {view === 'day' && <DayView anchor={anchor} onEdit={openEdit} />}
          {view === 'week' && <WeekView anchor={anchor} onEdit={openEdit} onPickDate={(d) => { setAnchor(d); setViewPersisted('day'); }} /> }
          {view === 'month' && <MonthView key={fmt.iso(anchor)} anchor={anchor} onEdit={openEdit} onPickDate={(d) => { setAnchor(d); setViewPersisted('day'); }} />}
          {view === 'year' && <YearView key={fmt.iso(anchor)} anchor={anchor} onPickDate={(d) => { setAnchor(d); setViewPersisted('month'); }} onZoomIn={() => setViewPersisted('month')} />}
          {view === 'planned' && <PlannedListView onEdit={openEdit} />}
          {view === 'analytics' && <AnalyticsView />}
        </div>
      </div>

      {/* Inline journal editor at bottom-right */}
      <div className={`inline-journal-section ${journalActive ? 'journal-open' : ''}`} ref={journalSectionRef}>
        {journalActive && (
          <textarea
            ref={textareaRef}
            className="inline-journal-textarea"
            value={journalText}
            onChange={handleJournalChange}
            onKeyDown={handleJournalKeyDown}
            placeholder="Запишите свои мысли..."
            rows={2}
            spellCheck={true}
          />
        )}
        <button 
          className={`view-icon-btn ${journalActive ? 'active' : ''}`} 
          onClick={toggleJournal} 
          title="Дневник" 
          aria-label="Дневник"
        >
          <JournalIcon />
        </button>
      </div>

      {/* Mobile-only bottom tab bar: week / dashboard / notes.
          Hidden on desktop (.mobile-bottom-nav is display:none above 720px)
          so the laptop keeps the full header switcher untouched. */}
      <nav className="mobile-bottom-nav" ref={mobileNavRef} aria-label="Основная навигация">
        <button
          className={`mobile-nav-btn ${view === 'dashboard' ? 'active' : ''}`}
          onClick={() => setViewPersisted('dashboard')}
          title="Дашборд"
          aria-label="Дашборд"
        >
          <DashboardIcon />
        </button>
        <button
          className={`mobile-nav-btn ${isCalendarSection ? 'active' : ''}`}
          onClick={() => setViewPersisted('week')}
          title="Неделя"
          aria-label="Неделя"
        >
          <WeekViewIcon />
        </button>
        <button
          className={`mobile-nav-btn ${journalActive ? 'active' : ''}`}
          onClick={toggleJournal}
          title="Заметки"
          aria-label="Заметки"
        >
          <JournalIcon />
        </button>
      </nav>

      {modal && (
        <TaskModal
          initial={modal.initial}
          editingId={modal.editingId}
          selectedDate={modal.selectedDate}
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

export default function App() {
  return (
    <AuthGate onUserLoaded={() => {}}>{<AppContent />}</AuthGate>
  );
}