export type BranchBox = { x: number; y: number; width: number; height: number };
export type CourseBranch = { width: number; height: number; anchorY: number; anchorHeight: number; boxes: BranchBox[]; incoming?: { x: number; y: number } };
export function packCourseBranches(branches: CourseBranch[]): {
  width: number; height: number; positions: { x: number; y: number }[];
};
export function courseUnderlineY(top: number, height: number, kind: string): number;
export function courseConnectorPath(parent: { x: number; y: number }, child: { x: number; y: number }, spineX: number): string;
export function courseConnectorBoxes(parent: { x: number; y: number }, child: { x: number; y: number }, spineX: number): BranchBox[];
