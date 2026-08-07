/** 教材实体轻量索引：供课堂 KG「新实体」二次匹配。 */

export type TextbookEntityIndex = {
  names: Set<string>;
  byZh: Map<string, string>;
  byEn: Map<string, string>;
};

export type TextbookEntityIndexJson = {
  names: string[];
  byZh: Record<string, string>;
  byEn: Record<string, string>;
};

function zhPart(name: string): string {
  return (name || "").split("/")[0].trim();
}

function enPart(name: string): string {
  const parts = (name || "").split("/");
  return parts.length > 1 ? parts.slice(1).join("/").trim() : "";
}

/** 粗清洗：去空白与常见标点，便于短名对齐。 */
export function cleanEntityKey(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[“”"'\-—–·•.,，。；;：:()（）\[\]【】{}]/g, "");
}

export function indexFromJson(raw: TextbookEntityIndexJson | null | undefined): TextbookEntityIndex | null {
  if (!raw?.names?.length) return null;
  return {
    names: new Set(raw.names.map(String)),
    byZh: new Map(Object.entries(raw.byZh || {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
    byEn: new Map(Object.entries(raw.byEn || {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
  };
}

/**
 * 将课堂实体名匹配到教材规范名；无命中返回 null。
 * 顺序：全名 → 中文主名 → 英文名 → 清洗键。
 */
export function lookupTextbookEntity(
  name: string,
  index: TextbookEntityIndex | null | undefined
): string | null {
  if (!name?.trim() || !index) return null;
  const raw = name.trim();
  if (index.names.has(raw)) return raw;

  const zh = zhPart(raw);
  if (zh) {
    const hit = index.byZh.get(zh.toLowerCase());
    if (hit) return hit;
    const ck = cleanEntityKey(zh);
    if (ck) {
      for (const [k, v] of index.byZh) {
        if (cleanEntityKey(k) === ck) return v;
      }
    }
  }

  const en = enPart(raw).toLowerCase();
  if (en) {
    const hit = index.byEn.get(en);
    if (hit) return hit;
  }

  const fullKey = cleanEntityKey(raw);
  if (fullKey) {
    for (const n of index.names) {
      if (cleanEntityKey(n) === fullKey || cleanEntityKey(zhPart(n)) === fullKey) {
        return n;
      }
    }
  }
  return null;
}
