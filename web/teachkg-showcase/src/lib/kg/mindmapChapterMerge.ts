/**
 * 章级导图：把同章下多讲导图挂到 `__chapter__/…` 下，每讲一枝 `__lecture__/N`。
 * 另：课总图 = 各章拼接（保留节→主题）；堂次图 = 从章树按讲枝 / 实体相关性裁剪。
 */
import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";
import { cloneForest, cloneNode, docForest } from "@/lib/apps/mindmapEdits";
import {
  chapterFileSlug,
  chapterNavId,
  type MindmapIndexItem,
  type MindmapSource,
} from "@/lib/kg/mindmapTypes";

function countNodes(n: MindmapTreeNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}

function depthOf(n: MindmapTreeNode, d = 0): number {
  if (!n.children.length) return d;
  return Math.max(...n.children.map((c) => depthOf(c, d + 1)));
}

function forestStats(trees: MindmapTreeNode[]) {
  let n = 0;
  let depth = 0;
  for (const t of trees) {
    n += countNodes(t);
    depth = Math.max(depth, depthOf(t));
  }
  return { n_nodes: n, max_depth: depth };
}

function finalizeDoc(
  lectureId: string,
  root: MindmapTreeNode,
  meta: MindmapDoc["meta"],
  orphanCount = 0
): MindmapDoc {
  const stats = forestStats([root]);
  return {
    lecture_id: lectureId,
    root,
    roots: [root],
    n_nodes: stats.n_nodes,
    max_depth: stats.max_depth,
    orphan_count: orphanCount,
    meta,
  };
}

/** 去重：跨讲同一实体 id 只在首次出现的讲枝保留深子树，其后作 copy 叶 */
function dedupeAcrossLectures(
  lectureBranches: MindmapTreeNode[]
): MindmapTreeNode[] {
  const seen = new Set<string>();
  const stripDup = (n: MindmapTreeNode): MindmapTreeNode => {
    if (seen.has(n.id) && !n.id.startsWith("__")) {
      return {
        ...n,
        copy: true,
        weak: true,
        children: [],
      };
    }
    if (!n.id.startsWith("__lecture__/") && !n.id.startsWith("__chapter__/")) {
      seen.add(n.id);
    }
    return {
      ...n,
      children: n.children.map(stripDup),
    };
  };
  return lectureBranches.map(stripDup);
}

export function buildChapterMindmapDoc(
  chapter: string,
  lectures: { lectureId: string; doc: MindmapDoc }[],
  opts: { source?: MindmapSource } = {}
): MindmapDoc {
  const chapterTitle = String(chapter || "").trim() || "未分章";
  const lectureIds = lectures.map((l) => l.lectureId);
  const branches: MindmapTreeNode[] = lectures.map(({ lectureId, doc }) => {
    const trees = cloneForest(docForest(doc));
    const lid = String(lectureId);
    return {
      id: `__lecture__/${lid}`,
      zh: `第 ${lid} 讲`,
      importance: Math.max(0.3, ...trees.map((t) => t.importance || 0)),
      relation: "toc_lecture",
      related: [],
      children: trees,
    } satisfies MindmapTreeNode;
  });

  const deduped = dedupeAcrossLectures(branches);
  const root: MindmapTreeNode = {
    id: `__chapter__/${chapterTitle}`,
    zh: chapterTitle,
    importance: 0.7,
    relation: null,
    related: [],
    children: deduped,
  };
  return finalizeDoc(
    chapterNavId(chapterTitle),
    root,
    {
      chapter: chapterTitle,
      root_zh: chapterTitle,
      virtual_root: true,
      scope: "chapter",
      lecture_ids: lectureIds,
      source: opts.source || "kg",
      n_trees: 1,
    },
    lectures.reduce((s, l) => s + (l.doc.orphan_count || 0), 0)
  );
}

/**
 * 从章根抽出课总图用的子树：保留节/主题层级，不再压成一层空叶。
 * 若章下是 `__lecture__/N` 包装，则拆开取其子枝，避免课总图再套一层「第 N 讲」。
 */
export function chapterBodyForCourse(
  chapterRoot: MindmapTreeNode,
  opts: { maxNodes?: number; maxDepth?: number } = {}
): MindmapTreeNode[] {
  const maxNodes = opts.maxNodes ?? 96;
  const maxDepth = opts.maxDepth ?? 4;
  const raw: MindmapTreeNode[] = [];
  for (const child of chapterRoot.children || []) {
    if (child.id.startsWith("__lecture__/")) {
      for (const t of child.children || []) raw.push(cloneNode(t));
    } else {
      raw.push(cloneNode(child));
    }
  }

  let used = 0;
  const trim = (n: MindmapTreeNode, depth: number): MindmapTreeNode | null => {
    if (used >= maxNodes) return null;
    used += 1;
    if (depth >= maxDepth) {
      return { ...n, children: [] };
    }
    const kids: MindmapTreeNode[] = [];
    for (const c of n.children || []) {
      if (used >= maxNodes) break;
      const next = trim(c, depth + 1);
      if (next) kids.push(next);
    }
    return { ...n, children: kids };
  };

  const out: MindmapTreeNode[] = [];
  for (const n of raw) {
    if (used >= maxNodes) break;
    const next = trim(n, 1);
    if (next) out.push(next);
  }
  return out;
}

/**
 * 从章根抽出「一级主题」叶（兼容旧逻辑）：跳过讲枝包装，实体不再带子树。
 */
export function chapterShallowTopics(
  chapterRoot: MindmapTreeNode,
  maxTopics = 8
): MindmapTreeNode[] {
  const topics: MindmapTreeNode[] = [];
  const seen = new Set<string>();
  const push = (n: MindmapTreeNode) => {
    if (!n?.id || n.id.startsWith("__")) return;
    if (seen.has(n.id)) return;
    seen.add(n.id);
    topics.push({
      ...cloneNode(n),
      children: [],
      copy: false,
      weak: false,
    });
  };
  for (const child of chapterRoot.children || []) {
    if (child.id.startsWith("__lecture__/")) {
      for (const t of child.children || []) push(t);
    } else if (child.id.startsWith("__section__/")) {
      // 骨架节：课总图只露节标题，不带子叶
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      topics.push({
        ...cloneNode(child),
        children: [],
        copy: false,
        weak: false,
      });
    } else {
      push(child);
    }
  }
  return topics
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, maxTopics);
}

/** 课总图：各章拼接，保留章内节→主题结构（可限深/限节点） */
export function buildCourseMindmapFromChapters(
  courseTitle: string,
  chapters: { chapter: string; doc: MindmapDoc }[],
  opts: {
    maxTopicsPerChapter?: number;
    maxNodesPerChapter?: number;
    maxDepthPerChapter?: number;
    shallow?: boolean;
    source?: MindmapSource;
  } = {}
): MindmapDoc {
  const title = String(courseTitle || "").trim() || "课程";
  const chapterNodes: MindmapTreeNode[] = chapters.map(({ chapter, doc }) => {
    const trees = docForest(doc);
    const chRoot =
      trees.find((t) => t.id.startsWith("__chapter__/")) || trees[0];
    const topics = !chRoot
      ? []
      : opts.shallow
        ? chapterShallowTopics(chRoot, opts.maxTopicsPerChapter ?? 8)
        : chapterBodyForCourse(chRoot, {
            maxNodes: opts.maxNodesPerChapter ?? 96,
            maxDepth: opts.maxDepthPerChapter ?? 4,
          });
    return {
      id: `__chapter__/${chapter}`,
      zh: chapter,
      importance: 0.65,
      relation: "toc_chapter",
      related: [],
      children: topics,
    } satisfies MindmapTreeNode;
  });

  const root: MindmapTreeNode = {
    id: `__course__/${title}`,
    zh: title,
    importance: 0.9,
    relation: null,
    related: [],
    children: chapterNodes,
  };
  const lectureIds = chapters.flatMap((c) => c.doc.meta?.lecture_ids || []);
  return finalizeDoc("course", root, {
    chapter: title,
    root_zh: title,
    virtual_root: true,
    scope: "course",
    lecture_ids: lectureIds,
    source: opts.source || "kg",
    n_chapters: chapters.length,
    n_trees: 1,
    composed_from: "chapters",
  });
}

/** 取出章树中指定讲次枝；没有讲枝包装时返回 null */
export function extractLectureBranches(
  chapterDoc: MindmapDoc,
  lectureIds: string[]
): MindmapTreeNode[] | null {
  const want = new Set(lectureIds.map(String));
  const root = docForest(chapterDoc)[0];
  if (!root) return null;
  const branches = (root.children || []).filter((c) => {
    const m = c.id.match(/^__lecture__\/(.+)$/);
    return m && want.has(m[1]);
  });
  if (!branches.length) return null;
  return branches.map((b) => cloneNode(b));
}

/**
 * 按实体 id 集合裁剪树：保留命中结点及其祖先；虚节点若仍有子则保留。
 * keepIds 为空时原样克隆。
 */
export function pruneTreeByEntityIds(
  node: MindmapTreeNode,
  keepIds: Set<string>
): MindmapTreeNode | null {
  if (!keepIds.size) return cloneNode(node);
  const kids = (node.children || [])
    .map((c) => pruneTreeByEntityIds(c, keepIds))
    .filter((c): c is MindmapTreeNode => Boolean(c));
  const isVirtual = node.id.startsWith("__");
  const selfKeep = keepIds.has(node.id) || keepIds.has(node.zh);
  if (!selfKeep && !kids.length && !isVirtual) return null;
  if (isVirtual && !kids.length && !selfKeep) return null;
  return {
    ...node,
    children: kids,
  };
}

/**
 * 堂次 / 讲次：从章导图裁剪。
 * 1) 优先保留对应 `__lecture__/k` 枝
 * 2) 若给了 entityIds，再按相关性剪枝
 * 3) 多章时挂到虚根下
 */
export function sliceChaptersForLectures(
  chapters: { chapter: string; doc: MindmapDoc }[],
  lectureIds: string[],
  opts: {
    entityIds?: Iterable<string>;
    sessionId?: string;
    source?: MindmapSource;
    minNodes?: number;
  } = {}
): MindmapDoc | null {
  const lids = lectureIds.map(String);
  const keep = new Set<string>();
  if (opts.entityIds) {
    for (const id of opts.entityIds) {
      const s = String(id || "").trim();
      if (s) keep.add(s);
    }
  }
  const minNodes = opts.minNodes ?? 4;

  const pieces: MindmapTreeNode[] = [];
  for (const { chapter, doc } of chapters) {
    const branches = extractLectureBranches(doc, lids);
    let piece: MindmapTreeNode | null = null;
    if (branches?.length) {
      const chRoot: MindmapTreeNode = {
        id: `__chapter__/${chapter}`,
        zh: chapter,
        importance: 0.7,
        relation: "toc_chapter",
        related: [],
        children: branches,
      };
      // 已按讲枝裁过；实体过滤仅作二次收紧（堂次图过大时）
      if (keep.size && countNodes(chRoot) > 48) {
        piece = pruneTreeByEntityIds(chRoot, keep) || chRoot;
      } else {
        piece = chRoot;
      }
    } else {
      const root = docForest(doc)[0];
      if (!root) continue;
      const pruned = keep.size
        ? pruneTreeByEntityIds(root, keep)
        : cloneNode(root);
      piece = pruned;
    }
    if (piece && (piece.children?.length || !piece.id.startsWith("__"))) {
      pieces.push(piece);
    }
  }

  if (!pieces.length) return null;

  const sessionId =
    opts.sessionId ||
    (lids.length === 2 ? `${lids[0]}_${lids[1]}` : lids[0] || "session");
  const label =
    lids.length === 2 ? `第 ${lids[0]}–${lids[1]} 讲` : `第 ${lids[0]} 讲`;

  let root: MindmapTreeNode;
  if (pieces.length === 1 && pieces[0].id.startsWith("__chapter__/")) {
    root = pieces[0];
  } else if (pieces.length === 1) {
    root = {
      id: `__lecture__/${sessionId}`,
      zh: label,
      importance: 0.6,
      relation: null,
      related: [],
      children: pieces[0].children?.length ? pieces[0].children : [pieces[0]],
    };
  } else {
    root = {
      id: `__lecture__/${sessionId}`,
      zh: label,
      importance: 0.6,
      relation: null,
      related: [],
      children: pieces,
    };
  }

  const stats = forestStats([root]);
  if (stats.n_nodes < minNodes) return null;

  return finalizeDoc(sessionId, root, {
    chapter: chapters.length === 1 ? chapters[0].chapter : undefined,
    root_zh: label,
    virtual_root: true,
    scope: "lecture",
    lecture_ids: lids,
    source: opts.source || "kg",
    n_trees: 1,
    composed_from: "chapter_slice",
  });
}

/** 从讲次索引项聚合出章级索引项（不含写盘；path 指向约定文件名） */
export function aggregateChapterIndexItems(
  lectureItems: MindmapIndexItem[]
): MindmapIndexItem[] {
  const byChapter = new Map<string, MindmapIndexItem[]>();
  for (const it of lectureItems) {
    if (it.scope === "course" || it.scope === "chapter") continue;
    if (it.lecture_id === "course" || String(it.lecture_id).startsWith("chapter:")) {
      continue;
    }
    const ch = String(it.chapter || "").trim();
    if (!ch) continue;
    if (!byChapter.has(ch)) byChapter.set(ch, []);
    byChapter.get(ch)!.push(it);
  }

  const chapterItems: MindmapIndexItem[] = [];
  for (const [ch, items] of byChapter) {
    const lids = items
      .map((i) => i.lecture_id)
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    const slug = chapterFileSlug(ch);
    chapterItems.push({
      lecture_id: chapterNavId(ch),
      chapter: ch,
      chapter_id: ch,
      root_zh: ch.replace(/^第\s*\d+\s*章\s*/, "").trim() || ch,
      n_nodes: items.reduce((s, i) => s + (i.n_nodes || 0), 0),
      max_depth: Math.max(...items.map((i) => i.max_depth || 0), 0) + 1,
      orphan_count: items.reduce((s, i) => s + (i.orphan_count || 0), 0),
      path: `mindmaps/chapter_${slug}.json`,
      scope: "chapter",
      lecture_ids: lids,
      source: "kg",
    });
  }

  chapterItems.sort((a, b) => {
    const na = Number(String(a.chapter).match(/第\s*(\d+)\s*章/)?.[1] || 999);
    const nb = Number(String(b.chapter).match(/第\s*(\d+)\s*章/)?.[1] || 999);
    if (na !== nb) return na - nb;
    return String(a.chapter).localeCompare(String(b.chapter), "zh");
  });
  return chapterItems;
}

export function mergeMindmapIndexWithChapters(
  items: MindmapIndexItem[]
): MindmapIndexItem[] {
  const course = items.filter((i) => i.scope === "course" || i.lecture_id === "course");
  const lectures = items.filter(
    (i) =>
      i.lecture_id !== "course" &&
      i.scope !== "course" &&
      i.scope !== "chapter" &&
      !String(i.lecture_id).startsWith("chapter:")
  );
  const existingChapters = items.filter(
    (i) => i.scope === "chapter" || String(i.lecture_id).startsWith("chapter:")
  );
  const chapters =
    existingChapters.length > 0
      ? existingChapters
      : aggregateChapterIndexItems(lectures);

  const normalizeLecture = (it: MindmapIndexItem): MindmapIndexItem => ({
    ...it,
    scope: it.scope || "lecture",
    source: it.source || "kg",
    chapter_id: it.chapter_id || it.chapter,
  });

  return [
    ...course.map((c) => ({
      ...c,
      scope: "course" as const,
      source: c.source || ("kg" as const),
    })),
    ...chapters,
    ...lectures.map(normalizeLecture),
  ];
}

/** 把单讲根列表包进讲枝（用于运行时合成且无静态 lecture json） */
export function wrapLectureDocAsBranch(
  lectureId: string,
  doc: MindmapDoc
): MindmapTreeNode {
  const trees = cloneForest(docForest(doc));
  return {
    id: `__lecture__/${lectureId}`,
    zh: `第 ${lectureId} 讲`,
    importance: Math.max(0.3, ...trees.map((t) => Number(t.importance) || 0)),
    relation: "toc_lecture",
    related: [],
    children: trees.map((t) => cloneNode(t)),
  };
}

/** 索引里找覆盖给定讲次的章条目 */
export function findChapterItemsForLectures(
  items: MindmapIndexItem[],
  lectureIds: string[]
): MindmapIndexItem[] {
  const want = new Set(lectureIds.map(String));
  const chapters = items.filter(
    (i) => i.scope === "chapter" || String(i.lecture_id).startsWith("chapter:")
  );
  const hit = chapters.filter((ch) =>
    (ch.lecture_ids || []).some((lid) => want.has(String(lid)))
  );
  if (hit.length) return hit;

  const lectureItems = items.filter((i) => want.has(String(i.lecture_id)));
  const chNames = [
    ...new Set(
      lectureItems.map((i) => String(i.chapter || "").trim()).filter(Boolean)
    ),
  ];
  return chNames.map((ch) => ({
    lecture_id: chapterNavId(ch),
    chapter: ch,
    chapter_id: ch,
    root_zh: ch,
    n_nodes: 0,
    max_depth: 0,
    orphan_count: 0,
    path: `mindmaps/chapter_${chapterFileSlug(ch)}.json`,
    scope: "chapter" as const,
    lecture_ids: lectureItems
      .filter((i) => i.chapter === ch)
      .map((i) => i.lecture_id),
    source: "kg" as const,
  }));
}
