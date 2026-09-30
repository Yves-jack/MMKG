/** 单课复习按「一堂课 = 相邻两讲」合并；配对规则与课堂图谱 session 一致：连续讲次号 n 与 n+1。 */

export type ReviewSession = {
  id: string;
  lectureIds: string[];
  label: string;
};

export function pairLecturesIntoSessions(lectureIds: string[]): ReviewSession[] {
  const sorted = [
    ...new Set(
      lectureIds
        .map((id) => String(id || "").trim())
        .filter((id) => /^\d+$/.test(id))
    ),
  ].sort((a, b) => Number(a) - Number(b));
  const set = new Set(sorted);
  const used = new Set<string>();
  const out: ReviewSession[] = [];

  for (const a of sorted) {
    if (used.has(a)) continue;
    const b = String(Number(a) + 1);
    if (set.has(b) && !used.has(b)) {
      used.add(a);
      used.add(b);
      out.push({
        id: `${a}_${b}`,
        lectureIds: [a, b],
        label: `第 ${a}–${b} 讲`,
      });
    }
  }
  for (const a of sorted) {
    if (used.has(a)) continue;
    out.push({ id: a, lectureIds: [a], label: `第 ${a} 讲` });
  }
  out.sort((x, y) => Number(x.lectureIds[0]) - Number(y.lectureIds[0]));
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
