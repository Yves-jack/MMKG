import type { PipelineEdge, PipelineItem, PipelineNode } from "@/lib/pipeline/types";

/** 与后端 build_char_half_windows 对齐：字数窗 + 半窗滑动 */
export function buildCharHalfWindows(
  lengths: number[],
  charBudget = 1500
): [number, number][] {
  const n = lengths.length;
  if (n < 2) return [];
  const budget = Math.max(1, Math.floor(charBudget || 1500));
  const windows: [number, number][] = [];
  let start = 0;
  let guard = 0;
  while (start < n - 1 && guard < n * 4) {
    guard += 1;
    let end = start;
    let total = 0;
    while (end < n) {
      total += Math.max(0, lengths[end] || 0);
      end += 1;
      // 至少 2 段后，达到字数阈值即可停
      if (end - start >= 2 && total >= budget) break;
    }
    const last = end - 1;
    // 至少 2 段；单段不成跨段
    if (last <= start) break;
    windows.push([start, last]);

    // 已含最后一段：后续小窗必为子集，停止
    if (last >= n - 1) break;

    const midTarget = Math.floor(total / 2);
    let acc = 0;
    let midIdx = start;
    for (let i = start; i < end; i++) {
      acc += Math.max(0, lengths[i] || 0);
      if (acc >= midTarget) {
        midIdx = i;
        break;
      }
    }
    let nextStart = midIdx > start ? midIdx : start + 1;
    if (nextStart <= start) nextStart = start + 1;
    // 下一窗还需至少还能再拼一段
    if (nextStart >= n - 1) break;
    start = nextStart;
  }
  return windows;
}

function lectureOrdinal(lectureId: string): string {
  const m = String(lectureId || "").match(/(\d+)/);
  return m ? String(Number(m[1])) : String(lectureId || "?").trim() || "?";
}

export function formatCrossCueSourceSpan(
  lectureId: string,
  startSeg1: number,
  endSeg1: number
): string {
  const n = lectureOrdinal(lectureId);
  const a = Math.max(1, startSeg1);
  const b = Math.max(a, endSeg1);
  return `第${n}讲的第${a}段到第${b}段`;
}

function zhLabel(name?: string | null) {
  return (name || "").split("/")[0];
}

function extractTextOf(item: PipelineItem): string {
  const merge = (item.stages || []).find((s) => s.id === "merge");
  return (
    (merge?.text || "").trim() ||
    (item.extract_text || "").trim() ||
    (item.asr_text || "").trim()
  );
}

/**
 * 若导出尚未写入跨段窗口项，则根据片段文本 + cross_cue_edges 在前端拼出列表末尾项。
 */
export function ensureCrossCueWindowItems(
  items: PipelineItem[],
  lectureId: string,
  charBudget = 1500
): PipelineItem[] {
  if (!items.length) return items;
  if (items.some((it) => it.is_cross_cue)) return items;

  const frags = items.filter((it) => !String(it.cue_id || "").startsWith("__cross_cue__"));
  const ordered = frags
    .map((it) => ({ it, text: extractTextOf(it) }))
    .filter((x) => x.text);
  if (ordered.length < 2) return items;

  const bySpan = new Map<string, PipelineEdge[]>();
  for (const { it } of ordered) {
    for (const e of it.cross_cue_edges || []) {
      if (!e?.from || !e?.to) continue;
      const span = String(e.extract_source || "").trim() || "cross_cue";
      const list = bySpan.get(span) || [];
      list.push({ ...e, source: "cross_cue" });
      bySpan.set(span, list);
    }
  }

  const lengths = ordered.map((x) => x.text.length);
  const windows = buildCharHalfWindows(lengths, charBudget);
  if (!windows.length) return items;

  const crossItems: PipelineItem[] = windows.map(([si, ei]) => {
    const span = formatCrossCueSourceSpan(lectureId, si + 1, ei + 1);
    const segs = ordered.slice(si, ei + 1);
    const windowText = segs
      .map((x, offset) => {
        const segNo = si + offset + 1;
        return `### 第${segNo}段\n${x.text}`;
      })
      .join("\n\n");
    const edges = (bySpan.get(span) || []).map((e, i) => ({
      ...e,
      id: e.id || `cross-${si + 1}-${ei + 1}-${i}`,
      source: "cross_cue",
      lecture_id: e.lecture_id || lectureId,
      cue_label: span,
      extract_source: e.extract_source || span,
    }));
    const nodeIds = new Set<string>();
    edges.forEach((e) => {
      if (e.from) nodeIds.add(e.from);
      if (e.to) nodeIds.add(e.to);
    });
    const nodes: PipelineNode[] = [...nodeIds].sort().map((id) => ({
      id,
      label: zhLabel(id),
      kind: "delta",
      title: `${id}\n来源: 跨段衔接`,
    }));
    return {
      cue_id: `__cross_cue__${si + 1}_${ei + 1}`,
      lecture_id: lectureId,
      is_cross_cue: true,
      cross_cue_span: span,
      start_seg: si + 1,
      end_seg: ei + 1,
      start_sec: segs[0]?.it.start_sec,
      end_sec: segs[segs.length - 1]?.it.end_sec,
      extract_text: windowText,
      media: {},
      stages: [
        {
          id: "cross_cue",
          title: "跨段抽取",
          subtitle: span,
          blurb:
            "左栏为窗口内多段拼接文本，右栏为该窗提取的跨段关系（不展示多模态证据）。",
          focus: "graph",
          text: windowText,
          nodes,
          edges,
          stats: {
            segments: ei - si + 1,
            chars: lengths.slice(si, ei + 1).reduce((a, b) => a + b, 0),
            edges: edges.length,
          },
        },
      ],
      cross_cue_edges: edges,
      triplets: [],
    };
  });

  return [...frags, ...crossItems];
}
