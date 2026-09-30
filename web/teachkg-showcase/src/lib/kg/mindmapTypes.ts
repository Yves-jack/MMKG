/** 导图索引与文档元数据契约（课 / 章 / 讲） */

export type MindmapScope = "course" | "chapter" | "lecture";

export type MindmapSource = "kg" | "summary+kg" | "review+kg";

export type MindmapIndexItem = {
  /** 导航键：course | chapter:<title> | 讲次 id */
  lecture_id: string;
  chapter?: string;
  /** 稳定章 id，通常与 chapter 标题一致或为其 slug */
  chapter_id?: string;
  root_zh?: string;
  n_nodes: number;
  max_depth: number;
  orphan_count: number;
  path: string;
  scope?: MindmapScope;
  /** 章导图包含的讲次 */
  lecture_ids?: string[];
  source?: MindmapSource;
};

export type MindmapIndexDoc = {
  courseId: string;
  title: string;
  items: MindmapIndexItem[];
};

export type MindmapDocMeta = {
  chapter?: string;
  root_zh?: string;
  virtual_root?: boolean;
  n_trees?: number;
  n_entities_raw?: number;
  n_edges_raw?: number;
  attached_orphans?: number;
  n_chapters?: number;
  scope?: MindmapScope;
  lecture_ids?: string[];
  source?: MindmapSource;
};

export function chapterNavId(chapter: string): string {
  return `chapter:${String(chapter || "").trim()}`;
}

export function parseChapterNavId(id: string): string | null {
  const s = String(id || "");
  if (!s.startsWith("chapter:")) return null;
  return s.slice("chapter:".length).trim() || null;
}

export function isCourseNavId(id: string): boolean {
  return id === "course";
}

/** 章文件名：去掉「第N章」前缀后做安全化 */
export function chapterFileSlug(chapter: string): string {
  const bare = String(chapter || "")
    .replace(/^第\s*\d+\s*章\s*/, "")
    .trim();
  const base = bare || String(chapter || "chapter");
  return base
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}
