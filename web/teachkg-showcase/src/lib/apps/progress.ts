/** 学习进度本地记忆（无后端） */

const PREFIX = "teachkg-progress:";

export type PracticeDiffKey = "easy" | "medium" | "hard";

export type PracticeDiffStat = {
  answered: number;
  correct: number;
};

export type PracticeSessionLog = {
  /** 同一组练习的稳定 id，便于实时覆盖更新 */
  id?: string;
  /** 最近一次写入时刻 */
  at: number;
  /** 本组开始时刻 */
  startedAt?: number;
  /** 本地日历日 YYYY-MM-DD（以开始日为准） */
  date: string;
  answered: number;
  /** 本组总题数（用于未完成时按进度计小数组数） */
  total?: number;
  correct: number;
  accuracy: number;
  /** 各难度作答情况 */
  byDifficulty?: Record<PracticeDiffKey, PracticeDiffStat>;
  /** 是否已点到结果页 */
  finished?: boolean;
};

export type PracticeStats = {
  bestAccuracy: number;
  lastAccuracy: number;
  sessions: number;
  wrongIds: string[];
  /** 每次完成一组的流水，用于日/周/月/年统计 */
  logs?: PracticeSessionLog[];
  updatedAt: number;
};

export type ContinueState = {
  app: string;
  lectureId?: string;
  label: string;
  href: string;
  at: number;
};

export type PracticeRange = "day" | "week" | "month" | "year";

export type PracticeBucket = {
  key: string;
  label: string;
  sessions: number;
  answered: number;
  correct: number;
  accuracy: number;
};

export type PracticeDiffSummary = {
  key: PracticeDiffKey;
  label: string;
  answered: number;
  correct: number;
  accuracy: number;
  share: number;
};

export type PracticeRangeSummary = {
  range: PracticeRange;
  title: string;
  sessions: number;
  answered: number;
  correct: number;
  accuracy: number;
  activeDays: number;
  buckets: PracticeBucket[];
  byDifficulty: PracticeDiffSummary[];
};

function emptyDiff(): Record<PracticeDiffKey, PracticeDiffStat> {
  return {
    easy: { answered: 0, correct: 0 },
    medium: { answered: 0, correct: 0 },
    hard: { answered: 0, correct: 0 },
  };
}

function mergeDiff(
  a: Record<PracticeDiffKey, PracticeDiffStat> | undefined,
  b: Record<PracticeDiffKey, PracticeDiffStat> | undefined
) {
  const out = emptyDiff();
  for (const k of ["easy", "medium", "hard"] as PracticeDiffKey[]) {
    out[k].answered = (a?.[k]?.answered || 0) + (b?.[k]?.answered || 0);
    out[k].correct = (a?.[k]?.correct || 0) + (b?.[k]?.correct || 0);
  }
  return out;
}

function normalizeDiff(
  raw?: Partial<Record<PracticeDiffKey, PracticeDiffStat>> | null
): Record<PracticeDiffKey, PracticeDiffStat> {
  const out = emptyDiff();
  if (!raw) return out;
  for (const k of ["easy", "medium", "hard"] as PracticeDiffKey[]) {
    out[k].answered = Math.max(0, Number(raw[k]?.answered) || 0);
    out[k].correct = Math.max(0, Number(raw[k]?.correct) || 0);
  }
  return out;
}

function toDiffSummary(
  by: Record<PracticeDiffKey, PracticeDiffStat>
): PracticeDiffSummary[] {
  const labels: Record<PracticeDiffKey, string> = {
    easy: "简单",
    medium: "中等",
    hard: "较难",
  };
  const total = ["easy", "medium", "hard"].reduce(
    (s, k) => s + (by[k as PracticeDiffKey]?.answered || 0),
    0
  );
  return (["easy", "medium", "hard"] as PracticeDiffKey[]).map((key) => {
    const answered = by[key]?.answered || 0;
    const correct = by[key]?.correct || 0;
    return {
      key,
      label: labels[key],
      answered,
      correct,
      accuracy: answered ? Math.round((correct / answered) * 100) : 0,
      share: total ? Math.round((answered / total) * 100) : 0,
    };
  });
}

function key(courseId: string, name: string) {
  return `${PREFIX}${courseId}:${name}`;
}

export function formatLocalDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function startOfWeek(d: Date) {
  const x = startOfDay(d);
  const wd = x.getDay(); // 0 Sun
  const offset = wd === 0 ? -6 : 1 - wd; // Monday start
  return addDays(x, offset);
}

function weekKey(d: Date) {
  const s = startOfWeek(d);
  return formatLocalDate(s);
}

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function yearKey(d: Date) {
  return String(d.getFullYear());
}

function parseDateKey(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function loadPracticeStats(courseId: string): PracticeStats {
  try {
    const raw = localStorage.getItem(key(courseId, "practice"));
    if (!raw) {
      return {
        bestAccuracy: 0,
        lastAccuracy: 0,
        sessions: 0,
        wrongIds: [],
        logs: [],
        updatedAt: 0,
      };
    }
    const parsed = JSON.parse(raw) as PracticeStats;
    return {
      bestAccuracy: parsed.bestAccuracy || 0,
      lastAccuracy: parsed.lastAccuracy || 0,
      sessions: parsed.sessions || 0,
      wrongIds: parsed.wrongIds || [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
      updatedAt: parsed.updatedAt || 0,
    };
  } catch {
    return {
      bestAccuracy: 0,
      lastAccuracy: 0,
      sessions: 0,
      wrongIds: [],
      logs: [],
      updatedAt: 0,
    };
  }
}

export function savePracticeStats(courseId: string, patch: Partial<PracticeStats>) {
  const prev = loadPracticeStats(courseId);
  const next: PracticeStats = {
    ...prev,
    ...patch,
    logs: patch.logs ?? prev.logs ?? [],
    updatedAt: Date.now(),
  };
  if (patch.lastAccuracy != null) {
    next.bestAccuracy = Math.max(prev.bestAccuracy, patch.lastAccuracy);
  }
  localStorage.setItem(key(courseId, "practice"), JSON.stringify(next));
  return next;
}

/** 一组练习对「练习组数」的贡献：打完计 1，进行中按进度计小数 */
export function sessionWeight(log: PracticeSessionLog): number {
  const answered = Math.max(0, log.answered || 0);
  if (answered <= 0) return 0;
  if (log.finished) return 1;
  const total = Math.max(0, log.total || 0);
  if (total > 0) return Math.min(1, answered / total);
  // 旧记录无 total：未完成不虚增整组
  return 0;
}

/** 展示用：整数不带小数，否则一位小数 */
export function formatSessionCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 按答题进度实时写入/覆盖同一组练习记录（中途退出也保留） */
export function upsertPracticeProgress(
  courseId: string,
  input: {
    sessionId: string;
    answered: number;
    correct: number;
    accuracy: number;
    total?: number;
    wrongIds?: string[];
    byDifficulty?: Partial<Record<PracticeDiffKey, PracticeDiffStat>>;
    finished?: boolean;
  }
) {
  const answered = Math.max(0, input.answered);
  if (!input.sessionId || answered <= 0) {
    return loadPracticeStats(courseId);
  }
  const prev = loadPracticeStats(courseId);
  const now = Date.now();
  const logs = [...(prev.logs || [])];
  const idx = logs.findIndex((l) => l.id && l.id === input.sessionId);
  const prevLog = idx >= 0 ? logs[idx] : null;
  const total =
    Math.max(0, input.total || 0) ||
    Math.max(0, prevLog?.total || 0) ||
    undefined;
  const log: PracticeSessionLog = {
    id: input.sessionId,
    at: now,
    startedAt: prevLog?.startedAt || prevLog?.at || now,
    date: prevLog?.date || formatLocalDate(new Date()),
    answered,
    total,
    correct: Math.max(0, input.correct),
    accuracy: Math.max(0, Math.min(100, input.accuracy)),
    byDifficulty: normalizeDiff(input.byDifficulty),
    finished: Boolean(input.finished || prevLog?.finished),
  };
  if (idx >= 0) logs[idx] = { ...prevLog, ...log };
  else logs.unshift(log);

  const sessionCount = Math.round(
    logs.reduce((s, l) => s + sessionWeight(l), 0) * 10
  ) / 10;
  const mergedWrong = Array.from(
    new Set([...(prev.wrongIds || []), ...(input.wrongIds || [])])
  ).slice(0, 200);

  return savePracticeStats(courseId, {
    lastAccuracy: log.accuracy,
    sessions: Math.max(prev.sessions || 0, Math.ceil(sessionCount)),
    wrongIds: input.wrongIds ? mergedWrong : prev.wrongIds,
    logs: logs.slice(0, 500),
  });
}

/** @deprecated 使用 upsertPracticeProgress；保留兼容旧调用 */
export function recordPracticeSession(
  courseId: string,
  input: {
    sessionId?: string;
    answered: number;
    correct: number;
    accuracy: number;
    wrongIds?: string[];
    byDifficulty?: Partial<Record<PracticeDiffKey, PracticeDiffStat>>;
    finished?: boolean;
  }
) {
  return upsertPracticeProgress(courseId, {
    ...input,
    sessionId:
      input.sessionId ||
      `legacy-${formatLocalDate()}-${input.answered}-${input.correct}`,
    finished: input.finished ?? true,
  });
}

function bucketLabel(range: PracticeRange, keyStr: string): string {
  if (range === "day") {
    const d = parseDateKey(keyStr);
    const today = formatLocalDate();
    const yday = formatLocalDate(addDays(new Date(), -1));
    if (keyStr === today) return "今天";
    if (keyStr === yday) return "昨天";
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  if (range === "week") {
    const d = parseDateKey(keyStr);
    const end = addDays(d, 6);
    return `${d.getMonth() + 1}/${d.getDate()}–${end.getMonth() + 1}/${end.getDate()}`;
  }
  if (range === "month") {
    const [y, m] = keyStr.split("-");
    return `${y}年${Number(m)}月`;
  }
  return `${keyStr}年`;
}

function inCurrentPeriod(dateStr: string, range: PracticeRange, now = new Date()) {
  const d = parseDateKey(dateStr);
  if (range === "day") return dateStr === formatLocalDate(now);
  if (range === "week") return weekKey(d) === weekKey(now);
  if (range === "month") return monthKey(d) === monthKey(now);
  return yearKey(d) === yearKey(now);
}

function periodTitle(range: PracticeRange, now = new Date()) {
  if (range === "day") return `${formatLocalDate(now)} · 今日`;
  if (range === "week") {
    const s = startOfWeek(now);
    const e = addDays(s, 6);
    return `${s.getMonth() + 1}/${s.getDate()}–${e.getMonth() + 1}/${e.getDate()} · 本周`;
  }
  if (range === "month") return `${now.getFullYear()}年${now.getMonth() + 1}月 · 本月`;
  return `${now.getFullYear()}年 · 本年`;
}

function keyOf(dateStr: string, range: PracticeRange) {
  const d = parseDateKey(dateStr);
  if (range === "day") return dateStr;
  if (range === "week") return weekKey(d);
  if (range === "month") return monthKey(d);
  return yearKey(d);
}

/** 汇总某时间粒度：当前周期总数 + 近期分桶列表 */
export function summarizePracticeRange(
  stats: PracticeStats,
  range: PracticeRange,
  now = new Date()
): PracticeRangeSummary {
  const logs = stats.logs || [];
  const periodLogs = logs.filter((l) => inCurrentPeriod(l.date, range, now));
  const sessions =
    Math.round(periodLogs.reduce((s, l) => s + sessionWeight(l), 0) * 10) / 10;
  const answered = periodLogs.reduce((s, l) => s + (l.answered || 0), 0);
  const correct = periodLogs.reduce((s, l) => s + (l.correct || 0), 0);
  const accuracy = answered ? Math.round((correct / answered) * 100) : 0;
  const activeDays = new Set(periodLogs.map((l) => l.date)).size;
  const byDifficulty = toDiffSummary(
    periodLogs.reduce(
      (acc, l) => mergeDiff(acc, normalizeDiff(l.byDifficulty)),
      emptyDiff()
    )
  );

  const map = new Map<string, PracticeBucket>();
  const bump = (k: string, l: PracticeSessionLog) => {
    const prev = map.get(k) || {
      key: k,
      label: bucketLabel(range, k),
      sessions: 0,
      answered: 0,
      correct: 0,
      accuracy: 0,
    };
    prev.sessions =
      Math.round((prev.sessions + sessionWeight(l)) * 10) / 10;
    prev.answered += l.answered || 0;
    prev.correct += l.correct || 0;
    prev.accuracy = prev.answered
      ? Math.round((prev.correct / prev.answered) * 100)
      : 0;
    map.set(k, prev);
  };

  // 预填空桶，保证近期轴连续
  if (range === "day") {
    for (let i = 13; i >= 0; i--) {
      const k = formatLocalDate(addDays(now, -i));
      map.set(k, {
        key: k,
        label: bucketLabel("day", k),
        sessions: 0,
        answered: 0,
        correct: 0,
        accuracy: 0,
      });
    }
  } else if (range === "week") {
    const cur = startOfWeek(now);
    for (let i = 7; i >= 0; i--) {
      const k = formatLocalDate(addDays(cur, -i * 7));
      map.set(k, {
        key: k,
        label: bucketLabel("week", k),
        sessions: 0,
        answered: 0,
        correct: 0,
        accuracy: 0,
      });
    }
  } else if (range === "month") {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = monthKey(d);
      map.set(k, {
        key: k,
        label: bucketLabel("month", k),
        sessions: 0,
        answered: 0,
        correct: 0,
        accuracy: 0,
      });
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const k = String(now.getFullYear() - i);
      map.set(k, {
        key: k,
        label: bucketLabel("year", k),
        sessions: 0,
        answered: 0,
        correct: 0,
        accuracy: 0,
      });
    }
  }

  for (const l of logs) {
    const k = keyOf(l.date, range);
    if (!map.has(k) && range !== "year") continue;
    if (!map.has(k)) {
      map.set(k, {
        key: k,
        label: bucketLabel(range, k),
        sessions: 0,
        answered: 0,
        correct: 0,
        accuracy: 0,
      });
    }
    bump(k, l);
  }

  const buckets = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));

  return {
    range,
    title: periodTitle(range, now),
    sessions,
    answered,
    correct,
    accuracy,
    activeDays,
    buckets,
    byDifficulty,
  };
}

export function loadContinue(courseId: string): ContinueState | null {
  try {
    const raw = localStorage.getItem(key(courseId, "continue"));
    return raw ? (JSON.parse(raw) as ContinueState) : null;
  } catch {
    return null;
  }
}

export function saveContinue(courseId: string, state: Omit<ContinueState, "at">) {
  const next: ContinueState = { ...state, at: Date.now() };
  localStorage.setItem(key(courseId, "continue"), JSON.stringify(next));
  return next;
}
