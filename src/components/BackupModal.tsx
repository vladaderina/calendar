import { useState } from 'react';
import {
  buildBackupJson,
  restoreFromBackupJson,
  pushLocalToServer,
  pullFromServer,
  useTasks,
} from '../store';

type Props = { onClose: () => void };

// Перенос данных между устройствами, которые разошлись (например, телефон
// двигал задачи без связи, и правки не дошли до сервера).
export default function BackupModal({ onClose }: Props) {
  const tasks = useTasks();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [busy, setBusy] = useState<'push' | 'pull' | null>(null);

  const handlePush = async () => {
    setBusy('push');
    setStatus(null);
    try {
      const r = await pushLocalToServer();
      setStatus({ ok: r.ok, message: r.message });
    } finally {
      setBusy(null);
    }
  };

  const handlePull = async () => {
    setBusy('pull');
    setStatus(null);
    try {
      const r = await pullFromServer();
      setStatus({ ok: r.ok, message: r.message });
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = () => {
    const json = buildBackupJson();
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calendar-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus({ ok: true, message: `Копия сохранена (${tasks.length} задач)` });
  };

  const handleCopy = async () => {
    const json = buildBackupJson();
    try {
      await navigator.clipboard.writeText(json);
      setStatus({ ok: true, message: 'Копия скопирована в буфер обмена — вставьте её в заметку или в чат' });
    } catch {
      setText(json);
      setShowPaste(true);
      setStatus({ ok: false, message: 'Не удалось скопировать автоматически — текст показан ниже, скопируйте вручную' });
    }
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = restoreFromBackupJson(String(reader.result ?? ''));
      setStatus({ ok: result.ok, message: result.message });
    };
    reader.onerror = () => setStatus({ ok: false, message: 'Не удалось прочитать файл' });
    reader.readAsText(file);
  };

  const handleRestoreText = () => {
    const result = restoreFromBackupJson(text);
    setStatus({ ok: result.ok, message: result.message });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal backup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Данные</h2>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <p className="backup-note">
          Копия — обычный файл со всеми задачами текущего устройства. Её можно перенести на другое
          устройство: сохранить здесь, открыть там и нажать «Восстановить».
        </p>

        <div className="backup-actions">
          <button className="btn" onClick={handleDownload}>Сохранить копию</button>
          <button className="btn ghost" onClick={() => void handleCopy()}>Скопировать текст</button>
        </div>

        <hr className="backup-sep" />

        <p className="backup-note">
          Если устройства разошлись: «Отправить на сервер» переносит то, что сейчас на этом
          устройстве, а «Загрузить с сервера» подтягивает данные, которые уже есть в базе. Ни одна
          из кнопок ничего не удаляет.
        </p>

        <div className="backup-actions">
          <button className="btn" onClick={() => void handlePush()} disabled={busy !== null}>
            {busy === 'push' ? 'Отправляю…' : 'Отправить на сервер'}
          </button>
          <button className="btn ghost" onClick={() => void handlePull()} disabled={busy !== null}>
            {busy === 'pull' ? 'Загружаю…' : 'Загрузить с сервера'}
          </button>
        </div>

        <hr className="backup-sep" />

        <p className="backup-note">
          Восстановление <strong>не удаляет</strong> ничего: задачи из копии добавляются, а
          совпадающие по номеру заменяются версией из копии. Так переносятся правки с другого
          устройства.
        </p>

        <label className="backup-file">
          <input
            type="file"
            accept=".json,application/json,text/plain"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <span>Выбрать файл копии</span>
        </label>

        <button className="backup-toggle" onClick={() => setShowPaste((v) => !v)}>
          {showPaste ? 'Скрыть вставку текста' : 'Вставить текст копии вручную'}
        </button>

        {showPaste && (
          <div className="backup-paste">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='Вставьте сюда JSON из копии — начинается с {"format":"calendar-backup"'
              rows={6}
            />
            <button className="btn" onClick={handleRestoreText} disabled={!text.trim()}>
              Восстановить из текста
            </button>
          </div>
        )}

        {status && (
          <div className={`backup-status ${status.ok ? 'ok' : 'err'}`}>{status.message}</div>
        )}
      </div>
    </div>
  );
}
