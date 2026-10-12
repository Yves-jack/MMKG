/** 本机 IndexedDB：复习笔记缓存（无后端） */

const DB_NAME = "teachkg-local";
const DB_VERSION = 1;
const STORE = "kv";

type KvRecord = { key: string; value: unknown; updatedAt: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const row = req.result as KvRecord | undefined;
        resolve((row?.value as T) ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ key, value, updatedAt: Date.now() } satisfies KvRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore quota / private mode */
  }
}

async function idbDel(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

export type StoredLectureNotes = {
  courseId: string;
  lectureId: string;
  notes: unknown;
  updatedAt: number;
};

function notesKey(courseId: string, lectureId: string) {
  return `review-notes:${courseId}:${lectureId}`;
}

export async function loadLectureNotesCache(
  courseId: string,
  lectureId: string
): Promise<StoredLectureNotes | null> {
  return idbGet<StoredLectureNotes>(notesKey(courseId, lectureId));
}

export async function saveLectureNotesCache(
  courseId: string,
  lectureId: string,
  notes: unknown
): Promise<void> {
  await idbSet(notesKey(courseId, lectureId), {
    courseId,
    lectureId,
    notes,
    updatedAt: Date.now(),
  } satisfies StoredLectureNotes);
}

export async function clearLectureNotesCache(
  courseId: string,
  lectureId: string
): Promise<void> {
  await idbDel(notesKey(courseId, lectureId));
}
