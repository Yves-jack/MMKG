/**
 * 导图冗余裁剪：同级同义/别名只留一个，并把游离定律挂回等值式。
 */
import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";

/** 同级互斥：优先保留靠前的规范名（匹配 zh 或 id 前缀） */
const SYNONYM_GROUPS: string[][] = [
  ["析取", "或门", "逻辑或"],
  ["合取", "与门", "逻辑与"],
  ["否定", "非门", "逻辑非"],
  ["幂等律", "等幂律"],
  ["重言式", "永真式"],
  ["蕴含", "蕴涵"],
  ["结点", "节点", "顶点"],
  ["道路", "路径"],
  ["回路", "环"],
];

function primaryZh(idOrZh: string): string {
  return String(idOrZh || "")
    .split("/")[0]
    .trim();
}

function matchesAlias(zh: string, alias: string): boolean {
  if (!zh || !alias) return false;
  return zh === alias || zh.includes(alias) || alias.includes(zh);
}

function synonymKey(zh: string): string | null {
  for (const group of SYNONYM_GROUPS) {
    for (const alias of group) {
      if (matchesAlias(zh, alias)) return group[0];
    }
  }
  return null;
}

function preferredRank(zh: string, groupCanon: string): number {
  const group = SYNONYM_GROUPS.find((g) => g[0] === groupCanon) || [groupCanon];
  for (let i = 0; i < group.length; i++) {
    if (matchesAlias(zh, group[i])) return i;
  }
  return 99;
}

function isLawName(zh: string): boolean {
  return /律$/.test(zh) || /分配|交换|结合|吸收|同一|零律|补余|德摩根|摩根/.test(zh);
}

function findEquivalenceHost(children: MindmapTreeNode[]): MindmapTreeNode | null {
  const prefer = ["基本等值式", "等值式", "等值演算"];
  for (const name of prefer) {
    const hit = children.find((c) => matchesAlias(primaryZh(c.zh || c.id), name));
    if (hit) return hit;
  }
  return null;
}

function pruneChildren(children: MindmapTreeNode[]): MindmapTreeNode[] {
  const kept: MindmapTreeNode[] = [];
  const bySyn = new Map<string, MindmapTreeNode>();

  for (const raw of children) {
    const node = pruneNode(raw);
    const zh = primaryZh(node.zh || node.id);
    const syn = synonymKey(zh);
    if (!syn) {
      kept.push(node);
      continue;
    }
    const prev = bySyn.get(syn);
    if (!prev) {
      bySyn.set(syn, node);
      continue;
    }
    const preferNew =
      preferredRank(zh, syn) < preferredRank(primaryZh(prev.zh || prev.id), syn) ||
      (preferredRank(zh, syn) === preferredRank(primaryZh(prev.zh || prev.id), syn) &&
        (node.importance || 0) > (prev.importance || 0));
    const winner = preferNew ? node : prev;
    const loser = preferNew ? prev : node;
    // 把败者子树并入胜者（去重）
    const childIds = new Set(winner.children.map((c) => c.id));
    for (const c of loser.children || []) {
      if (!childIds.has(c.id)) {
        winner.children.push(c);
        childIds.add(c.id);
      }
    }
    bySyn.set(syn, winner);
  }

  for (const n of bySyn.values()) kept.push(n);

  // 顶层游离「xx律」收入等值式宿主
  const host = findEquivalenceHost(kept);
  if (host) {
    const rest: MindmapTreeNode[] = [];
    for (const n of kept) {
      if (n === host) continue;
      const zh = primaryZh(n.zh || n.id);
      if (isLawName(zh) && !(n.children || []).length) {
        if (!host.children.some((c) => c.id === n.id)) {
          host.children.push({ ...n, relation: n.relation || "belong_to" });
        }
        continue;
      }
      rest.push(n);
    }
    host.children = pruneChildren(host.children || []).sort(
      (a, b) => (b.importance || 0) - (a.importance || 0)
    );
    return [host, ...rest].sort(
      (a, b) => (b.importance || 0) - (a.importance || 0)
    );
  }

  return kept.sort((a, b) => (b.importance || 0) - (a.importance || 0));
}

function pruneNode(node: MindmapTreeNode): MindmapTreeNode {
  return {
    ...node,
    children: pruneChildren(node.children || []),
  };
}

function countNodes(n: MindmapTreeNode): number {
  return 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
}

function depthOf(n: MindmapTreeNode, d = 0): number {
  if (!n.children?.length) return d;
  return Math.max(...n.children.map((c) => depthOf(c, d + 1)));
}

/** 裁剪森林冗余；返回新文档统计 */
export function pruneMindmapRedundancy(doc: MindmapDoc): MindmapDoc {
  const roots = (doc.roots?.length ? doc.roots : doc.root ? [doc.root] : []).map(
    pruneNode
  );
  if (!roots.length) return doc;
  const nNodes = roots.reduce((s, r) => s + countNodes(r), 0);
  const maxDepth = Math.max(...roots.map((r) => depthOf(r)));
  return {
    ...doc,
    root: roots[0],
    roots,
    n_nodes: nNodes,
    max_depth: maxDepth,
    meta: {
      ...doc.meta,
    },
  };
}
