import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";

/** 与后端 default_channel_weights_light 对齐（先恢复 log1p 合成，便于对照问题） */
const MENTION_BETA = 0.75;
const STRUCTURE_BETA = 0.25;
/** 与后端 RELATED_WITH_STRUCTURE_WEIGHT 对齐 */
const RELATED_WITH_STRUCTURE_WEIGHT = 0.5;

function zh(name: string): string {
  return String(name || "").split("/")[0]?.trim() || String(name || "");
}

function relOf(e: PipelineEdge): string {
  return String(e.relation || e.label || "")
    .trim()
    .toLowerCase();
}

function structureEdgeWeight(e: PipelineEdge): number {
  return relOf(e) === "related_with" ? RELATED_WITH_STRUCTURE_WEIGHT : 1;
}

function sizeFromImportance(score: number) {
  // 未归一的 log 合成分可能 >1；用 1-e^(-x) 压到 (0,1) 只影响点大小
  const s = Math.max(0, 1 - Math.exp(-Math.max(0, score)));
  return 10 + (36 - 10) * s;
}

/**
 * (匹配串, 规范实体 id)，按匹配串长度降序，便于最长匹配。
 * 同义合并后的 aliases 也写入词表，命中别名会计入 canonical。
 */
function buildMentionVocab(
  nodes: Array<Pick<PipelineNode, "id" | "aliases">>
): Array<[string, string]> {
  const best = new Map<string, string>();
  const add = (rawSurface: string, eid: string) => {
    const surface = zh(rawSurface);
    if (surface.length < 2) return;
    const prev = best.get(surface);
    if (prev == null) {
      best.set(surface, eid);
      return;
    }
    if (prev === eid) return;
    // 同表面冲突：优先保留更完整的 id；否则保持先写入（通常已是 canonical）
    if (eid.includes("/") && !prev.includes("/")) best.set(surface, eid);
    else if (eid.length > prev.length && !prev.includes("/")) best.set(surface, eid);
  };
  for (const n of nodes) {
    const eid = String(n?.id || "").trim();
    if (!eid) continue;
    add(eid, eid);
    for (const a of n.aliases || []) {
      const alias = String(a || "").trim();
      if (!alias) continue;
      add(alias, eid);
    }
  }
  return [...best.entries()].sort(
    (a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0])
  );
}

/** 与后端 longest_match_mentions 对齐：文本上贪心最长匹配（按首字分桶，整课长文本更快） */
function longestMatchMentions(
  text: string,
  vocab: Array<[string, string]>
): string[] {
  if (!text || !vocab.length) return [];
  const byFirst = new Map<string, Array<[string, string]>>();
  for (const entry of vocab) {
    const ch = entry[0][0] || "";
    let bucket = byFirst.get(ch);
    if (!bucket) {
      bucket = [];
      byFirst.set(ch, bucket);
    }
    bucket.push(entry);
  }
  for (const bucket of byFirst.values()) {
    bucket.sort(
      (a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0])
    );
  }
  const hits: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let matched = false;
    const candidates = byFirst.get(text[i]) || [];
    for (const [surface, eid] of candidates) {
      const L = surface.length;
      if (L <= 0 || i + L > n) continue;
      if (text.slice(i, i + L) === surface) {
        hits.push(eid);
        i += L;
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  return hits;
}

function collectStructureDegree(edges: PipelineEdge[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const e of edges) {
    const w = structureEdgeWeight(e);
    if (w <= 0) continue;
    for (const id of [String(e.from || ""), String(e.to || "")]) {
      if (!id) continue;
      degree.set(id, (degree.get(id) || 0) + w);
    }
  }
  return degree;
}

function indexByZh(src: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of src) {
    const z = zh(k);
    if (!z) continue;
    out.set(z, (out.get(z) || 0) + v);
  }
  return out;
}

/**
 * 轻量课堂分（片段 / 讲次 / 课次处理后图）：
 * - 提及次数：对 extract_text 做最长匹配；aliases 命中计入 canonical（同义相加）
 * - 可传 string[]：按块匹配再累加（整课避免拼超长串、利于局部性）
 * - 结构支撑：对传入边集求加权度（related_with 半权）——应传处理后保留边
 * score = 0.75·log1p(m) + 0.25·log1p(s)（未做 minmax 归一；点大小另用 1-e^(-I)）
 */
export function scoreFragmentClassroomImportance(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  extractText?: string | string[] | null
): PipelineNode[] {
  if (!nodes.length) return nodes;
  const structure = collectStructureDegree(edges);
  const chunks = Array.isArray(extractText)
    ? extractText.map((t) => String(t || "").trim()).filter(Boolean)
    : [String(extractText || "").trim()].filter(Boolean);
  const vocab = buildMentionVocab(nodes);
  const mention = new Map<string, number>();
  if (chunks.length && vocab.length) {
    for (const text of chunks) {
      for (const eid of longestMatchMentions(text, vocab)) {
        mention.set(eid, (mention.get(eid) || 0) + 1);
      }
    }
  }
  const mentionByZh = indexByZh(mention);
  const structureByZh = indexByZh(structure);

  return nodes.map((n) => {
    const id = String(n.id || "");
    const z = zh(id);
    const mCount = mention.get(id) ?? mentionByZh.get(z) ?? 0;
    const sCount = structure.get(id) ?? structureByZh.get(z) ?? 0;
    const mPart = MENTION_BETA * Math.log1p(Math.max(0, mCount));
    const sPart = STRUCTURE_BETA * Math.log1p(Math.max(0, sCount));
    const score = mPart + sPart;
    const hasSignal = mCount > 0 || sCount > 0;
    const sRounded =
      Math.abs(sCount - Math.round(sCount)) < 1e-9
        ? Math.round(sCount)
        : Math.round(sCount * 10) / 10;

    return {
      ...n,
      importance: hasSignal ? score : null,
      importance_base: null,
      importance_delta: null,
      importance_factor_counts: {
        mention_time: Math.round(mCount),
        structure_graph: sRounded,
      },
      importance_contributions: hasSignal
        ? {
            mention_time: mPart,
            structure_graph: sPart,
          }
        : null,
      size: hasSignal ? sizeFromImportance(score) : n.size,
    };
  });
}

/** @deprecated 使用 scoreFragmentClassroomImportance */
export function attachClassroomFactorsFromStage(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  extractText?: string | null
): PipelineNode[] {
  return scoreFragmentClassroomImportance(nodes, edges, extractText);
}
