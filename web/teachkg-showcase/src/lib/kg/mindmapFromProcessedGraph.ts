/**
 * 用处理后的课堂图谱投影思维导图（与单课复习关系图同源）。
 *
 * 重要性：只用节点上的展示分 `importance`（PR+课堂修正 或 课堂传递后的分），
 * 绝不回退到 `importance_base`（原始 PR / 教材先验）。
 *
 * Phase A：倒挂惩罚、弱父跳过、副本不带子树、firstSeen 排序
 * Phase B：高分回流、浅树豁免、depend_on → deps 旁路
 * Phase C：反模式纠边、虚根主题排序与薄枝合并
 */
import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";
import { isProcessEdgeSource } from "@/lib/kg/lectureKgProcess";
import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";

const REL_STRENGTH: Record<string, number> = {
  belong_to: 1,
  part_of: 0.85,
};

const PARENT_IMP_WEIGHT = 0.15;
const INVERT_PENALTY = 0.6;
const INVERT_TAU = 0.15;
const WEAK_PARENT_RATIO = 0.5;
const COPY_MAX_DEPTH = 0;
const MAX_COPIES_PER_CHILD = 1;
/** 虚根下「本讲补充」最多挂靠数 */
const MAX_SALVAGE_UNDER_VIRT = 8;
/** 回流最低展示分（与中位数取 max） */
const SALVAGE_FLOOR = 0.15;
/** 虚根下过薄主题（含根实体数）并入邻近主题 */
const THIN_THEME_ENTITIES = 3;

function relOf(e: PipelineEdge): string {
  return (e.relation || e.label || "").trim();
}

function primaryZh(id: string): string {
  return (id.split("/")[0] || id).trim();
}

/** 导图专用：课堂修正后的展示重要性（禁止用 base） */
export function mindmapNodeImportance(
  n: Pick<PipelineNode, "importance"> | null | undefined
): number {
  if (!n) return 0;
  const v = Number(n.importance);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function zhOf(id: string, labels: Map<string, string>): string {
  const lab = labels.get(id);
  if (lab) return lab.trim();
  if (
    id.startsWith("__chapter__/") ||
    id.startsWith("__course__/") ||
    id.startsWith("__lecture__/")
  ) {
    return (id.split("/")[1] || id).trim();
  }
  return primaryZh(id);
}

function chapterKeys(chapter: string): string[] {
  const bare = chapter.replace(/^第\s*\d+\s*章\s*/, "").trim();
  const keys: string[] = [];
  if (bare) keys.push(bare);
  for (const p of bare.split(/[与和及、,，/\s]+/)) {
    if (p.length >= 2) keys.push(p);
  }
  return [...new Set(keys)];
}

function entityMatchesKeys(zh: string, keys: string[]): boolean {
  for (const k of keys) {
    if (k && (k === zh || (k.length >= 2 && (zh.includes(k) || k.includes(zh))))) {
      return true;
    }
  }
  return false;
}

export function parseCueLabelSec(label?: string | null): number | null {
  if (!label) return null;
  const m = String(label).match(/(\d+)\s*s/i);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) ? sec : null;
}

export function hierarchyEdgeScore(opts: {
  rel: string;
  parentImp: number;
  childImp: number;
}): number {
  const strength = REL_STRENGTH[opts.rel] || 0;
  if (!strength) return -Infinity;
  const invert = Math.max(0, opts.childImp - opts.parentImp - INVERT_TAU);
  return (
    strength + PARENT_IMP_WEIGHT * opts.parentImp - INVERT_PENALTY * invert
  );
}

function compareHierScore(
  a: { score: number; rel: string; parent: string; child: string },
  b: { score: number; rel: string; parent: string; child: string }
): number {
  return (
    b.score - a.score ||
    a.child.localeCompare(b.child) ||
    a.parent.localeCompare(b.parent) ||
    a.rel.localeCompare(b.rel)
  );
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const i = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil(p * sortedAsc.length) - 1)
  );
  return sortedAsc[i]!;
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : ((s[mid - 1]! + s[mid]!) / 2);
}

/** 子-belong_to→父 且 父-part_of→祖 时，丢掉子→祖的 part_of */
export function pruneMindmapHierarchyShortcuts(edges: PipelineEdge[]): PipelineEdge[] {
  const belong = new Map<string, Set<string>>();
  const partOf = new Map<string, Set<string>>();
  const active: PipelineEdge[] = [];
  for (const e of edges) {
    if (isProcessEdgeSource(e.source) || !e.from || !e.to || e.from === e.to) continue;
    active.push(e);
    const r = relOf(e);
    if (r === "belong_to") {
      if (!belong.has(e.from)) belong.set(e.from, new Set());
      belong.get(e.from)!.add(e.to);
    } else if (r === "part_of") {
      if (!partOf.has(e.from)) partOf.set(e.from, new Set());
      partOf.get(e.from)!.add(e.to);
    }
  }
  return active.filter((e) => {
    if (relOf(e) !== "part_of") return true;
    const parents = belong.get(e.from);
    if (!parents) return true;
    for (const parent of parents) {
      if (partOf.get(parent)?.has(e.to)) return false;
    }
    return true;
  });
}

/**
 * 反模式纠边（课可扩展）：
 * - 命题逻辑 belong_to 谓词逻辑 → 翻转（谓词扩展自命题）
 * - 量词子类优先挂「量词」
 * - 定理/算法/公式不得做概念的父（任务：定理放在概念下面）
 */
export function isSpecialAttachKind(zh: string, id = ""): boolean {
  const t = `${zh} ${id}`;
  return /定理|算法|公式|公理|引理|推论|定律|法则|命题演算系统/.test(t);
}

export function applyMindmapAntiPatterns(
  edges: PipelineEdge[],
  nodeSet: Set<string>,
  labels: Map<string, string>
): PipelineEdge[] {
  const idByZh = new Map<string, string>();
  for (const id of nodeSet) {
    const zh = zhOf(id, labels);
    if (!idByZh.has(zh)) idByZh.set(zh, id);
    const pz = primaryZh(id);
    if (!idByZh.has(pz)) idByZh.set(pz, id);
  }
  const hasZh = (zh: string) => idByZh.has(zh);
  const out: PipelineEdge[] = [];
  for (const e of edges) {
    if (!e.from || !e.to || e.from === e.to) continue;
    let from = e.from;
    let to = e.to;
    let rel = relOf(e);
    const cz = zhOf(from, labels);
    const pz = zhOf(to, labels);
    const czp = primaryZh(from);
    const pzp = primaryZh(to);

    if (
      rel === "belong_to" &&
      (cz === "命题逻辑" || czp === "命题逻辑") &&
      (pz === "谓词逻辑" ||
        pz === "一阶谓词逻辑" ||
        pzp === "谓词逻辑" ||
        pzp === "一阶谓词逻辑")
    ) {
      out.push({
        ...e,
        from: to,
        to: from,
        relation: "part_of",
        label: "part_of",
      });
      continue;
    }

    if (
      (cz === "全称量词" ||
        cz === "存在量词" ||
        czp === "全称量词" ||
        czp === "存在量词") &&
      pz !== "量词" &&
      pzp !== "量词" &&
      hasZh("量词")
    ) {
      const qid = idByZh.get("量词")!;
      out.push({
        ...e,
        from,
        to: qid,
        relation: "belong_to",
        label: "belong_to",
      });
      continue;
    }

    // 定理/算法/公式 作为父、概念作为子 → 翻转（概念应在上）
    if (
      REL_STRENGTH[rel] &&
      isSpecialAttachKind(pz, to) &&
      !isSpecialAttachKind(cz, from) &&
      !from.startsWith("__") &&
      !to.startsWith("__")
    ) {
      out.push({
        ...e,
        from: to,
        to: from,
        relation: rel === "part_of" ? "belong_to" : rel,
        label: rel === "part_of" ? "belong_to" : rel,
      });
      continue;
    }

    // 描述性长名不做层次骨架（可后续回流）
    if (cz.length > 14 && /的|前置|公式/.test(cz)) continue;

    out.push({ ...e, relation: rel || e.relation, label: rel || e.label });
  }
  return out;
}

export type HierCand = {
  score: number;
  strength: number;
  parentImp: number;
  childImp: number;
  parent: string;
  child: string;
  rel: string;
};

export type MindmapForest = {
  parentOf: Map<string, { parent: string; rel: string }>;
  extraPlacements: { child: string; parent: string; rel: string; score: number }[];
  roots: string[];
  treeEdges: PipelineEdge[];
  /** related_with 旁路 */
  related: Map<string, Set<string>>;
  /** depend_on 旁路（from 依赖 to 的中文名） */
  deps: Map<string, Set<string>>;
  labels: Map<string, string>;
  importance: Map<string, number>;
  firstSeenSec: Map<string, number>;
  /** 全部层次候选（含未入树），供回流挂靠 */
  hierCandidates: HierCand[];
  /** 仅依赖连通或落选的高分候选 id */
  coveragePool: string[];
};

export function dropDependOnAndIsolates(
  nodes: PipelineNode[],
  edges: PipelineEdge[]
): { nodes: PipelineNode[]; edges: PipelineEdge[] } {
  const kept = edges.filter((e) => {
    if (isProcessEdgeSource(e.source) || !e.from || !e.to || e.from === e.to) return false;
    return Boolean(REL_STRENGTH[relOf(e)]);
  });
  const linked = new Set<string>();
  for (const e of kept) {
    linked.add(e.from);
    linked.add(e.to);
  }
  const nextNodes = nodes.filter((n) => n.id && linked.has(n.id));
  const ids = new Set(nextNodes.map((n) => n.id));
  const nextEdges = kept.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes: nextNodes, edges: nextEdges };
}

function collectFirstSeenSec(
  edges: PipelineEdge[],
  nodeSet: Set<string>
): Map<string, number> {
  const firstSeen = new Map<string, number>();
  const touch = (id: string, sec: number) => {
    if (!nodeSet.has(id)) return;
    const prev = firstSeen.get(id);
    if (prev == null || sec < prev) firstSeen.set(id, sec);
  };
  for (const e of edges) {
    if (isProcessEdgeSource(e.source) || !e.from || !e.to) continue;
    const sec = parseCueLabelSec(e.cue_label);
    if (sec == null) continue;
    touch(e.from, sec);
    touch(e.to, sec);
  }
  return firstSeen;
}

function addToSetMap(map: Map<string, Set<string>>, key: string, val: string) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(val);
}

export function assignMindmapForest(
  nodes: PipelineNode[],
  edges: PipelineEdge[]
): MindmapForest {
  const labels = new Map<string, string>();
  const importance = new Map<string, number>();
  for (const n of nodes) {
    const id = (n.id || "").trim();
    if (!id) continue;
    labels.set(id, (n.label || n.title || id).trim());
    importance.set(id, mindmapNodeImportance(n));
  }

  const stripped = dropDependOnAndIsolates(nodes, edges);
  const nodeSet = new Set<string>();
  const nodeIds: string[] = [];
  for (const n of stripped.nodes) {
    const id = (n.id || "").trim();
    if (!id) continue;
    if (!nodeSet.has(id)) {
      nodeSet.add(id);
      nodeIds.push(id);
    }
  }

  let kept = pruneMindmapHierarchyShortcuts(stripped.edges).filter(
    (e) => nodeSet.has(e.from) && nodeSet.has(e.to) && REL_STRENGTH[relOf(e)]
  );
  kept = applyMindmapAntiPatterns(kept, nodeSet, labels).filter(
    (e) => nodeSet.has(e.from) && nodeSet.has(e.to) && REL_STRENGTH[relOf(e)]
  );

  nodeSet.clear();
  nodeIds.length = 0;
  for (const e of kept) {
    if (!nodeSet.has(e.from)) {
      nodeSet.add(e.from);
      nodeIds.push(e.from);
    }
    if (!nodeSet.has(e.to)) {
      nodeSet.add(e.to);
      nodeIds.push(e.to);
    }
  }

  // 旁路：全图节点都可挂 deps/related（含仅依赖连通的点）
  const allIds = new Set<string>([...importance.keys()]);
  const firstSeenSec = collectFirstSeenSec(edges, allIds);
  const related = new Map<string, Set<string>>();
  const deps = new Map<string, Set<string>>();
  for (const e of edges) {
    if (isProcessEdgeSource(e.source) || !e.from || !e.to) continue;
    const r = relOf(e);
    if (r === "related_with") {
      if (allIds.has(e.from)) addToSetMap(related, e.from, zhOf(e.to, labels));
      if (allIds.has(e.to)) addToSetMap(related, e.to, zhOf(e.from, labels));
    } else if (r === "depend_on") {
      // from 依赖 to
      if (allIds.has(e.from)) addToSetMap(deps, e.from, zhOf(e.to, labels));
    }
  }

  const hier: HierCand[] = [];
  for (const e of kept) {
    const rel = relOf(e);
    const strength = REL_STRENGTH[rel];
    if (!strength) continue;
    const parentImp = importance.get(e.to) || 0;
    const childImp = importance.get(e.from) || 0;
    hier.push({
      score: hierarchyEdgeScore({ rel, parentImp, childImp }),
      strength,
      parentImp,
      childImp,
      parent: e.to,
      child: e.from,
      rel,
    });
  }
  hier.sort(compareHierScore);

  const uf = new Map<string, string>();
  for (const id of nodeIds) uf.set(id, id);
  const find = (x: string): string => {
    let r = uf.get(x) || x;
    while ((uf.get(r) || r) !== r) {
      const p = uf.get(r) || r;
      uf.set(r, uf.get(p) || p);
      r = p;
    }
    return r;
  };

  const parentOf = new Map<string, { parent: string; rel: string }>();
  const cands = new Map<string, HierCand[]>();
  for (const h of hier) {
    const list = cands.get(h.child) || [];
    list.push(h);
    cands.set(h.child, list);
  }
  const unassigned = new Set(cands.keys());
  const isReady = (child: string) => {
    for (const other of unassigned) {
      if (other === child) continue;
      const opts = cands.get(other) || [];
      if (opts.some((h) => h.parent === child)) return false;
    }
    return true;
  };
  while (unassigned.size) {
    let ready = [...unassigned].filter(isReady);
    if (!ready.length) ready = [...unassigned];
    ready.sort(
      (a, b) =>
        (importance.get(b) || 0) - (importance.get(a) || 0) || a.localeCompare(b)
    );
    let progressed = false;
    for (const child of ready) {
      const opts = [...(cands.get(child) || [])].sort(compareHierScore);
      const tryAttach = (allowWeak: boolean) => {
        for (const h of opts) {
          if (parentOf.has(h.child) || h.child === h.parent) continue;
          if (find(h.child) === find(h.parent)) continue;
          if (!allowWeak && h.parentImp < h.childImp * WEAK_PARENT_RATIO) continue;
          parentOf.set(h.child, { parent: h.parent, rel: h.rel });
          uf.set(find(h.child), find(h.parent));
          return true;
        }
        return false;
      };
      if (tryAttach(false) || tryAttach(true)) progressed = true;
      unassigned.delete(child);
    }
    if (!progressed) break;
  }

  const belongKids = new Set<string>();
  const partKids = new Set<string>();
  for (const h of hier) {
    if (h.rel === "belong_to") belongKids.add(h.child);
    if (h.rel === "part_of") partKids.add(h.child);
  }
  const extraRaw: { child: string; parent: string; rel: string; score: number }[] =
    [];
  const extraSeen = new Set<string>();
  for (const h of hier) {
    if (!belongKids.has(h.child) || !partKids.has(h.child)) continue;
    const used = parentOf.get(h.child);
    if (used && used.parent === h.parent && used.rel === h.rel) continue;
    if (h.parentImp < h.childImp * WEAK_PARENT_RATIO) continue;
    const key = `${h.child}\t${h.parent}\t${h.rel}`;
    if (extraSeen.has(key)) continue;
    extraSeen.add(key);
    extraRaw.push({
      child: h.child,
      parent: h.parent,
      rel: h.rel,
      score: h.score,
    });
  }
  const byChild = new Map<string, typeof extraRaw>();
  for (const p of extraRaw) {
    const list = byChild.get(p.child) || [];
    list.push(p);
    byChild.set(p.child, list);
  }
  const extraPlacements: typeof extraRaw = [];
  for (const list of byChild.values()) {
    list.sort((a, b) => b.score - a.score || a.parent.localeCompare(b.parent));
    extraPlacements.push(...list.slice(0, MAX_COPIES_PER_CHILD));
  }

  const roots = nodeIds.filter((id) => !parentOf.has(id));
  const treeEdges: PipelineEdge[] = [...parentOf.entries()].map(
    ([child, { parent, rel }]) => ({
      id: `mindmap-tree:${child}`,
      from: child,
      to: parent,
      relation: rel,
      label: rel,
    })
  );

  // 覆盖池：层次外实体 + 仅依赖连通实体（高分由 materialize 筛选）
  const inHierarchy = new Set<string>([...parentOf.keys(), ...roots]);
  const coveragePool: string[] = [];
  for (const id of allIds) {
    if (inHierarchy.has(id)) continue;
    coveragePool.push(id);
  }

  return {
    parentOf,
    extraPlacements,
    roots,
    treeEdges,
    related,
    deps,
    labels,
    importance,
    firstSeenSec,
    hierCandidates: hier,
    coveragePool,
  };
}

export type BuildMindmapOpts = {
  lectureId?: string;
  chapter?: string | null;
  /** 复习浓缩中的实体顺序（id 或 zh），用于根/子排序约束 */
  reviewOrder?: string[] | null;
  source?: "kg" | "summary+kg" | "review+kg";
  scope?: "course" | "chapter" | "lecture";
};

export function withUpdatedImportance(
  forest: MindmapForest,
  nodes: PipelineNode[]
): MindmapForest {
  const importance = new Map(forest.importance);
  for (const n of nodes) {
    const id = (n.id || "").trim();
    if (!id) continue;
    importance.set(id, mindmapNodeImportance(n));
  }
  return { ...forest, importance };
}

export function buildMindmapFromForest(
  forest: MindmapForest,
  opts: BuildMindmapOpts = {}
): MindmapDoc | null {
  return materializeForest(forest, opts);
}

type Kid = {
  id: string;
  rel: string;
  copy: boolean;
  salvaged?: boolean;
  linkKind?: MindmapTreeNode["linkKind"];
};

function sortKids(
  kids: Kid[],
  firstSeenSec: Map<string, number>,
  importance: Map<string, number>,
  reviewRank?: Map<string, number>
) {
  kids.sort((a, b) => {
    if (Number(a.copy) !== Number(b.copy)) return Number(a.copy) - Number(b.copy);
    if (Number(Boolean(a.salvaged)) !== Number(Boolean(b.salvaged))) {
      return Number(Boolean(a.salvaged)) - Number(Boolean(b.salvaged));
    }
    if (reviewRank && reviewRank.size) {
      const ra = reviewRank.has(a.id) ? reviewRank.get(a.id)! : 1e9;
      const rb = reviewRank.has(b.id) ? reviewRank.get(b.id)! : 1e9;
      if (ra !== rb) return ra - rb;
    }
    const ta = firstSeenSec.get(a.id);
    const tb = firstSeenSec.get(b.id);
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    if (ta != null && tb == null) return -1;
    if (ta == null && tb != null) return 1;
    return (importance.get(b.id) || 0) - (importance.get(a.id) || 0);
  });
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function collectSubtreeIds(n: MindmapTreeNode, into: Set<string>) {
  if (!n.id.startsWith("__lecture__/") && !n.id.startsWith("__salvage__/")) {
    into.add(n.id);
  }
  for (const c of n.children) collectSubtreeIds(c, into);
}

function materializeForest(
  forest: MindmapForest,
  opts: BuildMindmapOpts
): MindmapDoc | null {
  const {
    parentOf,
    extraPlacements,
    labels,
    importance,
    related,
    deps,
    firstSeenSec,
    hierCandidates,
    coveragePool,
  } = forest;
  const nodeSet = new Set([...parentOf.keys(), ...forest.roots]);
  if (!nodeSet.size && !coveragePool.length) return null;

  const reviewRank = new Map<string, number>();
  if (opts.reviewOrder?.length) {
    opts.reviewOrder.forEach((key, i) => {
      const k = String(key || "").trim();
      if (!k) return;
      if (!reviewRank.has(k)) reviewRank.set(k, i);
      const zh = primaryZh(k);
      if (zh && !reviewRank.has(zh)) reviewRank.set(zh, i);
    });
    // 也按节点 zh 匹配
    for (const id of [...nodeSet, ...coveragePool]) {
      if (reviewRank.has(id)) continue;
      const zh = zhOf(id, labels);
      if (reviewRank.has(zh)) reviewRank.set(id, reviewRank.get(zh)!);
    }
  }

  const childrenMap = new Map<string, Kid[]>();
  const addKid = (parent: string, kid: Kid) => {
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent)!.push(kid);
  };
  for (const [child, { parent, rel }] of parentOf) {
    addKid(parent, {
      id: child,
      rel,
      copy: false,
      linkKind: "hierarchy",
    });
  }
  for (const p of extraPlacements) {
    if (!nodeSet.has(p.parent) && !childrenMap.has(p.parent)) continue;
    addKid(p.parent, {
      id: p.child,
      rel: p.rel,
      copy: true,
      linkKind: "copy",
    });
  }
  for (const kids of childrenMap.values()) {
    sortKids(kids, firstSeenSec, importance, reviewRank);
  }

  const relatedList = (id: string): string[] =>
    [...(related.get(id) || [])].sort().slice(0, 6);
  const depsList = (id: string): string[] =>
    [...(deps.get(id) || [])].sort().slice(0, 8);

  const hasKids = (id: string) => (childrenMap.get(id) || []).length > 0;
  let rootIds = forest.roots.filter((id) => hasKids(id));

  const chapter = opts.chapter || "";
  const chapterKeyList = chapter ? chapterKeys(chapter) : [];
  const sortRootIds = (ids: string[]) => {
    ids.sort((a, b) => {
      if (reviewRank.size) {
        const ra = reviewRank.has(a)
          ? reviewRank.get(a)!
          : reviewRank.has(zhOf(a, labels))
            ? reviewRank.get(zhOf(a, labels))!
            : 1e9;
        const rb = reviewRank.has(b)
          ? reviewRank.get(b)!
          : reviewRank.has(zhOf(b, labels))
            ? reviewRank.get(zhOf(b, labels))!
            : 1e9;
        if (ra !== rb) return ra - rb;
      }
      const ha = chapterKeyList.length
        ? entityMatchesKeys(zhOf(a, labels), chapterKeyList)
          ? 1
          : 0
        : 0;
      const hb = chapterKeyList.length
        ? entityMatchesKeys(zhOf(b, labels), chapterKeyList)
          ? 1
          : 0
        : 0;
      const ta = firstSeenSec.get(a);
      const tb = firstSeenSec.get(b);
      const tCmp =
        ta != null && tb != null ? ta - tb : ta != null ? -1 : tb != null ? 1 : 0;
      return hb - ha || tCmp || (importance.get(b) || 0) - (importance.get(a) || 0);
    });
  };
  sortRootIds(rootIds);

  const buildNode = (
    id: string,
    rel: string | null = null,
    optsBuild: {
      weakLink?: boolean;
      salvaged?: boolean;
      linkKind?: MindmapTreeNode["linkKind"];
      ancestors?: Set<string>;
      depthLeft?: number;
    } = {}
  ): MindmapTreeNode => {
    const weakLink = Boolean(optsBuild.weakLink);
    const salvaged = Boolean(optsBuild.salvaged);
    const ancestors = optsBuild.ancestors || new Set<string>();
    const depthLeft =
      optsBuild.depthLeft ?? (weakLink ? COPY_MAX_DEPTH : Number.POSITIVE_INFINITY);
    const firstSeen = firstSeenSec.get(id);
    const linkKind =
      optsBuild.linkKind ||
      (weakLink ? (salvaged ? "attach" : "copy") : "hierarchy");
    if (ancestors.has(id)) {
      return {
        id,
        zh: zhOf(id, labels),
        importance: importance.get(id) || 0,
        relation: rel,
        related: relatedList(id),
        deps: depsList(id),
        copy: weakLink && !salvaged,
        weak: weakLink || salvaged,
        salvaged,
        linkKind,
        firstSeenSec: firstSeen,
        children: [],
      };
    }
    const nextAnc = new Set(ancestors);
    nextAnc.add(id);
    const kids = depthLeft <= 0 ? [] : childrenMap.get(id) || [];
    // 叶层：定理/算法/公式挂在概念下后不再深挖子树（资产/局部图走侧栏）
    const parentIsSpecial = isSpecialAttachKind(zhOf(id, labels), id);
    return {
      id,
      zh: zhOf(id, labels),
      importance: importance.get(id) || 0,
      relation: rel,
      related: relatedList(id),
      deps: depsList(id),
      copy: weakLink && !salvaged,
      weak: weakLink || salvaged,
      salvaged,
      linkKind,
      firstSeenSec: firstSeen,
      children: kids.map((k) => {
        const kidZh = zhOf(k.id, labels);
        const kidSpecial = isSpecialAttachKind(kidZh, k.id);
        let nextDepth =
          k.copy && !k.salvaged ? COPY_MAX_DEPTH : depthLeft - 1;
        if (parentIsSpecial || kidSpecial) {
          nextDepth = Math.min(nextDepth, 0);
        }
        return buildNode(k.id, k.rel, {
          weakLink: k.copy || k.salvaged,
          salvaged: k.salvaged,
          linkKind: k.linkKind,
          ancestors: nextAnc,
          depthLeft: nextDepth,
        });
      }),
    };
  };

  const depthOf = (n: MindmapTreeNode): number =>
    n.children.length ? 1 + Math.max(...n.children.map(depthOf)) : 1;
  const countEntities = (n: MindmapTreeNode): number =>
    1 + n.children.reduce((s, c) => s + countEntities(c), 0);

  const rootImps = rootIds.map((id) => importance.get(id) || 0).sort((a, b) => a - b);
  const p80 = percentile(rootImps, 0.8);
  const salvageTheta = Math.max(SALVAGE_FLOOR, medianOf([...importance.values()]));

  const MIN_TREE_ENTITIES = 4;
  const keepTree = (t: MindmapTreeNode): boolean => {
    const d = depthOf(t);
    const n = countEntities(t);
    const imp = t.importance || 0;
    if (d > 2 && n >= MIN_TREE_ENTITIES) return true;
    // 高分浅树豁免
    if (imp >= Math.max(SALVAGE_FLOOR, p80) && n >= 2 && d >= 2) return true;
    return false;
  };

  const builtRoots = rootIds.map((id) => buildNode(id));
  let treeNodes = builtRoots.filter(keepTree);
  const droppedShallowTrees = builtRoots.filter((t) => !keepTree(t));

  // 高分被滤浅树：整树弱挂（salvaged）
  const salvagedTrees = droppedShallowTrees.filter(
    (t) => (t.importance || 0) >= salvageTheta && countEntities(t) >= 2
  );

  if (!treeNodes.length && !salvagedTrees.length) {
    // 仍无结构时，尝试只从最高分根硬保一条
    const fallback = [...builtRoots].sort(
      (a, b) => (b.importance || 0) - (a.importance || 0)
    )[0];
    if (fallback) treeNodes = [{ ...fallback, salvaged: true, weak: true }];
    else return null;
  }

  // —— 回流：把不在树上的高分实体挂到已有父 / 依赖目标 ——
  const keptIds = new Set<string>();
  const markKept = (n: MindmapTreeNode) => {
    collectSubtreeIds(n, keptIds);
  };
  for (const t of treeNodes) markKept(t);
  for (const t of salvagedTrees) markKept(t);

  let attachedOrphans = 0;
  const pendingVirtSalvage: MindmapTreeNode[] = [...salvagedTrees.map((t) => ({
    ...t,
    weak: true,
    salvaged: true,
    relation: t.relation || "attach",
    linkKind: "attach" as const,
  }))];

  const trySalvageId = (id: string): boolean => {
    if (keptIds.has(id)) return false;
    const imp = importance.get(id) || 0;
    if (imp < salvageTheta) return false;

    // 1) 层次候选父已在树内
    const opts = hierCandidates
      .filter((h) => h.child === id && keptIds.has(h.parent))
      .sort(compareHierScore);
    if (opts[0]) {
      addKid(opts[0].parent, {
        id,
        rel: opts[0].rel,
        copy: true,
        salvaged: true,
        linkKind: "attach",
      });
      sortKids(childrenMap.get(opts[0].parent)!, firstSeenSec, importance);
      keptIds.add(id);
      attachedOrphans += 1;
      return true;
    }

    // 2) depend_on 目标在树内 → 弱挂到目标下
    const depTargets = [...(deps.get(id) || [])];
    for (const dzh of depTargets) {
      const parentId = [...keptIds].find(
        (x) => zhOf(x, labels) === dzh || primaryZh(x) === dzh
      );
      if (!parentId) continue;
      addKid(parentId, {
        id,
        rel: "depend_on",
        copy: true,
        salvaged: true,
        linkKind: "depend",
      });
      sortKids(childrenMap.get(parentId)!, firstSeenSec, importance);
      keptIds.add(id);
      attachedOrphans += 1;
      return true;
    }

    // 3) 留给虚根补充枝
    pendingVirtSalvage.push(
      buildNode(id, "attach", {
        weakLink: true,
        salvaged: true,
        linkKind: "attach",
        depthLeft: 0,
      })
    );
    keptIds.add(id);
    attachedOrphans += 1;
    return true;
  };

  const pool = [...coveragePool, ...droppedShallowTrees.map((t) => t.id)].filter(
    (id, i, arr) => arr.indexOf(id) === i
  );
  pool.sort((a, b) => (importance.get(b) || 0) - (importance.get(a) || 0));
  for (const id of pool) trySalvageId(id);

  // 回流改了 childrenMap：重建主树节点
  treeNodes = treeNodes.map((t) => {
    const rebuilt = buildNode(t.id);
    return t.salvaged
      ? { ...rebuilt, salvaged: true, weak: true }
      : rebuilt;
  });

  // 主题排序（虚根子）
  const sortThemes = (themes: MindmapTreeNode[]) => {
    themes.sort((a, b) => {
      const ha = chapterKeyList.length
        ? entityMatchesKeys(a.zh, chapterKeyList)
          ? 1
          : 0
        : 0;
      const hb = chapterKeyList.length
        ? entityMatchesKeys(b.zh, chapterKeyList)
          ? 1
          : 0
        : 0;
      const ta = a.firstSeenSec ?? firstSeenSec.get(a.id);
      const tb = b.firstSeenSec ?? firstSeenSec.get(b.id);
      const tCmp =
        ta != null && tb != null ? ta - tb : ta != null ? -1 : tb != null ? 1 : 0;
      const sa = a.children.reduce((s, c) => s + (c.importance || 0), a.importance || 0);
      const sb = b.children.reduce((s, c) => s + (c.importance || 0), b.importance || 0);
      return hb - ha || tCmp || sb - sa;
    });
  };

  /** 薄枝并入最相似主题 */
  const mergeThinThemes = (themes: MindmapTreeNode[]): MindmapTreeNode[] => {
    const main: MindmapTreeNode[] = [];
    const thin: MindmapTreeNode[] = [];
    for (const t of themes) {
      if (countEntities(t) < THIN_THEME_ENTITIES && !t.salvaged) thin.push(t);
      else main.push(t);
    }
    if (!thin.length) return themes;
    if (!main.length) return themes;
    const idSets = new Map<string, Set<string>>();
    for (const t of main) {
      const s = new Set<string>();
      collectSubtreeIds(t, s);
      idSets.set(t.id, s);
    }
    for (const t of thin) {
      const s = new Set<string>();
      collectSubtreeIds(t, s);
      let best = main[0]!;
      let bestJ = -1;
      for (const m of main) {
        const j = jaccard(s, idSets.get(m.id) || new Set());
        const tClose =
          t.firstSeenSec != null && m.firstSeenSec != null
            ? -Math.abs(t.firstSeenSec - m.firstSeenSec) / 1e6
            : 0;
        const score = j + tClose + (m.importance || 0) * 0.01;
        if (score > bestJ) {
          bestJ = score;
          best = m;
        }
      }
      best.children = [
        ...best.children,
        {
          ...t,
          relation: t.relation || "attach",
          weak: true,
          salvaged: true,
          linkKind: "attach",
        },
      ];
      const set = idSets.get(best.id) || new Set();
      for (const x of s) set.add(x);
      idSets.set(best.id, set);
    }
    for (const m of main) {
      sortKids(
        m.children.map((c) => ({
          id: c.id,
          rel: c.relation || "attach",
          copy: Boolean(c.copy),
          salvaged: c.salvaged,
          linkKind: c.linkKind,
        })),
        firstSeenSec,
        importance
      );
      // 保持 children 已合并；仅按 firstSeen/importance 重排
      m.children.sort((a, b) => {
        const ta = a.firstSeenSec;
        const tb = b.firstSeenSec;
        if (ta != null && tb != null && ta !== tb) return ta - tb;
        return (b.importance || 0) - (a.importance || 0);
      });
    }
    return main;
  };

  const lectureId = opts.lectureId || "";
  let root: MindmapTreeNode;
  let virtualRoot = false;
  let droppedShallow = Math.max(0, rootIds.length - builtRoots.filter(keepTree).length);

  const virtSalvageLimited = pendingVirtSalvage
    .filter((t) => !treeNodes.some((x) => x.id === t.id))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, MAX_SALVAGE_UNDER_VIRT);

  let themes = [...treeNodes];
  if (themes.length + virtSalvageLimited.length <= 1 && themes.length === 1 && !virtSalvageLimited.length) {
    root = themes[0]!;
  } else {
    virtualRoot = true;
    themes = mergeThinThemes(themes);
    sortThemes(themes);
    const virtId = `__lecture__/${lectureId || "graph"}`;
    const virtZh = lectureId.includes("_")
      ? `第 ${lectureId.replace("_", "–")} 讲`
      : lectureId
        ? `第 ${lectureId} 讲`
        : "本讲";
    const children: MindmapTreeNode[] = [
      ...themes.map((t) => ({
        ...t,
        relation: t.relation || "attach",
        weak: true,
        copy: false,
        linkKind: t.linkKind || "attach",
      })),
      ...virtSalvageLimited.map((t) => ({
        ...t,
        relation: "attach",
        weak: true,
        salvaged: true,
        copy: false,
        linkKind: "attach" as const,
      })),
    ];
    root = {
      id: virtId,
      zh: virtZh,
      importance: Math.max(...children.map((t) => t.importance || 0), 0),
      relation: null,
      related: [],
      deps: [],
      children,
    };
  }

  const finalIds = new Set<string>();
  const walkIds = (n: MindmapTreeNode) => {
    if (!n.id.startsWith("__lecture__/")) finalIds.add(n.id);
    for (const c of n.children) walkIds(c);
  };
  walkIds(root);
  const dropped =
    Math.max(0, forest.roots.length - rootIds.length) + droppedShallow;

  return {
    lecture_id: lectureId,
    root,
    roots: [root],
    n_nodes: finalIds.size,
    max_depth: depthOf(root),
    orphan_count: dropped,
    meta: {
      chapter: opts.chapter || undefined,
      root_zh: root.zh,
      virtual_root: virtualRoot,
      n_trees: 1,
      n_entities_raw: Math.max(nodeSet.size, importance.size),
      n_edges_raw: forest.treeEdges.length,
      attached_orphans: attachedOrphans + virtSalvageLimited.length,
      scope: opts.scope || "lecture",
      source: opts.source || (opts.reviewOrder?.length ? "review+kg" : "kg"),
    },
  };
}

export function buildMindmapFromProcessedGraph(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  opts: BuildMindmapOpts = {}
): MindmapDoc | null {
  const forest = assignMindmapForest(nodes, edges);
  return materializeForest(forest, opts);
}

export function collectMindmapTreeEdges(
  node: MindmapTreeNode
): { parent: string; child: string; rel?: string | null }[] {
  const out: { parent: string; child: string; rel?: string | null }[] = [];
  const walk = (n: MindmapTreeNode) => {
    for (const c of n.children || []) {
      if (n.id.startsWith("__lecture__/")) {
        walk(c);
        continue;
      }
      out.push({ parent: n.id, child: c.id, rel: c.relation });
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function collectForestTreeEdges(
  trees: MindmapTreeNode[]
): { parent: string; child: string; rel?: string | null }[] {
  return trees.flatMap(collectMindmapTreeEdges);
}

export function mindmapQualityStats(root: MindmapTreeNode): {
  copies: number;
  leafRatio: number;
  invertEdges: number;
  salvaged: number;
  entityCounts: Map<string, number>;
} {
  let copies = 0;
  let leaves = 0;
  let total = 0;
  let invertEdges = 0;
  let salvaged = 0;
  const entityCounts = new Map<string, number>();
  const walk = (n: MindmapTreeNode) => {
    if (!n.id.startsWith("__lecture__/")) {
      total += 1;
      entityCounts.set(n.id, (entityCounts.get(n.id) || 0) + 1);
      if (n.copy) copies += 1;
      if (n.salvaged) salvaged += 1;
      if (!n.children.length) leaves += 1;
    }
    for (const c of n.children || []) {
      if (
        !n.id.startsWith("__lecture__/") &&
        !c.id.startsWith("__lecture__/") &&
        (c.importance || 0) - (n.importance || 0) > 0.2 &&
        !c.weak &&
        !c.copy
      ) {
        invertEdges += 1;
      }
      walk(c);
    }
  };
  walk(root);
  return {
    copies,
    leafRatio: total ? leaves / total : 0,
    invertEdges,
    salvaged,
    entityCounts,
  };
}
