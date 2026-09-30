/**
 * 单课复习「关系图谱」：与课堂级 KgPage 同源数据与后处理。
 * 单讲走 lecture 融合；两讲堂次走 session 融合（fuseSessionFromPipelineCues）。
 */
import { courseDataUrl } from "@/lib/course";
import { applyRelatedWithVisibility } from "@/lib/kg/importanceFilter";
import {
  processLectureKg,
  type MultiRelCollapseDecision,
} from "@/lib/kg/lectureKgProcess";
import {
  applyMmkgEnrichmentToNodes,
  buildKgViewFromPipeline,
  enrichPipelineNodesWithImportance,
  loadLecturePipelineCues,
  loadMmkgEntityEnrichment,
  mergeMmkgEnrichmentMaps,
  type MmkgEntityEnrichment,
  type PipelineCueBundle,
} from "@/lib/kg/pipelineMergeSource";
import {
  assignMindmapForest,
  buildMindmapFromForest,
  withUpdatedImportance,
  type MindmapForest,
} from "@/lib/kg/mindmapFromProcessedGraph";
import { propagateImportanceToParents } from "@/lib/kg/propagateImportance";
import { applyClassicPagerankToNodes } from "@/lib/kg/classicPagerank";
import { blendPagerankWithClassroom } from "@/lib/kg/blendPagerankWithClassroom";
import {
  getImportanceSource,
  type ImportanceSource,
} from "@/lib/kg/importanceSource";
import { parseReviewGraphScope } from "@/lib/apps/reviewSession";
import type { MindmapDoc } from "@/components/mindmap/MindmapTree";
import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";

export type ReviewClassroomGraph = {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  stats: {
    nodes: number;
    edges: number;
    process_kept?: number;
  };
  forest: MindmapForest;
};

async function loadCuesSafe(
  lectureId: string,
  courseId: string
): Promise<PipelineCueBundle[]> {
  try {
    return await loadLecturePipelineCues(lectureId, courseId);
  } catch {
    return [];
  }
}

async function loadMultiRelCollapse(
  courseId: string,
  lectureId: string
): Promise<Record<string, MultiRelCollapseDecision>> {
  try {
    const res = await fetch(
      `${courseDataUrl(courseId, `pipeline/multi_rel_collapse_lecture_${lectureId}.json`)}?t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!res.ok) return {};
    const data = await res.json();
    return (data?.decisions || {}) as Record<string, MultiRelCollapseDecision>;
  } catch {
    return {};
  }
}

type ImportancePack = {
  scores: Record<string, number> | null;
  base: Record<string, number> | null;
  classroom: Record<string, number> | null;
  pagerank: Record<string, number> | null;
  contributions: Record<string, Record<string, number>> | null;
};

function emptyImportance(): ImportancePack {
  return {
    scores: null,
    base: null,
    classroom: null,
    pagerank: null,
    contributions: null,
  };
}

function takeMaxMap(
  into: Record<string, number>,
  from?: Record<string, number> | null
) {
  if (!from) return;
  for (const [k, v] of Object.entries(from)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const prev = into[k];
    into[k] = prev == null ? n : Math.max(prev, n);
  }
}

function takeMeanMap(
  into: Record<string, { sum: number; n: number }>,
  from?: Record<string, number> | null
) {
  if (!from) return;
  for (const [k, v] of Object.entries(from)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const prev = into[k] || { sum: 0, n: 0 };
    prev.sum += n;
    prev.n += 1;
    into[k] = prev;
  }
}

function finalizeMeanMap(
  acc: Record<string, { sum: number; n: number }>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, { sum, n }] of Object.entries(acc)) {
    if (n > 0) out[k] = sum / n;
  }
  return out;
}

function collectContextImportance(
  ctx: {
    scores?: Record<string, number>;
    classroom?: Record<string, number>;
    pagerank?: Record<string, number>;
    entities?: Record<
      string,
      { classroom_norm?: number; contributions?: Record<string, number> }
    >;
    top?: Array<{ name?: string; classroom_norm?: number }>;
  } | null
): {
  scores: Record<string, number>;
  classroom: Record<string, number>;
  pagerank: Record<string, number>;
  contributions: Record<string, Record<string, number>>;
} {
  const scores: Record<string, number> = {};
  const classroom: Record<string, number> = {};
  const pagerank: Record<string, number> = {};
  const contributions: Record<string, Record<string, number>> = {};
  if (!ctx) return { scores, classroom, pagerank, contributions };
  takeMaxMap(scores, ctx.scores);
  // 课堂分只取正值；0=无证据，不当作显式零写入
  if (ctx.classroom && typeof ctx.classroom === "object") {
    for (const [name, raw] of Object.entries(ctx.classroom)) {
      const cn = Number(raw);
      if (Number.isFinite(cn) && cn > 1e-12) {
        classroom[name] =
          classroom[name] == null ? cn : Math.max(classroom[name], cn);
      }
    }
  }
  takeMaxMap(pagerank, ctx.pagerank);
  if (ctx.entities && typeof ctx.entities === "object") {
    for (const [name, rec] of Object.entries(ctx.entities)) {
      const cn = Number(rec?.classroom_norm);
      if (Number.isFinite(cn) && cn > 1e-12) {
        classroom[name] =
          classroom[name] == null ? cn : Math.max(classroom[name], cn);
      }
      if (rec?.contributions) contributions[name] = rec.contributions;
    }
  }
  // top 兜底：旧产物 entities 可能缺 classroom_norm；正分吸收，显式 0 可筛
  for (const row of ctx.top || []) {
    const name = String(row?.name || "").trim();
    if (!name) continue;
    const cn = Number(row?.classroom_norm);
    if (!Number.isFinite(cn)) continue;
    if (cn > 1e-12) {
      if (classroom[name] == null) classroom[name] = cn;
    } else if (classroom[name] == null) {
      classroom[name] = 0;
    }
  }
  return { scores, classroom, pagerank, contributions };
}

async function loadImportanceForContexts(
  courseId: string,
  contextKeys: string[]
): Promise<ImportancePack> {
  try {
    const res = await fetch(
      `${courseDataUrl(courseId, "entity_importance_lookup.json")}?t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!res.ok) return emptyImportance();
    const j = await res.json();
    const scores: Record<string, number> = {};
    const classroomAcc: Record<string, { sum: number; n: number }> = {};
    const pagerank: Record<string, number> = {};
    const contrib: Record<string, Record<string, number>> = {};
    for (const key of contextKeys) {
      const packed = collectContextImportance(j?.by_context?.[key] || null);
      takeMaxMap(scores, packed.scores);
      // 堂次多讲：课堂分取 mean，避免一讲 hub 污染整堂修正
      takeMeanMap(classroomAcc, packed.classroom);
      takeMaxMap(pagerank, packed.pagerank);
      Object.assign(contrib, packed.contributions);
    }
    const classroom = finalizeMeanMap(classroomAcc);
    // 讲次/堂次上下文命中后：只用该上下文课堂分，不再回退整课 classroom
    const hitContext = contextKeys.some((k) => {
      const ctx = j?.by_context?.[k];
      return ctx && typeof ctx === "object" && Object.keys(ctx.scores || {}).length > 0;
    });
    const hitPagerank = contextKeys.some((k) => {
      const ctx = j?.by_context?.[k];
      return (
        ctx &&
        typeof ctx === "object" &&
        Object.keys(ctx.pagerank || {}).length > 0
      );
    });
    return {
      scores:
        Object.keys(scores).length
          ? scores
          : j?.scores && typeof j.scores === "object"
            ? j.scores
            : null,
      base: j?.base && typeof j.base === "object" ? j.base : null,
      classroom: Object.keys(classroom).length
        ? classroom
        : hitContext
          ? classroom
          : j?.classroom && typeof j.classroom === "object"
            ? j.classroom
            : null,
      pagerank: Object.keys(pagerank).length
        ? pagerank
        : hitPagerank
          ? pagerank
          : j?.pagerank && typeof j.pagerank === "object"
            ? j.pagerank
            : null,
      contributions:
        Object.keys(contrib).length
          ? contrib
          : j?.contributions && typeof j.contributions === "object"
            ? j.contributions
            : null,
    };
  } catch {
    return emptyImportance();
  }
}

function resolveDisplayClassroom(
  importance: ImportancePack,
  source: ImportanceSource
): Record<string, number> | null {
  if (source === "pagerank") {
    const pr = importance.pagerank;
    if (pr && Object.keys(pr).length) return pr;
  }
  return importance.classroom;
}

function relabelSessionCues(cues: PipelineCueBundle[]): PipelineCueBundle[] {
  return cues.map((c, i) => ({
    ...c,
    edges: c.edges.map((e) => ({
      ...e,
      cue_label: `片段 ${i + 1}${
        c.startSec != null ? ` · ${Math.round(c.startSec)}s` : ""
      }`,
    })),
    edgeCount: c.edges.length,
  }));
}

function finishReviewGraph(
  built: ReturnType<typeof buildKgViewFromPipeline>,
  processed: ReturnType<typeof processLectureKg>,
  importance: ImportancePack,
  enrich: Map<string, MmkgEntityEnrichment>,
  hideRelatedWith: boolean,
  importanceSource: ImportanceSource = getImportanceSource()
): ReviewClassroomGraph {
  // PageRank 在后处理图上算；课堂信号仍用 lookup
  const usePr = importanceSource === "pagerank";
  let nodes = usePr
    ? processed.nodes.map((n) => ({ ...n }))
    : enrichPipelineNodesWithImportance(processed.nodes, {
        scores: importance.scores,
        base: importance.base,
        classroom: resolveDisplayClassroom(importance, importanceSource),
        contributions: importance.contributions,
        displayMode: "classroom",
      });
  nodes = applyMmkgEnrichmentToNodes(nodes, enrich);

  const keptOnly = processed.edges.filter(
    (e) =>
      (e.source || "") !== "process_rule" &&
      (e.source || "") !== "process_node" &&
      (e.source || "") !== "process_isolated"
  );

  // 复习图谱默认隐藏 related_with，但不做隐藏后的短路径二次剪枝
  const vis = hideRelatedWith
    ? applyRelatedWithVisibility(
        {
          ...built.stage,
          nodes,
          edges: keptOnly,
          stats: {
            ...(built.stage.stats || {}),
            process_kept: processed.stats.kept_edges,
          },
        },
        true,
        { pruneShortPaths: false }
      )
    : {
        ...built.stage,
        nodes,
        edges: keptOnly,
        stats: {
          ...(built.stage.stats || {}),
          process_kept: processed.stats.kept_edges,
        },
      };

  const visEdges = (vis.edges || []).filter((e) => {
    const src = String(e.source || "");
    return (
      src !== "process_rule" &&
      src !== "process_node" &&
      src !== "process_isolated"
    );
  });
  const keepIds = new Set<string>();
  for (const e of visEdges) {
    if (e.from) keepIds.add(e.from);
    if (e.to) keepIds.add(e.to);
  }
  let visNodes = (vis.nodes || []).filter((n) => keepIds.has(n.id));

  if (usePr) {
    // 后处理图上算 PR，再用课堂信号轻量修正（mention/board 门控）
    // 修正后的 importance 同时驱动复习图谱与导图投影（导图不用 importance_base）
    visNodes = applyClassicPagerankToNodes(visNodes, visEdges);
    visNodes = blendPagerankWithClassroom(visNodes, {
      classroom: importance.classroom,
      contributions: importance.contributions,
    });
  } else {
    const propagated = propagateImportanceToParents(visNodes, visEdges);
    visNodes = propagated.nodes;
  }
  // 森林挂父 / 排序 / 气泡均读节点 importance（已课堂修正）
  const forest = withUpdatedImportance(
    assignMindmapForest(visNodes, visEdges),
    visNodes
  );

  return {
    nodes: visNodes,
    edges: visEdges,
    stats: {
      nodes: visNodes.length,
      edges: visEdges.length,
      process_kept: Number(vis.stats?.process_kept || processed.stats.kept_edges),
    },
    forest,
  };
}

function emptyGraph(): ReviewClassroomGraph {
  return {
    nodes: [],
    edges: [],
    stats: { nodes: 0, edges: 0 },
    forest: assignMindmapForest([], []),
  };
}

/** 加载并处理课堂图谱。`scopeId` 为单讲 `1` 或堂次 `1_2`（与 /kg/session 融合逻辑相同）。 */
export async function loadReviewClassroomGraph(
  courseId: string,
  scopeId: string,
  opts: {
    hideRelatedWith?: boolean;
    importanceSource?: ImportanceSource;
  } = {}
): Promise<ReviewClassroomGraph> {
  const hideRelatedWith = opts.hideRelatedWith !== false;
  const importanceSource = opts.importanceSource ?? getImportanceSource();
  const scope = parseReviewGraphScope(scopeId);

  if ("sessionPair" in scope) {
    const [a, b] = scope.sessionPair;
    const [cuesA, cuesB, enrichA, enrichB, decA, decB, importance] = await Promise.all([
      loadCuesSafe(a, courseId),
      loadCuesSafe(b, courseId),
      loadMmkgEntityEnrichment(courseId, a),
      loadMmkgEntityEnrichment(courseId, b),
      loadMultiRelCollapse(courseId, a),
      loadMultiRelCollapse(courseId, b),
      loadImportanceForContexts(courseId, [
        `session:${a}_${b}`,
        `lecture:${a}`,
        `lecture:${b}`,
      ]),
    ]);

    const cues = relabelSessionCues([...cuesA, ...cuesB]);
    if (!cues.length) return emptyGraph();

    const enrich = mergeMmkgEnrichmentMaps(enrichA, enrichB);
    const built = buildKgViewFromPipeline({
      scope: "session",
      sessionPair: [a, b],
      cues,
      cueFilter: null,
      hideRelatedWith: false,
      courseId,
    });
    const processed = processLectureKg(
      built.stage.nodes || [],
      built.stage.edges || [],
      { multiRelDecisions: { ...decA, ...decB } }
    );
    return finishReviewGraph(
      built,
      processed,
      importance,
      enrich,
      hideRelatedWith,
      importanceSource
    );
  }

  const lid = scope.lectureId;
  const [cues, enrich, multiRelDecisions, importance] = await Promise.all([
    loadCuesSafe(lid, courseId),
    loadMmkgEntityEnrichment(courseId, lid),
    loadMultiRelCollapse(courseId, lid),
    loadImportanceForContexts(courseId, [`lecture:${lid}`]),
  ]);

  if (!cues.length) return emptyGraph();

  const built = buildKgViewFromPipeline({
    scope: "lecture",
    lectureId: lid,
    cues,
    cueFilter: null,
    hideRelatedWith: false,
    courseId,
  });

  const processed = processLectureKg(
    built.stage.nodes || [],
    built.stage.edges || [],
    { multiRelDecisions }
  );

  return finishReviewGraph(
    built,
    processed,
    importance,
    enrich,
    hideRelatedWith,
    importanceSource
  );
}

/** 加载与复习图谱同源的处理后图，再投影为讲次/堂次导图。
 * 优先：从章导图按讲枝 / 实体相关性裁剪；失败再走图谱投影。
 */
export async function loadReviewLectureMindmap(
  courseId: string,
  scopeId: string,
  opts: { chapter?: string | null; preferChapterSlice?: boolean } = {}
): Promise<MindmapDoc> {
  const parsed = parseReviewGraphScope(scopeId);
  const lectureLabel =
    "sessionPair" in parsed
      ? `${parsed.sessionPair[0]}_${parsed.sessionPair[1]}`
      : parsed.lectureId;
  const lids =
    "sessionPair" in parsed
      ? [parsed.sessionPair[0], parsed.sessionPair[1]]
      : [parsed.lectureId];

  const preferSlice = opts.preferChapterSlice !== false;

  // 先拿课堂实体 id，作章树相关性裁剪；同时后面投影也要用图
  const g = await loadReviewClassroomGraph(courseId, scopeId);
  const entityIds = new Set<string>();
  for (const id of g.forest.importance.keys()) entityIds.add(id);
  for (const id of g.forest.roots) entityIds.add(id);
  for (const id of g.forest.parentOf.keys()) entityIds.add(id);

  if (preferSlice) {
    try {
      const { tryLoadMindmapSlicedFromChapters } = await import(
        "@/lib/kg/mindmapComposeLoad"
      );
      const sliced = await tryLoadMindmapSlicedFromChapters(courseId, lids, {
        entityIds,
        sessionId: lectureLabel,
      });
      if (sliced) {
        return {
          ...sliced,
          meta: {
            ...sliced.meta,
            chapter: opts.chapter || sliced.meta?.chapter,
            source: sliced.meta?.source || "kg",
          },
        };
      }
    } catch {
      /* fall through */
    }
  }

  const { loadLectureOutlineSignal } = await import("@/lib/kg/mindmapOutline");
  const outline = await loadLectureOutlineSignal(
    courseId,
    lids,
    opts.chapter ?? null
  );

  const doc = buildMindmapFromForest(g.forest, {
    lectureId: lectureLabel,
    chapter: opts.chapter ?? null,
    reviewOrder: outline.order,
    scope: "lecture",
    source: outline.source,
  });
  if (!doc) {
    throw new Error("本堂课后处理的图谱为空，无法生成导图");
  }
  return doc;
}
