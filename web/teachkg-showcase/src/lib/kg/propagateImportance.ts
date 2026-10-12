/**
 * 课堂重要性沿图谱层次向上传递：以课堂分为初值，按箭头方向贡献。
 *
 * 规则（v5）：
 * - 层次边：belong_to / part_of / depend_on；箭头 from=子 → to=父
 * - 自底向上；每个子向各父贡献 child×RATE/√父数（RATE=0.22）
 * - 线性累加：parent = own + boost（不软加）
 * - 传递结束后按最大值归一：I' = I / max(I)，最大为 1
 * - 子节点自身不扣减
 */
import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";

const PARENT_RELS = new Set(["belong_to", "part_of", "depend_on"]);

/** 与后端 PROPAGATE_RATE 对齐 */
export const PROPAGATE_RATE = 0.22;
/** @deprecated 不再软加；保留常量以免旧调用报错 */
export const PROPAGATE_TAU = 0.45;

function relOf(e: PipelineEdge): string {
  return String(e.relation || e.label || "")
    .trim()
    .toLowerCase();
}

function isProcessSource(src?: string | null) {
  const s = String(src || "");
  return (
    s === "process_rule" ||
    s === "process_node" ||
    s === "process_isolated"
  );
}

function sizeFromImportance(score: number) {
  // 归一后 I∈[0,1]，直接映射点大小
  const s = Math.max(0, Math.min(1, score));
  return 10 + (36 - 10) * s;
}

/** 线性累加：own + boost */
function mergeBoost(own: number, boost: number): number {
  return Math.max(0, own) + Math.max(0, boost);
}

function buildParentAdj(
  nodeIds: Set<string>,
  edges: PipelineEdge[]
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);

  const seen = new Set<string>();
  for (const e of edges) {
    if (isProcessSource(e.source)) continue;
    if (!PARENT_RELS.has(relOf(e))) continue;
    const from = e.from;
    const to = e.to;
    if (!from || !to || from === to) continue;
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    const key = `${from}\t${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    adj.get(from)!.push(to);
  }
  return adj;
}

function degrees(adj: Map<string, string[]>) {
  const indeg = new Map<string, number>();
  const outdeg = new Map<string, number>();
  for (const id of adj.keys()) {
    indeg.set(id, 0);
    outdeg.set(id, 0);
  }
  for (const [from, tos] of adj) {
    outdeg.set(from, tos.length);
    for (const to of tos) {
      indeg.set(to, (indeg.get(to) || 0) + 1);
    }
  }
  return { indeg, outdeg };
}

function pickLayerSeeds(
  remaining: Set<string>,
  indeg: Map<string, number>,
  outdeg: Map<string, number>
): string[] {
  const zeroIn: string[] = [];
  for (const id of remaining) {
    if ((indeg.get(id) || 0) === 0) zeroIn.push(id);
  }
  if (zeroIn.length) return zeroIn;

  let minDiff = Infinity;
  for (const id of remaining) {
    const d = (outdeg.get(id) || 0) - (indeg.get(id) || 0);
    if (d < minDiff) minDiff = d;
  }
  const seeds: string[] = [];
  for (const id of remaining) {
    const d = (outdeg.get(id) || 0) - (indeg.get(id) || 0);
    if (d === minDiff) seeds.push(id);
  }
  return seeds;
}

/** 有分值的节点除以最大值；全 0 则不变 */
function maxNormalize(scores: Map<string, number>): void {
  let hi = 0;
  for (const v of scores.values()) {
    if (v > hi) hi = v;
  }
  if (hi <= 1e-12) return;
  for (const [id, v] of scores) {
    scores.set(id, v / hi);
  }
}

export type PropagateImportanceStats = {
  layers: number;
  edges_used: number;
  boosted_nodes: number;
  started_from_min_outdiff: boolean;
  max_before_norm: number;
};

export function propagateImportanceToParents(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  opts: { rate?: number; tau?: number } = {}
): { nodes: PipelineNode[]; stats: PropagateImportanceStats } {
  const rate = opts.rate ?? PROPAGATE_RATE;
  const nodeIds = new Set(nodes.map((n) => n.id).filter(Boolean));
  const adj = buildParentAdj(nodeIds, edges);
  let edgeCount = 0;
  for (const tos of adj.values()) edgeCount += tos.length;

  const scores = new Map<string, number>();
  const initial = new Map<string, number>();
  const boostAcc = new Map<string, number>();
  /** 是否有显式课堂初值；无初值且未抬升时必须保持 null，否则筛零分会误杀整图 */
  const hadInitial = new Map<string, boolean>();
  for (const n of nodes) {
    const has =
      n.importance != null && Number.isFinite(Number(n.importance));
    const v = has ? Number(n.importance) : 0;
    scores.set(n.id, v);
    initial.set(n.id, v);
    boostAcc.set(n.id, 0);
    hadInitial.set(n.id, has);
  }

  let layer = 0;
  let startedFromMinOutdiff = false;

  if (edgeCount) {
    const { indeg: baseIndeg, outdeg } = degrees(adj);
    const indeg = new Map(baseIndeg);
    const remaining = new Set(nodeIds);
    let firstPick = true;

    while (remaining.size) {
      const seeds = pickLayerSeeds(remaining, indeg, outdeg);
      if (!seeds.length) break;

      if (firstPick) {
        const anyZero = seeds.some((id) => (baseIndeg.get(id) || 0) === 0);
        startedFromMinOutdiff = !anyZero;
        firstPick = false;
      }

      // 本层先线性合并，再向父累计 boost（用合并后的分）
      for (const id of seeds) {
        const own = initial.get(id) || 0;
        const boost = boostAcc.get(id) || 0;
        scores.set(id, mergeBoost(own, boost));
      }

      const layerSnap = new Map<string, number>();
      for (const id of seeds) layerSnap.set(id, scores.get(id) || 0);

      for (const id of seeds) {
        const imp = layerSnap.get(id) || 0;
        const parents = adj.get(id) || [];
        if (imp > 0 && rate > 0 && parents.length) {
          const share = (imp * rate) / Math.sqrt(parents.length);
          for (const parent of parents) {
            if (!nodeIds.has(parent)) continue;
            boostAcc.set(parent, (boostAcc.get(parent) || 0) + share);
          }
        }
        remaining.delete(id);
      }

      for (const id of seeds) {
        for (const parent of adj.get(id) || []) {
          if (!remaining.has(parent)) continue;
          indeg.set(parent, Math.max(0, (indeg.get(parent) || 0) - 1));
        }
      }

      layer += 1;
      if (layer > nodeIds.size + 2) break;
    }

    for (const id of nodeIds) {
      const own = initial.get(id) || 0;
      const boost = boostAcc.get(id) || 0;
      scores.set(id, mergeBoost(own, boost));
    }
  }

  let maxBeforeNorm = 0;
  for (const v of scores.values()) {
    if (v > maxBeforeNorm) maxBeforeNorm = v;
  }
  maxNormalize(scores);

  let boosted = 0;
  const out = nodes.map((n) => {
    const before = initial.get(n.id) || 0;
    const after = Math.max(0, scores.get(n.id) || 0);
    const had = hadInitial.get(n.id) === true;
    // 无课堂初值且传递后仍≈0：保持缺失，供「去掉零分」保留未标注实体
    if (!had && after <= 1e-12) {
      return {
        ...n,
        importance: null,
        importance_base: null,
        importance_delta: null,
      };
    }
    const rawAfter =
      maxBeforeNorm > 1e-12 ? after * maxBeforeNorm : after;
    if (rawAfter > before + 1e-12) boosted += 1;
    return {
      ...n,
      importance: after,
      importance_base: had ? before : null,
      importance_delta: had ? after - before : after,
      size: sizeFromImportance(after),
    };
  });

  return {
    nodes: out,
    stats: {
      layers: layer,
      edges_used: edgeCount,
      boosted_nodes: boosted,
      started_from_min_outdiff: startedFromMinOutdiff,
      max_before_norm: maxBeforeNorm,
    },
  };
}
