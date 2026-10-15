import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";
export type MasteryPayload = { mastery?: Record<string, number>; knowledge_points?: {id: string; name: string; mastery: number}[]; scope?: "personal" | "class_average"; learner_count?: number };
export function bindMasteryToMindmap(payload: MasteryPayload): Record<string, number>;
export function masteryScore(node: MindmapTreeNode, mastery: Readonly<Record<string, number>>): number | undefined;
export function masteryVisual(score: number | undefined): {radius: number; color: string; status: string; label: string};
export function collapseMindmap(doc: MindmapDoc, expandDepth: number, overrides?: Record<string, boolean>): MindmapDoc;
