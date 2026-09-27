interface Props {
  onChoice: (mode: 'single' | 'following' | 'all') => void;
  onClose: () => void;
}

// Shown when deleting a recurring task. Mirrors the classic calendar prompt.
export function RecurringDeleteModal({ onChoice, onClose }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal recurring-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Удалить повторяющуюся задачу?</h2>
        <p className="recurring-text">
          Эта задача связана с другими повторяющимися записями. Редактирование
          или удаление одной из них повлияет на другие.
        </p>
        <div className="recurring-options">
          <button className="btn recurring-option" onClick={() => onChoice('single')}>
            Только эта задача
          </button>
          <button className="btn recurring-option" onClick={() => onChoice('following')}>
            Эта и все последующие задачи
          </button>
          <button className="btn recurring-option" onClick={() => onChoice('all')}>
            Все связанные задачи
          </button>
        </div>
        <div className="modal-actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>отмена</button>
        </div>
      </div>
    </div>
  );
}
