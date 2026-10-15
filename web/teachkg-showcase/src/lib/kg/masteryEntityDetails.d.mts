export type MasteryEntity = {
  id?: string;
  label?: string;
  zh?: string;
  canonicalName?: string;
  aliases?: string[];
  description?: string;
};
export type MasteryEntityIndex = {
  exact: Map<string, MasteryEntity>;
  candidates: Map<string, MasteryEntity[]>;
  definitions: Record<string, string>;
};
export function createMasteryEntityIndex(
  nodes?: MasteryEntity[],
  definitions?: Record<string, string>,
): MasteryEntityIndex;
export function masteryEntityDetails(
  node: { id: string; zh: string },
  index: MasteryEntityIndex,
): { canonical: string; aliases: string[]; definition: string };
