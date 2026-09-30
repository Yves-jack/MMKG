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
  links?: {
    demos?: string[];
    anims?: string[];
    problems?: string[];
  };
};

export type AssetsLibrary = {
  course_id?: string;
  card_count?: number;
  cards?: AssetCard[];
  index_by_entity?: Record<string, string[]>;
};

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

export function assetRoleLabel(role?: string): string {
  const r = String(role || "about");
  return ROLE_LABEL[r] || r;
}

function zhPart(name: string): string {
  return (name || "").split("/")[0].trim();
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
export function entityMatchesAsset(entityId: string, card: AssetCard): boolean {
  const id = String(entityId || "").trim();
  if (!id) return false;
  const idZh = zhPart(id).toLowerCase();
  const keys = new Set<string>();
  keys.add(id);
  keys.add(idZh);
  for (const link of card.concepts || []) {
    const e = String(link.entity || "").trim();
    if (!e) continue;
    if (keys.has(e) || keys.has(zhPart(e).toLowerCase())) return true;
  }
  for (const edge of card.edges || []) {
    for (const e of [edge.subject, edge.object]) {
      const t = String(e || "").trim();
      if (!t) continue;
      if (keys.has(t) || keys.has(zhPart(t).toLowerCase())) return true;
    }
  }
  const names = [card.name, ...(card.aliases || [])];
  for (const n of names) {
    const full = String(n || "").trim();
    if (!full) continue;
    if (full === id || zhPart(full).toLowerCase() === idZh) return true;
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
};

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
  const ids = new Set<string>([
    ...(index[id] || []),
    ...(index[idZh] || []),
  ]);
  const lectureId =
    options?.lectureId != null && String(options.lectureId) !== ""
      ? String(options.lectureId)
      : null;
  const lectureOnly = Boolean(options?.lectureOnly && lectureId);
  const llmPrinciplesOnly = options?.llmPrinciplesOnly !== false;
  const kindAllow = options?.kinds?.length
    ? new Set(options.kinds.map(String))
    : null;

  const out: AssetCard[] = [];
  const seen = new Set<string>();
  for (const card of library.cards) {
    if (kindAllow && !kindAllow.has(String(card.kind))) continue;
    const hit =
      ids.has(card.asset_id) || entityMatchesAsset(id, card);
    if (!hit || seen.has(card.asset_id)) continue;
    if (llmPrinciplesOnly && card.kind === "principle" && card.source !== "llm") {
      continue;
    }
    const gLec = card.grounding?.lecture_id;
    if (lectureOnly) {
      if (card.source !== "llm") continue;
      if (String(gLec || "") !== lectureId) continue;
    } else if (lectureId && gLec != null && String(gLec) !== "" && String(gLec) !== lectureId) {
      continue;
    }
    seen.add(card.asset_id);
    out.push(card);
  }
  out.sort(
    (a, b) =>
      sourceRank(a) - sourceRank(b) || compareAssetsByAppearance(a, b)
  );
  return out;
}

function cardEntityKeys(card: AssetCard): Set<string> {
  const keys = new Set<string>();
  const add = (raw?: string | null) => {
    const t = String(raw || "").trim();
    if (!t) return;
    keys.add(t);
    keys.add(zhPart(t).toLowerCase());
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
    } else if (lectureId && gLec != null && String(gLec) !== "" && String(gLec) !== lectureId) {
      continue;
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
  hits.sort(
    (a, b) =>
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
