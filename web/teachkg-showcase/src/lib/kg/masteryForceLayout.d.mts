import type {
  PackedInput,
  PackedNode,
  PackedLayout,
} from "./packedMindmapLayout.mjs";
export type ForceBody = {
  node: PackedNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
};
export type MasteryForce = {
  autoFit: boolean;
  bodies: Map<string, ForceBody>;
  edges: Omit<PackedLayout["edges"][number], "path">[];
  domains: PackedLayout["domains"];
  bounds: PackedLayout["bounds"];
};
export function createMasteryForce(
  input: PackedInput,
  previous?: Map<string, ForceBody>,
): MasteryForce;
export function advanceMasteryForce(sim: MasteryForce): number;
export function moveMasteryForce(
  sim: MasteryForce,
  key: string,
  dx: number,
  dy: number,
): void;
export function forceBounds(sim: MasteryForce): PackedLayout["bounds"];
export function renderMasteryForce(sim: MasteryForce): PackedLayout;
