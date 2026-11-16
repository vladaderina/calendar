import { useState, useEffect } from 'react';
import { addDays, addMonths, addWeeks, addYears, format, isSameDay, isSameWeek, isSameMonth } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { View, Task } from './types';
import { fmt } from './utils/date';
import { WeekView } from './components/WeekView';
import { MonthView } from './components/MonthView';
import { DayView } from './components/DayView';
import { YearView } from './components/YearView';
import { YearWheelView } from './components/YearWheelView';
import { DashboardView } from './components/DashboardView';
import { PlannedListView } from './components/PlannedListView';
import { AnalyticsView } from './components/AnalyticsView';
import { store, useLastView, useSyncStatus, syncNow } from './store';
import { initSupabase } from './store';
import { TaskModal } from './components/TaskModal';
import { SearchModal } from './components/SearchModal';
import BackupModal from './components/BackupModal';
import { ChevronIcon } from './icons/ChevronIcon';
import { AuthGate } from './components/AuthGate';
import { signOut, getCurrentUser } from './lib/auth';
import { useUpdateAvailable } from './lib/updateCheck';

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
const WheelIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v9M12 12l7.8 4.5M12 12l-7.8 4.5" />
  </svg>
);
const SearchIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);
const WeekViewIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="4" y="4" width="14" height="14" rx="1" />
    <path d="M4 9h14M9 4v5M14 4v5" />
  </svg>
);
const RefreshIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M23 4v6h-6" />
    <path d="M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36" />
  </svg>
);

const CheckSquareIcon = ({ active }: { active: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    {active && <path d="M7.5 12l3 3 6-6" stroke="currentColor" strokeWidth="2.4" />}
  </svg>
);

const DataIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </svg>
);

const LogoutIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

function AppContent() {
  // View comes from the store (persisted in localStorage + Supabase)
  const view = useLastView() as View;
  const updateAvailable = useUpdateAvailable();
  const accountEmail = getCurrentUser()?.email ?? '';
  const setViewPersisted = (next: View) => {
    store.saveView(next);
  };
  const [anchor, setAnchor] = useState(new Date());
  const [modal, setModal] = useState<{ initial?: Partial<Task>; editingId?: string; selectedDate?: string } | null>(null);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCompleted, setShowCompleted] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('calendar.show_completed.v1');
      return saved ? JSON.parse(saved) : false;
    } catch {
      return false;
    }
  });

  const toggleShowCompleted = () => {
    setShowCompleted((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('calendar.show_completed.v1', JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

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

  const syncStatus = useSyncStatus();
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await syncNow();
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
      case 'wheel': return 'КРУГ ГОДА';
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

  const isTodayActive = (() => {
    const today = new Date();
    switch (view) {
      case 'day': return isSameDay(anchor, today);
      case 'week': return isSameWeek(anchor, today, { weekStartsOn: 1 });
      case 'month': return isSameMonth(anchor, today);
      case 'year': return anchor.getFullYear() === today.getFullYear();
      default: return true;
    }
  })();

  const handleTodayClick = () => {
    setAnchor(new Date());
    if (view === 'day') {
      // already in day view, anchor snaps to today
    } else if (view === 'month' || view === 'year') {
      // in month/year view, snap to current month/year
    } else {
      // in week view or others
      const contentEl = document.querySelector('.content') as HTMLElement | null;
      const todayCell = document.querySelector('.cell-header.today') as HTMLElement | null;
      if (contentEl && todayCell) {
        const cellEl = todayCell.closest('.cell') as HTMLElement;
        const targetEl = cellEl || todayCell;
        const contentRect = contentEl.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const targetScrollTop = contentEl.scrollTop + (targetRect.top - contentRect.top) - 60;
        contentEl.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
      }
    }
  };

  const goToWeek = () => {
    setViewPersisted('week')
    setAnchor(new Date());
  };

  const openEdit = (t: Task, editingDate?: string) => {
    setModal({ initial: t, editingId: t.id, selectedDate: editingDate });
    setShowSearchModal(false);
  };

  return (
    <div className={`app ${showCompleted ? 'show-completed' : 'hide-completed'}`}>
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
            <button
              className={`mobile-today-title-btn ${isTodayActive ? 'active' : 'idle'}`}
              onClick={handleTodayClick}
            >
              сегодня
            </button>
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
              className={`view-switcher-btn ${view === 'wheel' ? 'active' : ''}`}
              onClick={() => setViewPersisted('wheel')}
              title="Круг года"
              aria-label="Круг года"
            >
              <WheelIcon />
            </button>
          </div>

          <div className="header-controls">
            <button
              className={`nav-btn-arrow nav-btn-toggle-completed ${showCompleted ? 'active' : ''}`}
              onClick={toggleShowCompleted}
              title={showCompleted ? 'Скрыть выполненные задачи' : 'Показать выполненные задачи'}
              aria-label={showCompleted ? 'Скрыть выполненные задачи' : 'Показать выполненные задачи'}
            >
              <CheckSquareIcon active={showCompleted} />
            </button>
            {view === 'dashboard' && (
              <>
                <button className="today-btn desktop-only" onClick={handleTodayClick}>сегодня</button>
                <button className="nav-btn-search" onClick={() => setShowSearchModal(true)} title="Поиск" aria-label="Поиск"><SearchIcon /></button>
              </>
            )}
            {view === 'planned' && (
              <>
                <button className="today-btn desktop-only" onClick={handleTodayClick}>сегодня</button>
                <button className="nav-btn-search" onClick={() => setShowSearchModal(true)} title="Поиск" aria-label="Поиск"><SearchIcon /></button>
              </>
            )}
            {view === 'analytics' && (
              <>
                <button className="nav-btn-search" onClick={() => setShowSearchModal(true)} title="Поиск" aria-label="Поиск"><SearchIcon /></button>
              </>
            )}
            {view !== 'dashboard' && view !== 'planned' && view !== 'analytics' && view !== 'wheel' && (
              <>
                <button className="today-btn desktop-only" onClick={handleTodayClick}>сегодня</button>
                <button className="nav-btn-search" onClick={() => setShowSearchModal(true)} title="Поиск" aria-label="Поиск"><SearchIcon /></button>
                <button className={`nav-btn-arrow nav-btn-refresh ${isRefreshing ? 'refreshing' : ''}`} onClick={handleRefresh} disabled={isRefreshing} title="Обновить" aria-label="Обновить"><RefreshIcon /></button>
                <button className="nav-btn-arrow" onClick={() => shift(-1)} aria-label="Назад"><ChevronIcon dir="left" /></button>
                <button className="nav-btn-arrow" onClick={() => shift(1)} aria-label="Вперёд"><ChevronIcon dir="right" /></button>
              </>
            )}
            {accountEmail && <span className="account-chip" title={`Вы вошли как ${accountEmail}`}>{accountEmail}</span>}
            <button className="nav-btn-arrow" onClick={() => setShowBackupModal(true)} title="Данные: копия и восстановление" aria-label="Данные"><DataIcon /></button>
            <button className="nav-btn-arrow" onClick={() => void signOut()} title="Выйти" aria-label="Выйти"><LogoutIcon /></button>
          </div>
        </div>

        {updateAvailable && (
          <div className="sync-banner update" role="status" aria-live="polite">
            <span className="sync-banner-text">
              доступна новая версия приложения — старые версии не синхронизируются
            </span>
            <button type="button" className="sync-banner-retry" onClick={() => window.location.reload()}>
              Обновить
            </button>
          </div>
        )}

        {(syncStatus.state === 'error' ||
          syncStatus.state === 'offline' ||
          syncStatus.state === 'syncing') && (
          <div className={`sync-banner ${syncStatus.state}`} role="status" aria-live="polite">
            <span className="sync-banner-text">
              {syncStatus.message ||
                (syncStatus.state === 'offline'
                  ? 'нет сети — изменения копятся на устройстве'
                  : syncStatus.state === 'syncing'
                    ? 'синхронизирую…'
                    : 'нет связи с сервером')}
              {syncStatus.lastSuccessAt && (
                <span className="sync-banner-time">
                  {' '}· последняя удачная синхронизация{' '}
                  {new Date(syncStatus.lastSuccessAt).toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
            </span>
            <button
              type="button"
              className="sync-banner-retry"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing}
            >
              Повторить
            </button>
          </div>
        )}

        <div className="content">
          {view === 'dashboard' && <DashboardView onEdit={openEdit} />}
          {view === 'day' && <DayView anchor={anchor} onEdit={openEdit} />}
          {view === 'week' && <WeekView anchor={anchor} onEdit={openEdit} onPickDate={(d) => { setAnchor(d); setViewPersisted('day'); }} /> }
          {view === 'month' && <MonthView key={fmt.iso(anchor)} anchor={anchor} onEdit={openEdit} onPickDate={(d) => { setAnchor(d); setViewPersisted('day'); }} />}
          {view === 'year' && <YearView key={fmt.iso(anchor)} anchor={anchor} onPickDate={(d) => { setAnchor(d); setViewPersisted('week'); }} onZoomIn={() => setViewPersisted('month')} />}
          {view === 'wheel' && <YearWheelView onOpenWeek={(d) => { setAnchor(d); setViewPersisted('week'); }} />}
          {view === 'planned' && <PlannedListView onEdit={openEdit} />}
          {view === 'analytics' && <AnalyticsView />}
        </div>
      </div>

      {/* Mobile-only bottom tab bar: week / dashboard */}
      <nav className="mobile-bottom-nav" aria-label="Основная навигация">
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
          className={`mobile-nav-btn ${view === 'wheel' ? 'active' : ''}`}
          onClick={() => setViewPersisted('wheel')}
          title="Круг года"
          aria-label="Круг года"
        >
          <WheelIcon />
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

      {showBackupModal && <BackupModal onClose={() => setShowBackupModal(false)} />}

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