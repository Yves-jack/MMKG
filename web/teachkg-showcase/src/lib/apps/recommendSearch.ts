import type { RecFeedbackStore } from "@/lib/apps/localDb";
import { normalizedRecRating } from "@/lib/apps/localDb";
import { withBase } from "@/lib/withBase";

export type ExternalRecKind = "web" | "video";

export type ExternalRecItem = {
  kind: ExternalRecKind;
  title: string;
  url: string;
  snippet: string;
  /** 用于相关度比对的正文 / 视频简介 */
  content?: string;
  /** 面向用户的资源说明 */
  description?: string;
  /** 与知识点相关度 0–1 */
  relevance?: number;
  /** 多标签：站点、类型、相关档等 */
  tags?: string[];
  source: string;
  score: number;
  domain: string;
};

export type SearchResponse = {
  query: string;
  knowledgePoint?: string;
  providers: string[];
  notice: string | null;
  items: ExternalRecItem[];
  error?: string;
};

export async function fetchExternalRecs(input: {
  query: string;
  knowledgePoint?: string;
  context?: string;
}): Promise<SearchResponse> {
  const q = input.query.trim();
  if (!q) {
    return { query: "", providers: [], notice: null, items: [] };
  }
  const params = new URLSearchParams({ q });
  if (input.knowledgePoint) params.set("kp", input.knowledgePoint);
  if (input.context) params.set("context", input.context.slice(0, 800));
  const r = await fetch(withBase(`/api/recommend-search?${params}`));
  if (!r.ok) {
    const text = await r.text();
    return {
      query: q,
      providers: [],
      notice: null,
      items: [],
      error: text || `HTTP ${r.status}`,
    };
  }
  return (await r.json()) as SearchResponse;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 用本机 1–5 评分抬升/压低同一 URL、域名、知识点下的分数 */
export function applyFeedbackRerank(
  items: ExternalRecItem[],
  feedback: RecFeedbackStore,
  knowledgePoint: string
): ExternalRecItem[] {
  const urlDelta = new Map<string, number>();
  const domainDelta = new Map<string, number>();
  const kpUrlDelta = new Map<string, number>();

  for (const e of feedback.entries || []) {
    const rating = normalizedRecRating(e);
    if (rating == null) continue;
    // 1→-1 … 3→0 … 5→+1
    const signed = (rating - 3) / 2;
    const d = e.domain || domainOf(e.url);
    urlDelta.set(e.url, (urlDelta.get(e.url) || 0) + signed);
    if (d) domainDelta.set(d, (domainDelta.get(d) || 0) + signed * 0.35);
    if (e.knowledgePoint === knowledgePoint) {
      kpUrlDelta.set(e.url, (kpUrlDelta.get(e.url) || 0) + signed);
    }
  }

  return items
    .map((it) => {
      const d = it.domain || domainOf(it.url);
      const delta =
        (urlDelta.get(it.url) || 0) * 0.22 +
        (domainDelta.get(d) || 0) * 0.08 +
        (kpUrlDelta.get(it.url) || 0) * 0.2;
      return { ...it, score: it.score + delta };
    })
    .sort((a, b) => b.score - a.score);
}

export function ratingForUrl(
  feedback: RecFeedbackStore,
  url: string,
  knowledgePoint: string
): 1 | 2 | 3 | 4 | 5 | null {
  const hit = feedback.entries.find(
    (e) => e.url === url && e.knowledgePoint === knowledgePoint
  );
  return normalizedRecRating(hit);
}

function normalizeRecUrl(url: string): string {
  try {
    const u = new URL(String(url || "").trim());
    u.hash = "";
    let href = u.href;
    if (href.endsWith("/") && u.pathname !== "/") href = href.slice(0, -1);
    return href;
  } catch {
    return String(url || "").trim();
  }
}

/**
 * 合并推荐结果：按 URL 去重；同 URL 保留相关度/分数更高或简介更完整的一条。
 * 新结果优先参与比较，旧结果不会因重新检索被整表丢掉。
 */
export function mergeRecItems(
  existing: ExternalRecItem[],
  incoming: ExternalRecItem[],
  limit = 48
): ExternalRecItem[] {
  const map = new Map<string, ExternalRecItem>();

  const upsert = (it: ExternalRecItem, preferIncoming: boolean) => {
    const key = normalizeRecUrl(it.url);
    if (!key || !it.title) return;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, it);
      return;
    }
    const prevR = Number(prev.relevance) || 0;
    const nextR = Number(it.relevance) || 0;
    const prevS = Number(prev.score) || 0;
    const nextS = Number(it.score) || 0;
    const prevLen = String(prev.description || prev.content || prev.snippet || "")
      .length;
    const nextLen = String(it.description || it.content || it.snippet || "").length;
    const takeNew =
      nextR > prevR ||
      (nextR === prevR && nextS > prevS) ||
      (nextR === prevR && nextS === prevS && nextLen > prevLen) ||
      (preferIncoming && nextR === prevR && nextS === prevS && nextLen >= prevLen);
    if (!takeNew) return;
    map.set(key, {
      ...prev,
      ...it,
      tags: [...new Set([...(prev.tags || []), ...(it.tags || [])])].slice(0, 8),
      score: Math.max(prevS, nextS),
      relevance: Math.max(prevR, nextR),
    });
  };

  for (const it of existing || []) upsert(it, false);
  for (const it of incoming || []) upsert(it, true);

  return [...map.values()]
    .sort(
      (a, b) =>
        (Number(b.score) || 0) - (Number(a.score) || 0) ||
        (Number(b.relevance) || 0) - (Number(a.relevance) || 0)
    )
    .slice(0, limit);
}
