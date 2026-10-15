import type { VideoSegment } from "@/components/review/VideoChapterPlayer";
import { courseDataUrl } from "@/lib/course";

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

/** 课堂套话 / 无信息量短句 */
function isFillerSentence(raw: string): boolean {
  const t = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return true;
  if (t.length < 6) return true;
  if (/本段无有效|本段无实质|无有效口播|^片段\s*\d+$|^开场$|^过渡$|过渡片段|开场与导入/.test(t)) {
    return true;
  }
  if (/^(好|好的|嗯|啊|呃|噢|哦|行|对|是|OK|ok)[，,。！!？?\s]*$/.test(t)) {
    return true;
  }
  if (/^(好[，,]?)?(那?我们)?上课(了|啦)?[。！!]?$/.test(t)) return true;
  return false;
}

/**
 * 书面短介绍：优先教材/抽取文，取首句实质内容，控制长度。
 * 无实质则空。
 */
export function summarizeWritten(
  raw: string,
  opts: { maxLen?: number } = {}
): string {
  const maxLen = opts.maxLen ?? 52;
  let t = String(raw || "")
    .replace(/\r/g, "\n")
    .replace(/\$[^$]*\$/g, (m) => m.replace(/\s+/g, "")) // 保留公式但压空白
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!t) return "";

  // 去掉 markdown 列表头
  const lines = t
    .split(/\n+/)
    .map((l) => l.replace(/^[-*•]\s*/, "").replace(/^\d+[.)、]\s*/, "").trim())
    .filter(Boolean);
  const blob = lines.join("。");
  const parts = blob
    .split(/[。！？；.!?;\n]+/)
    .map((p) => p.replace(/^[，,、\s：:]+/, "").trim())
    .filter((p) => p && !isFillerSentence(p));

  if (!parts.length) return "";

  // 优先含定义/定理等书面句；否则取首句
  const scored = parts.map((text, idx) => {
    let score = 40 - idx; // 靠前略优
    if (/^[^，,]{2,24}(的定义|是指|又称|定义为)/.test(text)) score += 30;
    if (/定理|定义|性质|判定|当且仅当|充分|必要/.test(text)) score += 20;
    if (/图|边|点|道路|回路|连通|欧拉|命题|谓词|集合|关系/.test(text)) score += 10;
    if (/你们|大家|同学|我说|上课/.test(text)) score -= 25;
    return { text, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.text || "";
  if (!best || isFillerSentence(best)) return "";
  return clipText(best, maxLen);
}

/** ASR 口头腔 → 仍尽量压成短书面句；无实质则空 */
export function summarizeAsr(
  raw: string,
  opts: { maxLen?: number } = {}
): string {
  return summarizeWritten(raw, { maxLen: opts.maxLen ?? 52 });
}

/**
 * 悬停介绍：已有 summary/title 再压成短书面句；不回填知识点百科。
 */
export function enrichVideoSegments(
  segments: VideoSegment[],
  _points?: PointLike[]
): VideoSegment[] {
  if (!segments.length) return [];
  return segments.map((seg) => {
    const summary =
      summarizeWritten(seg.summary || "") ||
      summarizeWritten(seg.title || "") ||
      "";
    return { ...seg, title: summary, summary };
  });
}

type PipelineCueItem = {
  cue_id?: string;
  start_sec?: number;
  end_sec?: number;
  asr_text?: string;
  raw_asr_text?: string;
  extract_text?: string;
};

function captionFromCue(it: PipelineCueItem): string {
  // 书面优先 extract；无实质再退 ASR
  return (
    summarizeWritten(String(it.extract_text || "")) ||
    summarizeWritten(String(it.asr_text || it.raw_asr_text || "")) ||
    ""
  );
}

/**
 * 用 pipeline cue 重建/覆盖分段：
 * - 一段 = 一个 cue（避免超长重叠段盖住后面）
 * - 介绍 = 短书面 extract（否则 ASR）
 */
export async function overlaySpokenCaptionsFromPipeline(
  courseId: string,
  lectureId: string,
  segments: VideoSegment[]
): Promise<VideoSegment[]> {
  const lid = String(lectureId || "").trim();
  if (!lid) return segments;
  try {
    const rebuilt = await loadPipelineVideoSegments(courseId, lid);
    // pipeline 有有效 cue 时直接用重建结果（去重叠）
    if (rebuilt.some((s) => s.end_sec > s.start_sec && (s.summary || s.title))) {
      return rebuilt;
    }
    // 否则仅清洗旧分段文案
    return enrichVideoSegments(segments);
  } catch {
    return enrichVideoSegments(segments);
  }
}

/** 从 pipeline cue 生成进度条分段（1 cue = 1 段，介绍短书面） */
export async function loadPipelineVideoSegments(
  courseId: string,
  lectureId: string
): Promise<VideoSegment[]> {
  const lid = String(lectureId || "").trim();
  if (!lid) return [];
  try {
    const res = await fetch(
      `${courseDataUrl(courseId, `pipeline/pipeline_build_lecture_${lid}.json`)}?t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: PipelineCueItem[] };
    const items = Array.isArray(data.items) ? data.items : [];
    const segs: VideoSegment[] = [];
    let prevEnd = 0;
    items.forEach((it, i) => {
      const start = Number(it.start_sec);
      const end = Number(it.end_sec);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      // 空隙：保留时间轴刻度但不写介绍
      if (segs.length === 0 && start > 2) {
        segs.push({
          id: `${lid}-lead-0`,
          index: 1,
          start_sec: 0,
          end_sec: start,
          title: "",
          summary: "",
        });
      } else if (start > prevEnd + 8) {
        segs.push({
          id: `${lid}-gap-${i}`,
          index: segs.length + 1,
          start_sec: prevEnd,
          end_sec: start,
          title: "",
          summary: "",
        });
      }
      const summary = captionFromCue(it);
      segs.push({
        id: String(it.cue_id || `${lid}-cue-${i}`),
        index: segs.length + 1,
        start_sec: start,
        end_sec: end,
        title: summary,
        summary,
      });
      prevEnd = end;
    });
    return dedupeOverlappingSegments(segs.map((s, i) => ({ ...s, index: i + 1 })));
  } catch {
    return [];
  }
}

/**
 * 去掉明显“吞并”其它段的超长重叠段（保留更短、更贴时间轴的段）。
 */
export function dedupeOverlappingSegments(
  segments: VideoSegment[]
): VideoSegment[] {
  if (segments.length <= 1) return segments;
  const sorted = [...segments].sort(
    (a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec
  );
  const keep: VideoSegment[] = [];
  for (const seg of sorted) {
    const dur = Math.max(0, seg.end_sec - seg.start_sec);
    // 若已被更短段基本覆盖，或自己盖住多段且过长 → 丢弃超长吞并者
    const coveredByShorter = keep.some((k) => {
      const kd = Math.max(0, k.end_sec - k.start_sec);
      if (kd >= dur) return false;
      const ov =
        Math.min(seg.end_sec, k.end_sec) - Math.max(seg.start_sec, k.start_sec);
      return ov > kd * 0.85;
    });
    if (coveredByShorter) continue;

    // 若当前段几乎完全包含已有某短段，且自身长得多，也跳过（后写的长段）
    const swallows = keep.some((k) => {
      const kd = Math.max(0, k.end_sec - k.start_sec);
      if (dur < kd * 1.8) return false;
      return seg.start_sec <= k.start_sec + 0.5 && seg.end_sec >= k.end_sec - 0.5;
    });
    if (swallows) continue;

    keep.push(seg);
  }

  // 再滤：若某段时长 > 其它段总跨度的很大一部分且与多段重叠，去掉
  const refined = keep.filter((seg) => {
    const dur = seg.end_sec - seg.start_sec;
    if (dur < 600) return true;
    let hits = 0;
    for (const o of keep) {
      if (o === seg) continue;
      const ov =
        Math.min(seg.end_sec, o.end_sec) - Math.max(seg.start_sec, o.start_sec);
      if (ov > 30) hits += 1;
    }
    return hits < 3;
  });

  return refined.map((s, i) => ({ ...s, index: i + 1 }));
}
