import {
  buildLocalLectureNotes,
  fetchLectureNotes,
  isThemeNotes,
  type LectureNotesDoc,
} from "@/lib/apps/reviewNotes";
import {
  loadLectureNotesCache,
  saveLectureNotesCache,
} from "@/lib/apps/localDb";
import type { AppReviewDoc, AppReviewPoint, QuizItem } from "@/lib/apps/data";
import { zhName } from "@/lib/apps/data";
import { withBase } from "@/lib/withBase";

type PointCtx = {
  definition?: string;
  summary?: string;
  relations?: string[];
  evidence?: string[];
  nearConcepts?: string[];
  /** 复习页学习笔记摘录 */
  noteTheme?: string;
  noteOneLiner?: string;
  noteSummary?: string;
  noteBody?: string;
  noteBullets?: string[];
  noteTips?: string[];
  lectureOverview?: string;
  lectureThemes?: string[];
};

export type PolishQuizResult = {
  items: QuizItem[];
  error?: string;
  model?: string;
};

function normOpt(s: string) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[《》「」""'']/g, "")
    .toLowerCase();
}

/**
 * 用锁定的正确答案文本对齐选项下标。
 * 禁止短串 includes（避免「图」误命中「有向图」）。
 */
export function resolveAnswerIndex(
  options: string[] | undefined,
  locked: string | undefined
): number {
  const list = (options || []).map((o) => String(o ?? "").trim());
  const y = normOpt(locked || "");
  if (!y || !list.length) return -1;

  let hit = list.findIndex((o) => normOpt(o) === y);
  if (hit >= 0) return hit;

  hit = list.findIndex((o) => {
    const x = normOpt(o);
    if (!x) return false;
    if (
      x.startsWith(y) &&
      (x.length === y.length ||
        !/[\u4e00-\u9fffa-z0-9]/.test(x[y.length] || ""))
    ) {
      return y.length >= 2;
    }
    if (x.includes("/") && x.split("/")[0] === y) return true;
    return false;
  });
  return hit;
}

/** 锁定文本；判分与高亮以此为准 */
export function lockedCorrectAnswer(item: QuizItem): string {
  const fromField = String(item.correctAnswer || "").trim();
  if (fromField) return fromField;
  const idx = item.answerIndex;
  if (idx >= 0 && idx < (item.options?.length || 0)) {
    return String(item.options[idx] || "").trim();
  }
  return "";
}

export function resolvedCorrectIndex(item: QuizItem): number {
  const locked = lockedCorrectAnswer(item);
  const hit = resolveAnswerIndex(item.options, locked);
  if (hit >= 0) return hit;
  return item.answerIndex;
}

export function isCorrectPick(item: QuizItem, optionIndex: number): boolean {
  const locked = lockedCorrectAnswer(item);
  const picked = String(item.options[optionIndex] ?? "").trim();
  if (locked && picked && normOpt(picked) === normOpt(locked)) return true;
  const idx = resolveAnswerIndex(item.options, locked);
  if (idx >= 0) return optionIndex === idx;
  return optionIndex === item.answerIndex;
}

/** 合并后重新锁定 answerIndex / correctAnswer，避免模型下标错位 */
export function ensureQuizItemAnswer(item: QuizItem, seed?: QuizItem): QuizItem {
  const locked = String(
    item.correctAnswer ||
      seed?.correctAnswer ||
      seed?.options?.[seed.answerIndex] ||
      item.options?.[item.answerIndex] ||
      ""
  ).trim();
  let options = Array.isArray(item.options)
    ? item.options.map((o) => String(o).trim())
    : [];
  if (options.length !== 4 || new Set(options).size < 4) {
    options = seed?.options ? [...seed.options] : options;
  }
  let answerIndex = resolveAnswerIndex(options, locked);
  if (answerIndex < 0 && seed?.options) {
    options = [...seed.options];
    answerIndex = resolveAnswerIndex(options, locked);
    if (answerIndex < 0) answerIndex = seed.answerIndex;
  }
  if (answerIndex < 0) answerIndex = item.answerIndex;
  return {
    ...item,
    options,
    correctAnswer: locked || item.correctAnswer,
    answerIndex,
  };
}

function nearConceptsFor(
  point: AppReviewPoint,
  lecturePoints: AppReviewPoint[]
): string[] {
  const ban = new Set([point.zh, zhName(point.id)]);
  const names: string[] = [];
  const push = (z?: string) => {
    const n = zhName(z || "");
    if (!n || ban.has(n) || names.includes(n)) return;
    names.push(n);
  };
  for (const n of point.neighbors || []) {
    push(n.subject);
    push(n.object);
  }
  const ranked = [...lecturePoints].sort((a, b) => b.importance - a.importance);
  for (const p of ranked) {
    push(p.zh);
    if (names.length >= 8) break;
  }
  return names.slice(0, 8);
}

/** 优先读复习页缓存的主题笔记；没有则拉取/本地生成并写入缓存 */
export async function ensureLectureNotes(input: {
  courseId: string;
  lectureId: string;
  title?: string;
  points: AppReviewPoint[];
}): Promise<LectureNotesDoc> {
  const cached = await loadLectureNotesCache(input.courseId, input.lectureId);
  const cachedNotes = cached?.notes as LectureNotesDoc | undefined;
  if (isThemeNotes(cachedNotes)) return cachedNotes;

  try {
    const doc = await fetchLectureNotes(input);
    await saveLectureNotesCache(input.courseId, input.lectureId, doc);
    return doc;
  } catch {
    const local = buildLocalLectureNotes(input);
    await saveLectureNotesCache(input.courseId, input.lectureId, local);
    return local;
  }
}

function nameHits(hay: string, needle: string) {
  const a = (hay || "").trim();
  const b = (needle || "").trim();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function findNoteSlice(notes: LectureNotesDoc, entityZh: string) {
  const themes = notes.themes || [];
  const sections = notes.sections || [];
  const theme =
    themes.find(
      (t) =>
        nameHits(t.title, entityZh) ||
        (t.keyPoints || []).some((k) => nameHits(k, entityZh))
    ) || null;
  const sec =
    sections.find((s) => theme && s.id === theme.id) ||
    sections.find(
      (s) =>
        nameHits(s.title, entityZh) ||
        (s.related || []).some((r) => nameHits(r, entityZh))
    ) ||
    sections.find((s) => s.kind === "theme" || s.kind === "concept") ||
    null;
  return { theme, sec };
}

function parseNoteBullet(b: string): { name: string; def: string } | null {
  const m = String(b || "")
    .trim()
    .match(/^([^：:]{1,24})[：:]\s*(.+)$/);
  if (!m) return null;
  const name = m[1].trim();
  const def = m[2].trim();
  if (name.length < 1 || def.length < 12) return null;
  return { name, def };
}

function shuffleArr<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickNoteDistractors(
  correct: string,
  pool: string[],
  need: number
): string[] {
  const ban = new Set([correct]);
  const out: string[] = [];
  for (const x of shuffleArr(pool)) {
    const n = zhName(x);
    if (!n || ban.has(n) || out.includes(n)) continue;
    out.push(n);
    if (out.length >= need) break;
  }
  return out;
}

/**
 * 根据复习页「分主题学习笔记」出种子题。
 * 优先用主题要点 / 笔记 bullet（概念：释义），与图谱题互补。
 */
export function buildQuizFromNotes(
  packs: {
    lectureId: string;
    notes: LectureNotesDoc;
    points: AppReviewPoint[];
  }[],
  count = 10,
  opts?: { focusEntityId?: string | null; focusZh?: string | null }
): QuizItem[] {
  const pool: QuizItem[] = [];
  const focusId = opts?.focusEntityId || null;
  const focusZh = opts?.focusZh || null;

  for (const { lectureId, notes, points } of packs) {
    const byZh = new Map(points.map((p) => [p.zh, p]));
    const allKeys = [
      ...new Set(
        (notes.themes || []).flatMap((t) => t.keyPoints || []).concat(
          (notes.sections || []).flatMap((s) => s.related || [])
        )
      ),
    ].map(zhName).filter(Boolean);

    for (const sec of notes.sections || []) {
      if (sec.kind === "tips" || sec.kind === "checklist" || sec.kind === "extra") {
        continue;
      }
      const theme = (notes.themes || []).find((t) => t.id === sec.id);
      const related = [
        ...new Set([...(sec.related || []), ...(theme?.keyPoints || [])]),
      ].map(zhName).filter(Boolean);

      for (const bullet of sec.bullets || []) {
        const parsed = parseNoteBullet(bullet);
        if (!parsed) continue;
        const correct = zhName(parsed.name);
        if (!correct) continue;
        const distractors = pickNoteDistractors(
          correct,
          allKeys.filter((k) => k !== correct),
          3
        );
        if (distractors.length < 2) continue;
        while (distractors.length < 3 && allKeys.length > distractors.length + 1) {
          const filler = allKeys.find(
            (k) => k !== correct && !distractors.includes(k)
          );
          if (!filler) break;
          distractors.push(filler);
        }
        if (distractors.length < 2) continue;
        const options = shuffleArr([correct, ...distractors.slice(0, 3)]);
        const answerIndex = options.indexOf(correct);
        if (answerIndex < 0) continue;
        const point = byZh.get(correct);
        const hint =
          parsed.def.length > 100 ? `${parsed.def.slice(0, 100)}…` : parsed.def;
        pool.push({
          id: `note-${lectureId}-${sec.id}-${correct}`,
          lectureId,
          type: "definition",
          prompt: `根据本讲学习笔记，下列描述对应的概念是（ ）。\n${hint}`,
          options,
          answerIndex,
          correctAnswer: correct,
          explain: `笔记要点对应概念「${correct}」。`,
          explainDetail: [
            `【考点】主题「${sec.title || theme?.title || ""}」`,
            `【正确答案】${correct}`,
            `【解析】${parsed.def}`,
            theme?.oneLiner ? `【主题一句话】${theme.oneLiner}` : "",
            `【干扰项】其余选项属于本讲其它概念，注意与「${correct}」区分。`,
          ]
            .filter(Boolean)
            .join("\n"),
          difficulty: parsed.def.length > 70 ? "medium" : "easy",
          entityId: point?.id || correct,
          entityZh: correct,
          evidenceStartSec: point?.evidence?.[0]?.start_sec ?? null,
        });
      }

      // 主题一句话 → 选主题关键词
      if (theme?.oneLiner && related.length >= 3) {
        const correct = related[0];
        const distractors = pickNoteDistractors(
          correct,
          allKeys.filter((k) => !related.slice(0, 2).includes(k)),
          3
        );
        if (distractors.length >= 2) {
          const options = shuffleArr([
            correct,
            ...distractors.slice(0, 3),
          ]);
          const answerIndex = options.indexOf(correct);
          if (answerIndex >= 0) {
            const point = byZh.get(correct);
            pool.push({
              id: `note-theme-${lectureId}-${theme.id}`,
              lectureId,
              type: "definition",
              prompt: `本讲笔记中，主题「${theme.title}」可用一句话概括为：「${theme.oneLiner}」。该主题最核心的概念是（ ）。`,
              options,
              answerIndex,
              correctAnswer: correct,
              explain: `主题「${theme.title}」的核心概念是「${correct}」。`,
              explainDetail: [
                `【考点】主题地图 · ${theme.title}`,
                `【正确答案】${correct}`,
                `【解析】${theme.oneLiner}`,
                `【关键词】${(theme.keyPoints || []).join("、")}`,
              ].join("\n"),
              difficulty: "medium",
              entityId: point?.id || correct,
              entityZh: correct,
              evidenceStartSec: point?.evidence?.[0]?.start_sec ?? null,
            });
          }
        }
      }
    }
  }

  const matchFocus = (q: QuizItem) => {
    if (focusId && (q.entityId === focusId || q.entityId.includes(focusId))) {
      return true;
    }
    if (focusZh && (q.entityZh === focusZh || nameHits(q.entityZh, focusZh))) {
      return true;
    }
    return false;
  };

  if (focusId || focusZh) {
    const focused = pool.filter(matchFocus);
    const rest = shuffleArr(pool.filter((q) => !focused.includes(q)));
    return [...shuffleArr(focused), ...rest].slice(0, count);
  }
  return shuffleArr(pool).slice(0, count);
}

/** 为 LLM 润色附带课堂材料 + 复习笔记 */
export function attachQuizContexts(
  items: QuizItem[],
  docs: { lectureId: string; doc: AppReviewDoc }[],
  notesByLecture?: Map<string, LectureNotesDoc>
): Array<QuizItem & { context?: PointCtx }> {
  const byLecture = new Map<string, AppReviewPoint[]>();
  const byId = new Map<string, { p: AppReviewPoint; lectureId: string }>();
  for (const { lectureId, doc } of docs) {
    byLecture.set(lectureId, doc.points || []);
    for (const p of doc.points || []) {
      byId.set(p.id, { p, lectureId });
    }
  }
  return items.map((it) => {
    const hit = byId.get(it.entityId);
    const lecturePoints = byLecture.get(it.lectureId) || [];
    const p = hit?.p;
    const notes = notesByLecture?.get(it.lectureId);
    const slice = notes
      ? findNoteSlice(notes, it.entityZh || p?.zh || "")
      : { theme: null, sec: null };

    const near = p
      ? nearConceptsFor(p, lecturePoints)
      : [];
    const noteKeys = [
      ...(slice.theme?.keyPoints || []),
      ...(slice.sec?.related || []),
      ...(notes?.themes || []).flatMap((t) => t.keyPoints || []),
    ]
      .map(zhName)
      .filter((n) => n && n !== it.entityZh && !near.includes(n));

    const context: PointCtx = {
      definition: p?.definition,
      summary: p?.summary,
      relations: (p?.neighbors || []).slice(0, 8).map(
        (n) =>
          n.natural_statement ||
          `${zhName(n.subject)} —${n.label || n.predicate}→ ${zhName(n.object)}`
      ),
      evidence: (p?.evidence || [])
        .slice(0, 2)
        .map((e) => (e.text || "").trim())
        .filter(Boolean),
      nearConcepts: [...near, ...noteKeys].slice(0, 10),
      noteTheme: slice.theme?.title || slice.sec?.title,
      noteOneLiner: slice.theme?.oneLiner,
      noteSummary: slice.sec?.summary,
      noteBody: slice.sec?.body,
      noteBullets: (slice.sec?.bullets || []).slice(0, 8),
      noteTips: (slice.sec?.tips || []).slice(0, 4),
      lectureOverview: notes?.overview,
      lectureThemes: (notes?.themes || []).map(
        (t) => `${t.title}${t.oneLiner ? `：${t.oneLiner}` : ""}`
      ),
    };

    // 笔记释义优先补进 definition（供模型出定义题）
    if (!context.definition && slice.sec?.body) {
      context.definition = slice.sec.body.slice(0, 520);
    }
    if (!context.summary && slice.sec?.summary) {
      context.summary = slice.sec.summary;
    }

    return { ...it, context };
  });
}

export async function polishPracticeQuiz(input: {
  courseId: string;
  items: Array<QuizItem & { context?: PointCtx }>;
}): Promise<PolishQuizResult> {
  if (!input.items.length) return { items: [] };
  try {
    const r = await fetch(withBase("/api/practice-quiz"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: input.courseId,
        items: input.items,
      }),
    });
    const data = await r.json().catch(() => ({} as Record<string, unknown>));
    if (!r.ok) {
      return {
        items: input.items.map(stripContext),
        error:
          String(data?.message || data?.error || `HTTP ${r.status}`) ||
          "问答服务失败",
      };
    }
    if (!Array.isArray(data.items) || !data.items.length) {
      return {
        items: input.items.map(stripContext),
        error: "模型未返回题目",
      };
    }
    const items = data.items.map((it: QuizItem, i: number) => {
      const seed = input.items[i];
      const merged = {
        ...(seed ? stripContext(seed) : {}),
        ...stripContext(it),
        id: seed?.id || it.id || `q-${i}`,
        lectureId: it.lectureId || seed?.lectureId || "",
        type: it.type || seed?.type || "definition",
        entityId: seed?.entityId || it.entityId || "",
        entityZh: seed?.entityZh || it.entityZh || "",
        evidenceStartSec: seed?.evidenceStartSec ?? it.evidenceStartSec,
        difficulty: it.difficulty || seed?.difficulty || "medium",
        explainDetail: it.explainDetail || it.explain || seed?.explainDetail || seed?.explain,
        // 优先保留种子锁定答案，再信服务端
        correctAnswer:
          seed?.correctAnswer ||
          it.correctAnswer ||
          seed?.options?.[seed.answerIndex] ||
          "",
        polished: Boolean(it.polished),
      } as QuizItem;
      if (data.items.some((x: QuizItem) => x.polished)) {
        merged.polished = true;
      }
      return ensureQuizItemAnswer(merged, seed ? stripContext(seed) : undefined);
    });
    // 按种子 id 重排，避免批处理乱序
    const byId = new Map(items.map((x: QuizItem) => [x.id, x]));
    const ordered = input.items.map((s, i) => {
      const hit = byId.get(s.id) || items[i];
      if (hit) return ensureQuizItemAnswer(hit, stripContext(s));
      return ensureQuizItemAnswer(stripContext(s), stripContext(s));
    });
    return { items: ordered, model: data.model ? String(data.model) : undefined };
  } catch (e) {
    return {
      items: input.items.map(stripContext),
      error: String((e as Error)?.message || e || "网络错误"),
    };
  }
}

function stripContext(it: QuizItem & { context?: PointCtx }): QuizItem {
  const { context: _c, ...rest } = it as QuizItem & { context?: PointCtx };
  return rest;
}

export function difficultyLabel(d?: QuizItem["difficulty"]) {
  if (d === "easy") return "简单";
  if (d === "hard") return "较难";
  return "中等";
}
