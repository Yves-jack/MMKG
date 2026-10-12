import type { VideoSegment } from "@/components/review/VideoChapterPlayer";

type PointLike = {
  zh: string;
  importance?: number;
  summary?: string;
  definition?: string;
  evidence?: { text?: string; start_sec?: number | null; end_sec?: number | null }[];
};

function clipText(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n).replace(/[，,。；;：:\s]+$/g, "")}…`;
}

/** 把口语 ASR 标题收成更像摘要的短句 */
function condenseAsr(raw: string, maxLen = 72): string {
  const t = String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/^[…·\-\s]+/, "")
    .trim();
  if (!t) return "";
  if (/本段无有效|本段无实质|片段\s*\d+/.test(t)) return "";
  const parts = t.split(/[。！？；.!?;]/).map((p) => p.trim()).filter(Boolean);
  let buf = "";
  for (const part of parts) {
    const piece = part.replace(/^[，,、\s]+/, "");
    if (piece.length < 4) continue;
    buf = buf ? `${buf}；${piece}` : piece;
    if (buf.length >= 28) break;
  }
  return clipText(buf || t, maxLen);
}

/**
 * 为视频分段补全「摘要」：优先用该时段命中的知识点浓缩，
 * 否则把 ASR 标题收成可读短摘要。
 */
export function enrichVideoSegments(
  segments: VideoSegment[],
  points: PointLike[]
): VideoSegment[] {
  if (!segments.length) return [];

  return segments.map((seg) => {
    if (seg.summary && seg.summary.trim()) {
      return { ...seg, summary: clipText(seg.summary, 96) };
    }

    const hits: { zh: string; text: string; score: number }[] = [];
    for (const p of points) {
      const evs = p.evidence || [];
      let overlap = 0;
      for (const e of evs) {
        const t0 = Number(e.start_sec);
        if (!Number.isFinite(t0)) continue;
        if (t0 >= seg.start_sec - 1.5 && t0 < seg.end_sec + 1.5) overlap += 1;
      }
      if (!overlap) continue;
      const text = (p.summary || p.definition || "").trim();
      hits.push({
        zh: p.zh,
        text,
        score: overlap * 3 + Number(p.importance || 0),
      });
    }
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, 3);

    let summary = "";
    if (top.length) {
      const names = top.map((h) => h.zh).join("、");
      const lead = top.find((h) => h.text)?.text || "";
      summary = lead
        ? `${names}：${clipText(lead, 64)}`
        : `本段围绕「${names}」`;
    } else {
      summary = condenseAsr(seg.title);
    }

    return {
      ...seg,
      summary: summary || seg.title || `片段 ${seg.index}`,
    };
  });
}
