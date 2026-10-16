export type BranchBox = { x: number; y: number; width: number; height: number };
export type CourseBranch = { width: number; height: number; anchorY: number; anchorHeight: number; boxes: BranchBox[] };
export function packCourseBranches(branches: CourseBranch[]): {
  width: number; height: number; positions: { x: number; y: number }[];
};
