import type { MindmapDoc } from "@/components/mindmap/MindmapTree";
type KnowledgeNode = { id?: string; label?: string; zh?: string; aliases?: string[]; children?: KnowledgeNode[] };
export type LectureKnowledgeSource = { lecture_id?: string; chapter_names?: string[]; nodes?: KnowledgeNode[]; root?: KnowledgeNode; roots?: KnowledgeNode[] };
export function personalMasteryLectureLimit(courseId: string): number | null;
export function filterMindmapByLectureProgress(doc: MindmapDoc, sources: LectureKnowledgeSource[], throughLecture: number): MindmapDoc;
export function loadPersonalMasteryProgress(doc: MindmapDoc, throughLecture: number, loadJson: (path: string) => Promise<LectureKnowledgeSource | null>): Promise<MindmapDoc>;
