import { useMemo } from 'react';
import { format } from 'date-fns';
import { useJournal, store } from '../store';

interface JournalEntry {
  date: string;
  text: string;
}

export function AnalyticsView() {
  const journalData = useJournal();

  const journalEntries: JournalEntry[] = useMemo(() => {
    const entries = Object.entries(journalData)
      .map(([date, text]) => ({ date, text }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return entries;
  }, [journalData]);

  const exportEntries = () => {
    const exportData = journalEntries
      .filter(e => e.text.trim())
      .map(e => ({
        date: e.date,
        text: e.text,
      }));

    const BOM = '\uFEFF';
    const csv = BOM + 'date,text\n' + exportData.map(e =>
      `"${e.date}","${e.text.replace(/"/g, '""')}"`
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `journal-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDeleteEntry = (date: string) => {
    if (window.confirm(`Удалить запись от ${date}?`)) {
      store.deleteJournalEntry(date);
    }
  };

  return (
    <div className="analytics-page">
      <div className="analytics-controls">
        <button onClick={exportEntries} className="btn primary">
          Выгрузить все записи в CSV
        </button>
        <p className="muted" style={{ marginTop: '8px', fontSize: '12px' }}>
          Всего записей: {journalEntries.length}
        </p>
      </div>
      
      {journalEntries.length === 0 ? (
        <p className="muted" style={{ marginTop: '24px' }}>Нет записей в журнале</p>
      ) : (
        <div className="journal-entries-list">
          {journalEntries.map((e, i) => (
            <div key={i} className="journal-entry-item" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <div style={{ flex: 1 }}>
                <strong>{e.date}</strong>
                <p>{e.text.substring(0, 100)}{e.text.length > 100 ? '...' : ''}</p>
              </div>
              <button 
                onClick={() => handleDeleteEntry(e.date)}
                style={{ 
                  background: 'none', 
                  border: 'none', 
                  color: 'var(--muted)', 
                  cursor: 'pointer', 
                  fontSize: '18px',
                  padding: '4px',
                  opacity: 0.7,
                }}
                title="Удалить запись"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="muted" style={{ marginTop: '16px', fontSize: '12px' }}>
        Данные сохраняются в localStorage. CSV выгружается с сегодняшней датой.
      </p>
    </div>
  );
}