// One-time recovery of the notes that were wiped by the "strip the task mirror"
// migration (and by documents never being uploaded — the payload used to drop
// `md`, so the note text existed only in one browser).
//
// The text below was recovered from the browser's Local Storage LevelDB files on
// the machine the notes were written on. It is restored verbatim, under its
// original document id, and only when the note is missing or empty — running it
// again (or on a device that never lost anything) does nothing.
import { store } from '../store';
import { addBoardDoc, getBoardDoc, saveBoardDoc } from './board';
import { nodeKeyParts } from './doc';
import { nodeAt } from './tree';

const FLAG_KEY = 'calendar.restore.notes.v1';

interface LostNote {
  id: string;
  nodeKey: string;
  md: string;
}

const LOST: LostNote[] = [
  {
    id: '42fe43f4-e2da-4f12-8cd6-18281639729e',
    nodeKey: 'Работа\u001Fстраница',
    md: `- [ ] ОТПУСК 3 МОЙ ^2027-08-16
- [ ] Починить молекулу образы
- [x] Сделать AGENTS.md на все проекты
- [x] Доменные имена понять как называть
- [ ] ОТПУСК 2 МОЙ ^2027-09-17
- [x] Удалить репозитории с реестром
- [ ] Настроить SSH клиента
- [ ] BOOTSTRAP
- [ ] ОТПУСК 1 МОЙ ^2027-06-15
- [ ] Роль люксов: тест
- [ ] AGENTS.md раскидать
- [ ] Доделать реестр с переименованием
- [ ] Создать плейбуки для ролей
`,
  },
  {
    id: '55ed8cbe-1bf5-4c39-988c-6852c406a91a',
    nodeKey: 'Тело\u001Fстраница',
    md: `- [ ] Пробежать 21 км марафон
- [ ] Чистка зубов
- [ ] Делать стойки
- [ ] Сделать ринопластику
- [ ] Уметь делать стойку на руках
- [ ] Сесть на шпагат
- [ ] Научится кататься на лыжах горных
- [ ] Похудеть до 62-65 кг - быть в весе до конца жизни
- [ ] Сделать грудь
- [ ] Удалить второй зуб мудрости
- [ ] Танцевать научится красиво и платичное
- [ ] Научится кататься на серфе
- [ ] Уметь делать акробатические трюки
- [ ] Танцевать с партнером
`,
  },
  {
    id: '793d3531-7898-44f9-a2e0-2616df89b1b1',
    nodeKey: 'Развлечения\u001Fстраница\u001FДела',
    md: `- [ ] Построить шалаш
- [ ] Лагерь для взрослых
- [ ] Собирать грибы и ягоды в лесу
- [ ] На сапах на 9 мая
- [ ] Изумрудный карьер - пикник
- [ ] Совершить прыжок с парашутом
- [ ] Отдохнуть в санатории
- [ ] Отдыхать в термах
- [ ] Полет на самолете или прыжок с парашютом
- [ ] Скалолазание
- [ ] Яхта
- [ ] Санаторий Волна
- [ ] Снять видеоблог зимний. Один день из жизни (+ лыжи)
`,
  },
  {
    id: '53760546-16e1-4fda-b4b5-ffdd30658776',
    nodeKey: 'Автоматизация\u001FМеню\u001Fстраница',
    md: `- [ ] Привести в порядок все ингредиенты
- [x] Выложить фото с выпечкой
- [x] Выложить фото напитков
- [x] Выложить фото с фастфудом
- [x] Выложить праздничные фото
- [x] Выложить фото с супами и салатами
- [x] Выложить фото магазинные
- [ ] Привести в порядок все калории
- [ ] Привести в порядок все рецепты
- [ ] Допы удалить
- [x] Выложить фото с сладким
- [ ] Добавить возможность через бота добавлять новые карточки с рецептами и давать ему задания дополнить рецепт, улучшить, исправить, пересчитать калории
`,
  },
  {
    id: '585ad796-dafd-4d30-b465-96fc54037580',
    nodeKey: 'Автоматизация\u001FКалендарь\u001Fстраница',
    md: `- [ ] Сделать Дашборд оформленным
- [ ] Таблица с подарками
`,
  },
  {
    id: 'c4c80d63-d3ca-4a52-b2e4-37f737eec540',
    nodeKey: 'Автоматизация\u001Fстраница',
    md: `- [x] Все на один порт
- [ ] Выложить на гитхаб
`,
  },
];

/** Put the lost notes back: page nodes first (folders are created as needed),
 *  then the document text. Runs on EVERY mount and only writes to a note that
 *  is empty, so a stale browser tab that still holds the wiped copy cannot
 *  destroy the recovered text again — the next load heals it. */
export function restoreLostNotes(): void {
  if (typeof localStorage === 'undefined') return;
  let touched = 0;
  for (const note of LOST) {
    const { sphere, path } = nodeKeyParts(note.nodeKey);
    if (!sphere || !path.length) continue;
    if (!store.getSpheres().includes(sphere)) continue;

    // the page's parent folders must exist before the page can be added
    for (let i = 0; i < path.length - 1; i += 1) {
      store.addTopic(sphere, path[i], path.slice(0, i));
    }
    const existing = nodeAt(store.getTree()[sphere]?.children ?? [], path);
    if (!existing) {
      store.addNote(sphere, path.slice(0, -1), path[path.length - 1], note.id);
    } else if (existing.kind === 'note' && !existing.noteId) {
      store.setNoteId(sphere, path, note.id);
    }

    const doc = getBoardDoc(note.id);
    if (!doc) {
      addBoardDoc(path[path.length - 1], note.nodeKey, note.md, note.id);
    } else if (!(doc.md ?? '').trim()) {
      saveBoardDoc(note.id, { md: note.md });
    }
    touched += 1;
  }
  if (touched) {
    try {
      localStorage.setItem(FLAG_KEY, new Date().toISOString());
    } catch {
      // quota — nothing depends on this marker, it is only a breadcrumb
    }
  }
}
