/** 学科方法资产库（定理 / 原理 / 技术） */

export type AssetKind = "theorem" | "principle" | "technique";

export type AssetConceptRole = "about" | "applies_to" | "uses";

export type AssetConceptLink = {
  entity: string;
  role?: AssetConceptRole | string;
};

export type AssetCard = {
  asset_id: string;
  kind: AssetKind | string;
  name: string;
  aliases?: string[];
  summary?: string;
  statement?: string;
  steps?: string[];
  concepts?: AssetConceptLink[];
  grounding?: {
    lecture_id?: string;
    cue_id?: string;
    ppt_page?: number;
  };
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
};

export function assetKindLabel(kind?: string): string {
  return KIND_LABEL[String(kind || "")] || String(kind || "资产");
}

function zhPart(name: string): string {
  return (name || "").split("/")[0].trim();
}

/** 实体全名或中文主名是否与卡片概念链接匹配 */
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
  // 卡片自身名/别名与实体重合（同义合并后）
  const names = [card.name, ...(card.aliases || [])];
  for (const n of names) {
    const full = String(n || "").trim();
    if (!full) continue;
    if (full === id || zhPart(full).toLowerCase() === idZh) return true;
  }
  return false;
}

export function findAssetsForEntity(
  library: AssetsLibrary | null | undefined,
  entityId: string
): AssetCard[] {
  if (!library?.cards?.length || !entityId) return [];
  const id = String(entityId).trim();
  const idZh = zhPart(id);
  const index = library.index_by_entity || {};
  const ids = new Set<string>([
    ...(index[id] || []),
    ...(index[idZh] || []),
  ]);
  // 索引可能不全（仅精确 entity 键）；再扫一遍匹配中文主名
  const out: AssetCard[] = [];
  const seen = new Set<string>();
  for (const card of library.cards) {
    const hit =
      ids.has(card.asset_id) || entityMatchesAsset(id, card);
    if (!hit || seen.has(card.asset_id)) continue;
    seen.add(card.asset_id);
    out.push(card);
  }
  const kindOrder: Record<string, number> = {
    technique: 0,
    principle: 1,
    theorem: 2,
  };
  out.sort(
    (a, b) =>
      (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) ||
      a.asset_id.localeCompare(b.asset_id)
  );
  return out;
}
