/**
 * 经典加权 PageRank（在后处理图上计算）。
 * 应在 processLectureKg（含多关系合并为单条）之后调用，与展示拓扑一致。
 */
import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";

const RELATION_WEIGHTS: Record<string, number> = {
  part_of: 3,
  belong_to: 3,
  depend_on: 2,
  property_of: 1.5,
  synonym_of: 1.2,
  related_with: 1,
};

const DEFAULT_DAMPING = 0.85;
const MAX_ITERS = 80;
const TOL = 1e-8;

function relOf(e: PipelineEdge): string {
  return String(e.relation || e.label || "related_with")
    .split("|")[0]
    .trim()
    .toLowerCase() || "related_with";
}

function edgeWeight(e: PipelineEdge): number {
  return RELATION_WEIGHTS[relOf(e)] ?? 1;
}

function sizeFromImportance(score: number): number {
  const s = Math.max(0, Math.min(1, score));
  return 10 + (36 - 10) * s;
}

function normalize(scores: Record<string, number>): Record<string, number> {
  const vals = Object.values(scores);
  if (!vals.length) return scores;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (hi <= lo) {
    const out: Record<string, number> = {};
    for (const k of Object.keys(scores)) out[k] = 0.5;
    return out;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(scores)) {
    out[k] = (v - lo) / (hi - lo);
  }
  return out;
}

/** 在给定边集上跑经典加权 PageRank，返回 min-max 到 [0,1] 的分数。 */
export function classicPagerankScores(
  nodeIds: string[],
  edges: PipelineEdge[],
  opts: { damping?: number } = {}
): Record<string, number> {
  const damping = opts.damping ?? DEFAULT_DAMPING;
  const ids = [...new Set(nodeIds.filter(Boolean))];
  if (!ids.length) return {};

  const idSet = new Set(ids);
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;

  // 出边：u → list of {to, w}
  const out: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
  const outW = new Float64Array(n);

  for (const e of edges) {
    const src = String(e.source || "");
    if (
      src === "process_rule" ||
      src === "process_node" ||
      src === "process_isolated"
    ) {
      continue;
    }
    const from = e.from;
    const to = e.to;
    if (!from || !to || from === to) continue;
    if (!idSet.has(from) || !idSet.has(to)) continue;
    const i = index.get(from)!;
    const j = index.get(to)!;
    const w = edgeWeight(e);
    // 同向多边：取最大权（后处理后一般已是单条）
    const prev = out[i].find((x) => x.to === j);
    if (prev) {
      if (w > prev.w) {
        outW[i] += w - prev.w;
        prev.w = w;
      }
    } else {
      out[i].push({ to: j, w });
      outW[i] += w;
    }
  }

  let rank = new Float64Array(n);
  const fill = 1 / n;
  for (let i = 0; i < n; i++) rank[i] = fill;

  const teleport = (1 - damping) / n;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (outW[i] <= 0) dangling += rank[i];
    }
    const danglingShare = (damping * dangling) / n;
    for (let i = 0; i < n; i++) {
      next[i] = teleport + danglingShare;
    }
    for (let i = 0; i < n; i++) {
      const ow = outW[i];
      if (ow <= 0) continue;
      const mass = (damping * rank[i]) / ow;
      for (const { to, w } of out[i]) {
        next[to] += mass * w;
      }
    }
    let diff = 0;
    for (let i = 0; i < n; i++) {
      diff += Math.abs(next[i] - rank[i]);
    }
    rank = next;
    if (diff < TOL) break;
  }

  const raw: Record<string, number> = {};
  for (let i = 0; i < n; i++) raw[ids[i]] = rank[i];
  return normalize(raw);
}

/** 用后处理图上的 PageRank 覆盖节点 importance / size。 */
export function applyClassicPagerankToNodes(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  opts: { damping?: number } = {}
): PipelineNode[] {
  const scores = classicPagerankScores(
    nodes.map((n) => n.id),
    edges,
    opts
  );
  return nodes.map((n) => {
    const importance = scores[n.id];
    if (importance == null || !Number.isFinite(importance)) {
      return { ...n, importance: n.importance ?? 0, size: n.size };
    }
    return {
      ...n,
      importance,
      importance_base: null,
      importance_delta: null,
      importance_contributions: null,
      size: sizeFromImportance(importance),
    };
  });
}
