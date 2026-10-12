/**
 * 整课骨架：章为最外层，只含大纲/章节层级（节/主题），不含实体细节。
 */
import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";
import type { CoursePartInfo } from "@/lib/kg/mindmapChapterMerge";
import { COURSE_SKELETON_OUTLINE_KEY } from "@/lib/kg/mindmapTypes";

export type CourseSkeletonChapter = {
  title: string;
  sections: string[];
};

export type CourseSkeletonDoc = {
  courseId?: string;
  chapter?: string;
  source?: string | null;
  outline_text?: string;
  chapters?: CourseSkeletonChapter[];
  notes?: string;
};

const CHAPTER_LINE_RE = /^第\s*\d+\s*章/;

function cleanLine(s: string): string {
  return String(s || "")
    .replace(/^[-*•·]\s*/, "")
    .replace(/^\d+(?:\.\d+)*[.)、]\s*/, "")
    .replace(/^#+\s*/, "")
    .trim();
}

/** 文本大纲 → 章/节列表。支持「第N章」行 + 缩进子行，或 # 章 / ## 节 */
export function parseCourseSkeletonOutline(text: string): CourseSkeletonChapter[] {
  const lines = String(text || "").split(/\r?\n/);
  const chapters: CourseSkeletonChapter[] = [];
  let curIdx = -1;

  const pushChapter = (title: string) => {
    const t = cleanLine(title);
    if (!t) return;
    chapters.push({ title: t, sections: [] });
    curIdx = chapters.length - 1;
  };
  const cur = () => (curIdx >= 0 ? chapters[curIdx] : null);
  const addSection = (title: string) => {
    const c = cur();
    if (!c || c.sections.includes(title) || c.title === title) return;
    c.sections.push(title);
  };

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const md = raw.match(/^(#{1,3})\s+(.+)$/);
    if (md) {
      const level = md[1].length;
      const title = cleanLine(md[2]);
      if (!title) continue;
      if (level === 1 || CHAPTER_LINE_RE.test(title)) {
        pushChapter(title);
      } else if (cur()) {
        addSection(title);
      } else {
        pushChapter(title);
      }
      continue;
    }

    const indent = raw.match(/^(\s*)/)?.[1].length || 0;
    const title = cleanLine(raw);
    if (!title || title.length > 48) continue;

    if (CHAPTER_LINE_RE.test(title) && indent < 2) {
      pushChapter(title);
      continue;
    }
    if (!cur()) {
      pushChapter(title);
      continue;
    }
    if (indent >= 2 || !CHAPTER_LINE_RE.test(title)) {
      addSection(title);
    }
  }
  return chapters.filter((c) => c.title);
}

export function courseSkeletonToOutlineText(
  chapters: CourseSkeletonChapter[]
): string {
  const lines: string[] = [];
  for (const ch of chapters) {
    lines.push(ch.title);
    for (const sec of ch.sections || []) {
      lines.push(`  ${sec}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function courseSkeletonChaptersFromLlmJson(parsed: {
  chapters?: Array<{ title?: string; sections?: string[] | Array<{ title?: string }> }>;
} | null): CourseSkeletonChapter[] {
  if (!parsed?.chapters?.length) return [];
  return parsed.chapters
    .map((c) => {
      const title = cleanLine(c.title || "");
      if (!title) return null;
      const sections = (c.sections || [])
        .map((s) =>
          typeof s === "string" ? cleanLine(s) : cleanLine(s?.title || "")
        )
        .filter(Boolean);
      return { title, sections } satisfies CourseSkeletonChapter;
    })
    .filter(Boolean) as CourseSkeletonChapter[];
}

function sectionNode(chapterTitle: string, sectionTitle: string): MindmapTreeNode {
  return {
    id: `__section__/${chapterTitle}/${sectionTitle}`,
    zh: sectionTitle,
    importance: 0.45,
    relation: "toc_section",
    related: [],
    children: [],
  };
}

function chapterNode(ch: CourseSkeletonChapter): MindmapTreeNode {
  return {
    id: `__chapter__/${ch.title}`,
    zh: ch.title,
    importance: 0.65,
    relation: "toc_chapter",
    related: [],
    children: (ch.sections || []).map((s) => sectionNode(ch.title, s)),
  };
}

/** 由章/节列表生成整课骨架导图（最外层为章，可带分册） */
export function buildCourseSkeletonMindmapDoc(
  courseTitle: string,
  chapters: CourseSkeletonChapter[],
  opts: {
    parts?: CoursePartInfo[] | null;
    source?: string;
  } = {}
): MindmapDoc {
  const title = String(courseTitle || "").trim() || "课程";
  const byName = new Map(
    chapters.map((c) => [String(c.title || "").trim(), c] as const)
  );
  const parts = (opts.parts || []).filter((p) => (p.chapters || []).length);
  const useParts = parts.length >= 2;

  let children: MindmapTreeNode[];
  if (useParts) {
    const used = new Set<string>();
    children = [];
    for (const part of parts) {
      const partKids: MindmapTreeNode[] = [];
      for (const chName of part.chapters || []) {
        const hit = byName.get(String(chName).trim());
        if (!hit) continue;
        used.add(hit.title);
        partKids.push(chapterNode(hit));
      }
      if (!partKids.length) continue;
      const rawTitle = part.title || part.id || "分册";
      children.push({
        id: `__part__/${part.id || part.title}`,
        zh: String(rawTitle).startsWith("分册")
          ? String(rawTitle)
          : `分册 · ${rawTitle}`,
        importance: 0.75,
        relation: "toc_part",
        related: [],
        children: partKids,
      });
    }
    const rest = chapters.filter((c) => !used.has(c.title));
    if (rest.length) {
      children.push({
        id: "__part__/other",
        zh: "分册 · 其他",
        importance: 0.55,
        relation: "toc_part",
        related: [],
        children: rest.map(chapterNode),
      });
    }
  } else {
    children = chapters.map(chapterNode);
  }

  const root: MindmapTreeNode = {
    id: `__course__/${title}`,
    zh: title,
    importance: 0.9,
    relation: null,
    related: [],
    children,
  };

  const countNodes = (n: MindmapTreeNode): number =>
    1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
  const maxDepth = (n: MindmapTreeNode, d = 0): number =>
    (n.children || []).length
      ? Math.max(...(n.children || []).map((c) => maxDepth(c, d + 1)))
      : d;

  return {
    lecture_id: "course:skeleton",
    root,
    roots: [root],
    n_nodes: countNodes(root),
    max_depth: maxDepth(root),
    orphan_count: 0,
    meta: {
      chapter: title,
      root_zh: title,
      virtual_root: true,
      scope: "course",
      source: (opts.source as "summary+kg") || "summary+kg",
      n_chapters: chapters.length,
      n_parts: useParts ? children.length : 0,
      n_trees: 1,
      composed_from: "chapters",
      skeleton_source: "manual",
      skeleton_view: true,
      outline_key: COURSE_SKELETON_OUTLINE_KEY,
    },
  };
}
