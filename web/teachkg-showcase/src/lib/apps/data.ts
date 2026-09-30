/** 下游应用：从已同步的课内静态数据组装，无需额外后端。 */
import { courseDataUrl } from "@/lib/course";

export type AppReviewPoint = {
  id: string;
  zh: string;
  rank?: number;
  importance: number;
  mention_count?: number;
  origin: string;
  summary: string;
  definition?: string;
  neighbors?: {
    subject: string;
    predicate: string;
    object: string;
    label?: string;
    natural_statement?: string;
  }[];
  evidence?: {
    cue_id: string;
    text: string;
    start_sec?: number | null;
    end_sec?: number | null;
    lecture_id?: string;
  }[];
  source_lecture_ids?: string[];
};

export type AppReviewDoc = {
  course_id?: string;
  lecture_id: string;
  title?: string;
  n_points?: number;
  class_video?: string | null;
  duration_sec?: number | null;
  segments?: {
    id: string;
    index: number;
    start_sec: number;
    end_sec: number;
    title: string;
    summary?: string;
  }[];
  points: AppReviewPoint[];
};

export type AppReviewIndexItem = {
  lecture_id: string;
  title?: string;
  n_points?: number;
  path: string;
  duration_sec?: number | null;
};

export type AppAsset = {
  id: string;
  kind?: string;
  title?: string;
  name?: string;
  summary?: string;
  text?: string;
  lecture_id?: string | number;
  related_entities?: string[];
};

function zhName(name: string): string {
  return (name || "").split("/")[0].trim() || name;
}

export { zhName };

/** 推荐锚点：原理 / 技术 / 定理（排除过于空泛的单名） */
export type KpKind = "原理" | "技术" | "定理";

const GENERIC_KP = /^(定理|公理|原理|技术|方法|算法|范式|推论|引理)$/i;

export function classifyKpKind(name: string): KpKind | null {
  const s = zhName(name);
  if (!s || s.length < 2 || GENERIC_KP.test(s)) return null;
  // 定理类优先（含 theorem / 引理 / 具名不完全性等）
  if (
    /定理|theorem|引理|lemma|推论|corollary|不完全性|紧致性定理|完全性定理|Church-Rosser|Herbrand|Lowenheim|柯尼希|握手定理|欧拉定理|四色|五色/i.test(
      s
    )
  ) {
    return "定理";
  }
  if (/原理|principle|公理|axiom|定律|原则|外延性|分配律|同一律|排中律|矛盾律/i.test(s)) {
    return "原理";
  }
  if (
    /技术|方法|算法|技法|technique|method|algorithm|演算|归结|消解|判定法|DPLL|符号化|证明推理|知识表示|前束|Skolem|合取范式|析取范式|范式化/i.test(
      s
    )
  ) {
    return "技术";
  }
  return null;
}

export function originLabel(origin: string): string {
  if (origin === "shared") return "教材+课堂";
  if (origin === "lecture_only") return "课堂独有";
  if (origin === "textbook_hint") return "教材侧";
  return origin || "—";
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("text/html")) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function sortLectures<T extends { lecture_id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const na = Number(a.lecture_id);
    const nb = Number(b.lecture_id);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.lecture_id).localeCompare(String(b.lecture_id), "zh", {
      numeric: true,
    });
  });
}

export async function loadReviewIndex(courseId: string): Promise<AppReviewIndexItem[]> {
  const a = await fetchJson<{ items?: AppReviewIndexItem[] }>(
    courseDataUrl(courseId, "review_showcase.json")
  );
  if (a?.items?.length) return sortLectures(a.items);
  const b = await fetchJson<{ items?: AppReviewIndexItem[] }>(
    courseDataUrl(courseId, "review/index.json")
  );
  return sortLectures(b?.items || []);
}

export async function loadReviewLecture(
  courseId: string,
  lectureId: string
): Promise<AppReviewDoc | null> {
  return fetchJson<AppReviewDoc>(
    courseDataUrl(courseId, `review/lecture_${lectureId}.json`)
  );
}

export async function loadAllReviewPoints(
  courseId: string
): Promise<{ lectureId: string; point: AppReviewPoint }[]> {
  const index = await loadReviewIndex(courseId);
  const rows: { lectureId: string; point: AppReviewPoint }[] = [];
  await Promise.all(
    index.map(async (it) => {
      const doc = await loadReviewLecture(courseId, it.lecture_id);
      for (const p of doc?.points || []) {
        rows.push({ lectureId: String(it.lecture_id), point: p });
      }
    })
  );
  rows.sort((a, b) => b.point.importance - a.point.importance);
  return rows;
}

export async function loadImportanceScores(
  courseId: string
): Promise<Record<string, number>> {
  const raw = await fetchJson<{ scores?: Record<string, number> }>(
    courseDataUrl(courseId, "entity_importance_lookup.json")
  );
  return raw?.scores || {};
}

export async function loadAssetsLibrary(courseId: string): Promise<AppAsset[]> {
  const raw = await fetchJson<{ assets?: AppAsset[] } | AppAsset[]>(
    courseDataUrl(courseId, "assets_library.json")
  );
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return raw.assets || [];
}

export function firstEvidenceSec(
  evidence?: { start_sec?: number | null }[],
  fallback: number | null = null
): number | null {
  const times = (evidence || [])
    .map((e) => Number(e.start_sec))
    .filter((n) => Number.isFinite(n));
  return times.length ? Math.min(...times) : fallback;
}

export function matchPoint(
  points: AppReviewPoint[],
  query: string
): AppReviewPoint | undefined {
  const q = query
    .trim()
    .replace(/[？?。.!！,，、]+$/g, "")
    .toLowerCase();
  if (!q) return undefined;

  const rank = (p: AppReviewPoint) => {
    const zh = p.zh.toLowerCase();
    const idn = zhName(p.id).toLowerCase();
    const id = p.id.toLowerCase();
    if (id === q || zh === q || idn === q) return 0;
    if (zh.startsWith(q) || idn.startsWith(q)) return 1 + zh.length;
    if (q.length >= 2 && (zh.includes(q) || idn.includes(q))) return 20 + zh.length;
    if (q.length >= 2 && (p.summary || "").toLowerCase().includes(q)) return 80 + zh.length;
    return 999;
  };

  let best: AppReviewPoint | undefined;
  let bestRank = 999;
  for (const p of points) {
    const r = rank(p);
    if (r < bestRank) {
      bestRank = r;
      best = p;
    }
  }
  return bestRank < 999 ? best : undefined;
}

export type QaIntent = "definition" | "relation" | "lecture" | "all";

export function detectQaIntent(query: string): QaIntent {
  const q = query.trim();
  if (/怎么讲|课堂|老师|证据|口述|视频/.test(q)) return "lecture";
  if (/关系|相关|联系|依赖|属于|组成|区别|对比|和.+有/.test(q)) return "relation";
  if (/是什么|什么是|含义|定义|释义|解释|简述/.test(q)) return "definition";
  return "all";
}

export function buildGroundedAnswer(
  point: AppReviewPoint,
  intent: QaIntent = "all"
): {
  lead: string;
  bullets: string[];
  evidence: { text: string; start_sec?: number | null }[];
  intent: QaIntent;
} {
  const def =
    (point.definition || point.summary || "").trim() ||
    `${point.zh} 是本课涉及的重要概念。`;
  const bullets: string[] = [];
  for (const n of (point.neighbors || []).slice(0, 8)) {
    const other = n.subject === point.id ? n.object : n.subject;
    const rel = n.label || n.predicate;
    bullets.push(
      n.natural_statement?.trim() ||
        `${zhName(point.id)} —${rel}→ ${zhName(other)}`
    );
  }
  const evidence = (point.evidence || [])
    .slice(0, 4)
    .map((e) => ({
      text: (e.text || "").trim(),
      start_sec: e.start_sec,
    }))
    .filter((e) => e.text);

  let lead = def;
  if (intent === "relation" && bullets[0]) {
    lead = `与「${point.zh}」最直接的关系：${bullets[0]}`;
  } else if (intent === "lecture" && evidence[0]) {
    lead = `课堂相关表述：${evidence[0].text}`;
  } else if (intent === "definition") {
    lead = def;
  }

  return { lead, bullets, evidence, intent };
}

export type QuizDifficulty = "easy" | "medium" | "hard";

export type QuizItem = {
  id: string;
  lectureId: string;
  type: "relation" | "definition";
  prompt: string;
  options: string[];
  answerIndex: number;
  /** 锁定的正确答案文本，判分以此为准 */
  correctAnswer?: string;
  explain: string;
  /** 更完整的解析（可折叠展开） */
  explainDetail?: string;
  difficulty?: QuizDifficulty;
  entityId: string;
  entityZh: string;
  evidenceStartSec?: number | null;
  polished?: boolean;
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function relZh(pred: string) {
  const t = (pred || "").trim();
  if (/belong|归属|属于/.test(t)) return "归属";
  if (/part|组成|部分/.test(t)) return "组成";
  if (/depend|依赖/.test(t)) return "依赖";
  if (/synonym|同义|等价/.test(t)) return "同义/等价";
  if (/property|属性/.test(t)) return "属性";
  if (/related|相关/.test(t)) return "相关";
  return t || "关联";
}

function estimateDifficulty(
  type: QuizItem["type"],
  opts: { neighborCount?: number; defLen?: number }
): QuizDifficulty {
  if (type === "definition") {
    if ((opts.defLen || 0) > 80) return "medium";
    return "easy";
  }
  if ((opts.neighborCount || 0) >= 5) return "hard";
  return "medium";
}

/** 优先用邻接端点、同讲高重要性概念做干扰项，避免随机凑数 */
function pickDistractors(
  correct: string,
  selfZh: string,
  point: AppReviewPoint,
  lecturePoints: AppReviewPoint[],
  need = 3
): string[] {
  const ban = new Set([correct, selfZh].map((s) => s.trim()).filter(Boolean));
  const out: string[] = [];
  const push = (z?: string) => {
    const name = zhName(z || "");
    if (!name || ban.has(name) || out.includes(name)) return;
    out.push(name);
  };

  for (const n of point.neighbors || []) {
    push(n.subject);
    push(n.object);
    if (out.length >= need) break;
  }

  const ranked = [...lecturePoints].sort((a, b) => b.importance - a.importance);
  for (const p of ranked) {
    push(p.zh);
    if (out.length >= need) break;
  }

  // 仍不足：从邻接的邻接概念名里抽一点
  if (out.length < need) {
    for (const p of lecturePoints) {
      for (const n of p.neighbors || []) {
        push(n.subject);
        push(n.object);
        if (out.length >= need) break;
      }
      if (out.length >= need) break;
    }
  }

  return out.slice(0, need);
}

function cleanDefinitionText(raw: string, zh: string) {
  let t = String(raw || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(我们大家都知道|同学们|今天我们|大家看)[，,：:\s]*/g, "");
  // 去掉开头重复念概念名
  const re = new RegExp(`^${zh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[是为：:，,]\\s*`);
  t = t.replace(re, "");
  return t.trim();
}

export function buildQuizFromReviews(
  docs: { lectureId: string; doc: AppReviewDoc }[],
  count = 8,
  opts?: { focusEntityId?: string | null }
): QuizItem[] {
  const pool: QuizItem[] = [];
  const focusId = opts?.focusEntityId || null;

  for (const { lectureId, doc } of docs) {
    const lecturePoints = doc.points || [];
    for (const p of lecturePoints) {
      const nbrs = p.neighbors || [];
      // 选一条信息量更高的关系边
      const n =
        [...nbrs]
          .filter((x) => {
            const pred = (x.label || x.predicate || "").trim();
            return !/^(称为|是|叫做|名为)$/.test(pred);
          })
          .sort((a, b) => {
            const score = (x: (typeof nbrs)[0]) =>
              (x.natural_statement ? 2 : 0) + ((x.label || x.predicate || "").length > 0 ? 1 : 0);
            return score(b) - score(a);
          })[0] || null;

      if (n) {
        const correct = zhName(n.subject === p.id ? n.object : n.subject);
        const distractors = pickDistractors(correct, p.zh, p, lecturePoints, 3);
        if (distractors.length < 2) continue;
        while (distractors.length < 3) {
          const filler = lecturePoints.find(
            (q) => q.zh !== correct && q.zh !== p.zh && !distractors.includes(q.zh)
          );
          if (!filler) break;
          distractors.push(filler.zh);
        }
        if (distractors.length < 2) continue;
        const options = shuffle([correct, ...distractors.slice(0, 3)]);
        const answerIndex = options.indexOf(correct);
        if (answerIndex < 0) continue;
        const rel = relZh(n.label || n.predicate || "");
        const stmt =
          n.natural_statement ||
          `在本讲知识结构中，「${p.zh}」与「${correct}」之间是「${rel}」关系。`;
        const difficulty = estimateDifficulty("relation", {
          neighborCount: nbrs.length,
        });
        const wrong = options
          .map((o, i) => ({ o, i }))
          .filter((x) => x.i !== answerIndex)
          .map((x) => `${String.fromCharCode(65 + x.i)}.「${x.o}」与题干关系不符`)
          .join("；");
        pool.push({
          id: `rel-${lectureId}-${p.id}-${n.predicate}`,
          lectureId,
          type: "relation",
          prompt: `在本讲内容中，与「${p.zh}」构成「${rel}」关系的概念是（ ）。`,
          options,
          answerIndex,
          correctAnswer: correct,
          explain: `答案是「${correct}」。${stmt}`,
          explainDetail: [
            `【考点】概念「${p.zh}」的「${rel}」关系`,
            `【正确答案】${correct}`,
            `【解析】${stmt} 抓住关系类型「${rel}」，在选项中定位对应端点即可。`,
            `【干扰项】${wrong}`,
          ].join("\n"),
          difficulty,
          entityId: p.id,
          entityZh: p.zh,
          evidenceStartSec: firstEvidenceSec(p.evidence),
        });
      }

      const rawHint = cleanDefinitionText(p.definition || p.summary || "", p.zh);
      if (
        rawHint.length > 22 &&
        !/我们大家都知道|同学们|今天我们|大家看|下一[节讲]/.test(rawHint)
      ) {
        const correct = p.zh;
        const distractors = pickDistractors(correct, p.zh, p, lecturePoints, 3);
        if (distractors.length < 2) continue;
        while (distractors.length < 3) {
          const filler = lecturePoints.find(
            (q) => q.zh !== correct && !distractors.includes(q.zh)
          );
          if (!filler) break;
          distractors.push(filler.zh);
        }
        if (distractors.length < 2) continue;
        const options = shuffle([correct, ...distractors.slice(0, 3)]);
        const answerIndex = options.indexOf(correct);
        if (answerIndex < 0) continue;
        const hint = rawHint.length > 90 ? `${rawHint.slice(0, 90)}…` : rawHint;
        const difficulty = estimateDifficulty("definition", {
          defLen: rawHint.length,
        });
        const wrong = options
          .map((o, i) => ({ o, i }))
          .filter((x) => x.i !== answerIndex)
          .map((x) => `${String.fromCharCode(65 + x.i)}.「${x.o}」不符合题干关键特征`)
          .join("；");
        pool.push({
          id: `def-${lectureId}-${p.id}`,
          lectureId,
          type: "definition",
          prompt: `根据下列描述，选出对应的概念（ ）。\n${hint}`,
          options,
          answerIndex,
          correctAnswer: correct,
          explain: `该描述对应概念「${p.zh}」。`,
          explainDetail: [
            `【考点】概念「${p.zh}」的定义再认`,
            `【正确答案】${p.zh}`,
            `【解析】${(p.definition || p.summary || "").trim()}`,
            `【干扰项】${wrong}。作答时抓住题干中的关键特征，与各选项定义对照。`,
          ].join("\n"),
          difficulty,
          entityId: p.id,
          entityZh: p.zh,
          evidenceStartSec: firstEvidenceSec(p.evidence),
        });
      }
    }
  }

  if (focusId) {
    const focused = pool.filter(
      (q) =>
        q.entityId === focusId ||
        q.entityId.includes(focusId) ||
        focusId.includes(q.entityId)
    );
    const rest = shuffle(pool.filter((q) => !focused.includes(q)));
    return [...shuffle(focused), ...rest].slice(0, count);
  }

  return shuffle(pool).slice(0, count);
}
