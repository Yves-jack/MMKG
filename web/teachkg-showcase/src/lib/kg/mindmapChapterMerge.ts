/**
 * 章级导图：把同章下多讲导图挂到 `__chapter__/…` 下，每讲一枝 `__lecture__/N`。
 * 另：课总图 = 各章拼接（保留节→主题）；堂次图 = 从章树按讲枝 / 实体相关性裁剪。
 */
import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";
import { cloneForest, cloneNode, docForest } from "@/lib/review/mindmapEdits";
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
  /** 默认：无讲次层，按实体 id 深合并各讲内容 */
  return buildChapterMindmapMerged(chapter, lectures, opts);
}

/**
 * 章导图：各讲内容直接挂到章根下（不出现「第 N 讲」层），同 id 后者深合并。
 */
export function buildChapterMindmapMerged(
  chapter: string,
  lectures: { lectureId: string; doc: MindmapDoc }[],
  opts: { source?: MindmapSource } = {}
): MindmapDoc {
  const chapterTitle = String(chapter || "").trim() || "未分章";
  const bare = chapterTitle.replace(/^第\s*\d+\s*章\s*/, "").trim() || chapterTitle;
  const lectureIds = lectures.map((l) => String(l.lectureId));
  const byId = new Map<string, MindmapTreeNode>();

  const mergeInto = (existing: MindmapTreeNode, incoming: MindmapTreeNode) => {
    existing.importance = Math.max(
      existing.importance || 0,
      incoming.importance || 0
    );
    if (incoming.zh) existing.zh = incoming.zh;
    const childMap = new Map(
      (existing.children || []).map((c) => [c.id, c] as const)
    );
    for (const ic of incoming.children || []) {
      const prev = childMap.get(ic.id);
      if (prev) mergeInto(prev, ic);
      else childMap.set(ic.id, cloneNode(ic));
    }
    existing.children = [...childMap.values()].sort(
      (a, b) => (b.importance || 0) - (a.importance || 0)
    );
  };

  for (const { doc } of lectures) {
    for (const t of unwrapChapterTopics(docForest(doc))) {
      if (!t?.id || String(t.id).startsWith("__")) continue;
      const prev = byId.get(t.id);
      if (prev) mergeInto(prev, t);
      else byId.set(t.id, cloneNode(t));
    }
  }

  const children = [...byId.values()].sort(
    (a, b) => (b.importance || 0) - (a.importance || 0)
  );
  const root: MindmapTreeNode = {
    id: `__chapter__/${bare}`,
    zh: chapterTitle,
    importance: 0.7,
    relation: null,
    related: [],
    children,
  };
  return finalizeDoc(
    chapterNavId(chapterTitle),
    root,
    {
      chapter: chapterTitle,
      root_zh: bare,
      virtual_root: true,
      scope: "chapter",
      lecture_ids: lectureIds,
      source: opts.source || "kg",
      stitch: "entity_merge",
      n_trees: 1,
    },
    lectures.reduce((s, l) => s + (l.doc.orphan_count || 0), 0)
  );
}

/** 剥掉讲/章虚根，取出主题子树 */
function unwrapChapterTopics(trees: MindmapTreeNode[]): MindmapTreeNode[] {
  const out: MindmapTreeNode[] = [];
  for (const t of trees) {
    const id = String(t.id || "");
    if (id.startsWith("__lecture__/")) {
      for (const ch of t.children || []) {
        const cid = String(ch.id || "");
        if (cid.startsWith("__chapter__/")) {
          out.push(...(ch.children || []).map(cloneNode));
        } else if (!cid.startsWith("__")) {
          out.push(cloneNode(ch));
        }
      }
      continue;
    }
    if (id.startsWith("__chapter__/")) {
      out.push(...(t.children || []).map(cloneNode));
      continue;
    }
    if (!id.startsWith("__")) out.push(cloneNode(t));
  }
  return out;
}

/**
 * @deprecated 旧版按讲次枝拼接；保留供特殊调试，正式章图请用 buildChapterMindmapMerged
 */
export function buildChapterMindmapByLectureBranches(
  chapter: string,
  lectures: { lectureId: string; doc: MindmapDoc }[],
  opts: { source?: MindmapSource } = {}
): MindmapDoc {
  const chapterTitle = String(chapter || "").trim() || "未分章";
  const lectureIds = lectures.map((l) => l.lectureId);
  const branches: MindmapTreeNode[] = lectures.map(({ lectureId, doc }) => {
    const trees = cloneForest(unwrapChapterTopics(docForest(doc)));
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

/**
 * 骨架展示：只保留章下的节/主题虚节点，丢掉实体细节叶。
 */
export function chapterHierarchyOnly(
  chapterRoot: MindmapTreeNode,
  maxSections = 24
): MindmapTreeNode[] {
  const out: MindmapTreeNode[] = [];
  const seen = new Set<string>();
  const pushSection = (n: MindmapTreeNode) => {
    const id = String(n.id || "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    const sub = (n.children || [])
      .filter(
        (c) =>
          String(c.id || "").startsWith("__section__/") ||
          String(c.id || "").startsWith("__topic__/")
      )
      .slice(0, 12)
      .map((c) => ({
        ...cloneNode(c),
        children: [],
        copy: false,
        weak: false,
      }));
    out.push({
      ...cloneNode(n),
      children: sub,
      copy: false,
      weak: false,
    });
  };
  const walk = (nodes: MindmapTreeNode[]) => {
    for (const child of nodes || []) {
      const id = String(child.id || "");
      if (id.startsWith("__lecture__/")) {
        walk(child.children || []);
        continue;
      }
      if (id.startsWith("__section__/") || id.startsWith("__topic__/")) {
        pushSection(child);
        continue;
      }
      // 非虚节点：骨架视图忽略细节
    }
  };
  walk(chapterRoot.children || []);
  return out.slice(0, maxSections);
}

export type CoursePartInfo = {
  id: string;
  title: string;
  chapters: string[];
};

function makeChapterCourseNode(
  chapter: string,
  doc: MindmapDoc,
  opts: {
    maxTopicsPerChapter?: number;
    maxNodesPerChapter?: number;
    maxDepthPerChapter?: number;
    shallow?: boolean;
    /**
     * 骨架：章为最外层叶（无节/主题子节点）。
     * 完整课图勿开此项。
     */
    hierarchyOnly?: boolean;
  }
): MindmapTreeNode {
  const trees = docForest(doc);
  const chRoot =
    trees.find((t) => t.id.startsWith("__chapter__/")) || trees[0];
  // 骨架视图：分册 → 章（章不再挂下级）
  const topics = !chRoot
    ? []
    : opts.hierarchyOnly
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
  };
}

/** 去掉「第 N 章」前缀后的章名，用于去重 */
export function chapterBareTitle(name: string): string {
  const s = String(name || "").trim();
  return s.replace(/^第\s*\d+\s*章\s*/, "").trim() || s;
}

/**
 * 按目录顺序挑章：只保留 catalog 中的章（去掉分册重映射重复项 / 索引脏项），
 * 无 catalog 时按裸章名去重（保留先出现的）。
 */
export function preferCatalogChapters<T extends { chapter: string }>(
  loaded: T[],
  catalogOrder?: string[] | null
): T[] {
  if (!loaded.length) return [];
  const byExact = new Map(
    loaded.map((c) => [String(c.chapter || "").trim(), c] as const)
  );
  const byBare = new Map<string, T>();
  for (const c of loaded) {
    const bare = chapterBareTitle(c.chapter);
    if (!bare || byBare.has(bare)) continue;
    byBare.set(bare, c);
  }
  const order = (catalogOrder || []).map((n) => String(n || "").trim()).filter(Boolean);
  if (order.length) {
    const out: T[] = [];
    const used = new Set<string>();
    for (const name of order) {
      const hit = byExact.get(name) || byBare.get(chapterBareTitle(name));
      if (!hit) continue;
      const key = String(hit.chapter || "").trim();
      if (used.has(key)) continue;
      used.add(key);
      out.push({ ...hit, chapter: name } as T);
    }
    return out.length ? out : loaded;
  }
  const out: T[] = [];
  const seenBare = new Set<string>();
  for (const c of loaded) {
    const bare = chapterBareTitle(c.chapter);
    if (seenBare.has(bare)) continue;
    seenBare.add(bare);
    out.push(c);
  }
  return out;
}

/** 课总图：各章拼接；默认保留分册层（≥2 册时）；flattenParts=true 时章直挂课根 */
export function buildCourseMindmapFromChapters(
  courseTitle: string,
  chapters: { chapter: string; doc: MindmapDoc }[],
  opts: {
    maxTopicsPerChapter?: number;
    maxNodesPerChapter?: number;
    maxDepthPerChapter?: number;
    shallow?: boolean;
    hierarchyOnly?: boolean;
    source?: MindmapSource;
    /** 分册目录：有 ≥2 册且未 flatten 时插入 __part__ 层 */
    parts?: CoursePartInfo[] | null;
    /** true：章直接挂课根；默认 false 保留分册 */
    flattenParts?: boolean;
    lectureId?: string;
  } = {}
): MindmapDoc {
  const title = String(courseTitle || "").trim() || "课程";
  const byName = new Map(
    chapters.map((c) => [String(c.chapter || "").trim(), c] as const)
  );

  const parts = (opts.parts || []).filter((p) => (p.chapters || []).length);
  const flatten = Boolean(opts.flattenParts);
  const useParts = !flatten && parts.length >= 2;

  let children: MindmapTreeNode[];
  if (useParts) {
    const used = new Set<string>();
    children = [];
    for (const part of parts) {
      const partKids: MindmapTreeNode[] = [];
      for (const chName of part.chapters || []) {
        const hit = byName.get(String(chName).trim());
        if (!hit) continue;
        used.add(hit.chapter);
        partKids.push(makeChapterCourseNode(hit.chapter, hit.doc, opts));
      }
      if (!partKids.length) continue;
      const rawTitle = part.title || part.id || "分册";
      const displayTitle = String(rawTitle)
        .replace(/^分册(?:\s*[·:：-]\s*)?/, "")
        .trim() || "其他";
      children.push({
        id: `__part__/${part.id || part.title}`,
        zh: displayTitle,
        importance: 0.75,
        relation: "toc_part",
        related: [],
        children: partKids,
      });
    }
    const rest = chapters.filter((c) => !used.has(c.chapter));
    if (rest.length) {
      children.push({
        id: "__part__/other",
        zh: "其他",
        importance: 0.55,
        relation: "toc_part",
        related: [],
        children: rest.map((c) =>
          makeChapterCourseNode(c.chapter, c.doc, opts)
        ),
      });
    }
  } else {
    children = chapters.map(({ chapter, doc }) =>
      makeChapterCourseNode(chapter, doc, opts)
    );
  }

  const root: MindmapTreeNode = {
    id: `__course__/${title}`,
    zh: title,
    importance: 0.9,
    relation: null,
    related: [],
    children,
  };
  const lectureIds = chapters.flatMap((c) => c.doc.meta?.lecture_ids || []);
  return finalizeDoc(opts.lectureId || "course", root, {
    chapter: title,
    root_zh: title,
    virtual_root: true,
    scope: "course",
    lecture_ids: lectureIds,
    source: opts.source || "kg",
    n_chapters: chapters.length,
    n_parts: useParts ? children.length : 0,
    n_trees: 1,
    composed_from: "chapters",
    skeleton_view: Boolean(opts.hierarchyOnly) || undefined,
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

function normMatchKey(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[/\-·•,_，、]/g, "");
}

/** 课次复习点 / 片段标题 → 匹配键 */
export function collectLectureMatchKeys(terms: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const k = normMatchKey(raw);
    if (!k || k.length < 2) continue;
    if (/^片段\d*$/.test(k) || /好那么刚才|无有效口播/.test(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function nodeMatchScore(
  node: MindmapTreeNode,
  keys: string[],
  noteCorpusNorm?: string
): number {
  const zh = normMatchKey(node.zh || "");
  const idTail = normMatchKey(
    String(node.id || "")
      .split("/")
      .filter(Boolean)
      .slice(-1)[0] || ""
  );
  if (!zh && !idTail) return 0;
  let best = 0;
  // 笔记正文命中：节点名出现在 definition/summary/课次笔记里
  if (noteCorpusNorm && zh.length >= 2 && noteCorpusNorm.includes(zh)) {
    best = Math.max(best, zh.length >= 4 ? 9 : 7);
  }
  for (const k of keys) {
    if (!k) continue;
    if (zh === k || idTail === k) best = Math.max(best, 10);
    else if (zh.includes(k) || k.includes(zh)) {
      const shorter = Math.min(zh.length, k.length);
      const longer = Math.max(zh.length || 1, k.length);
      if (shorter >= 2 && shorter / longer >= 0.45) {
        best = Math.max(best, shorter >= 4 ? 8 : 6);
      }
    } else if (idTail && (idTail.includes(k) || k.includes(idTail))) {
      best = Math.max(best, 5);
    }
  }
  return best;
}

/**
 * 按课次关键词 / 笔记正文从章树抽出相关子树（含祖先路径）。
 * 部分子节点未命中时保留命中枝，父节点标 weak（残缺子树）。
 */
export function extractMatchingSubtree(
  root: MindmapTreeNode,
  matchTerms: Iterable<string>,
  opts: { minScore?: number; noteCorpus?: string } = {}
): MindmapTreeNode | null {
  const keys = collectLectureMatchKeys(matchTerms);
  const noteCorpusNorm = opts.noteCorpus
    ? normMatchKey(opts.noteCorpus)
    : "";
  if (!keys.length && !noteCorpusNorm) return null;
  const minScore = opts.minScore ?? 6;

  const walk = (
    node: MindmapTreeNode
  ): { node: MindmapTreeNode; hit: boolean; childTotal: number } | null => {
    const kids = node.children || [];
    const kept: MindmapTreeNode[] = [];
    let childHits = 0;
    for (const c of kids) {
      const sub = walk(c);
      if (!sub) continue;
      kept.push(sub.node);
      if (sub.hit) childHits += 1;
    }
    const selfScore = nodeMatchScore(node, keys, noteCorpusNorm);
    const selfHit = selfScore >= minScore;
    const isVirtual = String(node.id || "").startsWith("__");
    // 虚根/章根：仅当有子命中时保留
    if (isVirtual && String(node.id).startsWith("__chapter__/")) {
      if (!kept.length) return null;
      return {
        node: {
          ...cloneNode(node),
          children: kept,
          weak: kept.length < kids.length ? true : node.weak,
        },
        hit: true,
        childTotal: kids.length,
      };
    }
    if (!selfHit && !kept.length) return null;
    const incomplete = kids.length > 0 && kept.length > 0 && kept.length < kids.length;
    // 自身命中但子级全未命中：保留为叶（残缺：丢掉未讲细节）
    const children =
      selfHit && !kept.length
        ? []
        : kept;
    return {
      node: {
        ...cloneNode(node),
        children,
        weak: incomplete || (selfHit && kids.length > 0 && !kept.length) || node.weak,
      },
      hit: selfHit || childHits > 0,
      childTotal: kids.length,
    };
  };

  const result = walk(root);
  return result?.node || null;
}

/** 章树相对课次关键词 / 笔记正文的覆盖分（用于无 lecture_ids 时选章） */
export function scoreChapterAgainstTerms(
  doc: MindmapDoc,
  matchTerms: Iterable<string>,
  opts: { noteCorpus?: string } = {}
): number {
  const keys = collectLectureMatchKeys(matchTerms);
  const noteCorpusNorm = opts.noteCorpus
    ? normMatchKey(opts.noteCorpus)
    : "";
  if (!keys.length && !noteCorpusNorm) return 0;
  const root = docForest(doc)[0];
  if (!root) return 0;
  let score = 0;
  const walk = (n: MindmapTreeNode) => {
    score += nodeMatchScore(n, keys, noteCorpusNorm);
    for (const c of n.children || []) walk(c);
  };
  walk(root);
  return score;
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
 * 2) 有 matchTerms（课次复习点/片段）时，按相关/残缺子树抽取（text_first 主路径）
 * 3) 否则若给了 entityIds，按实体剪枝；仍无信号则整章（兼容旧数据）
 * 4) 多章时挂到虚根下
 */
export function sliceChaptersForLectures(
  chapters: { chapter: string; doc: MindmapDoc }[],
  lectureIds: string[],
  opts: {
    entityIds?: Iterable<string>;
    /** 课次内容关键词（review points / 片段标题 / 大纲信号） */
    matchTerms?: Iterable<string>;
    /** 笔记正文语料（definition/summary/课次笔记） */
    noteCorpus?: string;
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
  const matchKeys = collectLectureMatchKeys(opts.matchTerms || []);
  const noteCorpus = String(opts.noteCorpus || "").trim();
  const hasMatchSignal = matchKeys.length > 0 || noteCorpus.length > 0;
  const minNodes = opts.minNodes ?? 4;
  const matchOpts = { noteCorpus: noteCorpus || undefined };

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
      if (hasMatchSignal) {
        piece =
          extractMatchingSubtree(chRoot, matchKeys, matchOpts) ||
          (keep.size ? pruneTreeByEntityIds(chRoot, keep) : null) ||
          chRoot;
      } else if (keep.size && countNodes(chRoot) > 48) {
        piece = pruneTreeByEntityIds(chRoot, keep) || chRoot;
      } else {
        piece = chRoot;
      }
    } else {
      const root = docForest(doc)[0];
      if (!root) continue;
      const isOutline =
        doc.meta?.pipeline === "text_first_v1" ||
        doc.meta?.source === "outline_text" ||
        doc.meta?.source === "outline+kg";

      if (hasMatchSignal) {
        const matched = extractMatchingSubtree(root, matchKeys, matchOpts);
        if (matched && countNodes(matched) >= 2) {
          piece = matched;
        } else if (keep.size) {
          piece = pruneTreeByEntityIds(root, keep);
        }
        // text_first：匹配过稀时不回整章，宁可跳过该章
        if (!piece && !isOutline) piece = cloneNode(root);
      } else if (!keep.size) {
        piece = cloneNode(root);
      } else {
        let pruned = pruneTreeByEntityIds(root, keep);
        if (
          isOutline &&
          (!pruned || countNodes(pruned) < Math.min(minNodes, 4))
        ) {
          pruned = cloneNode(root);
        }
        piece = pruned;
      }
    }
    if (piece && (piece.children?.length || !piece.id.startsWith("__"))) {
      // 统一章包装，便于多章拼接
      if (!String(piece.id || "").startsWith("__chapter__/")) {
        piece = {
          id: `__chapter__/${chapter}`,
          zh: chapter,
          importance: 0.7,
          relation: "toc_chapter",
          related: [],
          children: piece.children?.length
            ? piece.children
            : piece.id.startsWith("__")
              ? []
              : [piece],
          weak: piece.weak,
        };
      } else {
        piece = { ...piece, zh: chapter };
      }
      pieces.push(piece);
    }
  }

  if (!pieces.length) return null;

  const sessionId =
    opts.sessionId ||
    (lids.length === 2 ? `${lids[0]}_${lids[1]}` : lids[0] || "session");
  const sessIdx = Math.ceil(Math.min(...lids.map(Number).filter((n) => n > 0)) / 2) || 1;
  const label = `第 ${sessIdx} 次课`;

  // 单章/多章均保留 __chapter__ 壳，树上可见章节名称
  const root: MindmapTreeNode = {
    id: `__lecture__/${sessionId}`,
    zh: label,
    importance: 0.6,
    relation: null,
    related: [],
    children: pieces,
  };

  const stats = forestStats([root]);
  if (stats.n_nodes < minNodes) return null;

  return finalizeDoc(sessionId, root, {
    chapter: chapters.length === 1 ? chapters[0].chapter : undefined,
    root_zh: label,
    virtual_root: true,
    scope: "lecture",
    lecture_ids: lids,
    source: opts.source || (hasMatchSignal ? "review+kg" : "kg"),
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
  items: MindmapIndexItem[],
  opts: {
    chapterOrder?: string[];
  } = {}
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
  // 已有部分章条目时仍与讲次聚合结果并集，避免 index 只登记 2 章导致侧栏「章节」缺失
  const aggregated = aggregateChapterIndexItems(lectures);
  const chapterByKey = new Map<string, MindmapIndexItem>();
  const putChapter = (it: MindmapIndexItem) => {
    const key =
      String(it.chapter || it.root_zh || "").trim() ||
      String(it.lecture_id || "").trim();
    if (!key) return;
    const prev = chapterByKey.get(key);
    if (!prev) {
      chapterByKey.set(key, { ...it, scope: "chapter" });
      return;
    }
    const lids = [
      ...new Set([...(prev.lecture_ids || []), ...(it.lecture_ids || [])].map(String)),
    ].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    chapterByKey.set(key, {
      ...prev,
      ...it,
      scope: "chapter",
      lecture_ids: lids.length ? lids : prev.lecture_ids,
      n_nodes: Math.max(Number(prev.n_nodes) || 0, Number(it.n_nodes) || 0),
      path: prev.path || it.path,
    });
  };
  for (const it of existingChapters) putChapter(it);
  for (const it of aggregated) putChapter(it);
  // catalog 章序：补全尚无索引行的章名（占位，path 按约定）
  for (const name of opts.chapterOrder || []) {
    const ch = String(name || "").trim();
    if (!ch || chapterByKey.has(ch)) continue;
    const slug = chapterFileSlug(ch);
    putChapter({
      lecture_id: chapterNavId(ch),
      chapter: ch,
      chapter_id: ch,
      root_zh: ch.replace(/^第\s*\d+\s*章\s*/, "").trim() || ch,
      n_nodes: 2,
      max_depth: 1,
      orphan_count: 0,
      path: `mindmaps/chapter_${slug}.json`,
      scope: "chapter",
      lecture_ids: [],
      source: "kg",
    });
  }
  const chapters = [...chapterByKey.values()].sort((a, b) => {
    const order = opts.chapterOrder || [];
    const ia = order.indexOf(String(a.chapter || ""));
    const ib = order.indexOf(String(b.chapter || ""));
    if (ia >= 0 || ib >= 0) {
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    }
    return String(a.chapter || "").localeCompare(String(b.chapter || ""), "zh");
  });

  const normalizeLecture = (it: MindmapIndexItem): MindmapIndexItem => ({
    ...it,
    scope: it.scope || "lecture",
    source: it.source || "kg",
    chapter_id: it.chapter_id || it.chapter,
  });

  const orderIdx = new Map(
    (opts.chapterOrder || []).map((n, i) => [String(n), i])
  );
  const chapterNum = (s?: string) => {
    const m = String(s || "").match(/第\s*(\d+)\s*章/);
    return m ? Number(m[1]) : 999;
  };
  const sortedChapters = [...chapters].sort((a, b) => {
    const ca = String(a.chapter || a.root_zh || "");
    const cb = String(b.chapter || b.root_zh || "");
    const ia = orderIdx.has(ca) ? orderIdx.get(ca)! : 10_000;
    const ib = orderIdx.has(cb) ? orderIdx.get(cb)! : 10_000;
    if (ia !== ib) return ia - ib;
    return chapterNum(ca) - chapterNum(cb) || ca.localeCompare(cb, "zh");
  });

  const sortedLectures = [...lectures]
    .map(normalizeLecture)
    .sort(
      (a, b) =>
        Number(a.lecture_id) - Number(b.lecture_id) ||
        String(a.lecture_id).localeCompare(String(b.lecture_id), "zh")
    );

  return [
    ...course.map((c) => ({
      ...c,
      scope: "course" as const,
      source: c.source || ("kg" as const),
    })),
    ...sortedChapters,
    ...sortedLectures,
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
