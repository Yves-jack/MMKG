/**
 * 课堂 KG 前端展示层筛选（与后端 entity_triage 无关）。
 *
 * 管线顺序：
 * 1. pipeline_build 各 cue merge 并集（主图原始数据）
 * 2. 讲次 / 片段边筛（buildKgViewFromPipeline）
 * 3. processLectureKg（含孤立/短路径剪枝）
 * 4. 重要性 hide | reveal（本文件：按保留百分比取头部节点）
 * 5. related_with 边隐藏（本文件）；隐藏后会再跑一轮短路径剪枝
 * mmkg 仅作实体描述 enrichment，不改边集。
 */

import type { PipelineEdge, PipelineNode, PipelineStage } from "@/lib/graph/types";
import { pruneShortPathComponents } from "@/lib/kg/lectureKgProcess";

export type ImportanceFilterMode = "hide" | "reveal";

export function nodeImportance(n: Pick<PipelineNode, "importance" | "importance_base">): number {
  const s = n.importance ?? n.importance_base ?? 0;
  return Number(s) || 0;
}

/** 有显式分才返回数字；缺失返回 null（筛零分时不应当成 0 丢掉） */
export function nodeImportanceOrNull(
  n: Pick<PipelineNode, "importance" | "importance_base">
): number | null {
  if (n.importance != null && Number.isFinite(Number(n.importance))) {
    return Number(n.importance);
  }
  if (n.importance_base != null && Number.isFinite(Number(n.importance_base))) {
    return Number(n.importance_base);
  }
  return null;
}

/** @deprecated 阈值模式：score≥τ 保留；请改用 selectImportanceKeepSetByPercent */
export function selectImportanceKeepSet(
  nodes: PipelineNode[],
  tau: number
): Set<string> {
  const keep = new Set<string>();
  const keepUnknown = tau > 0 && tau <= 0.15;
  for (const n of nodes) {
    const s = nodeImportanceOrNull(n);
    if (s == null) {
      if (keepUnknown) keep.add(n.id);
      continue;
    }
    if (s >= tau) keep.add(n.id);
  }
  if (keep.size === 0) {
    for (const n of nodes) {
      if (nodeImportanceOrNull(n) == null) keep.add(n.id);
    }
  }
  return keep;
}

/**
 * 按重要性保留前 keepPercent% 的节点（个数向上取整，至少 1）。
 * keepPercent≥100：全保留；≤0：不保留。
 * 无分数节点排在末尾（优先被裁掉）。
 */
export function selectImportanceKeepSetByPercent(
  nodes: PipelineNode[],
  keepPercent: number
): Set<string> {
  const p = Number(keepPercent);
  if (!Number.isFinite(p) || p >= 100) {
    return new Set(nodes.map((n) => n.id));
  }
  if (p <= 0 || !nodes.length) return new Set();
  const ranked = [...nodes].sort((a, b) => {
    const sa = nodeImportanceOrNull(a);
    const sb = nodeImportanceOrNull(b);
    const va = sa == null ? Number.NEGATIVE_INFINITY : sa;
    const vb = sb == null ? Number.NEGATIVE_INFINITY : sb;
    return vb - va || String(a.id).localeCompare(String(b.id));
  });
  const k = Math.max(1, Math.ceil((ranked.length * Math.min(100, p)) / 100));
  return new Set(ranked.slice(0, k).map((n) => n.id));
}

/** 去掉度数为 0 的孤立节点（无任何边） */
export function dropIsolatedNodes(
  nodes: PipelineNode[],
  edges: PipelineEdge[]
): { nodes: PipelineNode[]; edges: PipelineEdge[]; dropped: number } {
  const deg = new Set<string>();
  for (const e of edges) {
    if (e.from) deg.add(e.from);
    if (e.to) deg.add(e.to);
  }
  const nextNodes = nodes.filter((n) => deg.has(n.id));
  return {
    nodes: nextNodes,
    edges,
    dropped: nodes.length - nextNodes.length,
  };
}

export type ImportanceFilterResult = {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  filteredCount: number;
};

/**
 * @param keepPercent 保留重要性最高的前百分之几（1–100）；null/≥100 不过滤
 * @param mode hide — 删除被筛节点及两端不在 keep 的边（默认），并去掉孤立点
 * @param mode reveal — 保留全图，对被筛节点打 filtered_by_importance（灰色弱化）
 * @param tau 兼容旧阈值模式；若提供 keepPercent 则优先百分比
 */
export function applyImportanceFilter(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  opts: {
    keepPercent?: number | null | undefined;
    tau?: number | null | undefined;
    mode?: ImportanceFilterMode;
    dropIsolates?: boolean;
    /** 搜索定位等场景强制保留的节点（即使低于当前保留百分比） */
    forceKeepIds?: Iterable<string> | null;
  }
): ImportanceFilterResult {
  const mode: ImportanceFilterMode = opts.mode || "hide";
  const dropIsolates = opts.dropIsolates !== false;

  let keep: Set<string> | null = null;
  if (opts.keepPercent != null && Number.isFinite(Number(opts.keepPercent))) {
    const p = Number(opts.keepPercent);
    if (p < 100) keep = selectImportanceKeepSetByPercent(nodes, p);
  } else {
    const tau = opts.tau;
    if (tau != null && Number.isFinite(tau) && tau > 0) {
      keep = selectImportanceKeepSet(nodes, tau);
    }
  }
  const forceKeep = new Set<string>();
  if (opts.forceKeepIds) {
    for (const id of opts.forceKeepIds) {
      const s = String(id || "").trim();
      if (s) forceKeep.add(s);
    }
  }
  if (keep && forceKeep.size) {
    for (const id of forceKeep) keep.add(id);
    // 一并保留一跳邻居，避免搜到的点因孤立被再剪掉
    for (const e of edges) {
      if (forceKeep.has(e.from) && e.to) keep.add(e.to);
      if (forceKeep.has(e.to) && e.from) keep.add(e.from);
    }
  }

  if (!keep) {
    // keepPercent≥100 / 未设阈值：保留全图，不再丢孤立点（否则「当前」永远对不上「总数」）
    const cleared = nodes.map((n) => ({ ...n, filtered_by_importance: false }));
    return { nodes: cleared, edges: [...edges], filteredCount: 0 };
  }

  if (mode === "reveal") {
    let filteredCount = 0;
    const nextNodes = nodes.map((n) => {
      const filtered = !keep!.has(n.id);
      if (filtered) filteredCount += 1;
      return { ...n, filtered_by_importance: filtered };
    });
    return { nodes: nextNodes, edges: [...edges], filteredCount };
  }

  const nextNodes = nodes
    .filter((n) => keep!.has(n.id))
    .map((n) => ({ ...n, filtered_by_importance: false }));
  const nextEdges = edges.filter((e) => keep!.has(e.from) && keep!.has(e.to));
  // 去掉低分节点后，可能再产生短路径子图 → 一并剪掉
  const iso = pruneShortPathComponents(nextEdges);
  const isoKeptIds = new Set(iso.kept.map((e) => e.id));
  // 强制保留点相关的边：即使短路径剪枝也不丢掉
  const forcedEdges =
    forceKeep.size > 0
      ? nextEdges.filter(
          (e) =>
            !isoKeptIds.has(e.id) &&
            (forceKeep.has(e.from) || forceKeep.has(e.to))
        )
      : [];
  const forcedEdgeIds = new Set(forcedEdges.map((e) => e.id));
  const isoRemoved = iso.removed.filter((e) => !forcedEdgeIds.has(e.id));
  const isoKept = [...iso.kept, ...forcedEdges];
  const nodeMap = new Map(nextNodes.map((n) => [n.id, n]));
  const keptIds = new Set<string>();
  for (const e of isoKept) {
    keptIds.add(e.from);
    keptIds.add(e.to);
  }
  for (const id of forceKeep) {
    if (nodeMap.has(id)) keptIds.add(id);
  }
  for (const e of isoRemoved) {
    for (const id of [e.from, e.to]) {
      if (!id || nodeMap.has(id)) continue;
      const prev = nodes.find((n) => n.id === id);
      nodeMap.set(id, {
        ...(prev || { id }),
        id,
        label: prev?.label || id.split("/")[0],
        kind: prev?.kind || "filtered",
        title: prev?.title || `${id}\n（短路径剪枝）`,
        filtered_by_importance: false,
      });
    }
  }
  // hide 模式：主图只保留仍连着 kept 边的节点；处理边端点仍挂上供图例
  let outNodes: PipelineNode[] = [...nodeMap.values()].filter(
    (n) =>
      keptIds.has(n.id) ||
      forceKeep.has(n.id) ||
      isoRemoved.some((e) => e.from === n.id || e.to === n.id)
  );
  let outEdges = [...isoKept, ...isoRemoved];
  if (dropIsolates) {
    // 仅按「保留边」判定孤立，避免短路径删除边把孤立点又挂回来显示
    const d = dropIsolatedNodes(
      outNodes.filter((n) => keptIds.has(n.id) || forceKeep.has(n.id)),
      isoKept
    );
    const processEnds = new Set<string>();
    for (const e of isoRemoved) {
      if (e.from) processEnds.add(e.from);
      if (e.to) processEnds.add(e.to);
    }
    const byId = new Map(outNodes.map((n) => [n.id, n]));
    const merged = new Map(d.nodes.map((n) => [n.id, n]));
    for (const id of forceKeep) {
      if (!merged.has(id)) {
        const n = byId.get(id) || nodeMap.get(id);
        if (n) merged.set(id, n);
      }
    }
    outNodes = [
      ...merged.values(),
      ...[...processEnds]
        .filter((id) => !merged.has(id))
        .map((id) => byId.get(id))
        .filter(Boolean) as PipelineNode[],
    ];
    outEdges = [...d.edges, ...isoRemoved];
    // 强制点相关边若被 dropIsolates 丢掉，补回
    if (forceKeep.size) {
      const haveE = new Set(outEdges.map((e) => e.id));
      for (const e of isoKept) {
        if (haveE.has(e.id)) continue;
        if (forceKeep.has(e.from) || forceKeep.has(e.to)) {
          if (merged.has(e.from) && merged.has(e.to)) {
            outEdges.push(e);
            haveE.add(e.id);
          }
        }
      }
    }
  }
  return {
    nodes: outNodes,
    edges: outEdges,
    filteredCount: nodes.length - nextNodes.length,
  };
}

function isProcessSource(source?: string | null): boolean {
  const s = (source || "").trim();
  return (
    s === "process_rule" || s === "process_node" || s === "process_isolated"
  );
}

/**
 * 隐藏 related_with。
 * @param pruneShortPaths 默认 true：隐藏后再剪最长路径≤2（课堂 KG 图例用）。
 *   复习图谱传 false：只隐藏，不二次剪枝，避免「单边」观感变化。
 * @param forceKeepIds 搜索钉回等：保留这些点及一跳邻居；与钉回相关的 related_with 边也暂留
 */
export function applyRelatedWithVisibility(
  stage: PipelineStage,
  hideRelatedWith: boolean,
  opts: {
    pruneShortPaths?: boolean;
    forceKeepIds?: Iterable<string> | null;
  } = {}
): PipelineStage {
  if (!hideRelatedWith) return stage;
  const pruneShortPaths = opts.pruneShortPaths !== false;
  const allEdges = stage.edges || [];
  const forceKeep = new Set<string>();
  if (opts.forceKeepIds) {
    for (const id of opts.forceKeepIds) {
      const s = String(id || "").trim();
      if (s) forceKeep.add(s);
    }
  }
  if (forceKeep.size) {
    for (const e of allEdges) {
      if (forceKeep.has(String(e.from || "")) && e.to) forceKeep.add(String(e.to));
      if (forceKeep.has(String(e.to || "")) && e.from) forceKeep.add(String(e.from));
    }
  }
  const withoutRel = allEdges.filter((e) => {
    if ((e.relation || e.label || "") !== "related_with") return true;
    // 钉回邻域：暂留相关 related_with，避免邻居被裁成孤立点
    return (
      forceKeep.size > 0 &&
      (forceKeep.has(String(e.from || "")) || forceKeep.has(String(e.to || "")))
    );
  });
  const processKept = withoutRel.filter((e) => isProcessSource(e.source));
  const main = withoutRel.filter((e) => !isProcessSource(e.source));

  if (!pruneShortPaths) {
    const keep = new Set<string>();
    for (const e of [...main, ...processKept]) {
      if (e.from) keep.add(e.from);
      if (e.to) keep.add(e.to);
    }
    for (const id of forceKeep) keep.add(id);
    return {
      ...stage,
      edges: [...main, ...processKept],
      nodes: (stage.nodes || []).filter((n) => keep.has(n.id)),
      stats: {
        ...(stage.stats || {}),
        related_with_hidden: allEdges.length - withoutRel.length,
        process_kept: main.length,
        total: main.length,
      },
    };
  }

  const iso = pruneShortPathComponents(main);
  const es = [...iso.kept, ...processKept, ...iso.removed];
  const keep = new Set<string>();
  for (const e of es) {
    if (e.from) keep.add(e.from);
    if (e.to) keep.add(e.to);
  }
  for (const id of forceKeep) keep.add(id);
  const extraIso = iso.removed.length;
  const prevIso = Number(stage.stats?.process_isolated_removed || 0);
  return {
    ...stage,
    edges: es,
    nodes: (stage.nodes || []).filter((n) => keep.has(n.id)),
    stats: {
      ...(stage.stats || {}),
      related_with_hidden: allEdges.length - withoutRel.length,
      process_isolated_removed: prevIso + extraIso,
      process_kept: iso.kept.length,
      total: iso.kept.length,
    },
  };
}
