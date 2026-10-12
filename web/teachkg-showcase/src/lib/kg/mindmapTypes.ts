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
  n_parts?: number;
  scope?: MindmapScope;
  lecture_ids?: string[];
  source?: MindmapSource;
  id_redirects?: Record<string, string>;
  skeleton_view?: boolean;
  skeleton_source?: string;
  outline_key?: string;
  composed_from?: string;
};

export function chapterNavId(chapter: string): string {
  return `chapter:${String(chapter || "").trim()}`;
}

export function parseChapterNavId(id: string): string | null {
  const s = String(id || "");
  if (!s.startsWith("chapter:")) return null;
  return s.slice("chapter:".length).trim() || null;
}

/** 整课总览 */
export function isCourseNavId(id: string): boolean {
  return id === "course";
}

/** 整课骨架展示（章为最外层，仅大纲层级） */
export function isCourseSkeletonNavId(id: string): boolean {
  return id === "course:skeleton";
}

/** 整课总览或骨架 */
export function isAnyCourseNavId(id: string): boolean {
  return isCourseNavId(id) || isCourseSkeletonNavId(id);
}

/** 大纲 API / summaries 用的骨架章键 */
export const COURSE_SKELETON_OUTLINE_KEY = "__course_skeleton__";

/**
 * 集合论分册在教材里标为第9–12章，展示时按分册内第1–4章编号。
 * 内部导航 id 仍用原文，避免改数据文件。
 */
const SET_THEORY_CHAPTER_DISPLAY: Record<string, string> = {
  "第9章 集合": "第1章 集合",
  "第10章 关系": "第2章 关系",
  "第11章 函数": "第3章 函数",
  "第12章 实数集合与集合的基数": "第4章 实数集合与集合的基数",
};

export function displayChapterName(chapter: string): string {
  const raw = String(chapter || "").trim();
  return SET_THEORY_CHAPTER_DISPLAY[raw] || raw;
}

type ZhNode = {
  zh?: string;
  children?: ZhNode[];
  [key: string]: unknown;
};

/** 导图树展示：集合论第9–12章节点文案改为分册内第1–4章（id 不动） */
export function remapSetTheoryChapterLabelsInTree<T extends ZhNode>(node: T): T {
  const zh = displayChapterName(String(node.zh || ""));
  const children = Array.isArray(node.children)
    ? node.children.map((c) => remapSetTheoryChapterLabelsInTree(c))
    : node.children;
  if (zh === node.zh && children === node.children) return node;
  return { ...node, zh, children };
}

export function remapSetTheoryChapterLabelsInDoc<T extends {
  root?: ZhNode | null;
  roots?: ZhNode[];
  meta?: { chapter?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}>(doc: T): T {
  const root = doc.root ? remapSetTheoryChapterLabelsInTree(doc.root) : doc.root;
  const roots = Array.isArray(doc.roots)
    ? doc.roots.map((r) => remapSetTheoryChapterLabelsInTree(r))
    : doc.roots;
  const meta =
    doc.meta?.chapter != null
      ? { ...doc.meta, chapter: displayChapterName(String(doc.meta.chapter)) }
      : doc.meta;
  return { ...doc, root, roots, meta };
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
