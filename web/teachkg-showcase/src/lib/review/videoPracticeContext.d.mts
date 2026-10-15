export type PracticeConcept = { id: string; zh?: string };
export type VideoPracticeContext = {
  source: "selection" | "search" | "subtitle";
  points: { id: string; zh: string }[];
  captionStart?: number;
};
export function resolveVideoPracticeContext(input: {
  selected?: PracticeConcept | null;
  search?: string;
  catalog?: PracticeConcept[];
  points?: PracticeConcept[];
  captions?: { start: number; end: number; text: string }[];
  sec: number;
}): VideoPracticeContext | null;
export function buildVideoPracticeResource(
  context: VideoPracticeContext,
  courseId: string,
  matchPoint: (point: { id: string; zh: string }) => Promise<{
    match?: { matched_knowledge_points?: { id: string; content?: string }[] };
  }>,
): Promise<{
  resource_type: "exercise";
  resource_id: string;
  course_id: string;
  title: string;
  knowledge_point_ids: string[];
  metadata: Record<string, unknown>;
}>;
