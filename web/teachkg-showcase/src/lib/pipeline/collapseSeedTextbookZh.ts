import {
  buildStagedEntityMergeMap,
  dedupeMergeEdges,
} from "@/lib/kg/lectureKgProcess";
import type { PipelineEdge, PipelineNode, PipelineStage } from "@/lib/pipeline/types";

function primaryZh(name: string): string {
  return String(name || "").split("/")[0]?.trim() || String(name || "");
}

function remapId(id: string, mergeMap: Map<string, string>): string {
  if (!id) return id;
  return mergeMap.get(id) || id;
}

function collapseNodes(
  nodes: PipelineNode[],
  mergeMap: Map<string, string>
): PipelineNode[] {
  if (!nodes.length || !mergeMap.size) return nodes;
  const nodeMap = new Map<string, PipelineNode>();
  for (const n of nodes) {
    if (!n?.id) continue;
    const id = remapId(n.id, mergeMap);
    const prev = nodeMap.get(id);
    const aliases = [
      ...new Set(
        [...(prev?.aliases || []), ...(n.aliases || [])].filter(
          (a) => a && a !== id
        )
      ),
    ];
    if (!prev) {
      nodeMap.set(id, {
        ...n,
        id,
        label: primaryZh(id) || n.label,
        aliases: aliases.length ? aliases : undefined,
      });
      continue;
    }
    // 种子展示：alias 优先于 embedding；非 filtered 优先
    const preferIncoming =
      (String(n.kind || "").includes("alias") &&
        !String(prev.kind || "").includes("alias")) ||
      (String(prev.kind || "").includes("filtered") &&
        !String(n.kind || "").includes("filtered"));
    const base = preferIncoming ? n : prev;
    const other = preferIncoming ? prev : n;
    nodeMap.set(id, {
      ...base,
      id,
      label: primaryZh(id) || base.label || other.label,
      aliases: aliases.length ? aliases : undefined,
      kind: base.kind || other.kind,
      title: base.title || other.title,
      description: base.description || other.description,
    });
  }
  return [...nodeMap.values()];
}

function collapseEdges(
  edges: PipelineEdge[],
  mergeMap: Map<string, string>
): PipelineEdge[] {
  if (!edges.length || !mergeMap.size) return edges;
  return edges.map((e) => ({
    ...e,
    from: remapId(e.from, mergeMap),
    to: remapId(e.to, mergeMap),
  }));
}

/**
 * 种子实体 + 教材子图同中文名合并映射；用于改写后续阶段端点。
 * 融合结果本身不再做额外处理，只吃这里消掉的重复。
 */
export function buildSeedTextbookZhMergeMap(
  stages: PipelineStage[]
): Map<string, string> {
  const names = new Set<string>();
  const textbookNames = new Set<string>();
  for (const st of stages) {
    const sid = String(st.id || "");
    if (sid !== "seeds" && sid !== "textbook") continue;
    for (const n of st.nodes || []) {
      if (n?.id) names.add(String(n.id).trim());
    }
    for (const e of st.edges || []) {
      if (e?.from) names.add(String(e.from).trim());
      if (e?.to) names.add(String(e.to).trim());
      if (sid === "textbook") {
        const src = String(e.source || "");
        if (src === "textbook" || src === "textbook_revised") {
          if (e.from) textbookNames.add(String(e.from).trim());
          if (e.to) textbookNames.add(String(e.to).trim());
        }
      }
    }
  }
  return buildStagedEntityMergeMap(names, textbookNames);
}

const REMAP_STAGE_IDS = new Set([
  "seeds",
  "textbook",
  "correct",
  "delta",
  "merge",
  "cross_cue",
  "session_merge",
  "course_merge",
]);

function shouldRemapStage(id: string): boolean {
  return (
    REMAP_STAGE_IDS.has(id) ||
    id.startsWith("merge__") ||
    id.startsWith("course_merge__")
  );
}

/**
 * 按种子/教材同名映射改写各阶段节点与边端点。
 * textbook/correct 顺带做 SPO 去重；merge 只改写端点（简单拼接语义）。
 */
export function applySeedTextbookZhCollapse(
  stages: PipelineStage[]
): PipelineStage[] {
  const mergeMap = buildSeedTextbookZhMergeMap(stages);
  if (!mergeMap.size) return stages;

  return stages.map((st) => {
    const sid = String(st.id || "");
    if (!shouldRemapStage(sid)) return st;
    let nodes = collapseNodes(st.nodes || [], mergeMap);
    let edges = collapseEdges(st.edges || [], mergeMap);
    if (sid === "textbook" || sid === "correct") {
      edges = dedupeMergeEdges(edges);
    }
    return { ...st, nodes, edges };
  });
}
