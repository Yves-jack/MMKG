import type { MindmapDoc } from "@/components/mindmap/MindmapTree";
import type { PackedNode } from "./packedMindmapLayout.mjs";
export type LearningStep = { key: string; score: number; label: string };
export function masteryLearningPath(
  doc: MindmapDoc,
  mastery: Readonly<Record<string, number>>,
): LearningStep[];
export function visibleLearningPath(
  sequence: LearningStep[],
  nodes: PackedNode[],
): { from: string; to: string; path: string }[];
