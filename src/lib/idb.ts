// A tiny IndexedDB store for the heavy part of the dashboard: photo bytes.
//
// localStorage tops out around 5 MB per origin, and a few moodboard pictures
// (each a downscaled data URL) fill it entirely — then saving a TASK throws
// QuotaExceededError and the app dies on the next render. Pictures therefore
// live here, where the quota is measured in hundreds of megabytes, and
// localStorage keeps only the metadata.
const DB_NAME = 'calendar-board';
const DB_VERSION = 1;
const STORE = 'photos';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function idbPut(key: string, value: string): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function idbGet(key: string): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
  } catch {
    // nothing to do — the picture is gone from the map anyway
  }
}
