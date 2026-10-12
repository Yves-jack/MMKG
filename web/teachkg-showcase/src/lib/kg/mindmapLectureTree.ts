/**
 * 讲次导图组装为：第 N 讲 → 本讲涉及的章节 → 每章下本讲相关子树
 */
import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";
import { courseDataUrl } from "@/lib/course";
import { pruneMindmapRedundancy } from "@/lib/kg/mindmapPruneRedundancy";

export type LectureAssignRow = {
  subtree_root_id: string;
  chapter: string;
  confidence?: number;
  reason?: string;
};

export type LectureAssignDoc = {
  lecture_id?: string;
  candidates?: string[];
  assignments?: LectureAssignRow[];
};

function cloneNode(n: MindmapTreeNode): MindmapTreeNode {
  return {
    ...n,
    children: (n.children || []).map(cloneNode),
  };
}

function forestOf(doc: MindmapDoc): MindmapTreeNode[] {
  if (doc.roots?.length) return doc.roots.map(cloneNode);
  if (doc.root) return [cloneNode(doc.root)];
  return [];
}

function countNodes(n: MindmapTreeNode): number {
  return 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
}

function depthOf(n: MindmapTreeNode, d = 0): number {
  if (!n.children?.length) return d;
  return Math.max(...n.children.map((c) => depthOf(c, d + 1)));
}

function chapterBare(chapter: string): string {
  return String(chapter || "")
    .replace(/^第\s*\d+\s*章\s*/, "")
    .trim();
}

function chapterNum(chapter: string): number {
  const m = String(chapter || "").match(/第\s*(\d+)\s*章/);
  return m ? Number(m[1]) : 999;
}

/** 剥掉已有讲次/章虚根，露出主题森林，便于重新按章归桶 */
function unwrapToTopicForest(trees: MindmapTreeNode[]): MindmapTreeNode[] {
  const out: MindmapTreeNode[] = [];
  for (const t of trees) {
    const id = String(t.id || "");
    if (id.startsWith("__lecture__/")) {
      for (const ch of t.children || []) {
        const cid = String(ch.id || "");
        if (cid.startsWith("__chapter__/")) {
          out.push(...(ch.children || []).map(cloneNode));
        } else {
          out.push(cloneNode(ch));
        }
      }
      continue;
    }
    if (id.startsWith("__chapter__/")) {
      out.push(...(t.children || []).map(cloneNode));
      continue;
    }
    out.push(cloneNode(t));
  }
  return out;
}

/** 在森林中按 id 抽取子树（任意深度） */
function findSubtree(trees: MindmapTreeNode[], rootId: string): MindmapTreeNode | null {
  const target = String(rootId || "");
  if (!target) return null;
  const walk = (n: MindmapTreeNode): MindmapTreeNode | null => {
    if (String(n.id) === target) return cloneNode(n);
    for (const c of n.children || []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  for (const t of trees) {
    const hit = walk(t);
    if (hit) return hit;
  }
  return null;
}

/** 裁掉已匹配子树后的剩余顶层 */
function removeSubtrees(trees: MindmapTreeNode[], rootIds: Set<string>): MindmapTreeNode[] {
  const strip = (n: MindmapTreeNode): MindmapTreeNode | null => {
    if (rootIds.has(String(n.id))) return null;
    const kids = (n.children || [])
      .map(strip)
      .filter((x): x is MindmapTreeNode => !!x);
    return { ...n, children: kids };
  };
  return trees.map(strip).filter((x): x is MindmapTreeNode => !!x);
}

/**
 * 用 assign 结果把讲次森林收成：第 N 讲 → 章 → 本讲相关子树
 * subtree_root_id 可为任意深度节点。
 */
export function wrapLectureMindmapByChapters(
  doc: MindmapDoc,
  lectureId: string,
  assignments: LectureAssignRow[] | null | undefined,
  opts: {
    chapterHint?: string | null;
    chapterOrder?: string[] | null;
  } = {}
): MindmapDoc {
  const trees = unwrapToTopicForest(forestOf(doc));
  if (!trees.length) return doc;

  // 流水线已产出讲→章结构时直接用
  const rawRoots = forestOf(doc);
  if (rawRoots[0] && String(rawRoots[0].id).startsWith("__lecture__/")) {
    return doc;
  }

  const buckets = new Map<string, MindmapTreeNode[]>();
  const seenOrder: string[] = [];

  const push = (chapter: string, node: MindmapTreeNode) => {
    const ch =
      String(chapter || "").trim() ||
      String(opts.chapterHint || "").trim() ||
      "本讲内容";
    if (!buckets.has(ch)) {
      buckets.set(ch, []);
      seenOrder.push(ch);
    }
    // 同 id 不重复挂
    const list = buckets.get(ch)!;
    if (!list.some((n) => n.id === node.id)) list.push(node);
  };

  const used = new Set<string>();
  for (const a of assignments || []) {
    const rid = String(a.subtree_root_id || "").trim();
    const node = findSubtree(trees, rid);
    if (!node) continue;
    used.add(rid);
    push(a.chapter, node);
  }
  for (const t of removeSubtrees(trees, used)) {
    if (String(t.id || "").startsWith("__")) continue;
    push(opts.chapterHint || "本讲内容", t);
  }

  const preferred = [
    ...(opts.chapterOrder || []),
    ...(assignments || []).map((a) => a.chapter),
    ...(opts.chapterHint ? [opts.chapterHint] : []),
  ]
    .map((c) => String(c || "").trim())
    .filter(Boolean);

  const chapterNames = [...buckets.keys()].sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    if (ia >= 0 || ib >= 0) {
      return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib);
    }
    return chapterNum(a) - chapterNum(b) || a.localeCompare(b, "zh");
  });

  const chapterNodes: MindmapTreeNode[] = chapterNames.map((ch) => {
    const kids = (buckets.get(ch) || []).sort(
      (a, b) => (b.importance || 0) - (a.importance || 0)
    );
    return {
      id: `__chapter__/${chapterBare(ch) || ch}`,
      zh: ch.startsWith("第") ? ch : ch === "本讲内容" ? ch : ch,
      importance: Math.max(0.45, ...kids.map((k) => Number(k.importance) || 0)),
      relation: "toc_chapter",
      related: [],
      children: kids,
    };
  });

  const root: MindmapTreeNode = {
    id: `__lecture__/${lectureId}`,
    zh: `第 ${lectureId} 讲`,
    importance: 0.9,
    relation: null,
    related: [],
    children: chapterNodes,
  };

  return {
    ...doc,
    lecture_id: String(lectureId),
    root,
    roots: [root],
    n_nodes: countNodes(root),
    max_depth: depthOf(root),
    meta: {
      ...doc.meta,
      scope: "lecture",
      root_zh: `第 ${lectureId} 讲`,
      virtual_root: true,
      n_trees: 1,
      composed_from: undefined,
      chapter: chapterNames[0] || opts.chapterHint || doc.meta?.chapter,
      lecture_ids: [String(lectureId)],
    },
  };
}

export async function loadLectureAssign(
  courseId: string,
  lectureId: string
): Promise<LectureAssignDoc | null> {
  try {
    const r = await fetch(
      `${courseDataUrl(courseId, `mindmaps/lecture_${lectureId}.assign.json`)}?t=${Date.now()}`,
      { cache: "no-store" }
    );
    if (!r.ok) return null;
    return (await r.json()) as LectureAssignDoc;
  } catch {
    return null;
  }
}

/** 静态讲次导图 + 讲→章→子树包装 + 冗余裁剪 */
export async function loadWrappedLectureMindmap(
  courseId: string,
  lectureId: string,
  baseDoc: MindmapDoc,
  opts: {
    chapterHint?: string | null;
    chapterOrder?: string[] | null;
  } = {}
): Promise<MindmapDoc> {
  const assign = await loadLectureAssign(courseId, lectureId);
  // 先裁剪主题冗余，再按章归桶，避免虚根干扰
  const prunedTopics = pruneMindmapRedundancy({
    ...baseDoc,
    root: unwrapToTopicForest(forestOf(baseDoc))[0] || baseDoc.root,
    roots: unwrapToTopicForest(forestOf(baseDoc)),
  });
  return wrapLectureMindmapByChapters(
    prunedTopics,
    lectureId,
    assign?.assignments,
    {
      chapterHint: opts.chapterHint || assign?.candidates?.[0],
      chapterOrder: opts.chapterOrder || assign?.candidates || null,
    }
  );
}
