/**
 * 资源层资产库。
 *
 * 对齐流水线：图上只保留抽象关系；property_of 已折进实体详情。
 * 公式 / 例子 / 定理·原理·方法 都是资源卡，通过 concepts / edges 挂回抽象层，
 * grounding.start_sec 指向完整课时间轴。
 */

export type AssetKind =
  | "theorem"
  | "principle"
  | "technique"
  | "formula"
  | "example";

export type AssetConceptRole =
  | "about"
  | "applies_to"
  | "uses"
  | "illustrates"
  | "instance_of"
  | "notation_of"
  | "proves";

export type AssetConceptLink = {
  entity: string;
  role?: AssetConceptRole | string;
};

export type AssetEdgeLink = {
  subject: string;
  predicate: string;
  object: string;
  role?: AssetConceptRole | string;
};

export type AssetGrounding = {
  lecture_id?: string;
  cue_id?: string;
  ppt_page?: number;
  start_sec?: number | null;
  end_sec?: number | null;
};

export type AssetCard = {
  asset_id: string;
  kind: AssetKind | string;
  name: string;
  aliases?: string[];
  summary?: string;
  statement?: string;
  steps?: string[];
  latex?: string;
  /** 原文依据（课堂连续子串），用于重叠关联 */
  evidence?: string;
  concepts?: AssetConceptLink[];
  edges?: AssetEdgeLink[];
  grounding?: AssetGrounding;
  source?: string;
  /** 嵌入分章结果（可多章，带权重） */
  chapters?: Array<string | { name?: string; weight?: number; role?: string }>;
  links?: {
    demos?: string[];
    anims?: string[];
    problems?: string[];
  };
};

export type AssetsChapterRef = {
  name: string;
  number?: number | null;
  sections?: string[];
  part_id?: string;
  part_title?: string;
};

export type AssetsChapterPart = {
  id: string;
  title: string;
  source?: string;
  chapters?: AssetsChapterRef[];
};

export type AssetsChapterCatalog = {
  course_id?: string;
  n_parts?: number;
  n_chapters?: number;
  parts?: AssetsChapterPart[];
  chapter_order?: string[];
  chapter_to_part?: Record<string, string>;
};

export type AssetsLibrary = {
  course_id?: string;
  card_count?: number;
  cards?: AssetCard[];
  index_by_entity?: Record<string, string[]>;
  index_by_chapter?: Record<string, string[]>;
  /** 教材 toc 提取的分主题章节目录（含重复章号区分） */
  chapter_catalog?: AssetsChapterCatalog;
};

/** 卡片所属章节名（去重保序） */
export function assetChapterNames(card: Pick<AssetCard, "chapters">): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ch of card.chapters || []) {
    const name = (typeof ch === "string" ? ch : ch?.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 按目录分册顺序排列章节名；无目录时退回章号排序 */
export function sortChaptersForDisplay(
  names: string[],
  catalog?: AssetsChapterCatalog | null
): string[] {
  const order = catalog?.chapter_order || [];
  const idx = new Map(order.map((n, i) => [n, i]));
  const num = (s: string) => {
    const m = String(s).match(/第\s*(\d+)\s*章/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  return [...names].sort((a, b) => {
    const ia = idx.has(a) ? idx.get(a)! : 10_000;
    const ib = idx.has(b) ? idx.get(b)! : 10_000;
    if (ia !== ib) return ia - ib;
    return num(a) - num(b) || a.localeCompare(b, "zh");
  });
}

/** 将章节按主题分册分组（用于侧栏） */
export function groupChaptersByPart(
  names: string[],
  catalog?: AssetsChapterCatalog | null
): Array<{ id: string; title: string; chapters: string[] }> {
  const sorted = sortChaptersForDisplay(names, catalog);
  const parts = catalog?.parts || [];
  if (!parts.length) {
    return [{ id: "all", title: "全部章节", chapters: sorted }];
  }
  const nameSet = new Set(sorted);
  const groups: Array<{ id: string; title: string; chapters: string[] }> = [];
  const used = new Set<string>();
  for (const part of parts) {
    const list: string[] = [];
    for (const ch of part.chapters || []) {
      const n = String(ch.name || "").trim();
      if (n && nameSet.has(n) && !used.has(n)) {
        list.push(n);
        used.add(n);
      }
    }
    // 也收录 index 里属于该 part 但 toc 未列的
    const pid = String(part.id || "");
    for (const n of sorted) {
      if (used.has(n)) continue;
      if ((catalog?.chapter_to_part || {})[n] === pid) {
        list.push(n);
        used.add(n);
      }
    }
    if (list.length) {
      groups.push({
        id: pid || part.title || "part",
        title: part.title || pid || "分册",
        chapters: list,
      });
    }
  }
  const rest = sorted.filter((n) => !used.has(n));
  if (rest.length) {
    groups.push({ id: "other", title: "其他", chapters: rest });
  }
  return groups;
}

const KIND_LABEL: Record<string, string> = {
  theorem: "定理",
  principle: "原理",
  technique: "方法",
  formula: "公式",
  example: "例子",
};

const ROLE_LABEL: Record<string, string> = {
  about: "关于",
  applies_to: "作用于",
  uses: "用到",
  illustrates: "举例说明",
  instance_of: "实例",
  notation_of: "记号",
  proves: "证明",
};

export function assetKindLabel(kind?: string): string {
  return KIND_LABEL[String(kind || "")] || String(kind || "资产");
}

/** 图谱/导图「相关资源」展示类型（暂不含原理：抽取质量不稳） */
export const RELATED_ASSET_KINDS = [
  "formula",
  "example",
  "theorem",
  "technique",
] as const;

export function assetRoleLabel(role?: string): string {
  const r = String(role || "about");
  return ROLE_LABEL[r] || r;
}

function zhPart(name: string): string {
  return (name || "").split("/")[0].trim();
}

/** 实体键规范化：全名小写 + 中文主名小写，便于跨图谱/导图匹配 */
export function normalizeEntityKeys(raw: string): string[] {
  const id = String(raw || "").trim();
  if (!id) return [];
  const zh = zhPart(id);
  const out = new Set<string>();
  out.add(id);
  out.add(id.toLowerCase());
  if (zh) {
    out.add(zh);
    out.add(zh.toLowerCase());
  }
  return [...out];
}

/** 从 cards 重建 index_by_entity / index_by_chapter（静态 JSON 常缺索引） */
export function ensureAssetsLibraryIndexes(
  library: AssetsLibrary | null | undefined
): AssetsLibrary | null {
  if (!library || !Array.isArray(library.cards)) return library ?? null;
  const byEntity: Record<string, string[]> = {};
  const byChapter: Record<string, string[]> = {};
  const addEnt = (key: string, aid: string) => {
    for (const k of normalizeEntityKeys(key)) {
      (byEntity[k] ||= []).push(aid);
    }
  };
  for (const card of library.cards) {
    const aid = String(card?.asset_id || "").trim();
    if (!aid) continue;
    for (const link of card.concepts || []) addEnt(String(link?.entity || ""), aid);
    for (const edge of card.edges || []) {
      addEnt(String(edge?.subject || ""), aid);
      addEnt(String(edge?.object || ""), aid);
    }
    for (const name of assetChapterNames(card)) {
      (byChapter[name] ||= []).push(aid);
    }
  }
  const uniq = (m: Record<string, string[]>) =>
    Object.fromEntries(
      Object.keys(m)
        .sort()
        .map((k) => [k, [...new Set(m[k])].sort()])
    );
  return {
    ...library,
    card_count: library.cards.length,
    index_by_entity: uniq(byEntity),
    index_by_chapter: uniq(byChapter),
  };
}

const CUE_MS_SPAN = /_(\d+)_(\d+)$/;

/** ``课程_讲次_889100_980600`` → 秒 */
export function parseCueIdTimes(
  cueId?: string | null
): { start_sec: number; end_sec: number } | null {
  const m = String(cueId || "").match(CUE_MS_SPAN);
  if (!m) return null;
  return { start_sec: Number(m[1]) / 1000, end_sec: Number(m[2]) / 1000 };
}

export function resolveAssetGrounding(card: AssetCard): AssetGrounding {
  const g = { ...(card.grounding || {}) };
  if (g.start_sec == null && g.cue_id) {
    const span = parseCueIdTimes(g.cue_id);
    if (span) {
      g.start_sec = span.start_sec;
      g.end_sec = span.end_sec;
    }
  }
  return g;
}

/** 复习页跳转：完整课 + 秒；优先挂第一个概念实体 */
export function assetReviewSeek(
  card: AssetCard,
  fallbackLectureId?: string | null
): { lectureId: string; startSec: number; entityId?: string } | null {
  const g = resolveAssetGrounding(card);
  const lectureId = String(g.lecture_id || fallbackLectureId || "").trim();
  const startSec = Number(g.start_sec);
  if (!lectureId || !Number.isFinite(startSec)) return null;
  const entityId = card.concepts?.[0]?.entity;
  return { lectureId, startSec, entityId };
}

/** 实体全名或中文主名是否与卡片概念/边端点匹配 */
export function entityMatchesAsset(
  entityId: string,
  card: AssetCard,
  options?: { includeCardNames?: boolean }
): boolean {
  const id = String(entityId || "").trim();
  if (!id) return false;
  const keys = new Set(normalizeEntityKeys(id));
  const hit = (raw?: string | null) => {
    const t = String(raw || "").trim();
    if (!t) return false;
    return normalizeEntityKeys(t).some((k) => keys.has(k));
  };
  for (const link of card.concepts || []) {
    if (hit(link.entity)) return true;
  }
  for (const edge of card.edges || []) {
    if (hit(edge.subject) || hit(edge.object)) return true;
  }
  if (options?.includeCardNames !== false) {
    for (const n of [card.name, ...(card.aliases || [])]) {
      if (hit(n)) return true;
    }
  }
  return false;
}

export type FindAssetsOptions = {
  /** 讲次页：优先展示该讲课堂抽取；可隐藏无讲次锚点的课程级精选 */
  lectureId?: string | null;
  /** 为 true 时仅保留本讲大模型抽取（source=llm 且 grounding.lecture_id 匹配） */
  lectureOnly?: boolean;
  /** 原理仅展示大模型抽取（默认 true） */
  llmPrinciplesOnly?: boolean;
  kinds?: Array<AssetKind | string> | null;
  /**
   * full：索引 + 概念/边/卡名（图谱默认）。
   * concept：索引 + 概念/边挂载，不含卡名乱撞（导图叶节点）。
   * strict：仅索引精确键（导图 topic）。
   */
  matchMode?: "full" | "concept" | "strict";
};

/** 导图节点 → 资源匹配：章节无；topic 严格；叶/实体用 concept（尽量但不乱） */
export type MindmapAssetPolicy = "none" | "strict" | "leaf";

export function mindmapNodeAssetPolicy(nodeId: string): MindmapAssetPolicy {
  const id = String(nodeId || "").trim();
  if (
    id.startsWith("__course__/") ||
    id.startsWith("__part__/") ||
    id.startsWith("__chapter__/") ||
    id.startsWith("__lecture__/") ||
    id.startsWith("chapter:") ||
    id.startsWith("part:")
  ) {
    return "none";
  }
  if (
    id.startsWith("__section__/") ||
    id.startsWith("__topic__/") ||
    id.startsWith("__salvage__/")
  ) {
    return "strict";
  }
  return "leaf";
}

function sourceRank(card: AssetCard): number {
  if (card.source === "llm" || (card.evidence || "").trim()) return 0;
  if (card.source === "curated") return 2;
  return 1;
}

function lectureNum(card: AssetCard): number {
  const n = Number(card.grounding?.lecture_id);
  return Number.isFinite(n) ? n : 1e9;
}

function assetStartSec(card: AssetCard): number {
  const g = resolveAssetGrounding(card);
  const s = g.start_sec;
  if (s != null && Number.isFinite(Number(s))) return Number(s);
  return Number.POSITIVE_INFINITY;
}

/** 按课堂原文出现顺序：讲次 → 时间轴秒数。无时间的排在该讲末尾。 */
export function compareAssetsByAppearance(a: AssetCard, b: AssetCard): number {
  return (
    lectureNum(a) - lectureNum(b) ||
    assetStartSec(a) - assetStartSec(b) ||
    String(a.asset_id || "").localeCompare(String(b.asset_id || ""))
  );
}

export function findAssetsForEntity(
  library: AssetsLibrary | null | undefined,
  entityId: string,
  options?: FindAssetsOptions
): AssetCard[] {
  if (!library?.cards?.length || !entityId) return [];
  const id = String(entityId).trim();
  const idZh = zhPart(id);
  const index = library.index_by_entity || {};
  const ids = new Set<string>();
  for (const key of normalizeEntityKeys(id)) {
    for (const aid of index[key] || []) ids.add(aid);
  }
  const lectureId =
    options?.lectureId != null && String(options.lectureId) !== ""
      ? String(options.lectureId)
      : null;
  const lectureOnly = Boolean(options?.lectureOnly && lectureId);
  const llmPrinciplesOnly = options?.llmPrinciplesOnly !== false;
  const mode = options?.matchMode || "full";
  const kindAllow = options?.kinds?.length
    ? new Set(options.kinds.map(String))
    : null;

  const out: AssetCard[] = [];
  const seen = new Set<string>();
  for (const card of library.cards) {
    if (kindAllow && !kindAllow.has(String(card.kind))) continue;
    let hit = ids.has(card.asset_id);
    if (!hit && mode === "full") {
      hit = entityMatchesAsset(id, card, { includeCardNames: true });
    } else if (!hit && mode === "concept") {
      hit = entityMatchesAsset(id, card, { includeCardNames: false });
    }
    // strict：仅索引键
    if (!hit || seen.has(card.asset_id)) continue;
    if (llmPrinciplesOnly && card.kind === "principle" && card.source !== "llm") {
      continue;
    }
    const gLec = card.grounding?.lecture_id;
    // 仅 lectureOnly 时硬过滤讲次；否则保留全部，排序时本讲优先
    if (lectureOnly) {
      if (card.source !== "llm") continue;
      if (String(gLec || "") !== lectureId) continue;
    }
    seen.add(card.asset_id);
    out.push(card);
  }
  const lecturePrefer = (card: AssetCard) =>
    lectureId && String(card.grounding?.lecture_id || "") === lectureId ? 0 : 1;
  out.sort(
    (a, b) =>
      lecturePrefer(a) - lecturePrefer(b) ||
      sourceRank(a) - sourceRank(b) ||
      compareAssetsByAppearance(a, b)
  );
  return out;
}

function cardEntityKeys(card: AssetCard): Set<string> {
  const keys = new Set<string>();
  const add = (raw?: string | null) => {
    for (const k of normalizeEntityKeys(String(raw || ""))) keys.add(k);
  };
  for (const link of card.concepts || []) add(link.entity);
  for (const edge of card.edges || []) {
    add(edge.subject);
    add(edge.object);
  }
  return keys;
}

/** 与当前资源卡共享概念的其它卡（例子↔原理/定理/方法/公式） */
export function findPeerAssets(
  library: AssetsLibrary | null | undefined,
  card: AssetCard | null | undefined,
  options?: FindAssetsOptions & { maxItems?: number }
): AssetCard[] {
  if (!library?.cards?.length || !card) return [];
  const selfKeys = cardEntityKeys(card);
  if (!selfKeys.size) return [];
  const lectureId =
    options?.lectureId != null && String(options.lectureId) !== ""
      ? String(options.lectureId)
      : null;
  const lectureOnly = Boolean(options?.lectureOnly && lectureId);
  const llmPrinciplesOnly = options?.llmPrinciplesOnly !== false;
  const kindAllow = options?.kinds?.length
    ? new Set(options.kinds.map(String))
    : null;
  const maxItems = options?.maxItems ?? 8;

  type Hit = { peer: AssetCard; shared: number; diffKind: boolean };
  const hits: Hit[] = [];
  for (const other of library.cards) {
    if (other.asset_id === card.asset_id) continue;
    if (kindAllow && !kindAllow.has(String(other.kind))) continue;
    if (llmPrinciplesOnly && other.kind === "principle" && other.source !== "llm") {
      continue;
    }
    const gLec = other.grounding?.lecture_id;
    if (lectureOnly) {
      if (other.source !== "llm") continue;
      if (String(gLec || "") !== lectureId) continue;
    }
    const otherKeys = cardEntityKeys(other);
    let shared = 0;
    for (const k of selfKeys) if (otherKeys.has(k)) shared += 1;
    if (!shared) continue;
    hits.push({
      peer: other,
      shared,
      diffKind: String(other.kind) !== String(card.kind),
    });
  }
  const lecturePrefer = (peer: AssetCard) =>
    lectureId && String(peer.grounding?.lecture_id || "") === lectureId ? 0 : 1;
  hits.sort(
    (a, b) =>
      lecturePrefer(a.peer) - lecturePrefer(b.peer) ||
      Number(b.diffKind) - Number(a.diffKind) ||
      b.shared - a.shared ||
      sourceRank(a.peer) - sourceRank(b.peer) ||
      a.peer.asset_id.localeCompare(b.peer.asset_id)
  );
  return hits.slice(0, maxItems).map((h) => h.peer);
}

/** 某实体关联资源里最早的课堂秒数（图谱/导图侧栏用） */
export function firstAssetWatch(
  library: AssetsLibrary | null | undefined,
  entityId: string,
  options?: FindAssetsOptions
): { lectureId: string; startSec: number; entityId?: string } | null {
  const cards = findAssetsForEntity(library, entityId, options);
  let best: { lectureId: string; startSec: number; entityId?: string } | null = null;
  for (const card of cards) {
    const hit = assetReviewSeek(card, options?.lectureId);
    if (!hit) continue;
    if (!best || hit.startSec < best.startSec) best = hit;
  }
  return best;
}
