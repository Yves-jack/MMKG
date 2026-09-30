/**
 * 课堂重要性向上传递：以课堂分为初值，按拓扑层从子节点向父节点贡献重要性。
 *
 * 规则（v3，与后端 propagate_importance.py 同源）：
 * - 父边：belong_to / part_of / depend_on（from=子 → to=父）
 * - 自底向上；每个子向各父贡献 child×RATE/√父数（RATE=0.22）
 * - 用渐近饱和合并：parent = own + (1-own)·(1-e^(-boost/τ))
 *   避免线性累加把大量枢纽直接顶到 1.0
 * - 子节点自身不扣减
 */
import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";

const PARENT_RELS = new Set(["belong_to", "part_of", "depend_on"]);

/** 与后端 PROPAGATE_RATE 对齐 */
export const PROPAGATE_RATE = 0.22;
/** 渐近饱和尺度：boost 约等于 τ 时吃掉约 63% 剩余空间 */
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
  const s = Math.max(0, Math.min(1, score));
  return 10 + (36 - 10) * s;
}

function mergeBoost(own: number, boost: number, tau = PROPAGATE_TAU): number {
  const o = Math.max(0, Math.min(1, own));
  const b = Math.max(0, boost);
  if (b <= 1e-12) return o;
  const t = Math.max(1e-6, tau);
  return o + (1 - o) * (1 - Math.exp(-b / t));
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

export type PropagateImportanceStats = {
  layers: number;
  edges_used: number;
  boosted_nodes: number;
  started_from_min_outdiff: boolean;
};

export function propagateImportanceToParents(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  opts: { rate?: number; tau?: number } = {}
): { nodes: PipelineNode[]; stats: PropagateImportanceStats } {
  const rate = opts.rate ?? PROPAGATE_RATE;
  const tau = opts.tau ?? PROPAGATE_TAU;
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

  if (!edgeCount) {
    return {
      nodes,
      stats: {
        layers: 0,
        edges_used: 0,
        boosted_nodes: 0,
        started_from_min_outdiff: false,
      },
    };
  }

  const { indeg: baseIndeg, outdeg } = degrees(adj);
  const indeg = new Map(baseIndeg);
  const remaining = new Set(nodeIds);
  let layer = 0;
  let startedFromMinOutdiff = false;
  let firstPick = true;

  while (remaining.size) {
    const seeds = pickLayerSeeds(remaining, indeg, outdeg);
    if (!seeds.length) break;

    if (firstPick) {
      const anyZero = seeds.some((id) => (baseIndeg.get(id) || 0) === 0);
      startedFromMinOutdiff = !anyZero;
      firstPick = false;
    }

    // 本层先结算渐近合并，再向父累计 boost（用合并后的分）
    for (const id of seeds) {
      const own = initial.get(id) || 0;
      const boost = boostAcc.get(id) || 0;
      scores.set(id, mergeBoost(own, boost, tau));
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

  // 剩余未出队的节点也做一次合并
  for (const id of nodeIds) {
    const own = initial.get(id) || 0;
    const boost = boostAcc.get(id) || 0;
    scores.set(id, mergeBoost(own, boost, tau));
  }

  let boosted = 0;
  const out = nodes.map((n) => {
    const before = initial.get(n.id) || 0;
    const after = Math.min(1, Math.max(0, scores.get(n.id) || 0));
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
    if (after > before + 1e-12) boosted += 1;
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
    },
  };
}
