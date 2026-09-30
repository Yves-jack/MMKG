/**
 * 课堂 KG 展示后处理：去重合并 → 层次规则删边 → 不合适节点 → 孤立/短路径子图。
 * 被删边保留为 process_* 来源，供图例高亮。
 */
import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";

export const PROCESS_SOURCE_RULE = "process_rule";
export const PROCESS_SOURCE_NODE = "process_node";
export const PROCESS_SOURCE_ISOLATED = "process_isolated";

export const PROCESS_EDGE_SOURCES = [
  PROCESS_SOURCE_RULE,
  PROCESS_SOURCE_NODE,
  PROCESS_SOURCE_ISOLATED,
] as const;

export function isProcessEdgeSource(source?: string | null): boolean {
  const s = (source || "").trim();
  return (
    s === PROCESS_SOURCE_RULE ||
    s === PROCESS_SOURCE_NODE ||
    s === PROCESS_SOURCE_ISOLATED
  );
}

const SOURCE_RANK: Record<string, number> = {
  textbook: 100,
  textbook_revised: 90,
  lecture_delta: 80,
  kg_completion: 70,
  cross_cue: 60,
  llm_fallback: 40,
  llm_only: 30,
};

function relOf(e: PipelineEdge): string {
  return (e.relation || e.label || "").trim();
}

function spoCore(e: PipelineEdge): string {
  return `${e.from || ""}\t${relOf(e)}\t${e.to || ""}`;
}

function sourceRank(src?: string | null): number {
  return SOURCE_RANK[(src || "").trim()] ?? 10;
}

const BAD_ZH_RE =
  /(字母|括号|符号|记号|下标|上标|空白|空格|标点|逗号|句号|原始符号|自然语言|日常生活|英文|单词|粒度)/;
const BAD_PHRASE_RE = /(不能|没有|无需|转化为|翻译成|方式|条件|描述|表示|只能|独立于)/;
const BAD_ACTION_RE = /(转化为|形式化|实例化|约束化|展开|赋值|指派|解释)$/;
const BAD_BROAD_RE = /^(推理语言|形式化逻辑系统)$/;
const PLACEHOLDER_RE =
  /^(?:[a-z](?:,[a-z])+|\.{2,}|…|[a-z]{1,2})$/i;

function primaryZh(name: string): string {
  return (name || "").split("/")[0].trim();
}

function primaryEn(name: string): string {
  const parts = (name || "").split("/");
  return parts.length > 1 ? parts.slice(1).join("/").trim() : "";
}

/** 拉丁字母小写，用于排除大小写影响（中文不受影响） */
export function foldLatinCase(s: string): string {
  return (s || "").replace(/[A-Za-z]+/g, (w) => w.toLowerCase());
}

function compactWs(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** 全名大小写折叠键（阶段1） */
export function entityCaseFoldKey(name: string): string {
  return foldLatinCase(compactWs(name));
}

/** 整体匹配键：中英双语用 zh+enFold；否则用整段 case-fold（阶段2） */
export function entityWholeMatchKey(name: string): string {
  const zh = primaryZh(name);
  const en = compactWs(primaryEn(name));
  if (zh && en) return `W\t${zh}\t${foldLatinCase(en)}`;
  if (zh) return `W\t${zh}\t`;
  if (en) return `W\t\t${foldLatinCase(en)}`;
  return `W\t${entityCaseFoldKey(name)}`;
}

/** 局部匹配：中文主名键（阶段3a） */
export function entityLocalZhKey(name: string): string {
  const zh = primaryZh(name);
  return zh.length >= 2 ? `Z\t${zh}` : "";
}

/** 局部匹配：英文主名键（阶段3b，较短英文不参与） */
export function entityLocalEnKey(name: string): string {
  const en = foldLatinCase(compactWs(primaryEn(name) || (!primaryZh(name) ? name : "")));
  const compact = en.replace(/[\s\-_.]+/g, "");
  return compact.length >= 4 ? `E\t${en}` : "";
}

/** @deprecated 兼容旧调用：现为局部中文主名 */
export function entityDedupeKey(name: string): string {
  return primaryZh(name);
}

/** 同簇中选正式全名：优先教材侧、含英文、规范小写英文 */
export function pickCanonicalEntityName(
  names: Iterable<string>,
  textbookNames?: Set<string>
): string {
  const list = [...new Set([...names].map((n) => n.trim()).filter(Boolean))];
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  const score = (n: string): number => {
    let s = 0;
    if (textbookNames?.has(n)) s += 100;
    const en = primaryEn(n);
    if (en) s += 20;
    if (en && en === en.toLowerCase()) s += 8;
    if (en && /[A-Z]/.test(en[0] || "") && en.slice(1) === en.slice(1).toLowerCase())
      s += 2;
    s += Math.min(n.length, 40) * 0.01;
    return s;
  };
  return list.slice().sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

/**
 * 分阶段实体合并映射：
 * 1) 排除大小写 → 2) 整体全名匹配 → 3) 局部（先中文主名，再英文主名）
 */
export function buildStagedEntityMergeMap(
  entityNames: Iterable<string>,
  textbookNames?: Set<string>
): Map<string, string> {
  const names = [
    ...new Set([...entityNames].map((n) => (n || "").trim()).filter(Boolean)),
  ];
  if (names.length < 2) return new Map();

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) || x;
    if (p !== x) {
      const r = find(p);
      parent.set(x, r);
      return r;
    }
    return x;
  };
  const uniteGroup = (group: string[]) => {
    if (group.length < 2) return;
    const roots = [...new Set(group.map(find))];
    if (roots.length < 2) return;
    const canon = pickCanonicalEntityName(roots, textbookNames);
    const keep = find(canon);
    for (const r of roots) {
      const rr = find(r);
      if (rr !== keep) parent.set(rr, keep);
    }
  };

  for (const n of names) parent.set(n, n);

  const bucketAndUnite = (keyFn: (n: string) => string) => {
    const buckets = new Map<string, string[]>();
    // 对当前代表元分组，避免重复 unite
    const roots = [...new Set(names.map(find))];
    for (const r of roots) {
      const key = keyFn(r);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }
    for (const group of buckets.values()) uniteGroup(group);
  };

  // 1) 排除大小写：全名仅大小写不同 → 合并
  bucketAndUnite(entityCaseFoldKey);
  // 2) 整体：中英结构全名一致（英文已折叠）
  bucketAndUnite(entityWholeMatchKey);
  // 3a) 局部：同中文主名（multiary vs n-ary 等）
  bucketAndUnite(entityLocalZhKey);
  // 3b) 局部：同英文主名（一侧缺中文或中文已一致的代表元）
  {
    const buckets = new Map<string, string[]>();
    const roots = [...new Set(names.map(find))];
    for (const r of roots) {
      const key = entityLocalEnKey(r);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(r);
    }
    for (const group of buckets.values()) {
      if (group.length < 2) continue;
      // 不同中文主名不因英文相同硬并（避免误伤）
      const zhs = new Set(
        group.map((g) => primaryZh(g)).filter((z) => z.length >= 2)
      );
      if (zhs.size > 1) continue;
      uniteGroup(group);
    }
  }

  const mergeMap = new Map<string, string>();
  for (const n of names) {
    const root = find(n);
    if (root !== n) mergeMap.set(n, root);
  }
  return mergeMap;
}

/**
 * 分阶段实体合并后重写节点/边端点，供 SPO 去重。
 */
export function mergeEntitiesByPrimaryZh(
  nodes: PipelineNode[],
  edges: PipelineEdge[]
): { nodes: PipelineNode[]; edges: PipelineEdge[]; mergeMap: Map<string, string> } {
  const textbookNames = new Set<string>();
  for (const e of edges) {
    if ((e.source || "") === "textbook" || (e.source || "") === "textbook_revised") {
      if (e.from) textbookNames.add(e.from);
      if (e.to) textbookNames.add(e.to);
    }
  }

  const nameSet = new Set<string>();
  for (const n of nodes) if (n?.id) nameSet.add(n.id.trim());
  for (const e of edges) {
    if (e.from) nameSet.add(e.from.trim());
    if (e.to) nameSet.add(e.to.trim());
  }

  const mergeMap = buildStagedEntityMergeMap(nameSet, textbookNames);
  const remap = (id: string) => mergeMap.get(id) || id;

  const nodeMap = new Map<string, PipelineNode>();
  for (const n of nodes) {
    if (!n?.id) continue;
    const id = remap(n.id);
    const prev = nodeMap.get(id);
    // 非等价合并：不写入 aliases（仅 synonym_of 合并才挂别名）
    const carryAliases = [...(prev?.aliases || []), ...(n.aliases || [])].filter(
      (a) => a && a !== id
    );
    if (!prev) {
      nodeMap.set(id, {
        ...n,
        id,
        label: primaryZh(id) || n.label,
        aliases: carryAliases.length ? carryAliases : undefined,
        properties: [...(n.properties || [])],
      });
    } else {
      const properties = [
        ...new Set([...(prev.properties || []), ...(n.properties || [])]),
      ];
      nodeMap.set(id, {
        ...prev,
        aliases: carryAliases.length ? carryAliases : undefined,
        properties: properties.length ? properties : undefined,
        title: prev.title || n.title,
        description: prev.description || n.description,
        kind: prev.kind === "new" || n.kind === "new" ? "new" : prev.kind || n.kind,
      });
    }
  }

  const outEdges = edges.map((e) => ({
    ...e,
    from: remap(e.from),
    to: remap(e.to),
  }));
  for (const e of outEdges) {
    for (const id of [e.from, e.to]) {
      if (!id || nodeMap.has(id)) continue;
      nodeMap.set(id, { id, label: primaryZh(id), kind: "entity" });
    }
  }
  return { nodes: [...nodeMap.values()], edges: outEdges, mergeMap };
}

/** 不合适节点：记号/元叙述/过程短语/占位符等 */
export function isInappropriateEntity(name: string): boolean {
  const full = (name || "").trim();
  if (!full) return true;
  const zh = primaryZh(full);
  if (!zh) return true;
  if (zh.length === 1 && !/[\u4e00-\u9fff]/.test(zh)) return true;
  if (PLACEHOLDER_RE.test(zh.replace(/\s/g, ""))) return true;
  if (BAD_BROAD_RE.test(zh)) return true;
  if (BAD_ZH_RE.test(zh)) return true;
  if (BAD_PHRASE_RE.test(zh) && zh.length <= 8) return true;
  if (BAD_ACTION_RE.test(zh)) return true;
  // 纯英文短串且无中文
  if (!/[\u4e00-\u9fff]/.test(zh) && /^[a-zA-Z0-9,.\s…]{1,6}$/.test(zh)) return true;
  return false;
}

function markProcessEdge(
  e: PipelineEdge,
  source: string,
  reasonZh: string
): PipelineEdge {
  return {
    ...e,
    id: e.id || `${source}-${e.from}->${e.to}`,
    source,
    dedupe_reason: source,
    dedupe_reason_zh: reasonZh,
  };
}

function mergeEdgePair(base: PipelineEdge, other: PipelineEdge): PipelineEdge {
  const cueIds = new Set<string>([
    ...(base.cue_ids || []),
    ...(other.cue_ids || []),
    base.cue_id || "",
    other.cue_id || "",
  ].filter(Boolean));
  const isCross =
    Boolean(base.is_cross_cue) ||
    Boolean(other.is_cross_cue) ||
    isCrossCueSourceLocal(base.source) ||
    isCrossCueSourceLocal(other.source);
  return {
    ...base,
    cue_ids: [...cueIds],
    cue_id: base.cue_id || other.cue_id,
    context: base.context || other.context,
    description: base.description || other.description,
    concrete: base.concrete || other.concrete,
    concrete_relation: base.concrete_relation || other.concrete_relation,
    statement_direction: base.statement_direction || other.statement_direction,
    extract_source: base.extract_source || other.extract_source,
    is_cross_cue: isCross || undefined,
    cue_label:
      base.cue_label && other.cue_label && base.cue_label !== other.cue_label
        ? `${base.cue_label}；${other.cue_label}`
        : base.cue_label || other.cue_label,
  };
}

function isCrossCueSourceLocal(source?: string | null): boolean {
  const s = (source || "").trim();
  if (!s) return false;
  if (s === "cross_cue" || s.startsWith("cross_cue")) return true;
  return s.includes("讲的第") && s.includes("段到第");
}

/** 无向关系：synonym_of / related_with 双向视为同一条 */
function spoDedupeKey(e: PipelineEdge): string {
  const rel = relOf(e);
  const a = e.from || "";
  const b = e.to || "";
  if (rel === "synonym_of" || rel === "related_with") {
    const [x, y] = [a, b].slice().sort();
    return `${x}\t${rel}\t${y}\tundirected`;
  }
  return spoCore(e);
}

/** 1) SPO 去重（跨 source 合并，保留更高优先级来源） */
export function dedupeMergeEdges(edges: PipelineEdge[]): PipelineEdge[] {
  const bySpo = new Map<string, PipelineEdge>();
  for (const e of edges) {
    if (!e?.from || !e?.to || isProcessEdgeSource(e.source)) continue;
    if (e.from === e.to) continue;
    const key = spoDedupeKey(e);
    const prev = bySpo.get(key);
    if (!prev) {
      bySpo.set(key, { ...e });
      continue;
    }
    const keepNew = sourceRank(e.source) > sourceRank(prev.source);
    const base = keepNew ? e : prev;
    const other = keepNew ? prev : e;
    bySpo.set(key, mergeEdgePair({ ...base }, other));
  }
  return [...bySpo.values()];
}

/**
 * 同端点对上：若已有具体关系，丢掉 related_with（与 Stage2 entity_merge 一致）。
 */
export function dropRedundantRelatedWith(edges: PipelineEdge[]): PipelineEdge[] {
  const pairRels = new Map<string, Set<string>>();
  const pairKey = (a: string, b: string) => [a, b].slice().sort().join("\t");
  for (const e of edges) {
    if (!e.from || !e.to || isProcessEdgeSource(e.source)) continue;
    const k = pairKey(e.from, e.to);
    if (!pairRels.has(k)) pairRels.set(k, new Set());
    pairRels.get(k)!.add(relOf(e));
  }
  return edges.filter((e) => {
    if (isProcessEdgeSource(e.source)) return true;
    if (relOf(e) !== "related_with") return true;
    const rels = pairRels.get(pairKey(e.from, e.to));
    return !rels || rels.size <= 1;
  });
}

/** synonym_of 连通分量合并为一点，别名挂到 canonical */
export function mergeSynonymNodes(
  nodes: PipelineNode[],
  edges: PipelineEdge[]
): { nodes: PipelineNode[]; edges: PipelineEdge[] } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) || x;
    if (p !== x) {
      const r = find(p);
      parent.set(x, r);
      return r;
    }
    return x;
  };
  const unite = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // 优先保留：更短中文主名；并列时保留含英文全名的一侧
    const za = primaryZh(ra);
    const zb = primaryZh(rb);
    let keep = ra;
    let drop = rb;
    if (za.length > zb.length) {
      keep = rb;
      drop = ra;
    } else if (za.length === zb.length) {
      const ea = primaryEn(ra);
      const eb = primaryEn(rb);
      if (!ea && eb) {
        keep = rb;
        drop = ra;
      } else if (ea && eb && eb.length > ea.length) {
        keep = rb;
        drop = ra;
      }
    }
    parent.set(drop, keep);
  };

  for (const e of edges) {
    if (relOf(e) !== "synonym_of" || !e.from || !e.to) continue;
    unite(e.from, e.to);
  }

  const aliasMap = new Map<string, Set<string>>();
  const remap = (id: string) => find(id);
  for (const n of nodes) {
    if (!n?.id) continue;
    parent.set(n.id, parent.get(n.id) || n.id);
  }
  for (const n of nodes) {
    if (!n?.id) continue;
    const root = remap(n.id);
    if (root === n.id) continue;
    // 仅因 synonym_of 并入的名字记为别名
    if (!aliasMap.has(root)) aliasMap.set(root, new Set());
    aliasMap.get(root)!.add(n.id);
  }

  const nodeMap = new Map<string, PipelineNode>();
  // 先放入 canonical 自身节点，避免被同义成员的 label 覆盖（如 论域←个体域）
  for (const n of nodes) {
    if (!n?.id) continue;
    if (remap(n.id) !== n.id) continue;
    const synAliases = aliasMap.get(n.id) || new Set<string>();
    const aliases = new Set<string>([...(n.aliases || []), ...synAliases]);
    aliases.delete(n.id);
    nodeMap.set(n.id, {
      ...n,
      id: n.id,
      label: primaryZh(n.id) || n.label,
      aliases: aliases.size ? [...aliases] : undefined,
    });
  }
  for (const n of nodes) {
    if (!n?.id) continue;
    const root = remap(n.id);
    const prev = nodeMap.get(root);
    const synAliases = aliasMap.get(root) || new Set<string>();
    if (!prev) {
      // 端点仅出现在边上、无独立 node 记录时
      const aliases = new Set<string>([...synAliases]);
      aliases.delete(root);
      if (n.id !== root) aliases.add(n.id);
      nodeMap.set(root, {
        id: root,
        label: primaryZh(root),
        kind: n.kind || "entity",
        title: n.title,
        description: n.description,
        aliases: aliases.size ? [...aliases] : undefined,
        properties: n.properties?.length ? [...n.properties] : undefined,
      });
      continue;
    }
    if (n.id === root) continue;
    const aliases = new Set<string>([
      ...(prev.aliases || []),
      ...synAliases,
      n.id,
      ...(n.aliases || []),
    ]);
    aliases.delete(root);
    nodeMap.set(root, {
      ...prev,
      // 始终以 canonical id 的中文主名为展示名
      label: primaryZh(root) || prev.label,
      aliases: aliases.size ? [...aliases] : undefined,
      title: prev.title || n.title,
      description: prev.description || n.description,
      kind: prev.kind === "new" || n.kind === "new" ? "new" : prev.kind || n.kind,
      properties: (() => {
        const props = [
          ...new Set([...(prev.properties || []), ...(n.properties || [])]),
        ].filter(Boolean);
        return props.length ? props : undefined;
      })(),
    });
  }

  const outEdges: PipelineEdge[] = [];
  for (const e of edges) {
    if (!e.from || !e.to) continue;
    if (relOf(e) === "synonym_of") continue; // 合并后同义边消失
    const from = remap(e.from);
    const to = remap(e.to);
    if (!from || !to || from === to) continue;
    outEdges.push({ ...e, from, to });
  }
  // 端点合并后可能产生新的同 SPO，再去重
  return {
    nodes: [...nodeMap.values()],
    edges: dedupeMergeEdges(outEdges),
  };
}

/**
 * 2) 层次捷径：子-belong_to→父、父-part_of→祖、子-part_of→祖 → 删子→祖的 part_of
 */
export function pruneHierarchyShortcuts(edges: PipelineEdge[]): {
  kept: PipelineEdge[];
  removed: PipelineEdge[];
} {
  const active = edges.filter((e) => !isProcessEdgeSource(e.source));
  const belong = new Map<string, Set<string>>(); // child -> parents
  const partOf = new Map<string, Set<string>>(); // part -> wholes
  for (const e of active) {
    const r = relOf(e);
    if (r === "belong_to") {
      if (!belong.has(e.from)) belong.set(e.from, new Set());
      belong.get(e.from)!.add(e.to);
    } else if (r === "part_of") {
      if (!partOf.has(e.from)) partOf.set(e.from, new Set());
      partOf.get(e.from)!.add(e.to);
    }
  }

  const dropKeys = new Set<string>();
  for (const e of active) {
    if (relOf(e) !== "part_of") continue;
    const child = e.from;
    const grand = e.to;
    const parents = belong.get(child);
    if (!parents) continue;
    for (const parent of parents) {
      if (partOf.get(parent)?.has(grand)) {
        dropKeys.add(spoCore(e));
        break;
      }
    }
  }

  const kept: PipelineEdge[] = [];
  const removed: PipelineEdge[] = [];
  for (const e of edges) {
    if (isProcessEdgeSource(e.source)) {
      removed.push(e);
      continue;
    }
    if (dropKeys.has(spoCore(e))) {
      removed.push(
        markProcessEdge(e, PROCESS_SOURCE_RULE, "层次捷径：已有子→父→祖，删子→祖 part_of")
      );
    } else {
      kept.push(e);
    }
  }
  return { kept, removed };
}

/** 3) 不合适节点：删节点及其关联边 */
export function filterInappropriateNodes(
  nodes: PipelineNode[],
  edges: PipelineEdge[]
): { nodes: PipelineNode[]; kept: PipelineEdge[]; removed: PipelineEdge[] } {
  const bad = new Set(
    nodes.filter((n) => isInappropriateEntity(n.id)).map((n) => n.id)
  );
  // 端点也可能不在 nodes 列表
  for (const e of edges) {
    if (isProcessEdgeSource(e.source)) continue;
    if (e.from && isInappropriateEntity(e.from)) bad.add(e.from);
    if (e.to && isInappropriateEntity(e.to)) bad.add(e.to);
  }

  const kept: PipelineEdge[] = [];
  const removed: PipelineEdge[] = [];
  for (const e of edges) {
    if (isProcessEdgeSource(e.source)) {
      removed.push(e);
      continue;
    }
    if (bad.has(e.from) || bad.has(e.to)) {
      removed.push(
        markProcessEdge(e, PROCESS_SOURCE_NODE, "不合适节点筛选：端点为记号/元叙述/占位等")
      );
    } else {
      kept.push(e);
    }
  }
  const keepIds = new Set<string>();
  kept.forEach((e) => {
    keepIds.add(e.from);
    keepIds.add(e.to);
  });
  const finalNodes = nodes.filter((n) => keepIds.has(n.id));
  return { nodes: finalNodes, kept, removed };
}

function undirectedAdj(
  edges: PipelineEdge[]
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    if (!e.from || !e.to || e.from === e.to) continue;
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return adj;
}

function connectedComponents(adj: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    const comp: string[] = [];
    seen.add(start);
    while (stack.length) {
      const u = stack.pop()!;
      comp.push(u);
      for (const v of adj.get(u) || []) {
        if (seen.has(v)) continue;
        seen.add(v);
        stack.push(v);
      }
    }
    comps.push(comp);
  }
  return comps;
}

/**
 * 无向连通分量内最长简单路径的边数。
 * 只精确到阈值 3：≤2 用于短路径剪枝，≥3 即保留（早停）。
 * 避免在稠密大分量上做全量最长路 DFS（会话融合图会卡死页面）。
 */
export function longestPathLength(comp: string[], adj: Map<string, Set<string>>): number {
  if (comp.length <= 1) return 0;
  if (comp.length === 2) return 1;
  if (comp.length === 3) {
    // 三点最多 2 条边的路径
    return 2;
  }
  const compSet = new Set(comp);
  // 存在长度≥3 的简单路径 ⇔ 某点 u 的两邻居 a,b 中，a 或 b 还能走到 {u,a,b} 之外
  for (const u of comp) {
    const nbrs: string[] = [];
    for (const v of adj.get(u) || []) {
      if (compSet.has(v)) nbrs.push(v);
    }
    for (let i = 0; i < nbrs.length; i++) {
      const a = nbrs[i];
      for (let j = i + 1; j < nbrs.length; j++) {
        const b = nbrs[j];
        for (const x of adj.get(a) || []) {
          if (x !== u && x !== b && compSet.has(x)) return 3;
        }
        for (const x of adj.get(b) || []) {
          if (x !== u && x !== a && compSet.has(x)) return 3;
        }
      }
    }
  }
  return 2;
}

/**
 * 4) 孤立边 / 最长路径≤2 的连通子图整段删除
 */
export function pruneShortPathComponents(edges: PipelineEdge[]): {
  kept: PipelineEdge[];
  removed: PipelineEdge[];
} {
  const active = edges.filter((e) => !isProcessEdgeSource(e.source));
  const adj = undirectedAdj(active);
  // 度为 0 的点不在 adj 里；边端点都会进
  const comps = connectedComponents(adj);
  const dropNodes = new Set<string>();
  for (const comp of comps) {
    const len = longestPathLength(comp, adj);
    if (len <= 2) {
      comp.forEach((n) => dropNodes.add(n));
    }
  }

  const kept: PipelineEdge[] = [];
  const removed: PipelineEdge[] = [];
  for (const e of edges) {
    if (isProcessEdgeSource(e.source)) {
      removed.push(e);
      continue;
    }
    if (dropNodes.has(e.from) || dropNodes.has(e.to)) {
      removed.push(
        markProcessEdge(
          e,
          PROCESS_SOURCE_ISOLATED,
          "孤立边/短路径子图：连通分量最长路径≤2"
        )
      );
    } else {
      kept.push(e);
    }
  }
  return { kept, removed };
}

export type LectureKgProcessStats = {
  input_edges: number;
  after_dedupe: number;
  after_synonym: number;
  property_folded: number;
  multi_rel_collapsed: number;
  rule_removed: number;
  node_removed: number;
  isolated_removed: number;
  kept_edges: number;
};

/** LLM / 人工对「两端点多关系」的裁决 */
export type MultiRelCollapseDecision = {
  from: string;
  to: string;
  relation: string;
  concrete?: string;
  reason?: string;
};

export type LectureKgProcessOptions = {
  /** pairKey = sorted(a,b).join('\\t') → 裁决；有则优先于启发式 */
  multiRelDecisions?: Map<string, MultiRelCollapseDecision> | Record<string, MultiRelCollapseDecision>;
};

export type LectureKgProcessResult = {
  nodes: PipelineNode[];
  /** 保留边 + 处理删除边（供图例） */
  edges: PipelineEdge[];
  stats: LectureKgProcessStats;
};

function pairKeyUndirected(a: string, b: string): string {
  return [a, b].slice().sort().join("\t");
}

function firstSentence(text: string): string {
  const t = (text || "").trim();
  if (!t) return "";
  const m = t.match(/^[\s\S]+?[。！？!?；;\n]/);
  return (m ? m[0] : t).trim();
}

/**
 * 将 property_of 收成一句特性说明。
 * 优先用边的 statement / description（与图谱边描述一致），否则按 statement_direction 拼读。
 * property_of：S=属性、O=拥有者；object_to_subject 时常读成「拥有者 … 属性」。
 */
export function propertyOfToSentence(e: PipelineEdge): string {
  // 优先关系描述，其次拼读 statement，再 context，最后按方向拼读
  const desc = firstSentence(e.description || "");
  if (desc) return desc;

  const statement = (e.statement || "").trim();
  if (statement) return statement;

  const ctx = (e.context || "").trim();
  if (ctx) return firstSentence(ctx);

  const propZh = primaryZh(e.from) || (e.from || "").trim() || "?";
  const ownerZh = primaryZh(e.to) || (e.to || "").trim() || "?";
  let concrete = (e.concrete || e.concrete_relation || "").trim();
  if (!concrete) concrete = "具有属性";
  // 填补「用…表示 / 是…的属性」中的省略号
  if (concrete.includes("…") || concrete.includes("...")) {
    concrete = concrete.replace(/\.\.\./g, "…").replace(/…/g, propZh);
  }
  const dir = (e.statement_direction || "").trim();
  if (dir === "object_to_subject") {
    return `${ownerZh}${concrete}${propZh}`;
  }
  if (dir === "subject_to_object" || !dir) {
    // 「是…的属性」类：属性是拥有者的属性
    if (/的属性$/.test(concrete) || concrete.includes(propZh)) {
      return `${propZh}${concrete.includes(ownerZh) ? concrete : `是${ownerZh}的属性`}`;
    }
    return `${propZh}${concrete}${ownerZh}`;
  }
  return `${ownerZh}${concrete}${propZh}`;
}

/**
 * property_of：属性→拥有者。收成拥有者节点的 properties[]（每条一句），边不再入图。
 */
export function foldPropertyOfToNodeProperties(
  nodes: PipelineNode[],
  edges: PipelineEdge[]
): { nodes: PipelineNode[]; edges: PipelineEdge[]; folded: number } {
  const nodeMap = new Map<string, PipelineNode>();
  for (const n of nodes) {
    if (!n?.id) continue;
    nodeMap.set(n.id, {
      ...n,
      properties: [...(n.properties || [])],
    });
  }
  const kept: PipelineEdge[] = [];
  let folded = 0;
  for (const e of edges) {
    if (isProcessEdgeSource(e.source)) {
      kept.push(e);
      continue;
    }
    if (relOf(e) !== "property_of") {
      kept.push(e);
      continue;
    }
    const ownerId = (e.to || "").trim();
    const sentence = propertyOfToSentence(e);
    if (!ownerId || !sentence) {
      folded += 1;
      continue;
    }
    let owner = nodeMap.get(ownerId);
    if (!owner) {
      owner = { id: ownerId, label: primaryZh(ownerId), kind: "entity", properties: [] };
      nodeMap.set(ownerId, owner);
    }
    const props = owner.properties || [];
    if (!props.includes(sentence)) props.push(sentence);
    owner.properties = props;
    folded += 1;
  }
  return { nodes: [...nodeMap.values()], edges: kept, folded };
}

const MULTI_REL_RANK: Record<string, number> = {
  belong_to: 100,
  part_of: 90,
  depend_on: 85,
  synonym_of: 40,
  related_with: 15,
};

function scoreMultiRelCandidate(e: PipelineEdge): number {
  return (MULTI_REL_RANK[relOf(e)] ?? 20) + sourceRank(e.source) * 0.01;
}

function decisionMapFrom(
  raw?: LectureKgProcessOptions["multiRelDecisions"]
): Map<string, MultiRelCollapseDecision> {
  if (!raw) return new Map();
  if (raw instanceof Map) return raw;
  return new Map(Object.entries(raw));
}

function lookupMultiRelDecision(
  decisionMap: Map<string, MultiRelCollapseDecision>,
  a: string,
  b: string
): MultiRelCollapseDecision | undefined {
  const exact = decisionMap.get(pairKeyUndirected(a, b));
  if (exact) {
    // 端点可能已因实体合并改名：对齐到当前 a/b
    return alignDecisionEndpoints(exact, a, b);
  }
  const zhKey = pairKeyUndirected(primaryZh(a), primaryZh(b));
  for (const [k, d] of decisionMap) {
    const [x, y] = k.split("\t");
    if (pairKeyUndirected(primaryZh(x || ""), primaryZh(y || "")) === zhKey) {
      return alignDecisionEndpoints(d, a, b);
    }
  }
  return undefined;
}

function alignDecisionEndpoints(
  d: MultiRelCollapseDecision,
  a: string,
  b: string
): MultiRelCollapseDecision {
  const fromZh = primaryZh(d.from);
  const toZh = primaryZh(d.to);
  let from = d.from;
  let to = d.to;
  if (fromZh === primaryZh(a) && toZh === primaryZh(b)) {
    from = a;
    to = b;
  } else if (fromZh === primaryZh(b) && toZh === primaryZh(a)) {
    from = b;
    to = a;
  } else if ([a, b].includes(d.from) && [a, b].includes(d.to)) {
    from = d.from;
    to = d.to;
  } else {
    // 兜底：保持方向语义，映射到当前端点
    from = fromZh === primaryZh(a) ? a : b;
    to = from === a ? b : a;
  }
  return { ...d, from, to };
}

/**
 * 两实体间多条不同关系 → 收成单条。
 * 优先使用 LLM 裁决表；否则按关系优先级+来源启发式保留一条。
 */
export function collapseMultiRelations(
  edges: PipelineEdge[],
  decisions?: LectureKgProcessOptions["multiRelDecisions"]
): { edges: PipelineEdge[]; collapsed: number } {
  const decisionMap = decisionMapFrom(decisions);
  const active = edges.filter((e) => !isProcessEdgeSource(e.source));
  const processKept = edges.filter((e) => isProcessEdgeSource(e.source));

  const groups = new Map<string, PipelineEdge[]>();
  for (const e of active) {
    if (!e.from || !e.to || e.from === e.to) continue;
    const k = pairKeyUndirected(e.from, e.to);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }

  const out: PipelineEdge[] = [...processKept];
  let collapsed = 0;

  for (const [key, group] of groups) {
    const rels = new Set(group.map(relOf));
    if (group.length === 1 || rels.size <= 1) {
      // 同关系多条已在 SPO 去重；若仍重复取一条
      out.push(group[0]);
      if (group.length > 1) collapsed += group.length - 1;
      continue;
    }

    const [pa, pb] = key.split("\t");
    const decided =
      lookupMultiRelDecision(decisionMap, pa, pb) ||
      lookupMultiRelDecision(decisionMap, group[0].from, group[0].to);
    if (decided?.from && decided?.to && decided?.relation) {
      const base =
        group.find(
          (e) =>
            e.from === decided.from &&
            e.to === decided.to &&
            relOf(e) === decided.relation
        ) ||
        group.find((e) => e.from === decided.from && e.to === decided.to) ||
        group[0];
      out.push({
        ...base,
        from: decided.from,
        to: decided.to,
        relation: decided.relation,
        label: decided.relation,
        concrete: decided.concrete || base.concrete,
        concrete_relation: decided.concrete || base.concrete_relation,
        description: decided.reason
          ? `多关系合并：${decided.reason}`
          : base.description,
        dedupe_reason: "multi_rel_llm",
        dedupe_reason_zh: decided.reason || "LLM 多关系合并为单条",
      });
      collapsed += group.length - 1;
      continue;
    }

    // 启发式：保留最高分一条
    const best = group
      .slice()
      .sort(
        (a, b) =>
          scoreMultiRelCandidate(b) - scoreMultiRelCandidate(a) ||
          (a.from || "").localeCompare(b.from || "")
      )[0];
    out.push({
      ...best,
      dedupe_reason: best.dedupe_reason || "multi_rel_heuristic",
      dedupe_reason_zh:
        best.dedupe_reason_zh ||
        `多关系启发式保留 ${relOf(best)}（候选：${[...rels].join("、")}）`,
    });
    collapsed += group.length - 1;
  }

  return { edges: out, collapsed };
}

/**
 * 完整处理链。
 * 输入应为流水线 merge 并集（可含跨段边）。
 */
export function processLectureKg(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  options?: LectureKgProcessOptions
): LectureKgProcessResult {
  const input = edges.filter((e) => e?.from && e?.to);
  // 实体分阶段合并 → SPO 去重 → synonym → 冗余 related_with
  // → property_of 收成特性 → 多关系收成单条 → 规则/节点/孤立剪枝
  const byZh = mergeEntitiesByPrimaryZh(nodes, input);
  const deduped = dedupeMergeEdges(byZh.edges);
  const syn = mergeSynonymNodes(byZh.nodes, deduped);
  const cleaned = dropRedundantRelatedWith(syn.edges);
  const afterDedupe = dedupeMergeEdges(cleaned);

  const prop = foldPropertyOfToNodeProperties(syn.nodes, afterDedupe);
  const multi = collapseMultiRelations(prop.edges, options?.multiRelDecisions);
  const afterMulti = dedupeMergeEdges(multi.edges);

  const rule = pruneHierarchyShortcuts(afterMulti);
  const nodeF = filterInappropriateNodes(prop.nodes, rule.kept);
  const iso = pruneShortPathComponents(nodeF.kept);

  // 节点：保留仍在 kept 边上的；若仅有 properties 且曾挂特性，也保留有特性的孤立？——短路径会删边；
  // 特性挂在仍存活的拥有者上即可。
  const keepIds = new Set<string>();
  iso.kept.forEach((e) => {
    keepIds.add(e.from);
    keepIds.add(e.to);
  });
  // 合并剪枝后节点上的 properties（来自 prop.nodes）
  const propById = new Map(prop.nodes.map((n) => [n.id, n]));
  const outNodes = nodeF.nodes
    .filter((n) => keepIds.has(n.id))
    .map((n) => {
      const fromProp = propById.get(n.id);
      const properties = [
        ...new Set([...(fromProp?.properties || []), ...(n.properties || [])]),
      ].filter(Boolean);
      return { ...n, properties: properties.length ? properties : undefined };
    });

  const removedAll = [...rule.removed, ...nodeF.removed, ...iso.removed];
  const removedMap = new Map<string, PipelineEdge>();
  for (const e of removedAll) {
    if (!isProcessEdgeSource(e.source)) continue;
    const key = `${e.source}\t${spoCore(e)}`;
    if (!removedMap.has(key)) removedMap.set(key, e);
  }

  const stats: LectureKgProcessStats = {
    input_edges: input.length,
    after_dedupe: afterDedupe.length,
    after_synonym: syn.edges.length,
    property_folded: prop.folded,
    multi_rel_collapsed: multi.collapsed,
    rule_removed: rule.removed.filter((e) => e.source === PROCESS_SOURCE_RULE).length,
    node_removed: nodeF.removed.filter((e) => e.source === PROCESS_SOURCE_NODE).length,
    isolated_removed: iso.removed.filter((e) => e.source === PROCESS_SOURCE_ISOLATED)
      .length,
    kept_edges: iso.kept.length,
  };

  return {
    nodes: outNodes,
    edges: [...iso.kept, ...removedMap.values()],
    stats,
  };
}
