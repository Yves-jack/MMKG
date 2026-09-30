/**
 * 课堂 KG 前端展示层筛选（与后端 entity_triage 无关）。
 *
 * 管线顺序：
 * 1. pipeline_build 各 cue merge 并集（主图原始数据）
 * 2. 讲次 / 片段边筛（buildKgViewFromPipeline）
 * 3. processLectureKg（含孤立/短路径剪枝）
 * 4. 重要性 hide | reveal（本文件）
 * 5. related_with 边隐藏（本文件）；隐藏后会再跑一轮短路径剪枝
 * mmkg 仅作实体描述 enrichment，不改边集。
 */

import type { PipelineEdge, PipelineNode, PipelineStage } from "@/lib/pipeline/types";
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

/** score≥τ 保留；无分数节点在低阈值时保留（避免稀疏课堂分讲次被筛空） */
export function selectImportanceKeepSet(
  nodes: PipelineNode[],
  tau: number
): Set<string> {
  const keep = new Set<string>();
  // ≤0.15 视为「轻度筛选」：只挡显式低分/零分，不误杀未标注实体
  const keepUnknown = tau > 0 && tau <= 0.15;
  for (const n of nodes) {
    const s = nodeImportanceOrNull(n);
    if (s == null) {
      if (keepUnknown) keep.add(n.id);
      continue;
    }
    if (s >= tau) keep.add(n.id);
  }
  // 安全网：若几乎筛光但仍有未标注节点，强制保留未标注，避免整图空白
  if (keep.size === 0) {
    for (const n of nodes) {
      if (nodeImportanceOrNull(n) == null) keep.add(n.id);
    }
  }
  return keep;
}

export type ImportanceFilterResult = {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  filteredCount: number;
};

/**
 * @param mode hide — 删除被筛节点及两端不在 keep 的边（默认）
 * @param mode reveal — 保留全图，对被筛节点打 filtered_by_importance（灰色弱化）
 */
export function applyImportanceFilter(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  opts: { tau: number | null | undefined; mode?: ImportanceFilterMode }
): ImportanceFilterResult {
  const tau = opts.tau;
  const mode: ImportanceFilterMode = opts.mode || "hide";
  if (tau == null || !Number.isFinite(tau) || tau <= 0) {
    return {
      nodes: nodes.map((n) => ({ ...n, filtered_by_importance: false })),
      edges: [...edges],
      filteredCount: 0,
    };
  }

  const keep = selectImportanceKeepSet(nodes, tau);

  if (mode === "reveal") {
    let filteredCount = 0;
    const nextNodes = nodes.map((n) => {
      const filtered = !keep.has(n.id);
      if (filtered) filteredCount += 1;
      return { ...n, filtered_by_importance: filtered };
    });
    return { nodes: nextNodes, edges: [...edges], filteredCount };
  }

  const nextNodes = nodes
    .filter((n) => keep.has(n.id))
    .map((n) => ({ ...n, filtered_by_importance: false }));
  const nextEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  // 去掉低分节点后，可能再产生短路径子图 → 一并剪掉
  const iso = pruneShortPathComponents(nextEdges);
  const nodeMap = new Map(nextNodes.map((n) => [n.id, n]));
  const keptIds = new Set<string>();
  for (const e of iso.kept) {
    keptIds.add(e.from);
    keptIds.add(e.to);
  }
  for (const e of iso.removed) {
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
  return {
    nodes: [...nodeMap.values()].filter(
      (n) => keptIds.has(n.id) || iso.removed.some((e) => e.from === n.id || e.to === n.id)
    ),
    edges: [...iso.kept, ...iso.removed],
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
 */
export function applyRelatedWithVisibility(
  stage: PipelineStage,
  hideRelatedWith: boolean,
  opts: { pruneShortPaths?: boolean } = {}
): PipelineStage {
  if (!hideRelatedWith) return stage;
  const pruneShortPaths = opts.pruneShortPaths !== false;
  const allEdges = stage.edges || [];
  const withoutRel = allEdges.filter(
    (e) => (e.relation || e.label || "") !== "related_with"
  );
  const processKept = withoutRel.filter((e) => isProcessSource(e.source));
  const main = withoutRel.filter((e) => !isProcessSource(e.source));

  if (!pruneShortPaths) {
    const keep = new Set<string>();
    for (const e of [...main, ...processKept]) {
      if (e.from) keep.add(e.from);
      if (e.to) keep.add(e.to);
    }
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
