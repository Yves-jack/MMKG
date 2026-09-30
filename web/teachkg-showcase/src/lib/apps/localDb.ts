/** 本机 IndexedDB：问答对话与练习进度（无后端） */

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

export type StoredChatMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  pointId?: string;
  pointZh?: string;
  compareId?: string;
  compareZh?: string;
  intent?: string;
  bullets?: string[];
  evidence?: { text: string; start_sec?: number | null }[];
  usedExtra?: boolean;
  extraNote?: string;
};

export type QaThread = {
  courseId: string;
  lectureId: string;
  msgs: StoredChatMsg[];
  updatedAt: number;
};

export type PracticeSession = {
  courseId: string;
  lectureFilter: string;
  focusMode: boolean;
  quiz: unknown[];
  idx: number;
  picked: number | null;
  /** 每题选择的选项下标，便于跳题回看 */
  picks?: Array<number | null>;
  verdicts: Array<"ok" | "wrong" | null>;
  mode: "quiz" | "wrongbook";
  finished: boolean;
  /** 本组练习统计会话 id（实时写入进度） */
  practiceSessionId?: string;
  updatedAt: number;
};

function qaKey(courseId: string, lectureId: string) {
  return `qa:${courseId}:${lectureId}`;
}

function practiceKey(courseId: string) {
  return `practice:${courseId}`;
}

export async function loadQaThread(
  courseId: string,
  lectureId: string
): Promise<QaThread | null> {
  return idbGet<QaThread>(qaKey(courseId, lectureId));
}

export async function saveQaThread(
  courseId: string,
  lectureId: string,
  msgs: StoredChatMsg[]
): Promise<void> {
  if (!msgs.length) {
    await idbDel(qaKey(courseId, lectureId));
    return;
  }
  await idbSet(qaKey(courseId, lectureId), {
    courseId,
    lectureId,
    msgs,
    updatedAt: Date.now(),
  } satisfies QaThread);
}

export async function clearQaThread(courseId: string, lectureId: string): Promise<void> {
  await idbDel(qaKey(courseId, lectureId));
}

export async function loadPracticeSession(
  courseId: string
): Promise<PracticeSession | null> {
  return idbGet<PracticeSession>(practiceKey(courseId));
}

export async function savePracticeSession(session: PracticeSession): Promise<void> {
  await idbSet(practiceKey(session.courseId), {
    ...session,
    updatedAt: Date.now(),
  });
}

export async function clearPracticeSession(courseId: string): Promise<void> {
  await idbDel(practiceKey(courseId));
}

/** 外链推荐反馈：1–5 分量化评分（越高越贴合课内） */
export type RecFeedbackRating = 1 | 2 | 3 | 4 | 5;

export type RecFeedbackEntry = {
  url: string;
  domain: string;
  knowledgePoint: string;
  /** 1–5；缺省时可能仅有旧版 vote */
  rating?: RecFeedbackRating;
  /** @deprecated 旧版二值反馈，读入时会映射到 rating */
  vote?: 1 | -1;
  updatedAt: number;
};

export type RecFeedbackStore = {
  courseId: string;
  entries: RecFeedbackEntry[];
  updatedAt: number;
};

function feedbackKey(courseId: string) {
  return `rec-feedback:${courseId}`;
}

/** 统一成 1–5；无有效评分则 null */
export function normalizedRecRating(
  entry: Pick<RecFeedbackEntry, "rating" | "vote"> | null | undefined
): RecFeedbackRating | null {
  if (!entry) return null;
  const r = Number(entry.rating);
  if (r >= 1 && r <= 5) return Math.round(r) as RecFeedbackRating;
  if (entry.vote === 1) return 5;
  if (entry.vote === -1) return 1;
  return null;
}

function migrateFeedbackStore(store: RecFeedbackStore): RecFeedbackStore {
  return {
    ...store,
    entries: (store.entries || []).map((e) => {
      const rating = normalizedRecRating(e);
      if (!rating) return e;
      if (e.rating === rating) return e;
      return { ...e, rating };
    }),
  };
}

export async function loadRecFeedback(courseId: string): Promise<RecFeedbackStore> {
  const saved = await idbGet<RecFeedbackStore>(feedbackKey(courseId));
  return migrateFeedbackStore(
    saved || {
      courseId,
      entries: [],
      updatedAt: 0,
    }
  );
}

export async function upsertRecFeedback(
  courseId: string,
  entry: Omit<RecFeedbackEntry, "updatedAt" | "rating" | "vote"> & {
    rating: RecFeedbackRating | null;
    updatedAt?: number;
  }
): Promise<RecFeedbackStore> {
  const store = await loadRecFeedback(courseId);
  const idx = store.entries.findIndex(
    (e) => e.url === entry.url && e.knowledgePoint === entry.knowledgePoint
  );
  let entries = [...store.entries];

  // null = 取消评分，从库中移除
  if (entry.rating == null) {
    if (idx >= 0) entries.splice(idx, 1);
  } else {
    const nextEntry: RecFeedbackEntry = {
      url: entry.url,
      domain: entry.domain,
      knowledgePoint: entry.knowledgePoint,
      rating: entry.rating,
      updatedAt: entry.updatedAt || Date.now(),
    };
    if (idx >= 0) entries[idx] = nextEntry;
    else entries.push(nextEntry);
  }

  const next: RecFeedbackStore = {
    courseId,
    entries: entries.slice(-400),
    updatedAt: Date.now(),
  };
  await idbSet(feedbackKey(courseId), next);
  return next;
}

export async function clearRecFeedback(courseId: string): Promise<void> {
  await idbDel(feedbackKey(courseId));
}

/** 外链推荐结果缓存（按课程 + 知识点名） */
export type SavedRecItem = {
  kind: "web" | "video";
  title: string;
  url: string;
  snippet: string;
  content?: string;
  description?: string;
  relevance?: number;
  tags?: string[];
  source: string;
  score: number;
  domain: string;
};

export type SavedRecBundle = {
  courseId: string;
  knowledgePoint: string;
  entityId?: string;
  items: SavedRecItem[];
  providers: string[];
  notice: string | null;
  fetchedAt: number;
};

export type RecResultsIndex = {
  courseId: string;
  /** 已有缓存的知识点中文名 */
  points: string[];
  updatedAt: number;
};

function recResultsKey(courseId: string, knowledgePoint: string) {
  return `rec-results:${courseId}:${encodeURIComponent(knowledgePoint)}`;
}

function recResultsIndexKey(courseId: string) {
  return `rec-results-index:${courseId}`;
}

export async function loadRecResultsIndex(
  courseId: string
): Promise<RecResultsIndex> {
  const saved = await idbGet<RecResultsIndex>(recResultsIndexKey(courseId));
  return (
    saved || {
      courseId,
      points: [],
      updatedAt: 0,
    }
  );
}

export async function loadRecResults(
  courseId: string,
  knowledgePoint: string
): Promise<SavedRecBundle | null> {
  const kp = String(knowledgePoint || "").trim();
  if (!kp) return null;
  return idbGet<SavedRecBundle>(recResultsKey(courseId, kp));
}

export async function saveRecResults(
  courseId: string,
  bundle: Omit<SavedRecBundle, "courseId" | "fetchedAt"> & {
    fetchedAt?: number;
  }
): Promise<SavedRecBundle> {
  const knowledgePoint = String(bundle.knowledgePoint || "").trim();
  const next: SavedRecBundle = {
    courseId,
    knowledgePoint,
    entityId: bundle.entityId,
    items: (bundle.items || []).slice(0, 48).map((it) => ({
      ...it,
      snippet: String(it.snippet || "").slice(0, 400),
      content: String(it.content || "").slice(0, 800),
      description: String(it.description || "").slice(0, 500),
      tags: Array.isArray(it.tags) ? it.tags.slice(0, 8) : [],
    })),
    providers: bundle.providers || [],
    notice: bundle.notice ?? null,
    fetchedAt: bundle.fetchedAt || Date.now(),
  };
  await idbSet(recResultsKey(courseId, knowledgePoint), next);

  const index = await loadRecResultsIndex(courseId);
  const points = [
    knowledgePoint,
    ...index.points.filter((p) => p !== knowledgePoint),
  ].slice(0, 120);
  await idbSet(recResultsIndexKey(courseId), {
    courseId,
    points,
    updatedAt: Date.now(),
  } satisfies RecResultsIndex);

  return next;
}

/** 练习题质量反馈：+1 不错 / -1 有问题 */
export type QuizQualityVote = 1 | -1;

export type QuizQualityEntry = {
  quizId: string;
  lectureId: string;
  entityId: string;
  entityZh?: string;
  prompt: string;
  difficulty?: string;
  polished?: boolean;
  vote: QuizQualityVote;
  /** 负反馈原因标签 */
  reasons?: string[];
  updatedAt: number;
};

export type QuizQualityStore = {
  courseId: string;
  entries: QuizQualityEntry[];
  updatedAt: number;
};

function quizQualityKey(courseId: string) {
  return `quiz-quality:${courseId}`;
}

export async function loadQuizQuality(
  courseId: string
): Promise<QuizQualityStore> {
  const saved = await idbGet<QuizQualityStore>(quizQualityKey(courseId));
  return (
    saved || {
      courseId,
      entries: [],
      updatedAt: 0,
    }
  );
}

export async function upsertQuizQuality(
  courseId: string,
  entry: Omit<QuizQualityEntry, "updatedAt"> & { updatedAt?: number }
): Promise<QuizQualityStore> {
  const store = await loadQuizQuality(courseId);
  const nextEntry: QuizQualityEntry = {
    ...entry,
    reasons: entry.vote === 1 ? [] : entry.reasons || [],
    updatedAt: entry.updatedAt || Date.now(),
  };
  const idx = store.entries.findIndex((e) => e.quizId === nextEntry.quizId);
  const entries = [...store.entries];
  if (idx >= 0) entries[idx] = nextEntry;
  else entries.push(nextEntry);
  const next: QuizQualityStore = {
    courseId,
    entries: entries.slice(-500),
    updatedAt: Date.now(),
  };
  await idbSet(quizQualityKey(courseId), next);
  return next;
}

export async function clearQuizQuality(courseId: string): Promise<void> {
  await idbDel(quizQualityKey(courseId));
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

/** 收藏本条目：用户主动收藏或写笔记后保留（答错不会自动入库） */
export type WrongbookEntry = {
  id: string;
  /** 题目快照 */
  quiz: {
    id: string;
    lectureId: string;
    type: "relation" | "definition";
    prompt: string;
    options: string[];
    answerIndex: number;
    correctAnswer?: string;
    explain: string;
    explainDetail?: string;
    difficulty?: "easy" | "medium" | "hard";
    entityId: string;
    entityZh: string;
    evidenceStartSec?: number | null;
    polished?: boolean;
  };
  note: string;
  /** 用户主动收藏 */
  starred: boolean;
  /** @deprecated 旧版答错自动入库标记；加载时会清理仅因此入库的条目 */
  fromWrong?: boolean;
  wrongCount?: number;
  lastWrongAt?: number | null;
  createdAt: number;
  updatedAt: number;
};

export type WrongbookStore = {
  courseId: string;
  entries: WrongbookEntry[];
  updatedAt: number;
};

function wrongbookKey(courseId: string) {
  return `wrongbook:${courseId}`;
}

function isFavoriteEntry(e: WrongbookEntry) {
  return Boolean(e.starred) || Boolean((e.note || "").trim());
}

export async function loadWrongbook(courseId: string): Promise<WrongbookStore> {
  const saved = await idbGet<WrongbookStore>(wrongbookKey(courseId));
  if (!saved) {
    return {
      courseId,
      entries: [],
      updatedAt: 0,
    };
  }
  const entries = (saved.entries || []).filter(isFavoriteEntry);
  // 清理旧版「仅因答错入库」的条目
  if (entries.length !== (saved.entries || []).length) {
    return saveWrongbook({
      courseId,
      entries: entries.slice(0, 200),
      updatedAt: Date.now(),
    });
  }
  return { ...saved, entries };
}

async function saveWrongbook(store: WrongbookStore): Promise<WrongbookStore> {
  const next = { ...store, updatedAt: Date.now() };
  await idbSet(wrongbookKey(store.courseId), next);
  return next;
}

function snapshotQuiz(quiz: WrongbookEntry["quiz"]): WrongbookEntry["quiz"] {
  return {
    id: quiz.id,
    lectureId: quiz.lectureId,
    type: quiz.type,
    prompt: quiz.prompt,
    options: [...(quiz.options || [])],
    answerIndex: quiz.answerIndex,
    correctAnswer: quiz.correctAnswer,
    explain: quiz.explain,
    explainDetail: quiz.explainDetail,
    difficulty: quiz.difficulty,
    entityId: quiz.entityId,
    entityZh: quiz.entityZh,
    evidenceStartSec: quiz.evidenceStartSec,
    polished: quiz.polished,
  };
}

/** 星标 = 收藏本收录：点亮加入，再点移出 */
export async function toggleWrongbookStar(
  courseId: string,
  quiz: WrongbookEntry["quiz"]
): Promise<WrongbookStore> {
  const store = await loadWrongbook(courseId);
  const now = Date.now();
  const idx = store.entries.findIndex((e) => e.id === quiz.id);
  const entries = [...store.entries];
  if (idx >= 0) {
    entries.splice(idx, 1);
  } else {
    entries.unshift({
      id: quiz.id,
      quiz: snapshotQuiz(quiz),
      note: "",
      starred: true,
      fromWrong: false,
      wrongCount: 0,
      lastWrongAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return saveWrongbook({
    courseId,
    entries: entries.slice(0, 200),
    updatedAt: now,
  });
}

export async function setWrongbookNote(
  courseId: string,
  id: string,
  note: string
): Promise<WrongbookStore> {
  const store = await loadWrongbook(courseId);
  const now = Date.now();
  const idx = store.entries.findIndex((e) => e.id === id);
  if (idx < 0) return store;
  const entries = [...store.entries];
  const hasNote = Boolean(note.trim());
  // 清空笔记 → 移出收藏本
  if (!hasNote) {
    entries.splice(idx, 1);
  } else {
    entries[idx] = {
      ...entries[idx],
      note,
      starred: true,
      updatedAt: now,
    };
  }
  return saveWrongbook({ courseId, entries, updatedAt: now });
}

/** 写入笔记：有内容自动收藏；清空则移出收藏本 */
export async function upsertWrongbookNote(
  courseId: string,
  quiz: WrongbookEntry["quiz"],
  note: string
): Promise<WrongbookStore> {
  const store = await loadWrongbook(courseId);
  const now = Date.now();
  const hasNote = Boolean(String(note || "").trim());
  const idx = store.entries.findIndex((e) => e.id === quiz.id);
  const entries = [...store.entries];
  if (idx >= 0) {
    if (!hasNote) {
      entries.splice(idx, 1);
    } else {
      entries[idx] = {
        ...entries[idx],
        quiz: snapshotQuiz(quiz),
        note,
        starred: true,
        updatedAt: now,
      };
    }
  } else if (hasNote) {
    entries.unshift({
      id: quiz.id,
      quiz: snapshotQuiz(quiz),
      note,
      starred: true,
      fromWrong: false,
      wrongCount: 0,
      lastWrongAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return saveWrongbook({
    courseId,
    entries: entries.slice(0, 200),
    updatedAt: now,
  });
}

export async function removeWrongbookEntry(
  courseId: string,
  id: string
): Promise<WrongbookStore> {
  const store = await loadWrongbook(courseId);
  const entries = store.entries.filter((e) => e.id !== id);
  return saveWrongbook({
    courseId,
    entries,
    updatedAt: Date.now(),
  });
}

/** 动画观看进度 */
export type AnimProgressStore = {
  courseId: string;
  /** specId → 看完时间戳 */
  watched: Record<string, number>;
  updatedAt: number;
};

function animProgressKey(courseId: string) {
  return `anim-progress:${courseId}`;
}

export async function loadAnimProgress(
  courseId: string
): Promise<AnimProgressStore> {
  const saved = await idbGet<AnimProgressStore>(animProgressKey(courseId));
  return (
    saved || {
      courseId,
      watched: {},
      updatedAt: 0,
    }
  );
}

export async function markAnimWatched(
  courseId: string,
  specId: string
): Promise<AnimProgressStore> {
  const store = await loadAnimProgress(courseId);
  const next: AnimProgressStore = {
    courseId,
    watched: { ...store.watched, [specId]: Date.now() },
    updatedAt: Date.now(),
  };
  await idbSet(animProgressKey(courseId), next);
  return next;
}

