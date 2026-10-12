/**
 * 特性合并与重要性同级分层：
 * - 单课：property_merge_lecture_{N}.json → 叠到 kg_processed_lecture_*
 * - 整课：property_merge_course.json → 叠到 kg_processed_course
 */
import type { PipelineNode } from "@/lib/pipeline/types";
import { courseDataUrl } from "@/lib/course";

export type PropertyMergeDecision = {
  properties: string[];
  reason?: string;
  before_count?: number;
  after_count?: number;
};

export type PropertyMergeFile = {
  decisions?: Record<string, PropertyMergeDecision>;
};

/** 将 LLM 合并结果叠到节点 properties */
export function applyPropertyMergeDecisions(
  nodes: PipelineNode[],
  decisions?: Record<string, PropertyMergeDecision> | null
): PipelineNode[] {
  if (!nodes.length || !decisions || !Object.keys(decisions).length) {
    return nodes;
  }
  return nodes.map((n) => {
    const id = String(n.id || "");
    const dec = decisions[id];
    const props = (dec?.properties || [])
      .map((p) => String(p || "").trim())
      .filter(Boolean);
    if (!props.length) return n;
    return { ...n, properties: props };
  });
}

export async function tryLoadPropertyMerge(
  courseId: string,
  opts: { scope: "course" | "lecture" | "session"; lectureId?: string }
): Promise<Record<string, PropertyMergeDecision>> {
  const file =
    opts.scope === "course"
      ? "property_merge_course.json"
      : opts.lectureId
        ? `property_merge_lecture_${opts.lectureId}.json`
        : "";
  if (!file) return {};
  try {
    const res = await fetch(
      `${courseDataUrl(courseId, `pipeline/${file}`)}?t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!res.ok) return {};
    const data = (await res.json()) as PropertyMergeFile;
    return data?.decisions || {};
  } catch {
    return {};
  }
}
