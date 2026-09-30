/**
 * 思维导图本地编辑：增删移子树、剪贴板、横向远程连接。
 * 持久化在 localStorage，按 courseId + lectureId 分键；章导图另可写盘。
 */
import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";

export type MindmapRemoteLink = {
  id: string;
  from: string;
  to: string;
  label?: string;
};

/** 森林路径：第 0 段为树下标，其后为各层 children 下标 */
export type MindmapPath = number[];

export type MindmapEditPatch = {
  version: 1;
  trees: MindmapTreeNode[];
  remoteLinks: MindmapRemoteLink[];
  updatedAt: number;
};

function storageKey(courseId: string, lectureId: string) {
  return `teachkg.mindmap.edits.v1:${courseId}:${lectureId}`;
}

export function cloneNode(n: MindmapTreeNode): MindmapTreeNode {
  return {
    ...n,
    children: (n.children || []).map(cloneNode),
    deps: n.deps ? [...n.deps] : undefined,
    related: n.related ? [...n.related] : undefined,
  };
}

export function cloneForest(trees: MindmapTreeNode[]): MindmapTreeNode[] {
  return trees.map(cloneNode);
}

export function docForest(doc: MindmapDoc): MindmapTreeNode[] {
  return doc.roots?.length ? doc.roots : doc.root ? [doc.root] : [];
}

export function withForest(
  doc: MindmapDoc,
  trees: MindmapTreeNode[],
  remoteLinks?: MindmapRemoteLink[]
): MindmapDoc {
  const countNodes = (n: MindmapTreeNode): number =>
    1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
  const depthOf = (n: MindmapTreeNode, d = 0): number =>
    (n.children || []).length
      ? Math.max(...n.children.map((c) => depthOf(c, d + 1)))
      : d;
  const n_nodes = trees.reduce((s, t) => s + countNodes(t), 0);
  const max_depth = trees.length ? Math.max(...trees.map((t) => depthOf(t))) : 0;
  const root = trees[0] || doc.root;
  return {
    ...doc,
    root,
    roots: trees,
    n_nodes,
    max_depth,
    remoteLinks: remoteLinks ?? doc.remoteLinks ?? [],
    meta: {
      ...(doc.meta || {}),
      n_trees: trees.length,
    },
  };
}

export function getAt(
  trees: MindmapTreeNode[],
  path: MindmapPath
): MindmapTreeNode | null {
  if (!path.length) return null;
  let cur: MindmapTreeNode | undefined = trees[path[0]];
  if (!cur) return null;
  for (let i = 1; i < path.length; i++) {
    cur = cur.children?.[path[i]];
    if (!cur) return null;
  }
  return cur;
}

export function pathEquals(a: MindmapPath, b: MindmapPath) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function isAncestorPath(anc: MindmapPath, desc: MindmapPath) {
  if (anc.length >= desc.length) return false;
  return anc.every((v, i) => v === desc[i]);
}

/** 删除节点：子节点接到被删节点的父亲（同级插入原位置） */
export function deleteNodePromoteChildren(
  trees: MindmapTreeNode[],
  path: MindmapPath
): MindmapTreeNode[] | null {
  if (!path.length) return null;
  const next = cloneForest(trees);
  const node = getAt(next, path);
  if (!node) return null;
  const kids = [...(node.children || [])];

  if (path.length === 1) {
    // 删整棵树根：子树升为森林中的新树
    next.splice(path[0], 1, ...kids);
    return next.length ? next : trees;
  }

  const parentPath = path.slice(0, -1);
  const parent = getAt(next, parentPath);
  if (!parent) return null;
  const idx = path[path.length - 1];
  parent.children = [
    ...parent.children.slice(0, idx),
    ...kids,
    ...parent.children.slice(idx + 1),
  ];
  return next;
}

/** 整枝删除（含全部子孙） */
export function deleteSubtree(
  trees: MindmapTreeNode[],
  path: MindmapPath
): MindmapTreeNode[] | null {
  if (!path.length) return null;
  const next = cloneForest(trees);
  if (!getAt(next, path)) return null;
  if (path.length === 1) {
    next.splice(path[0], 1);
    return next;
  }
  const parent = getAt(next, path.slice(0, -1));
  if (!parent) return null;
  const idx = path[path.length - 1];
  parent.children = [
    ...parent.children.slice(0, idx),
    ...parent.children.slice(idx + 1),
  ];
  return next;
}

function newNodeId(zh: string): string {
  const base = String(zh || "节点").trim() || "节点";
  return `__manual__/${base}/${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function makeLeafNode(zh: string, opts?: Partial<MindmapTreeNode>): MindmapTreeNode {
  const name = String(zh || "").trim() || "新节点";
  return {
    id: opts?.id || newNodeId(name),
    zh: name,
    importance: opts?.importance ?? 0.35,
    relation: opts?.relation ?? "manual",
    related: opts?.related ? [...opts.related] : [],
    deps: opts?.deps ? [...opts.deps] : [],
    children: [],
  };
}

/** 在 parent 下追加子节点 */
export function addChildNode(
  trees: MindmapTreeNode[],
  parentPath: MindmapPath,
  child: MindmapTreeNode
): MindmapTreeNode[] | null {
  if (!parentPath.length) return null;
  const next = cloneForest(trees);
  const parent = getAt(next, parentPath);
  if (!parent) return null;
  parent.children = [...(parent.children || []), cloneNode(child)];
  return next;
}

/** 在 path 所指节点后插入同级 */
export function addSiblingNode(
  trees: MindmapTreeNode[],
  path: MindmapPath,
  sibling: MindmapTreeNode
): MindmapTreeNode[] | null {
  if (!path.length) return null;
  const next = cloneForest(trees);
  if (path.length === 1) {
    next.splice(path[0] + 1, 0, cloneNode(sibling));
    return next;
  }
  const parent = getAt(next, path.slice(0, -1));
  if (!parent) return null;
  const idx = path[path.length - 1];
  parent.children = [
    ...parent.children.slice(0, idx + 1),
    cloneNode(sibling),
    ...parent.children.slice(idx + 1),
  ];
  return next;
}

/** 同级顺序调整：delta = -1 上移 / +1 下移；成功返回新森林与新 path */
export function reorderSibling(
  trees: MindmapTreeNode[],
  path: MindmapPath,
  delta: -1 | 1
): { trees: MindmapTreeNode[]; path: MindmapPath } | null {
  if (!path.length || (delta !== -1 && delta !== 1)) return null;
  const idx = path[path.length - 1];
  const nextIdx = idx + delta;
  const next = cloneForest(trees);

  if (path.length === 1) {
    if (nextIdx < 0 || nextIdx >= next.length) return null;
    const [item] = next.splice(idx, 1);
    next.splice(nextIdx, 0, item);
    return { trees: next, path: [nextIdx] };
  }

  const parent = getAt(next, path.slice(0, -1));
  if (!parent?.children) return null;
  if (nextIdx < 0 || nextIdx >= parent.children.length) return null;
  const kids = [...parent.children];
  const [item] = kids.splice(idx, 1);
  kids.splice(nextIdx, 0, item);
  parent.children = kids;
  return { trees: next, path: [...path.slice(0, -1), nextIdx] };
}

/** 是否还可上移 / 下移（不改树） */
export function canReorderSibling(
  trees: MindmapTreeNode[],
  path: MindmapPath | null | undefined
): { up: boolean; down: boolean } {
  if (!path?.length) return { up: false, down: false };
  const idx = path[path.length - 1];
  if (path.length === 1) {
    return { up: idx > 0, down: idx < trees.length - 1 };
  }
  const parent = getAt(trees, path.slice(0, -1));
  const n = parent?.children?.length ?? 0;
  return { up: idx > 0, down: idx < n - 1 };
}

/** 按导图键缓存撤销栈（跨章节切换保留，便于跨图剪切粘贴后回源撤销） */
export type MindmapUndoEntry = {
  doc: MindmapDoc;
  /** 该步相对上一状态做了什么（简短） */
  label: string;
  at: number;
};

/** 右栏展示用（不含完整快照） */
export type MindmapHistoryItem = {
  label: string;
  at: number;
};

const undoStacks = new Map<string, MindmapUndoEntry[]>();

export function loadMindmapUndoStack(scopeKey: string): MindmapUndoEntry[] {
  if (!scopeKey) return [];
  return undoStacks.get(scopeKey) || [];
}

export function saveMindmapUndoStack(scopeKey: string, stack: MindmapUndoEntry[]) {
  if (!scopeKey) return;
  if (!stack.length) undoStacks.delete(scopeKey);
  else undoStacks.set(scopeKey, stack);
}

export function clearMindmapUndoStack(scopeKey: string) {
  if (!scopeKey) return;
  undoStacks.delete(scopeKey);
}

/** 深拷贝子树并重生所有 id（跨图粘贴用） */
export function cloneSubtreeWithNewIds(node: MindmapTreeNode): MindmapTreeNode {
  const walk = (n: MindmapTreeNode): MindmapTreeNode => {
    const zh = n.zh || "节点";
    return {
      ...n,
      id: newNodeId(zh),
      children: (n.children || []).map(walk),
      deps: n.deps ? [...n.deps] : undefined,
      related: n.related ? [...n.related] : undefined,
      copy: true,
    };
  };
  return walk(cloneNode(node));
}

const CLIP_KEY = "teachkg.mindmap.clipboard.v1";

export type MindmapClipboard = {
  version: 1;
  subtree: MindmapTreeNode;
  sourceLectureId?: string;
  cut?: boolean;
  updatedAt: number;
};

export function saveMindmapClipboard(clip: Omit<MindmapClipboard, "version" | "updatedAt">) {
  const full: MindmapClipboard = {
    version: 1,
    subtree: cloneNode(clip.subtree),
    sourceLectureId: clip.sourceLectureId,
    cut: Boolean(clip.cut),
    updatedAt: Date.now(),
  };
  try {
    sessionStorage.setItem(CLIP_KEY, JSON.stringify(full));
  } catch {
    /* ignore */
  }
  return full;
}

export function loadMindmapClipboard(): MindmapClipboard | null {
  try {
    const raw = sessionStorage.getItem(CLIP_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as MindmapClipboard;
    if (j?.version !== 1 || !j.subtree?.id) return null;
    return j;
  } catch {
    return null;
  }
}

export function clearMindmapClipboard() {
  try {
    sessionStorage.removeItem(CLIP_KEY);
  } catch {
    /* ignore */
  }
}

/** 收集森林中全部节点（扁平，含 path） */
export function flattenForest(
  trees: MindmapTreeNode[]
): { node: MindmapTreeNode; path: MindmapPath }[] {
  const out: { node: MindmapTreeNode; path: MindmapPath }[] = [];
  const walk = (n: MindmapTreeNode, path: MindmapPath) => {
    out.push({ node: n, path });
    (n.children || []).forEach((c, i) => walk(c, [...path, i]));
  };
  trees.forEach((t, i) => walk(t, [i]));
  return out;
}

/** 把 from 子树挪到 toParent 下（追加为最后一个孩子） */
export function moveSubtree(
  trees: MindmapTreeNode[],
  fromPath: MindmapPath,
  toParentPath: MindmapPath
): MindmapTreeNode[] | null {
  if (!fromPath.length) return null;
  if (pathEquals(fromPath, toParentPath)) return null;
  if (isAncestorPath(fromPath, toParentPath)) return null; // 不能移进自己的后代

  const next = cloneForest(trees);
  const moving = getAt(next, fromPath);
  const toParent = getAt(next, toParentPath);
  if (!moving || !toParent) return null;

  // detach
  if (fromPath.length === 1) {
    next.splice(fromPath[0], 1);
  } else {
    const parent = getAt(next, fromPath.slice(0, -1));
    if (!parent) return null;
    const idx = fromPath[fromPath.length - 1];
    // 若 toParent 在同一父链且下标受 splice 影响：先取再插
    parent.children = [
      ...parent.children.slice(0, idx),
      ...parent.children.slice(idx + 1),
    ];
  }

  // toParent 路径可能因同树删除而偏移——仅当 toParent 与 from 同树且在 from 之后的兄弟时需修正
  // 简化：重新在 next 上按 id+原路径近似定位；若失败则用传入路径修正
  let dest = getAt(next, adjustPathAfterDetach(toParentPath, fromPath));
  if (!dest) {
    // 回退：按 id 搜索
    dest = findFirstById(next, toParent.id);
  }
  if (!dest) return null;
  dest.children = [...(dest.children || []), cloneNode(moving)];
  return next;
}

function adjustPathAfterDetach(toPath: MindmapPath, fromPath: MindmapPath): MindmapPath {
  if (!fromPath.length || !toPath.length) return toPath;
  // 同父下、from 在 to 之前：to 的最后一段下标 -1
  if (
    fromPath.length === toPath.length &&
    fromPath.slice(0, -1).every((v, i) => v === toPath[i]) &&
    fromPath[fromPath.length - 1] < toPath[toPath.length - 1]
  ) {
    const adj = [...toPath];
    adj[adj.length - 1] -= 1;
    return adj;
  }
  // from 是森林根且 to 是后面的树
  if (
    fromPath.length === 1 &&
    toPath.length >= 1 &&
    fromPath[0] < toPath[0]
  ) {
    const adj = [...toPath];
    adj[0] -= 1;
    return adj;
  }
  return toPath;
}

export function findFirstById(
  trees: MindmapTreeNode[],
  id: string
): MindmapTreeNode | null {
  const walk = (n: MindmapTreeNode): MindmapTreeNode | null => {
    if (n.id === id) return n;
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

export function findPathById(
  trees: MindmapTreeNode[],
  id: string
): MindmapPath | null {
  const walk = (n: MindmapTreeNode, path: MindmapPath): MindmapPath | null => {
    if (n.id === id) return path;
    for (let i = 0; i < (n.children || []).length; i++) {
      const hit = walk(n.children[i], [...path, i]);
      if (hit) return hit;
    }
    return null;
  };
  for (let i = 0; i < trees.length; i++) {
    const hit = walk(trees[i], [i]);
    if (hit) return hit;
  }
  return null;
}

export function addRemoteLink(
  links: MindmapRemoteLink[],
  from: string,
  to: string,
  label = "相关"
): MindmapRemoteLink[] {
  if (!from || !to || from === to) return links;
  if (links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from))) {
    return links;
  }
  return [
    ...links,
    {
      id: `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      from,
      to,
      label,
    },
  ];
}

export function removeRemoteLink(
  links: MindmapRemoteLink[],
  id: string
): MindmapRemoteLink[] {
  return links.filter((l) => l.id !== id);
}

export function loadMindmapEditPatch(
  courseId: string,
  lectureId: string
): MindmapEditPatch | null {
  try {
    const raw = localStorage.getItem(storageKey(courseId, lectureId));
    if (!raw) return null;
    const j = JSON.parse(raw) as MindmapEditPatch;
    if (j?.version !== 1 || !Array.isArray(j.trees)) return null;
    return {
      version: 1,
      trees: j.trees,
      remoteLinks: Array.isArray(j.remoteLinks) ? j.remoteLinks : [],
      updatedAt: Number(j.updatedAt) || Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveMindmapEditPatch(
  courseId: string,
  lectureId: string,
  patch: Omit<MindmapEditPatch, "version" | "updatedAt">
) {
  const full: MindmapEditPatch = {
    version: 1,
    trees: patch.trees,
    remoteLinks: patch.remoteLinks || [],
    updatedAt: Date.now(),
  };
  localStorage.setItem(storageKey(courseId, lectureId), JSON.stringify(full));
}

export function clearMindmapEditPatch(courseId: string, lectureId: string) {
  localStorage.removeItem(storageKey(courseId, lectureId));
}

/** 把本地编辑叠到新加载的导图上（有补丁则整树替换） */
export function applyMindmapEditPatch(
  doc: MindmapDoc,
  patch: MindmapEditPatch | null
): MindmapDoc {
  if (!patch?.trees?.length) {
    return {
      ...doc,
      remoteLinks: doc.remoteLinks || [],
    };
  }
  return withForest(doc, cloneForest(patch.trees), patch.remoteLinks || []);
}
