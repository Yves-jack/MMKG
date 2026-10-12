/**
 * 预计算 KG 产物：process + 课堂分 + 父子传递。
 * 前端只做保留%过滤与渲染；导出脚本复用同一套 TS 逻辑保证一致。
 */
import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";
import {
  buildKgViewFromPipeline,
  classUnitsFromLectureIds,
  processCourseFromClassUnits,
  type ClassUnitSpec,
  type PipelineCueBundle,
} from "@/lib/kg/pipelineMergeSource";
import {
  isProcessEdgeSource,
  processLectureKg,
  type LectureKgProcessStats,
  type MultiRelCollapseDecision,
} from "@/lib/kg/lectureKgProcess";
import { scoreFragmentClassroomImportance } from "@/lib/pipeline/classroomFactors";
import { propagateImportanceToParents } from "@/lib/kg/propagateImportance";

export const KG_PROCESSED_SCHEMA_VERSION = 1 as const;

export type KgProcessedScope = "lecture" | "session" | "course";

export type KgProcessedArtifact = {
  schema_version: typeof KG_PROCESSED_SCHEMA_VERSION;
  course_id: string;
  scope: KgProcessedScope;
  lecture_id?: string;
  lecture_ids?: string[];
  title: string;
  subtitle?: string;
  blurb?: string;
  stage_id: string;
  generated_at: string;
  process_stats: Pick<
    LectureKgProcessStats,
    | "rule_removed"
    | "node_removed"
    | "isolated_removed"
    | "kept_edges"
    | "property_folded"
    | "multi_rel_collapsed"
  >;
  propagate_stats: {
    layers: number;
    edges_used: number;
    boosted_nodes: number;
    max_before_norm?: number;
  };
  /** 供编辑后重算 mention；整课为分块数组 */
  extract_texts: string[];
  nodes: PipelineNode[];
  kept_edges: PipelineEdge[];
  process_edges: PipelineEdge[];
};

export function kgProcessedFileStem(
  scope: KgProcessedScope,
  opts: { lectureId?: string; sessionPair?: [string, string] | null }
): string {
  if (scope === "course") return "kg_processed_course";
  if (scope === "session" && opts.sessionPair) {
    return `kg_processed_session_${opts.sessionPair[0]}_${opts.sessionPair[1]}`;
  }
  return `kg_processed_lecture_${opts.lectureId || "1"}`;
}

function finishArtifact(args: {
  courseId: string;
  scope: KgProcessedScope;
  lectureId?: string;
  lectureIds?: string[];
  title: string;
  subtitle?: string;
  blurb?: string;
  stageId: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  processStats: LectureKgProcessStats;
  extractTexts: string[];
}): KgProcessedArtifact {
  const keptOnly = args.edges.filter((e) => !isProcessEdgeSource(e.source));
  const processOnly = args.edges.filter((e) => isProcessEdgeSource(e.source));
  const scored = scoreFragmentClassroomImportance(
    args.nodes,
    keptOnly,
    args.extractTexts
  );
  const propagated = propagateImportanceToParents(scored, keptOnly);
  return {
    schema_version: KG_PROCESSED_SCHEMA_VERSION,
    course_id: args.courseId,
    scope: args.scope,
    lecture_id: args.lectureId,
    lecture_ids: args.lectureIds,
    title: args.title,
    subtitle: args.subtitle,
    blurb: args.blurb,
    stage_id: args.stageId,
    generated_at: new Date().toISOString(),
    process_stats: {
      rule_removed: args.processStats.rule_removed,
      node_removed: args.processStats.node_removed,
      isolated_removed: args.processStats.isolated_removed,
      kept_edges: args.processStats.kept_edges,
      property_folded: args.processStats.property_folded,
      multi_rel_collapsed: args.processStats.multi_rel_collapsed,
    },
    propagate_stats: {
      layers: propagated.stats.layers,
      edges_used: propagated.stats.edges_used,
      boosted_nodes: propagated.stats.boosted_nodes,
      max_before_norm: propagated.stats.max_before_norm,
    },
    extract_texts: args.extractTexts,
    nodes: propagated.nodes,
    kept_edges: keptOnly,
    process_edges: processOnly,
  };
}

export function buildLectureOrSessionProcessed(opts: {
  courseId: string;
  scope: "lecture" | "session";
  lectureId?: string;
  sessionPair?: [string, string] | null;
  cues: PipelineCueBundle[];
  multiRelDecisions?: Record<string, MultiRelCollapseDecision>;
}): KgProcessedArtifact {
  const built = buildKgViewFromPipeline({
    scope: opts.scope,
    lectureId: opts.lectureId,
    sessionPair: opts.sessionPair || null,
    cues: opts.cues,
    cueFilter: null,
    hideRelatedWith: false,
    lectureFilter: null,
    courseId: opts.courseId,
  });
  const processed = processLectureKg(
    built.stage.nodes || [],
    built.stage.edges || [],
    { multiRelDecisions: opts.multiRelDecisions }
  );
  const extractTexts = opts.cues
    .map((c) => String(c.text || "").trim())
    .filter(Boolean);
  return finishArtifact({
    courseId: opts.courseId,
    scope: opts.scope,
    lectureId:
      opts.scope === "session" && opts.sessionPair
        ? `${opts.sessionPair[0]}+${opts.sessionPair[1]}`
        : opts.lectureId,
    lectureIds: opts.sessionPair || (opts.lectureId ? [opts.lectureId] : undefined),
    title: built.stage.title,
    subtitle: built.stage.subtitle,
    blurb:
      (built.stage.blurb || "") +
      " · 单课：本堂片段并集→process→单课级重要性（预计算）",
    stageId: built.stage.id,
    nodes: processed.nodes,
    edges: processed.edges,
    processStats: processed.stats,
    extractTexts,
  });
}

export function buildCourseProcessed(opts: {
  courseId: string;
  cues: PipelineCueBundle[];
  units?: ClassUnitSpec[];
  multiRelDecisions?: Record<string, MultiRelCollapseDecision>;
}): KgProcessedArtifact {
  const lectureIds = [
    ...new Set(opts.cues.map((c) => String(c.lectureId || "")).filter(Boolean)),
  ];
  const units =
    opts.units && opts.units.length > 0
      ? opts.units
      : classUnitsFromLectureIds(lectureIds);
  const courseBuilt = processCourseFromClassUnits(opts.cues, {
    units,
    multiRelDecisions: opts.multiRelDecisions,
  });
  return finishArtifact({
    courseId: opts.courseId,
    scope: "course",
    lectureId: "course",
    lectureIds,
    title: "整课 · 单课处理后的并集",
    subtitle: `先处理 ${courseBuilt.classUnitCount} 个单课，再进一步处理`,
    blurb:
      "整课 = 各单课（片段并集→process）结果并集 → 再 process → 整课级重要性（预计算）",
    stageId: "course_merge",
    nodes: courseBuilt.nodes,
    edges: [...courseBuilt.keptEdges, ...courseBuilt.processEdges],
    processStats: courseBuilt.courseStats,
    extractTexts: courseBuilt.extractTexts,
  });
}
