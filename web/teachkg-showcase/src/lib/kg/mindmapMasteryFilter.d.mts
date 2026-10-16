import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";

export type MasteryStatus = "learning" | "mastered" | "unlearned" | "unrecorded";
export type MasteryByZh =
  | Readonly<Record<string, number | null | undefined>>
  | ReadonlyMap<string, number | null | undefined>;

export type MasteryViewNode = Omit<MindmapTreeNode, "children"> & {
  /** Original child-index path, unaffected by filtering or sibling removal. */
  __sourcePath: number[];
  children: MasteryViewNode[];
};

export type MasteryViewDoc = Omit<MindmapDoc, "root" | "roots"> & {
  root: MasteryViewNode;
  roots?: MasteryViewNode[];
};

export type MasteryFilterStats = {
  totalNodes: number;
  visibleNodes: number;
  hiddenNodes: number;
  requestedPercent: number;
  actualPercent: number;
  requestedNodes: number;
  targetNodes: number;
  mandatoryNodes: number;
  totalByStatus: Record<MasteryStatus, number>;
  visibleByStatus: Record<MasteryStatus, number>;
};

export function filterMindmapByMastery(
  sourceDoc: MindmapDoc,
  masteryByZh: MasteryByZh,
  percent: number,
  options?: {
    /** Select only this occurrence; takes precedence over selectedId. */
    selectedPath?: readonly number[] | null;
    /** Legacy fallback; selects every occurrence with the same ID. */
    selectedId?: string | null;
    /** Allocate visible nodes proportionally across root-level subtrees. */
    balanceDomains?: boolean;
  },
): { doc: MasteryViewDoc; stats: MasteryFilterStats };
