/**
 * 课堂 KG 前端展示层筛选（与后端 entity_triage 无关）。
 *
 * 管线顺序：
 * 1. pipeline_build 各 cue merge 并集（主图原始数据）
 * 2. 讲次 / 片段边筛（buildKgViewFromPipeline）
 * 3. 重要性 hide | reveal（本文件）
 * 4. related_with 边隐藏（本文件 applyRelatedWithVisibility）
 * mmkg 仅作实体描述 enrichment，不改边集。
 */

import type { PipelineEdge, PipelineNode, PipelineStage } from "@/lib/pipeline/types";

export type ImportanceFilterMode = "hide" | "reveal";

export function nodeImportance(n: Pick<PipelineNode, "importance" | "importance_base">): number {
  const s = n.importance ?? n.importance_base ?? 0;
  return Number(s) || 0;
}

/** score≥τ 的核节点，以及与核相连的 1-hop（低分邻接仍算「保留」，不算被筛） */
export function selectImportanceKeepSet(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  tau: number
): Set<string> {
  const keep = new Set<string>();
  for (const n of nodes) {
    if (nodeImportance(n) >= tau) keep.add(n.id);
  }
  for (const e of edges) {
    if (keep.has(e.from) || keep.has(e.to)) {
      keep.add(e.from);
      keep.add(e.to);
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

  const keep = selectImportanceKeepSet(nodes, edges, tau);

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
  return {
    nodes: nextNodes,
    edges: nextEdges,
    filteredCount: nodes.length - nextNodes.length,
  };
}

/** 隐藏 related_with 边后，只保留仍有边相连的节点 */
export function applyRelatedWithVisibility(
  stage: PipelineStage,
  hideRelatedWith: boolean
): PipelineStage {
  if (!hideRelatedWith) return stage;
  const allEdges = stage.edges || [];
  const es = allEdges.filter((e) => (e.relation || e.label || "") !== "related_with");
  const keep = new Set<string>();
  for (const e of es) {
    if (e.from) keep.add(e.from);
    if (e.to) keep.add(e.to);
  }
  return {
    ...stage,
    edges: es,
    nodes: (stage.nodes || []).filter((n) => keep.has(n.id)),
    stats: {
      ...(stage.stats || {}),
      related_with_hidden: allEdges.length - es.length,
      total: es.length,
    },
  };
}
