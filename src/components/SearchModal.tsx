import { useState, useMemo, useRef, useEffect } from 'react';
import type { Task } from '../types';
import { useTasks } from '../store';

interface Props {
  onClose: () => void;
  onEdit: (task: Task) => void;
}

const COLORS = ['', '#0a0a0a', '#e74c3c', '#f39c12', '#f1c40f', '#27ae60', '#3498db', '#9b59b6', '#e91e63'];
const COLOR_LABELS: Record<string, string> = {
  '': 'без цвета',
  '#0a0a0a': 'чёрный',
  '#e74c3c': 'красный',
  '#f39c12': 'оранжевый',
  '#f1c40f': 'жёлтый',
  '#27ae60': 'зелёный',
  '#3498db': 'синий',
  '#9b59b6': 'фиолетовый',
  '#e91e63': 'розовый',
};

export function SearchModal({ onClose, onEdit }: Props) {
  const allTasks = useTasks();
  const [query, setQuery] = useState('');
  const [selectedColor, setSelectedColor] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  // Show results ONLY when the user is actually filtering: text in the box
  // or a color chip pressed. Empty state stays empty.
  const isFiltering = q.length > 0 || selectedColor !== '';

  const results = useMemo(() => {
    if (!isFiltering) return [];
    return allTasks.filter((t) => {
      const matchesSearch = !q || t.title.toLowerCase().includes(q);
      const matchesColor = !selectedColor || t.color === selectedColor;
      return matchesSearch && matchesColor;
    });
  }, [allTasks, q, selectedColor, isFiltering]);

  const handleTaskClick = (task: Task) => {
    onEdit(task);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-modal-header">
          <input
            ref={inputRef}
            type="text"
            className="search-modal-input"
            placeholder="поиск задачи…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
          />
          <button className="search-close" onClick={onClose}>×</button>
        </div>

        <div className="search-modal-filters">
          <div className="color-filter-row">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`color-filter-btn ${selectedColor === c ? 'selected' : ''}`}
                style={{
                  background: c || 'transparent',
                  border: c ? 'none' : '2px dashed var(--line)',
                }}
                onClick={() => setSelectedColor(selectedColor === c ? '' : c)}
                title={COLOR_LABELS[c]}
              />
            ))}
          </div>
        </div>

        {isFiltering && (
          <div className="search-modal-results">
            {results.length === 0 ? (
              <div className="search-empty">задачи не найдены</div>
            ) : (
              results.map((task) => (
                <div
                  key={task.id}
                  className="search-result-item"
                  onClick={() => handleTaskClick(task)}
                >
                  <span className="suggestion-dot" style={{ background: task.color || 'transparent' }} />
                  <div className="search-result-title">{task.title}</div>
                  <div className="search-result-date">
                    {task.startDate
                      ? new Date(task.startDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
                      : ''}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
