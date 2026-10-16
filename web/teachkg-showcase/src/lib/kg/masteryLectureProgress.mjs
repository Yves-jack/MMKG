import { isStructuralMindmapNode } from "./mindmapResourceIdentity.mjs";

// Course progress is independent of chapter numbers and paired classroom sessions.
const completedLectures = Object.freeze({
  "离散数学(图论+数理逻辑与集合论)": 10,
});
export function personalMasteryLectureLimit(courseId) {
  return completedLectures[courseId] ?? null;
}
const key = (value) => typeof value === "string"
  ? value.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
function names(node) {
  return [node.id, node.label, node.zh, ...(node.aliases || [])]
    .filter((value) => typeof value === "string" && !value.startsWith("__"))
    .flatMap((value) => [key(value), key(value.split("/")[0])])
    .filter(Boolean);
}
const chapterKey = (value) => key(value).replace(/^第\s*\d+\s*章\s*/, "");
function lectureChapters(doc) {
  const chapters = new Set();
  const walk = (node) => {
    if (String(node.id).startsWith("__chapter__/")) chapters.add(chapterKey(node.zh));
    for (const child of node.children || []) walk(child);
  };
  for (const root of doc.roots?.length ? doc.roots : doc.root ? [doc.root] : []) walk(root);
  return [...chapters];
}
function sourceNodes(source) {
  if (Array.isArray(source?.nodes) && source.nodes.length) return source.nodes;
  const out = [];
  const walk = (node) => {
    if (!isStructuralMindmapNode(node)) out.push(node);
    for (const child of node.children || []) walk(child);
  };
  for (const root of source?.roots?.length ? source.roots : source?.root ? [source.root] : []) walk(root);
  return out;
}

/** Keep exact taught concepts and their ancestors, never all descendants of a taught parent. */
export function filterMindmapByLectureProgress(doc, sources, throughLecture) {
  if (!Number.isInteger(throughLecture) || throughLecture < 1)
    throw new Error("已完成讲次必须为正整数");
  const taught = new Set();
  const taughtByChapter = new Map();
  const covered = new Set();
  for (const source of sources) {
    const lecture = Number(source.lecture_id);
    if (!Number.isInteger(lecture) || lecture < 1 || lecture > throughLecture) continue;
    const nodes = sourceNodes(source);
    if (!nodes.length) continue;
    covered.add(lecture);
    const chapters = source.chapter_names || [];
    for (const node of nodes) for (const name of names(node)) {
      if (!chapters.length) taught.add(name);
      for (const chapter of chapters) {
        const chapterName = chapterKey(chapter);
        if (!taughtByChapter.has(chapterName)) taughtByChapter.set(chapterName, new Set());
        taughtByChapter.get(chapterName).add(name);
      }
    }
  }
  for (let lecture = 1; lecture <= throughLecture; lecture++) {
    if (!covered.has(lecture)) throw new Error(`缺少第 ${lecture} 讲知识点数据，无法限定已学范围`);
  }
  let nNodes = 0, maxDepth = 0, nChapters = 0, nParts = 0;
  const retainedIds = new Set();
  const prune = (node, depth, isRoot = false, chapter = "") => {
    const context = String(node.id).startsWith("__chapter__/") ? chapterKey(node.zh) : chapter;
    const children = (node.children || []).map((child) => prune(child, depth + 1, false, context)).filter(Boolean);
    const matched = !isStructuralMindmapNode(node) && names(node).some((name) => taught.has(name) || taughtByChapter.get(context)?.has(name));
    if (!isRoot && !matched && !children.length) return null;
    nNodes++;
    maxDepth = Math.max(maxDepth, depth);
    retainedIds.add(node.id);
    if (String(node.id).startsWith("__chapter__/")) nChapters++;
    if (String(node.id).startsWith("__part__/")) nParts++;
    return { ...node, children };
  };
  const roots = (doc.roots?.length ? doc.roots : [doc.root]).map((root) => prune(root, 0, true));
  return {
    ...doc,
    root: roots[0],
    ...(doc.roots ? { roots } : {}),
    n_nodes: nNodes,
    max_depth: maxDepth,
    orphan_count: 0,
    ...(doc.remoteLinks ? { remoteLinks: doc.remoteLinks.filter((edge) => retainedIds.has(edge.from) && retainedIds.has(edge.to)) } : {}),
    meta: { ...doc.meta, lecture_ids: Array.from({ length: throughLecture }, (_, i) => String(i + 1)),
      completed_lecture: throughLecture, n_chapters: nChapters, n_parts: nParts },
  };
}

/** Use uncapped classroom KG nodes; older deployments may fall back to their lecture mindmaps. */
export async function loadPersonalMasteryProgress(doc, throughLecture, loadJson) {
  const sources = await Promise.all(Array.from({ length: throughLecture }, async (_, i) => {
    const lecture = String(i + 1);
    const [processed, mindmap] = await Promise.all([
      loadJson(`pipeline/kg_processed_lecture_${lecture}.json`),
      loadJson(`mindmaps/lecture_${lecture}.json`),
    ]);
    // Chapter context comes from the tuned lecture tree, not a chapter-number cutoff.
    if (String(mindmap?.lecture_id) !== lecture || !sourceNodes(mindmap).length)
      throw new Error(`缺少第 ${lecture} 讲导图数据，无法限定已学范围`);
    const source = String(processed?.lecture_id) === lecture && sourceNodes(processed).length ? processed : mindmap;
    if (sourceNodes(source).length) return { ...source, chapter_names: lectureChapters(mindmap) };
    throw new Error(`缺少第 ${lecture} 讲知识点数据，无法限定已学范围`);
  }));
  return filterMindmapByLectureProgress(doc, sources, throughLecture);
}
