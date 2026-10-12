/**
 * 一堂课 = 固定槽位的两讲：1–2、3–4、…、17–18、19–20。
 * 槽位缺一讲时，剩下那一讲单独成课（如缺 17 则第 18 讲自己是一课），
 * 不把下一槽位的讲拉过来凑对。
 */

export type ReviewSession = {
  id: string;
  lectureIds: string[];
  label: string;
};

/** 课次序号：讲 1–2 → 1，3–4 → 2，落单讲 N → ceil(N/2) */
export function sessionIndexFromLectureIds(lectureIds: string[]): number {
  const nums = lectureIds
    .map((id) => Number(String(id || "").trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return 1;
  return Math.ceil(Math.min(...nums) / 2);
}

export function pairLecturesIntoSessions(lectureIds: string[]): ReviewSession[] {
  const sorted = [
    ...new Set(
      lectureIds
        .map((id) => String(id || "").trim())
        .filter((id) => /^\d+$/.test(id))
    ),
  ].sort((a, b) => Number(a) - Number(b));
  if (!sorted.length) return [];
  const set = new Set(sorted);
  const max = Number(sorted[sorted.length - 1]);
  const out: ReviewSession[] = [];

  for (let odd = 1; odd <= max; odd += 2) {
    const a = String(odd);
    const b = String(odd + 1);
    const hasA = set.has(a);
    const hasB = set.has(b);
    if (hasA && hasB) {
      const idx = sessionIndexFromLectureIds([a, b]);
      out.push({
        id: `${a}_${b}`,
        lectureIds: [a, b],
        label: `第 ${idx} 次课`,
      });
    } else if (hasA) {
      const idx = sessionIndexFromLectureIds([a]);
      out.push({ id: a, lectureIds: [a], label: `第 ${idx} 次课` });
    } else if (hasB) {
      const idx = sessionIndexFromLectureIds([b]);
      out.push({ id: b, lectureIds: [b], label: `第 ${idx} 次课` });
    }
  }
  return out;
}

export function parseSessionRouteId(raw?: string | null): {
  kind: "session" | "lecture";
  id: string;
  lectureIds: string[];
} | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const pair = s.match(/^(\d+)_(\d+)$/);
  if (pair) {
    const a = pair[1];
    const b = pair[2];
    const lectureIds = Number(a) <= Number(b) ? [a, b] : [b, a];
    return { kind: "session", id: `${lectureIds[0]}_${lectureIds[1]}`, lectureIds };
  }
  const one = s.match(/^(?:lecture[_-])?(\d+)$/i);
  if (one) return { kind: "lecture", id: one[1], lectureIds: [one[1]] };
  return null;
}

export function resolveReviewSession(
  raw: string | null | undefined,
  sessions: ReviewSession[]
): ReviewSession | null {
  if (!sessions.length) return null;
  const parsed = parseSessionRouteId(raw);
  if (!parsed) return sessions[0] || null;
  const exact = sessions.find((s) => s.id === parsed.id);
  if (exact) return exact;
  for (const lec of parsed.lectureIds) {
    const hit = sessions.find((s) => s.lectureIds.includes(lec));
    if (hit) return hit;
  }
  return null;
}

export function sessionTitle(session: ReviewSession, fallbackTitle?: string): string {
  const extra = (fallbackTitle || "").trim();
  if (extra && !/^第\s*\d+/.test(extra)) return `${session.label} · ${extra}`;
  return `${session.label} · 单课复习`;
}

export function parseReviewGraphScope(
  id: string
): { lectureId: string } | { sessionPair: [string, string] } {
  const parsed = parseSessionRouteId(id);
  if (parsed?.kind === "session" && parsed.lectureIds.length === 2) {
    return { sessionPair: [parsed.lectureIds[0], parsed.lectureIds[1]] };
  }
  return { lectureId: parsed?.lectureIds[0] || String(id) };
}
