import type {
  PipelineEdge,
  PipelineItem,
  PipelineNode,
  PipelinePayload,
  PipelineStage,
} from "@/lib/pipeline/types";
import { applyImportanceFilter } from "@/lib/kg/importanceFilter";
import {
  lookupTextbookEntity,
  type TextbookEntityIndex,
} from "@/lib/kg/textbookEntityIndex";
import { withBase } from "@/lib/withBase";

export type KgGrounding = {
  lecture_id?: string | number;
  ppt_page_index?: number;
  cue_id?: string;
  clip_path?: string;
  ppt_frame_path?: string;
  start_sec?: number;
  end_sec?: number;
  context?: string;
  source_text?: string;
  natural_statement?: string;
  extract_source?: string;
  alignment?: Record<string, number | string>;
  alignment_ok?: boolean;
};

export type KgModalEvidence = {
  texts?: { cue_id?: string; context?: string; source_text?: string; role?: string }[];
  clips?: { cue_id?: string; clip_path?: string; start_sec?: number; end_sec?: number }[];
  images?: { cue_id?: string; ppt_frame_path?: string; ppt_page_index?: number }[];
};

export type KgEntity = {
  id?: string;
  name?: string;
  zh?: string;
  description?: string;
  aliases?: string[];
  mention_count?: number;
  modal_evidence?: KgModalEvidence;
  modal_links?: unknown[];
  cue_ids?: string[];
};

export type KgEdge = {
  subject?: string;
  object?: string;
  abstract_relation?: string;
  concrete_relation?: string;
  natural_statement?: string;
  description?: string;
  statement_direction?: string;
  attribute_category?: string;
  grounding?: KgGrounding;
  modal_links?: unknown[];
  cue_ids?: string[];
  provenance?: { lecture_id?: string | number; cue_id?: string }[];
};

export type KgCue = {
  cue_id: string;
  start_sec?: number;
  end_sec?: number;
  clip?: string;
  ppt?: string;
  edgeCount: number;
};

/** data\\segments\\... → /repo-data/segments/...（路径分段编码，兼容中文课程名） */
export function toMediaUrl(raw?: string | null): string | null {
  if (!raw) return null;
  let p = String(raw).replace(/\\/g, "/");
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  if (p.startsWith("/repo-data/")) {
    p = p.slice("/repo-data/".length);
  } else {
    const idx = p.indexOf("/data/");
    if (idx >= 0) p = p.slice(idx + "/data/".length);
    else if (p.startsWith("data/")) p = p.slice("data/".length);
  }
  p = p.replace(/^\/+/, "");
  if (!p) return null;
  const encoded = p
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");
  return withBase(`/repo-data/${encoded}`);
}

export function fmtSec(n?: number) {
  if (n == null || Number.isNaN(n)) return "";
  const s = Math.floor(n);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function zhLabel(name?: string | null) {
  return (name || "").split("/")[0];
}

function edgeSource(e: KgEdge, dataSource: "kg" | "mmkg"): string {
  const raw = (e.grounding?.extract_source || "").trim();
  if (
    raw === "cross_cue" ||
    raw.startsWith("cross_cue") ||
    (raw.includes("讲的第") && raw.includes("段到第") && raw.endsWith("段"))
  ) {
    return "cross_cue";
  }
  if (raw === "textbook" || raw === "lecture_delta" || raw === "kg_completion" || raw === "llm_fallback" || raw === "llm_only") {
    return raw;
  }
  if (raw.includes("textbook")) return "textbook";
  if (raw.includes("delta")) return "lecture_delta";
  if (raw.includes("llm")) return "llm_fallback";
  // 纯文本 KG 无 grounding：按课堂边展示，便于与融合页一致的边色
  if (dataSource === "kg") return "lecture_delta";
  return "lecture_delta";
}

function lectureOfEdge(e: KgEdge): string {
  const lid =
    e.grounding?.lecture_id ??
    e.provenance?.find((p) => p.lecture_id != null)?.lecture_id;
  return lid != null ? String(lid) : "";
}

function cueIdsOfEdge(e: KgEdge): string[] {
  const out = new Set<string>();
  for (const c of e.cue_ids || []) {
    if (c) out.add(String(c));
  }
  if (e.grounding?.cue_id) out.add(String(e.grounding.cue_id));
  for (const p of e.provenance || []) {
    if (p?.cue_id) out.add(String(p.cue_id));
  }
  return [...out];
}

/** 与侧栏「本讲片段」列表一致的展示标签 */
export function formatCueLabel(
  cueId: string | null | undefined,
  cues: { cue_id: string; start_sec?: number }[],
  opts?: { includeId?: boolean }
): string | null {
  const id = String(cueId || "").trim();
  if (!id) return null;
  const idx = cues.findIndex((c) => c.cue_id === id);
  const cue = idx >= 0 ? cues[idx] : null;
  const parts: string[] = [];
  if (idx >= 0) {
    parts.push(`片段 ${idx + 1}`);
    if (cue?.start_sec != null) parts.push(`${Math.round(cue.start_sec)}s`);
  } else {
    parts.push("片段");
  }
  if (opts?.includeId) {
    const short = id.includes("_") ? id.split("_").slice(-2).join("_") : id;
    parts.push(short);
  }
  return parts.join(" · ");
}

export function collectCues(edges: KgEdge[]): KgCue[] {
  const map = new Map<string, KgCue>();
  for (const e of edges) {
    const g = e.grounding || {};
    const ids = cueIdsOfEdge(e);
    if (!ids.length && (g.clip_path || g.ppt_frame_path)) {
      ids.push(g.cue_id || `anon_${map.size}`);
    }
    for (const id of ids) {
      const prev = map.get(id);
      if (prev) {
        prev.edgeCount += 1;
        if (!prev.clip && g.clip_path) prev.clip = toMediaUrl(g.clip_path) || undefined;
        if (!prev.ppt && g.ppt_frame_path) prev.ppt = toMediaUrl(g.ppt_frame_path) || undefined;
        if (prev.start_sec == null && g.start_sec != null) prev.start_sec = g.start_sec;
        if (prev.end_sec == null && g.end_sec != null) prev.end_sec = g.end_sec;
      } else {
        map.set(id, {
          cue_id: id,
          start_sec: g.start_sec,
          end_sec: g.end_sec,
          clip: toMediaUrl(g.clip_path) || undefined,
          ppt: toMediaUrl(g.ppt_frame_path) || undefined,
          edgeCount: 1,
        });
      }
    }
  }
  const lectureOfCue = (cueId: string) => {
    const m = String(cueId).match(/^[a-zA-Z0-9]+_(\d+)_/);
    return m ? Number(m[1]) : 0;
  };
  // 先按讲次、再按时间：避免多讲合并时 start_sec 交叉导致片段交错
  return [...map.values()].sort(
    (a, b) =>
      lectureOfCue(a.cue_id) - lectureOfCue(b.cue_id) ||
      (a.start_sec ?? 0) - (b.start_sec ?? 0) ||
      a.cue_id.localeCompare(b.cue_id)
  );
}

/** 按完整名 / 中文名 / 忽略大小写匹配重要性分 */
export function lookupImportance(
  map: Record<string, number> | null | undefined,
  entityId: string
): number | null {
  if (!map) return null;
  const id = String(entityId || "").trim();
  if (!id) return null;
  if (typeof map[id] === "number" && Number.isFinite(map[id])) return map[id];
  const zh = zhLabel(id);
  if (zh && typeof map[zh] === "number" && Number.isFinite(map[zh])) return map[zh];
  const idLower = id.toLowerCase();
  const zhLower = zh.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (k.toLowerCase() === idLower) return v;
    if (zhLabel(k).toLowerCase() === zhLower) return v;
  }
  return null;
}

/** 与 lookupImportance 同策略匹配贡献拆解 */
export function lookupContributions(
  map: Record<string, Record<string, number>> | null | undefined,
  entityId: string
): Record<string, number> | null {
  if (!map) return null;
  const id = String(entityId || "").trim();
  if (!id) return null;
  const direct = map[id];
  if (direct && typeof direct === "object") return direct;
  const zh = zhLabel(id);
  if (zh && map[zh] && typeof map[zh] === "object") return map[zh];
  const idLower = id.toLowerCase();
  const zhLower = zh.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (!v || typeof v !== "object") continue;
    if (k.toLowerCase() === idLower) return v;
    if (zhLabel(k).toLowerCase() === zhLower) return v;
  }
  return null;
}

function sizeFromImportance(score: number) {
  const s = Math.max(0, Math.min(1, score));
  // 讲次课堂分已是 [0,1]，线性映射半径与观感一致
  return 10 + (36 - 10) * s;
}

export type AdaptKgOptions = {
  courseId?: string;
  lectureId?: string;
  dataSource: "kg" | "mmkg";
  /** 整课模式下按讲次筛边 */
  lectureFilter?: string;
  /** 按片段筛边；空=全讲 */
  cueFilter?: string | null;
  title?: string;
  subtitle?: string;
  /** 教材实体索引：对新实体做最终匹配 */
  textbookIndex?: TextbookEntityIndex | null;
  /** 反馈后重要性（entity_importance_feedback.scores） */
  importanceScores?: Record<string, number> | null;
  /** 教材先验重要性（importance_bundle.global） */
  importanceBase?: Record<string, number> | null;
  /** 实体贡献拆解（prior / mention_time / ...） */
  importanceContributions?: Record<string, Record<string, number>> | null;
  /** 重要性过滤阈值：score < τ 的节点视为被筛 */
  importanceMin?: number | null;
  /** hide=删除被筛节点；reveal=保留并标记 filtered_by_importance */
  importanceFilterMode?: "hide" | "reveal";
};

export type AdaptedKg = {
  payload: PipelinePayload;
  stage: PipelineStage;
  cues: KgCue[];
  edgeIndex: Map<string, KgEdge>;
  entityIndex: Map<string, KgEntity>;
};

export function adaptKgToPipeline(
  entities: KgEntity[],
  edges: KgEdge[],
  opts: AdaptKgOptions
): AdaptedKg {
  const dataSource = opts.dataSource;
  let filtered = edges.filter((e) => e.subject && e.object);
  if (opts.lectureFilter) {
    filtered = filtered.filter((e) => lectureOfEdge(e) === opts.lectureFilter);
  }
  const cues = collectCues(filtered);
  if (opts.cueFilter) {
    filtered = filtered.filter((e) => cueIdsOfEdge(e).includes(opts.cueFilter!));
  }

  const entityIndex = new Map<string, KgEntity>();
  for (const ent of entities) {
    const id = ent.id || ent.name || "";
    if (id) entityIndex.set(id, ent);
  }
  for (const e of filtered) {
    if (e.subject && !entityIndex.has(e.subject)) {
      entityIndex.set(e.subject, { id: e.subject, name: e.subject });
    }
    if (e.object && !entityIndex.has(e.object)) {
      entityIndex.set(e.object, { id: e.object, name: e.object });
    }
  }

  const onTb = new Set<string>();
  const onDelta = new Set<string>();
  const pipeEdges: PipelineEdge[] = [];
  const edgeIndex = new Map<string, KgEdge>();
  let nTb = 0;
  let nDelta = 0;
  let nFb = 0;

  filtered.forEach((e, i) => {
    const src = edgeSource(e, dataSource);
    if (src === "textbook") {
      nTb += 1;
      onTb.add(e.subject!);
      onTb.add(e.object!);
    } else if (src === "llm_fallback" || src === "llm_only") {
      nFb += 1;
      onDelta.add(e.subject!);
      onDelta.add(e.object!);
    } else {
      nDelta += 1;
      onDelta.add(e.subject!);
      onDelta.add(e.object!);
    }
    const id = `kg_e${i}`;
    edgeIndex.set(id, e);
    const rel = e.abstract_relation || "related_with";
    const edgeCueIds = cueIdsOfEdge(e);
    const primaryCue = edgeCueIds[0] || "";
    pipeEdges.push({
      id,
      from: e.subject!,
      to: e.object!,
      label: rel,
      title: e.natural_statement || e.description || rel,
      statement: e.natural_statement || "",
      description: e.description || "",
      context: e.grounding?.context || "",
      source: src,
      relation: rel,
      concrete: e.concrete_relation || "",
      concrete_relation: e.concrete_relation || "",
      statement_direction: e.statement_direction || "",
      attribute_category: e.attribute_category || "",
      cue_id: primaryCue || null,
      cue_ids: edgeCueIds,
      cue_label: formatCueLabel(primaryCue, cues),
      lecture_id: lectureOfEdge(e) || opts.lectureId || null,
    });
  });

  // —— 最终步：课堂「新实体」再与教材母图匹配（别名 / 中英文主名）——
  const tbIndex = opts.textbookIndex || null;
  const remap = new Map<string, string>();
  let nRematched = 0;
  if (tbIndex) {
    const endpoints = new Set<string>();
    for (const e of pipeEdges) {
      endpoints.add(e.from);
      endpoints.add(e.to);
    }
    for (const id of endpoints) {
      // 已在教材边上的端点也规范化到母图全名，避免同义双节点
      const hit = lookupTextbookEntity(id, tbIndex);
      if (hit && hit !== id) {
        remap.set(id, hit);
        nRematched += 1;
      } else if (hit && !onTb.has(id)) {
        // 名称已是教材实体，但仅出现在增量边上 → 记为教材命中
        onTb.add(id);
        nRematched += 1;
      }
    }
    if (remap.size) {
      for (const e of pipeEdges) {
        e.from = remap.get(e.from) || e.from;
        e.to = remap.get(e.to) || e.to;
      }
      for (const [from, to] of remap) {
        onTb.add(to);
        if (onDelta.has(from)) onDelta.add(to);
        const prev = entityIndex.get(from);
        if (prev) {
          const existing = entityIndex.get(to);
          // 链接/归并重写端点：不写入 aliases（别名仅来自 synonym_of）
          entityIndex.set(to, {
            ...(existing || prev),
            id: to,
            name: to,
            zh: existing?.zh || prev.zh || zhLabel(to),
            aliases: existing?.aliases || prev.aliases || [],
          });
        }
      }
    }
  }

  const keep = new Set<string>();
  for (const e of pipeEdges) {
    keep.add(e.from);
    keep.add(e.to);
  }

  const pipeNodes: PipelineNode[] = [];
  let nNew = 0;
  for (const id of keep) {
    const ent = entityIndex.get(id) || { id, name: id };
    const tb =
      onTb.has(id) || (tbIndex != null && lookupTextbookEntity(id, tbIndex) != null);
    const delta = onDelta.has(id);
    let kind = "textbook";
    if (tb) {
      kind = "textbook";
    } else if (delta) {
      kind = "new";
      nNew += 1;
    } else {
      kind = "new";
      nNew += 1;
    }
    const mentions = Number(ent.mention_count) || 0;
    const fb = lookupImportance(opts.importanceScores, id);
    const base = lookupImportance(opts.importanceBase, id);
    const importance = fb;
    const importance_base = base;
    const importance_delta =
      fb != null && base != null ? fb - base : null;
    const contribLookup = opts.importanceContributions || null;
    let importance_contributions: Record<string, number> | null = null;
    if (contribLookup) {
      importance_contributions =
        contribLookup[id] ||
        contribLookup[zhLabel(id)] ||
        null;
    }
    const size =
      fb != null
        ? sizeFromImportance(fb)
        : base != null
          ? sizeFromImportance(base)
          : 14 + Math.min(16, Math.log1p(mentions) * 4);
    const aliasList = (ent.aliases || []).filter((a) => a && a !== id);
    pipeNodes.push({
      id,
      label: zhLabel(ent.zh || ent.name || id).slice(0, 18),
      title: id,
      kind,
      size,
      importance,
      importance_base,
      importance_delta,
      importance_contributions,
      ...(aliasList.length ? { aliases: aliasList } : {}),
    });
  }

  const tau = opts.importanceMin;
  const imp = applyImportanceFilter(pipeNodes, pipeEdges, {
    tau,
    mode: opts.importanceFilterMode || "hide",
  });
  pipeNodes.length = 0;
  pipeNodes.push(...imp.nodes);
  pipeEdges.length = 0;
  pipeEdges.push(...imp.edges);
  const nFilteredOut = imp.filteredCount;

  // 讲次图谱统一用融合阶段图例（绿教材 / 蓝增量），与流水线「融合结果」一致
  const stageId = opts.cueFilter ? `merge__${opts.cueFilter}` : "merge";

  const stage: PipelineStage = {
    id: stageId,
    title:
      opts.lectureId != null
        ? `第 ${opts.lectureId} 讲 · ${dataSource.toUpperCase()}`
        : `整课 · ${dataSource.toUpperCase()}`,
    subtitle: dataSource === "mmkg" ? "教材 + 课堂增量" : "讲次关系图",
    blurb:
      dataSource === "mmkg"
        ? "展示设计对齐流水线「融合结果」：绿=教材边，蓝粗=课堂增量；粉节点=仅课堂实体。新实体会再与教材母图匹配。"
        : "布局对齐融合图谱：蓝边为课堂抽取关系；粉节点为当前图中实体。切换 MMKG 可看教材/增量拆分。",
    focus: "multimodal",
    nodes: pipeNodes,
    edges: pipeEdges,
    stats: {
      textbook: nTb,
      delta: nDelta,
      fallback: nFb,
      total: pipeEdges.length,
      new_nodes: nNew,
      rematched_textbook: nRematched,
      importance_filtered_nodes: nFilteredOut,
      importance_min: tau != null && tau > 0 ? tau : 0,
    },
  };

  const mediaCue = opts.cueFilter
    ? cues.find((c) => c.cue_id === opts.cueFilter)
    : cues[0];

  const item: PipelineItem = {
    cue_id: mediaCue?.cue_id || `lecture_${opts.lectureId || "course"}`,
    lecture_id: opts.lectureId,
    start_sec: mediaCue?.start_sec,
    end_sec: mediaCue?.end_sec,
    media: {
      clip: mediaCue?.clip || "",
      ppt: mediaCue?.ppt || "",
    },
    stages: [stage],
  };

  const payload: PipelinePayload = {
    brand: "TeachKG",
    product: "知识图谱",
    mode: "lecture",
    course_id: opts.courseId || "数理逻辑",
    lecture_id: opts.lectureId,
    title: opts.title || stage.title,
    subtitle: opts.subtitle || stage.subtitle,
    items: [item],
  };

  return { payload, stage, cues, edgeIndex, entityIndex };
}

export function evidenceFromEntity(ent: KgEntity) {
  const ev = ent.modal_evidence || {};
  const clip = ev.clips?.[0];
  const img = ev.images?.[0];
  const text = ev.texts?.[0];
  return {
    clipUrl: toMediaUrl(clip?.clip_path),
    pptUrl: toMediaUrl(img?.ppt_frame_path),
    context: text?.context || "",
    sourceText: text?.source_text || "",
    meta: [
      clip?.cue_id,
      clip && (clip.start_sec != null || clip.end_sec != null)
        ? `${fmtSec(clip.start_sec)}–${fmtSec(clip.end_sec)}`
        : "",
      img?.ppt_page_index != null ? `PPT #${img.ppt_page_index}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function evidenceFromEdge(edge: KgEdge) {
  const g = edge.grounding || {};
  return {
    clipUrl: toMediaUrl(g.clip_path),
    pptUrl: toMediaUrl(g.ppt_frame_path),
    context: g.context || "",
    sourceText: g.source_text || "",
    alignment: g.alignment,
    meta: [
      g.cue_id,
      g.start_sec != null || g.end_sec != null
        ? `${fmtSec(g.start_sec)}–${fmtSec(g.end_sec)}`
        : "",
      g.ppt_page_index != null ? `PPT #${g.ppt_page_index}` : "",
      g.extract_source || "",
      g.alignment_ok === true ? "对齐✓" : g.alignment_ok === false ? "对齐✗" : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
