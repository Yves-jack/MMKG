import type { AppReviewPoint, QaIntent } from "@/lib/apps/data";
import { matchPoint, zhName } from "@/lib/apps/data";
import { withBase } from "@/lib/withBase";

export type QaLlmPointPayload = {
  id: string;
  zh: string;
  summary?: string;
  definition?: string;
  neighbors?: AppReviewPoint["neighbors"];
  evidence?: { text: string; start_sec?: number | null }[];
};

export type QaLlmResult = {
  answer: string;
  bullets: string[];
  usedExtra: boolean;
  extraNote: string;
  citedConcepts: string[];
  model?: string;
  fallback?: boolean;
  error?: string;
};

function packPoint(p: AppReviewPoint): QaLlmPointPayload {
  return {
    id: p.id,
    zh: p.zh,
    summary: p.summary,
    definition: p.definition,
    neighbors: (p.neighbors || []).slice(0, 8),
    evidence: (p.evidence || []).slice(0, 4).map((e) => ({
      text: e.text || "",
      start_sec: e.start_sec,
    })),
  };
}

/** 从问题与本讲知识点中挑出要喂给模型的课堂上下文 */
export function collectQaContext(
  points: AppReviewPoint[],
  question: string,
  opts?: { primary?: AppReviewPoint | null; secondary?: AppReviewPoint | null }
): AppReviewPoint[] {
  const out: AppReviewPoint[] = [];
  const seen = new Set<string>();
  const push = (p?: AppReviewPoint | null) => {
    if (!p || seen.has(p.id)) return;
    seen.add(p.id);
    out.push(p);
  };

  push(opts?.primary || null);
  push(opts?.secondary || null);

  const cleaned = question
    .replace(/^(什么是|是什么|简述|解释)/, "")
    .replace(/[？?。.!！]+$/g, "")
    .trim();
  push(matchPoint(points, cleaned));
  push(matchPoint(points, question));

  // 再捞几个名称出现在问句中的点
  const ranked = [...points]
    .map((p) => {
      const zh = p.zh.toLowerCase();
      const q = question.toLowerCase();
      let score = 0;
      if (q.includes(zh) && zh.length >= 2) score += 10 + p.importance;
      else if (zh.length >= 2 && cleaned.includes(zh)) score += 8 + p.importance;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  for (const { p } of ranked) {
    push(p);
    if (out.length >= 6) break;
  }

  // 仍太少：补重要性最高的 2 个，避免完全空上下文
  if (out.length < 2) {
    const top = [...points].sort((a, b) => b.importance - a.importance).slice(0, 3);
    for (const p of top) push(p);
  }

  return out.slice(0, 8);
}

export async function askQaLlm(input: {
  courseId: string;
  lectureId: string;
  question: string;
  intent: QaIntent;
  points: AppReviewPoint[];
  history?: { role: "user" | "assistant"; text: string }[];
}): Promise<QaLlmResult> {
  const r = await fetch(withBase("/api/qa-chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      courseId: input.courseId,
      lectureId: input.lectureId,
      question: input.question,
      intent: input.intent,
      points: input.points.map(packPoint),
      history: input.history || [],
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return {
      answer: "",
      bullets: [],
      usedExtra: false,
      extraNote: "",
      citedConcepts: [],
      error:
        data?.message ||
        data?.error ||
        `问答服务失败（HTTP ${r.status}）`,
    };
  }

  return {
    answer: String(data.answer || "").trim(),
    bullets: Array.isArray(data.bullets) ? data.bullets.map(String) : [],
    usedExtra: Boolean(data.usedExtra),
    extraNote: String(data.extraNote || ""),
    citedConcepts: Array.isArray(data.citedConcepts)
      ? data.citedConcepts.map(String)
      : [],
    model: data.model,
  };
}

export function resolveCitedPoint(
  points: AppReviewPoint[],
  cited: string[],
  fallback?: AppReviewPoint | null
): AppReviewPoint | undefined {
  for (const name of cited) {
    const hit = matchPoint(points, name) || points.find((p) => zhName(p.id) === name);
    if (hit) return hit;
  }
  return fallback || undefined;
}
