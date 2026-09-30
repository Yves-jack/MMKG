import { courseDataUrl } from "@/lib/course";
import { toMediaUrl } from "@/lib/kg/adaptToPipeline";

export type AsrCaption = {
  start: number;
  end: number;
  text: string;
};

/** 字幕相对 ASR 起点提前量：开口时就该看见，而不是讲了一截才出 */
const CAPTION_LEAD_SEC = 0.45;

function splitRawAsr(raw: string): string[] {
  const cleaned = String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/[，,]{2,}/g, "，")
    .trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= 42) {
      out.push(p);
      continue;
    }
    const bits = p.split(/(?<=[，,、])\s*/).map((s) => s.trim()).filter(Boolean);
    let buf = "";
    for (const b of bits) {
      if (!buf) buf = b;
      else if ((buf + b).length <= 42) buf += b;
      else {
        out.push(buf);
        buf = b;
      }
    }
    if (buf) out.push(buf);
  }
  return out.length ? out : [cleaned];
}

function captionsFromCue(
  text: string,
  startSec: number,
  endSec: number
): AsrCaption[] {
  const start = Number(startSec);
  const end = Number(endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const chunks = splitRawAsr(text);
  if (!chunks.length) return [];
  const weights = chunks.map((c) => Math.max(4, c.length));
  const total = weights.reduce((s, n) => s + n, 0) || 1;
  const span = end - start;
  let acc = 0;
  return chunks.map((chunk, i) => {
    const a = start + (acc / total) * span;
    acc += weights[i];
    const b = i === chunks.length - 1 ? end : start + (acc / total) * span;
    return { start: a, end: Math.max(a + 0.12, b), text: chunk };
  });
}

function capsFromRawList(cues: unknown): AsrCaption[] {
  if (!Array.isArray(cues)) return [];
  const caps: AsrCaption[] = [];
  for (const cue of cues) {
    if (!cue || typeof cue !== "object") continue;
    const row = cue as {
      start_sec?: number;
      end_sec?: number;
      text?: string;
      raw_asr_text?: string;
    };
    const text = String(row.text || row.raw_asr_text || "").trim();
    if (!text) continue;
    caps.push(...captionsFromCue(text, Number(row.start_sec), Number(row.end_sec)));
  }
  caps.sort((a, b) => a.start - b.start || a.end - b.end);
  return caps;
}

async function loadFineAsrCaptions(
  courseId: string,
  lectureId: string
): Promise<AsrCaption[]> {
  const url = toMediaUrl(`segments/${courseId}/asr_work/${lectureId}/raw_cues.json`);
  if (!url) return [];
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { cues?: unknown } | unknown[];
  const cues = Array.isArray(data) ? data : (data as { cues?: unknown }).cues;
  return capsFromRawList(cues);
}

/** 优先用细粒度 raw_cues 时间戳；没有再退回讲次流水线窗口 */
export async function loadLectureAsrCaptions(
  courseId: string,
  lectureId: string
): Promise<AsrCaption[]> {
  try {
    const fine = await loadFineAsrCaptions(courseId, lectureId);
    if (fine.length) return fine;
  } catch {
    /* fallback */
  }

  try {
    const res = await fetch(
      `${courseDataUrl(courseId, `pipeline/pipeline_build_lecture_${lectureId}.json`)}?t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: {
        start_sec?: number;
        end_sec?: number;
        raw_asr_text?: string;
        asr_text?: string;
      }[];
    };
    const caps: AsrCaption[] = [];
    for (const it of data.items || []) {
      const raw = String(it.raw_asr_text || "").trim();
      const text = raw || String(it.asr_text || "").trim();
      if (!text) continue;
      caps.push(...captionsFromCue(text, Number(it.start_sec), Number(it.end_sec)));
    }
    caps.sort((a, b) => a.start - b.start);
    return caps;
  } catch {
    return [];
  }
}

export function captionAt(caps: AsrCaption[], sec: number): AsrCaption | null {
  if (!caps.length || !Number.isFinite(sec)) return null;
  let lo = 0;
  let hi = caps.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (caps[mid].start - CAPTION_LEAD_SEC <= sec) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return null;
  const c = caps[idx];
  if (sec >= c.end) return null;
  return c;
}
