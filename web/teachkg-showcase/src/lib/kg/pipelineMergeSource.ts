import type {
  PipelineEdge,
  PipelineNode,
  PipelinePayload,
  PipelineStage,
} from "@/lib/pipeline/types";
import { lookupImportance } from "@/lib/kg/adaptToPipeline";

export type PipelineCueBundle = {
  cueId: string;
  lectureId: string;
  startSec?: number;
  endSec?: number;
  text: string;
  clip?: string;
  ppt?: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /** 跨段边：仅讲次/课堂级并入，段级视图不展示 */
  crossCueEdges?: PipelineEdge[];
  edgeCount: number;
};

export type MmkgEntityEnrichment = {
  description?: string;
};

function formatText(raw: string): string {
  return (raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/<---\s*Page Split\s*--->/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function spoKey(e: PipelineEdge): string {
  return `${e.from || ""}\t${e.relation || e.label || ""}\t${e.to || ""}\t${e.source || ""}`;
}

/** 识别跨段边 source（含 legacy「第N讲的第a段到第b段」） */
export function isCrossCueEdgeSource(source?: string | null): boolean {
  const s = (source || "").trim();
  if (!s) return false;
  if (s === "cross_cue" || s.startsWith("cross_cue")) return true;
  return s.includes("讲的第") && s.includes("段到第") && s.endsWith("段");
}

/** 讲次/课堂级：把各片段的 cross_cue_edges 并入并集图 */
export function attachCrossCueEdges(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  bundles: PipelineCueBundle[]
): { nodes: PipelineNode[]; edges: PipelineEdge[] } {
  const nodeMap = new Map<string, PipelineNode>();
  for (const n of nodes) {
    if (n?.id) nodeMap.set(n.id, { ...n });
  }
  const edgeMap = new Map<string, PipelineEdge>();
  for (const e of edges) {
    if (!e?.from || !e?.to) continue;
    edgeMap.set(spoKey(e), { ...e });
  }
  for (const b of bundles) {
    for (const raw of b.crossCueEdges || []) {
      if (!raw?.from || !raw?.to) continue;
      const e: PipelineEdge = {
        ...raw,
        id: raw.id || `${b.cueId}::cross::${raw.from}->${raw.to}`,
        source: "cross_cue",
        lecture_id: raw.lecture_id || b.lectureId,
        cue_id: raw.cue_id || b.cueId,
        cue_ids: raw.cue_ids?.length ? raw.cue_ids : b.cueId ? [b.cueId] : [],
        cue_label: raw.cue_label || undefined,
      };
      const key = spoKey(e);
      if (!edgeMap.has(key)) edgeMap.set(key, e);
      for (const id of [e.from, e.to]) {
        if (!id || nodeMap.has(id)) continue;
        nodeMap.set(id, {
          id,
          label: id.split("/")[0],
          kind: "delta",
          title: `${id}\n来源: 跨段衔接`,
        });
      }
    }
  }
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

function stageMergeOf(item: {
  extract_text?: string;
  stages?: { id?: string; text?: string; nodes?: PipelineNode[]; edges?: PipelineEdge[] }[];
}): { text: string; nodes: PipelineNode[]; edges: PipelineEdge[] } | null {
  const merge = (item.stages || []).find((s) => s.id === "merge");
  if (!merge) return null;
  return {
    text: formatText((merge.text || item.extract_text || "").trim()),
    nodes: [...(merge.nodes || [])],
    edges: [...(merge.edges || [])],
  };
}

function toMediaUrl(raw?: string | null): string {
  if (!raw) return "";
  let p = String(raw).replace(/\\/g, "/");
  if (p.startsWith("/repo-data/") || p.startsWith("http")) return p;
  if (p.startsWith("../../")) p = p.slice("../../".length);
  if (p.startsWith("../")) p = p.replace(/^(\.\.\/)+/, "");
  if (p.startsWith("segments/") || p.startsWith("processed/") || p.startsWith("kg/")) {
    return `/repo-data/${p}`;
  }
  return p;
}

function sizeFromImportance(score: number) {
  const s = Math.max(0, Math.min(1, score));
  return 10 + (36 - 10) * Math.sqrt(s);
}

/** 合并多片段融合图：节点按 id 并集，边按 SPO+source 去重 */
export function unionMergeGraphs(
  bundles: PipelineCueBundle[]
): { nodes: PipelineNode[]; edges: PipelineEdge[] } {
  const nodeMap = new Map<string, PipelineNode>();
  const edgeMap = new Map<string, PipelineEdge>();
  for (const b of bundles) {
    for (const n of b.nodes) {
      if (!n?.id) continue;
      if (!nodeMap.has(n.id)) nodeMap.set(n.id, { ...n });
    }
    for (const e of b.edges) {
      if (!e?.from || !e?.to) continue;
      const key = spoKey(e);
      if (edgeMap.has(key)) {
        const prev = edgeMap.get(key)!;
        const cueIds = new Set<string>([
          ...(prev.cue_ids || []),
          ...(e.cue_ids || []),
          b.cueId,
        ].filter(Boolean));
        const lecs = new Set<string>();
        for (const raw of [prev.lecture_id, e.lecture_id, b.lectureId]) {
          String(raw || "")
            .split(/[+]/)
            .map((x) => x.trim())
            .filter(Boolean)
            .forEach((x) => lecs.add(x));
        }
        edgeMap.set(key, {
          ...prev,
          cue_ids: [...cueIds],
          cue_id: prev.cue_id || e.cue_id || b.cueId,
          lecture_id:
            lecs.size > 1
              ? [...lecs].sort((x, y) => Number(x) - Number(y)).join("+")
              : [...lecs][0] || prev.lecture_id || e.lecture_id,
          context: prev.context || e.context,
          description: prev.description || e.description,
          cue_label:
            prev.cue_label && e.cue_label && prev.cue_label !== e.cue_label
              ? `${prev.cue_label}；${e.cue_label}`
              : prev.cue_label || e.cue_label,
        });
        continue;
      }
      edgeMap.set(key, {
        ...e,
        lecture_id: e.lecture_id || b.lectureId || null,
        cue_id: e.cue_id || b.cueId,
        cue_ids: e.cue_ids?.length ? e.cue_ids : b.cueId ? [b.cueId] : [],
      });
    }
  }
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

/**
 * 一堂课总图：两讲流水线 merge 并集（与单讲/片段对齐），
 * 不用 triplets.jsonl 的 session_merge（会混入未进融合步的边）。
 */
export function fuseSessionFromPipelineCues(
  cues: PipelineCueBundle[],
  pair: [string, string]
): { nodes: PipelineNode[]; edges: PipelineEdge[] } {
  const union = unionMergeGraphs(cues);
  const [a, b] = pair;
  type Acc = {
    edge: PipelineEdge;
    lecs: Set<string>;
    cueIds: Set<string>;
    labels: string[];
  };
  const bySpo = new Map<string, Acc>();
  for (const e of union.edges) {
    const key = spoCore(e);
    let acc = bySpo.get(key);
    if (!acc) {
      acc = { edge: { ...e }, lecs: new Set(), cueIds: new Set(), labels: [] };
      bySpo.set(key, acc);
    } else {
      const prevSrc = acc.edge.source || "";
      const nextSrc = e.source || "";
      if (prevSrc === "textbook" && nextSrc && nextSrc !== "textbook") {
        acc.edge = {
          ...acc.edge,
          ...e,
          source: nextSrc,
          context: e.context || acc.edge.context,
          description: e.description || acc.edge.description,
        };
      } else {
        acc.edge.context = acc.edge.context || e.context;
        acc.edge.description = acc.edge.description || e.description;
      }
    }
    for (const raw of [e.lecture_id]) {
      String(raw || "")
        .split(/[+]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((x) => acc!.lecs.add(x));
    }
    if (e.cue_id) acc.cueIds.add(String(e.cue_id));
    (e.cue_ids || []).forEach((c) => acc!.cueIds.add(String(c)));
    const lab = (e.cue_label || "").trim();
    if (lab && !acc.labels.includes(lab)) acc.labels.push(lab);
  }

  const edges: PipelineEdge[] = [];
  let i = 0;
  for (const acc of bySpo.values()) {
    const lecs = [...acc.lecs].sort((x, y) => Number(x) - Number(y));
    const both = lecs.includes(a) && lecs.includes(b);
    edges.push({
      ...acc.edge,
      id: acc.edge.id || `session_fuse-${i++}`,
      lecture_id: both ? `${a}+${b}` : lecs[0] || acc.edge.lecture_id || null,
      cue_id: [...acc.cueIds][0] || acc.edge.cue_id || null,
      cue_ids: [...acc.cueIds],
      cue_label:
        acc.labels.length <= 1
          ? acc.labels[0] || acc.edge.cue_label || null
          : acc.labels.join("；"),
    });
  }
  return { nodes: union.nodes, edges };
}

function spoCore(e: PipelineEdge): string {
  return `${e.from || ""}\t${e.relation || e.label || ""}\t${e.to || ""}`;
}

/** 给融合节点补重要性分（反馈后 / 教材先验）与节点大小 */
export function enrichPipelineNodesWithImportance(
  nodes: PipelineNode[],
  opts: {
    scores?: Record<string, number> | null;
    base?: Record<string, number> | null;
    contributions?: Record<string, Record<string, number>> | null;
  } = {}
): PipelineNode[] {
  return nodes.map((n) => {
    const fb = lookupImportance(opts.scores, n.id);
    const base = lookupImportance(opts.base, n.id);
    const importance =
      fb ?? (n.importance != null ? Number(n.importance) : null) ?? base;
    const importance_base =
      base ?? (n.importance_base != null ? Number(n.importance_base) : null);
    const contribLookup = opts.contributions || null;
    let importance_contributions = n.importance_contributions || null;
    if (contribLookup) {
      const hit =
        contribLookup[n.id] || contribLookup[String(n.id).split("/")[0] || ""];
      if (hit) importance_contributions = hit;
    }
    const importance_delta =
      importance != null && importance_base != null
        ? Number(importance) - Number(importance_base)
        : n.importance_delta ?? null;
    const size =
      importance != null && Number.isFinite(Number(importance))
        ? sizeFromImportance(Number(importance))
        : n.size;
    return {
      ...n,
      importance,
      importance_base,
      importance_delta,
      importance_contributions,
      size,
    };
  });
}

/** mmkg 实体描述 enrichment（不增删边） */
export async function loadMmkgEntityEnrichment(
  courseId: string,
  lectureId?: string | null
): Promise<Map<string, MmkgEntityEnrichment>> {
  const path = lectureId
    ? `/repo-data/kg/${courseId}/lecture_${lectureId}/mmkg.json`
    : `/repo-data/kg/${courseId}/mmkg.json`;
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return new Map();
    const data = (await res.json()) as {
      entities?: { id?: string; name?: string; description?: string }[];
    };
    const map = new Map<string, MmkgEntityEnrichment>();
    for (const ent of data.entities || []) {
      const id = String(ent.id || ent.name || "").trim();
      if (!id) continue;
      const description = String(ent.description || "").trim();
      if (description) map.set(id, { description });
    }
    return map;
  } catch {
    return new Map();
  }
}

export function applyMmkgEnrichmentToNodes(
  nodes: PipelineNode[],
  enrichment: Map<string, MmkgEntityEnrichment> | null | undefined
): PipelineNode[] {
  if (!enrichment?.size) return nodes;
  return nodes.map((n) => {
    const hit =
      enrichment.get(n.id) || enrichment.get(String(n.id).split("/")[0] || "");
    if (!hit?.description) return n;
    return { ...n, description: hit.description };
  });
}

/** 整课：各讲 pipeline merge 片段串联（标签带讲次前缀） */
export async function loadCoursePipelineUnion(
  lectureIds: string[]
): Promise<PipelineCueBundle[]> {
  const ids = [...new Set(lectureIds.map(String).filter(Boolean))].sort(
    (a, b) => Number(a) - Number(b)
  );
  const all: PipelineCueBundle[] = [];
  const failed: string[] = [];
  for (const lid of ids) {
    try {
      const cues = await loadLecturePipelineCues(lid);
      cues.forEach((c, idx) => {
        const labelPrefix = `第${lid}讲·片段${idx + 1}`;
        all.push({
          ...c,
          edges: c.edges.map((e) => ({
            ...e,
            lecture_id: e.lecture_id || lid,
            cue_label: e.cue_label?.startsWith("第")
              ? e.cue_label
              : `${labelPrefix}${
                  c.startSec != null ? ` · ${Math.round(c.startSec)}s` : ""
                }`,
          })),
          crossCueEdges: (c.crossCueEdges || []).map((e) => ({
            ...e,
            lecture_id: e.lecture_id || lid,
            cue_label: e.cue_label?.startsWith("第")
              ? e.cue_label
              : `${labelPrefix}${
                  c.startSec != null ? ` · ${Math.round(c.startSec)}s` : ""
                }`,
          })),
        });
      });
    } catch {
      failed.push(lid);
    }
  }
  if (!all.length) {
    throw new Error(
      `整课无可用流水线融合数据${
        failed.length ? `（失败讲次: ${failed.join(", ")}）` : ""
      }`
    );
  }
  return all;
}

/** 按讲次筛边（整课下拉）；lecture_id 可为 "1" 或 "1+2" */
export function filterPipelineGraphByLecture(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  lectureId: string | null | undefined
): { nodes: PipelineNode[]; edges: PipelineEdge[] } {
  const lid = String(lectureId || "").trim();
  if (!lid) return { nodes, edges };
  const nextEdges = edges.filter((e) => {
    const raw = String(e.lecture_id || "");
    if (!raw) return false;
    return raw
      .split(/[+]/)
      .map((x) => x.trim())
      .includes(lid);
  });
  const keep = new Set<string>();
  for (const e of nextEdges) {
    if (e.from) keep.add(e.from);
    if (e.to) keep.add(e.to);
  }
  return {
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: nextEdges,
  };
}

export async function loadLecturePipelineCues(
  lectureId: string
): Promise<PipelineCueBundle[]> {
  const res = await fetch(`/data/pipeline/pipeline_build_lecture_${lectureId}.json`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`缺少流水线数据 pipeline_build_lecture_${lectureId}.json`);
  }
  const data = (await res.json()) as {
    items?: {
      cue_id?: string;
      lecture_id?: string;
      start_sec?: number;
      end_sec?: number;
      extract_text?: string;
      media?: { clip?: string; ppt?: string };
      cross_cue_edges?: PipelineEdge[];
      stages?: {
        id?: string;
        text?: string;
        nodes?: PipelineNode[];
        edges?: PipelineEdge[];
      }[];
    }[];
  };

  const out: PipelineCueBundle[] = [];
  (data.items || []).forEach((it, idx) => {
    const cueId = String(it.cue_id || "").trim();
    if (!cueId) return;
    const merge = stageMergeOf(it);
    if (!merge) return;
    const cueLabel = `片段 ${idx + 1}${
      it.start_sec != null ? ` · ${Math.round(it.start_sec)}s` : ""
    }`;
    const edges = merge.edges
      // 段级 merge 若误含跨段边，加载时剔除
      .filter((e) => !isCrossCueEdgeSource(e.source))
      .map((e, i) => ({
        ...e,
        id: `${cueId}::${e.id || `e${i}`}`,
        cue_id: cueId,
        cue_ids: [cueId],
        lecture_id: String(it.lecture_id || lectureId),
        cue_label: cueLabel,
      }));
    const crossCueEdges = ((it as { cross_cue_edges?: PipelineEdge[] }).cross_cue_edges || [])
      .filter((e) => e?.from && e?.to)
      .map((e, i) => ({
        ...e,
        id: `${cueId}::cross::${e.id || `e${i}`}`,
        source: "cross_cue" as const,
        cue_id: cueId,
        cue_ids: [cueId],
        lecture_id: String(it.lecture_id || lectureId),
        cue_label: cueLabel,
      }));
    out.push({
      cueId,
      lectureId: String(it.lecture_id || lectureId),
      startSec: it.start_sec,
      endSec: it.end_sec,
      text: merge.text,
      clip: toMediaUrl(it.media?.clip),
      ppt: toMediaUrl(it.media?.ppt),
      nodes: merge.nodes,
      edges,
      crossCueEdges,
      edgeCount: edges.length,
    });
  });
  return out;
}

export async function loadSessionMergeStage(
  lecA: string,
  lecB: string
): Promise<PipelineStage | null> {
  const res = await fetch(`/data/pipeline/pipeline_build_session_${lecA}_${lecB}.json`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    items?: { stages?: PipelineStage[] }[];
  };
  const stages = data.items?.[0]?.stages || [];
  return stages.find((s) => s.id === "session_merge") || null;
}

export function buildKgViewFromPipeline(opts: {
  scope: "lecture" | "session" | "course";
  lectureId?: string;
  sessionPair?: [string, string] | null;
  cues: PipelineCueBundle[];
  sessionStage?: PipelineStage | null;
  cueFilter: string | null;
  /** 外层用 applyRelatedWithVisibility；此处默认 false 避免双重过滤 */
  hideRelatedWith?: boolean;
  lectureFilter?: string | null;
}): {
  payload: PipelinePayload;
  stage: PipelineStage;
  cues: PipelineCueBundle[];
  activeCue: PipelineCueBundle | null;
} {
  const {
    scope,
    cues,
    sessionStage = null,
    cueFilter,
    hideRelatedWith = false,
    lectureFilter = null,
  } = opts;
  const filteredCues = cueFilter
    ? cues.filter((c) => c.cueId === cueFilter)
    : cues;

  let nodes: PipelineNode[];
  let edges: PipelineEdge[];
  let stageId: string;
  let title: string;
  let subtitle: string;
  let blurb: string;
  let mode: "lecture" | "session" | "course" = "lecture";

  if (scope === "course") {
    const union = unionMergeGraphs(filteredCues.length ? filteredCues : cues);
    const filtered = filterPipelineGraphByLecture(
      union.nodes,
      union.edges,
      lectureFilter
    );
    nodes = filtered.nodes;
    edges = filtered.edges;
    stageId = lectureFilter ? `course_merge__${lectureFilter}` : "course_merge";
    mode = "course";
    title = lectureFilter ? `整课 · 第 ${lectureFilter} 讲边` : "整课 · 流水线融合并集";
    subtitle = "各讲各片段 merge 并集";
    blurb = "课堂 KG 主图 = 流水线融合结果合并；与单讲融合步同源";
  } else if (scope === "session" && !cueFilter && cues.length && opts.sessionPair) {
    const fused = fuseSessionFromPipelineCues(cues, opts.sessionPair);
    nodes = fused.nodes;
    edges = fused.edges;
    stageId = "session_merge";
    mode = "session";
    title = `第 ${opts.sessionPair[0]}–${opts.sessionPair[1]} 讲 · 一堂课融合`;
    subtitle = "两讲流水线融合并集";
    blurb = "由两讲各片段流水线 merge 合并；与流水线单讲/片段一致";
  } else if (scope === "session" && !cueFilter && sessionStage) {
    nodes = [...(sessionStage.nodes || [])];
    edges = [...(sessionStage.edges || [])];
    stageId = "session_merge";
    mode = "session";
    title = opts.sessionPair
      ? `第 ${opts.sessionPair[0]}–${opts.sessionPair[1]} 讲 · 一堂课融合`
      : "一堂课融合";
    subtitle = "来自流水线 session_merge（无单讲 merge 缓存时回退）";
    blurb = sessionStage.blurb || "相邻两讲融合总图";
  } else {
    const union = unionMergeGraphs(filteredCues.length ? filteredCues : cues);
    nodes = union.nodes;
    edges = union.edges;
    stageId = cueFilter ? `merge__${cueFilter}` : "merge";
    title =
      scope === "session" && opts.sessionPair
        ? cueFilter
          ? `第 ${opts.sessionPair[0]}–${opts.sessionPair[1]} 讲 · 片段`
          : `第 ${opts.sessionPair[0]}–${opts.sessionPair[1]} 讲 · 一堂课融合`
        : `第 ${opts.lectureId} 讲 · 融合图谱`;
    subtitle = "来自流水线融合步";
    blurb = cueFilter
      ? "当前片段的流水线融合结果（不含跨段边）"
      : "各片段流水线融合图合并；跨段边仅在讲次/课堂全图展示";
  }

  // 讲次 / 一堂课 / 整课（未选单片段）时并入跨段边；段级视图排除
  if (!cueFilter) {
    const crossBundles =
      scope === "course" && lectureFilter
        ? cues.filter((c) => String(c.lectureId) === String(lectureFilter))
        : cues;
    const attached = attachCrossCueEdges(nodes, edges, crossBundles);
    nodes = attached.nodes;
    edges = attached.edges;
  } else {
    edges = edges.filter((e) => !isCrossCueEdgeSource(e.source));
  }

  if (hideRelatedWith) {
    edges = edges.filter((e) => (e.relation || e.label || "") !== "related_with");
    const keep = new Set<string>();
    edges.forEach((e) => {
      if (e.from) keep.add(e.from);
      if (e.to) keep.add(e.to);
    });
    nodes = nodes.filter((n) => keep.has(n.id));
  }

  const fullUnionEdges = unionMergeGraphs(cues).edges;
  const baselineForHidden =
    scope === "course"
      ? filterPipelineGraphByLecture(
          unionMergeGraphs(cues).nodes,
          fullUnionEdges,
          lectureFilter
        ).edges
      : scope === "session" && !cueFilter && cues.length && opts.sessionPair
        ? fuseSessionFromPipelineCues(cues, opts.sessionPair).edges
        : scope === "session" && !cueFilter && sessionStage
          ? sessionStage.edges || []
          : unionMergeGraphs(filteredCues.length ? filteredCues : cues).edges;
  const nTb = edges.filter((e) => (e.source || "") === "textbook").length;
  const nRev = edges.filter((e) => (e.source || "") === "textbook_revised").length;
  const nDelta = edges.filter((e) => (e.source || "") === "lecture_delta").length;
  const nCross = edges.filter((e) => isCrossCueEdgeSource(e.source)).length;
  const nRelHidden = hideRelatedWith
    ? baselineForHidden.filter((e) => (e.relation || e.label || "") === "related_with")
        .length
    : 0;

  const stage: PipelineStage = {
    id: stageId,
    title,
    subtitle,
    blurb,
    focus: "multimodal",
    text: "",
    nodes,
    edges,
    stats: {
      textbook: nTb,
      revised: nRev,
      delta: nDelta,
      cross_cue: nCross,
      total: edges.length,
      ...(hideRelatedWith ? { related_with_hidden: nRelHidden } : {}),
    },
  };

  const activeCue =
    (cueFilter && cues.find((c) => c.cueId === cueFilter)) || cues[0] || null;

  const payload: PipelinePayload = {
    brand: "TeachKG",
    product: "知识图谱",
    mode: mode === "course" ? "lecture" : mode,
    course_id: "shuliluoji",
    lecture_id:
      scope === "session" && opts.sessionPair
        ? `${opts.sessionPair[0]}+${opts.sessionPair[1]}`
        : scope === "course"
          ? "course"
          : opts.lectureId,
    lecture_ids: opts.sessionPair || undefined,
    title,
    subtitle,
    items: [
      {
        cue_id: activeCue?.cueId || `lecture_${opts.lectureId || scope}`,
        lecture_id: activeCue?.lectureId || opts.lectureId,
        start_sec: activeCue?.startSec,
        end_sec: activeCue?.endSec,
        media: { clip: activeCue?.clip || "", ppt: activeCue?.ppt || "" },
        stages: [stage],
      },
    ],
  };

  return { payload, stage, cues, activeCue };
}
