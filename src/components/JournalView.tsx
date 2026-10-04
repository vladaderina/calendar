import { useState, useEffect, useRef } from 'react';
import { fmt } from '../utils/date';

const JOURNAL_KEY = 'calendar.journal.v1';

function loadJournal(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveJournal(data: Record<string, string>) {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(data));
}

export function getJournalEntry(date: Date): string | null {
  const journal = loadJournal();
  return journal[fmt.iso(date)] || null;
}

export function JournalView({ anchor, onBack }: { anchor: Date; onBack: () => void }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load journal entry for this day
  useEffect(() => {
    const entry = getJournalEntry(anchor);
    setText(entry || '');
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [anchor]);

  const save = () => {
    const journal = loadJournal();
    const iso = fmt.iso(anchor);
    if (text.trim()) {
      journal[iso] = text.trim();
    } else {
      delete journal[iso];
    }
    saveJournal(journal);
  };

  // Auto-save on unmount
  useEffect(() => {
    return () => {
      save();
    };
  }, [text]);

  return (
    <div className="journal-page">
      <div className="journal-header">
        <button className="journal-back-btn" onClick={onBack} title="Назад">
          ‹
        </button>
        <h1 className="journal-title">{fmt.full(anchor)}</h1>
      </div>
      <div className="journal-content">
        <textarea
          ref={inputRef}
          className="journal-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Запишите свои мысли, чувства, заметки..."
        />
      </div>
      <div className="journal-footer">
        <button className="btn primary" onClick={save}>Сохранить</button>
      </div>
    </div>
  );
}