import type {
  MindmapDoc,
  MindmapTreeNode,
} from "@/components/mindmap/MindmapTree";
export type PackedRecord = {
  key: string;
  node: MindmapTreeNode;
  depth: number;
  branch: number;
  children: string[];
  spec: {
    compact?: boolean;
    lines: string[];
    fontSize: number;
    textWidth: number;
    w: number;
    h: number;
    extra: number;
  };
};
export type PackedInput = { rootKey: string; records: PackedRecord[] };
export type PackedNode = PackedRecord & {
  free?: boolean;
  compact?: boolean;
  left: number;
  right: number;
  top: number;
  bottom: number;
  side: -1 | 1;
  width: number;
  height: number;
  fontSize: number;
  lines: string[];
  textWidth: number;
  extra: number;
};
export type PackedLayout = {
  nodes: PackedNode[];
  edges: {
    key: string;
    parent: string;
    child: string;
    path: string;
    depth: number;
    branch: number;
  }[];
  domains: MindmapTreeNode[];
  plans: {
    domain: string;
    side: number;
    plan: [string, number, number][];
    height: number;
  }[];
  bounds: { x: number; y: number; width: number; height: number };
};
export function preparePackedMindmap(
  doc: MindmapDoc,
  measure: (text: string, size: number) => number,
  options?: { markers?: boolean; showLabels?: boolean },
): PackedInput;
export function layoutPackedMindmap(input: PackedInput): PackedLayout;
