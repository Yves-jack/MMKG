import type { PipelineEdge, PipelineNode, PipelineStage } from "./types";

export const SOURCE_EDGE_COLOR: Record<string, string> = {
  textbook: "#3ecf8e",
  textbook_revised: "#f0b429",
  textbook_before: "#9ca3af",
  lecture_delta: "#5b8def",
  cross_cue: "#22d3ee",
  llm_fallback: "#f0b429",
  llm_only: "#f0b429",
  filtered: "#6b7280",
  both: "#3ecf8e",
  lecture_1: "#5b8def",
  lecture_2: "#e879a9",
};

/** 教材关系谓词着色（优先于 source） */
export const RELATION_EDGE_COLOR: Record<string, string> = {
  belong_to: "#4e79a7",
  part_of: "#59a14f",
  depend_on: "#f28e2b",
  synonym_of: "#b07aa1",
  property_of: "#e15759",
  related_with: "#76b7b2",
};

export const RELATION_EDGE_LABEL: Record<string, string> = {
  belong_to: "belong_to 归属",
  part_of: "part_of 组成",
  depend_on: "depend_on 依赖",
  synonym_of: "synonym_of 同义",
  property_of: "property_of 属性→拥有者",
  related_with: "related_with 相关",
};

/** 抽象关系类型图例（教材 / 课堂 KG 共用） */
export const RELATION_TYPE_FILTERS: HlFilter[] = [
  { key: "e_belong", label: "belong_to", color: RELATION_EDGE_COLOR.belong_to, edgeRelations: ["belong_to"] },
  { key: "e_part", label: "part_of", color: RELATION_EDGE_COLOR.part_of, edgeRelations: ["part_of"] },
  { key: "e_depend", label: "depend_on", color: RELATION_EDGE_COLOR.depend_on, edgeRelations: ["depend_on"] },
  { key: "e_syn", label: "synonym_of", color: RELATION_EDGE_COLOR.synonym_of, edgeRelations: ["synonym_of"] },
  { key: "e_prop", label: "property_of", color: RELATION_EDGE_COLOR.property_of, edgeRelations: ["property_of"] },
  { key: "e_rel", label: "related_with", color: RELATION_EDGE_COLOR.related_with, edgeRelations: ["related_with"] },
];

/** 跨段边高亮（讲次/课堂级） */
export const CROSS_CUE_HIGHLIGHT_FILTER: HlFilter = {
  key: "e_cross",
  label: "跨段边",
  color: SOURCE_EDGE_COLOR.cross_cue,
  edgeSources: ["cross_cue"],
};

/** 等价 / 相关：双向关系 */
export const BIDIRECTIONAL_RELATIONS = new Set(["synonym_of", "related_with"]);

export function isBidirectionalRelation(relation?: string | null): boolean {
  const r = (relation || "").trim();
  return BIDIRECTIONAL_RELATIONS.has(r);
}

/** 文本箭头：双向用 <->；出边 ->；入边 <- */
export function relationArrowText(
  relation: string | null | undefined,
  dir: "out" | "in" | "undirected" = "out"
): string {
  const pred = (relation || "").trim() || "related_with";
  if (isBidirectionalRelation(pred) || dir === "undirected") {
    return `<-[${pred}]->`;
  }
  return dir === "in" ? `<-[${pred}]-` : `-[${pred}]->`;
}

/**
 * vis-network arrows 配置。
 * from=主体、to=客体：箭头始终跟存盘 SPO（主→客），不跟 statement_direction。
 * statement_direction 只影响自然语言拼读（如 property_of「具有」读成「拥有者具有属性」）。
 * property_of：S=属性、O=拥有者 → 箭头属性→拥有者。
 */
export function relationVisArrows(
  relation?: string | null,
  statementDirection?: string | null
): string {
  if (isBidirectionalRelation(relation)) return "to;from";
  const dir = (statementDirection || "").trim();
  if (dir === "undirected") return "to;from";
  return "to";
}

/** 解析边的陈述方向（修订前边可能只在 before snap 里） */
export function edgeStatementDirection(e: PipelineEdge): string {
  const action = (e.correction_action || "").trim();
  const direct = (e.statement_direction || "").trim();
  if (direct) return direct;
  if (action === "revise_before") return (e.before?.direction || "").trim();
  if (action === "revise") return (e.after?.direction || "").trim();
  return (e.after?.direction || e.before?.direction || "").trim();
}

export const KIND_STYLE: Record<
  string,
  { background: string; border: string; solid?: boolean }
> = {
  seed: { background: "#2a2418", border: "#f0b429" },
  seed_alias: { background: "#2a2418", border: "#f0b429" },
  seed_embedding: { background: "#14262e", border: "#2dd4bf" },
  seed_filtered_alias: { background: "#243028", border: "#7a8f82" },
  seed_filtered_embedding: { background: "#1e2c32", border: "#6a8a92" },
  seed_filtered: { background: "#2a2e35", border: "#6b7280" },
  textbook: { background: "#1a2a22", border: "#3ecf8e" },
  delta: { background: "#1a2333", border: "#5b8def" },
  mixed: { background: "#142a32", border: "#2dd4bf" },
  final: { background: "#1a2333", border: "#5b8def" },
  both: { background: "#163528", border: "#3ecf8e" },
  lecture_1: { background: "#152238", border: "#5b8def" },
  lecture_2: { background: "#2a1a28", border: "#e879a9" },
  tb_only: { background: "#3ecf8e", border: "#2a9f68", solid: true },
  class_only: { background: "#5b8def", border: "#3d6fd4", solid: true },
  shared: { background: "#d4a017", border: "#b8860b", solid: true },
  fallback: { background: "#2a2418", border: "#f0b429" },
  new: { background: "#2a1a24", border: "#e879a9" },
  entity: { background: "#1c2330", border: "#3d4a60" },
  importance_filtered: { background: "#23262c", border: "#6b7280" },
};

export type HlFilter = {
  key: string;
  label: string;
  color: string;
  nodeKinds?: string[];
  edgeSources?: string[];
  /** 按谓词高亮（教材分片页） */
  edgeRelations?: string[];
  /** 按边 id 聚焦（正文划线 / 选中关系） */
  edgeIds?: string[];
  /** 按节点 id 聚焦（选中实体：自身+邻接边+邻居） */
  nodeIds?: string[];
};

export type VisNode = Record<string, unknown> & {
  id: string;
  label?: string;
  _kind?: string;
  _bg?: string;
  _border?: string;
  _fontColor?: string;
  _baseOpacity?: number;
  x?: number;
  y?: number;
  size?: number;
};

export type VisEdge = Record<string, unknown> & {
  id: string;
  from: string;
  to: string;
  _source?: string;
  _relation?: string;
  _edgeColor?: string;
  _fontColor?: string;
  smooth?: unknown;
};

export function kindStyle(kind?: string) {
  if (kind && KIND_STYLE[kind]) return KIND_STYLE[kind];
  if (kind && String(kind).startsWith("lecture_")) {
    const n = Number(String(kind).replace("lecture_", ""));
    if (!Number.isNaN(n)) {
      return n % 2 === 1
        ? { background: "#152238", border: "#5b8def" }
        : { background: "#2a1a28", border: "#e879a9" };
    }
  }
  return KIND_STYLE.entity;
}

export function edgeSourceColor(src: string, relation?: string) {
  // 跨段边：固定青色，不被谓词色覆盖（便于图例高亮识别）
  if (src === "cross_cue" || (src && src.includes("讲的第") && src.includes("段到第"))) {
    return SOURCE_EDGE_COLOR.cross_cue;
  }
  // 已知谓词优先按关系类型着色（教材分片 / 子图均适用）
  const rel = (relation || "").trim();
  if (rel && RELATION_EDGE_COLOR[rel]) return RELATION_EDGE_COLOR[rel];
  if (SOURCE_EDGE_COLOR[src]) return SOURCE_EDGE_COLOR[src];
  if (src && String(src).startsWith("lecture_")) {
    const n = Number(String(src).replace("lecture_", ""));
    if (!Number.isNaN(n)) return n % 2 === 1 ? "#5b8def" : "#e879a9";
  }
  return "#8b97a8";
}

export function isSessionLectureStage(mode: string, stage?: PipelineStage | null) {
  return (
    mode === "session" &&
    !!stage?.id &&
    String(stage.id).startsWith("lecture_")
  );
}

export function stageEdgesForDisplay(
  mode: string,
  stage: PipelineStage,
  hideFiltered: boolean
): PipelineEdge[] {
  const edges = stage.edges || [];
  if (!hideFiltered) return edges;
  if (
    isSessionLectureStage(mode, stage) ||
    stage.id === "textbook" ||
    stage.id === "correct" ||
    stage.id === "merge" ||
    stage.id === "cross_cue"
  ) {
    return edges.filter((e) => (e.source || "") !== "filtered");
  }
  return edges;
}

export function stageNodesForDisplay(
  mode: string,
  stage: PipelineStage,
  edges: PipelineEdge[],
  hideFiltered: boolean
): PipelineNode[] {
  const nodes = stage.nodes || [];
  const shouldFilter =
    hideFiltered &&
    (isSessionLectureStage(mode, stage) ||
      stage.id === "textbook" ||
      stage.id === "correct" ||
      stage.id === "merge" ||
      stage.id === "cross_cue");
  if (!shouldFilter) return nodes;
  const keep = new Set<string>();
  edges.forEach((e) => {
    if (e.from) keep.add(e.from);
    if (e.to) keep.add(e.to);
  });
  return nodes.filter((n) => keep.has(n.id));
}

export function assignParallelCurves(edges: VisEdge[]) {
  const groups: Record<string, VisEdge[]> = {};
  edges.forEach((e) => {
    const key = [e.from, e.to].slice().sort().join("||");
    (groups[key] ||= []).push(e);
  });
  Object.values(groups).forEach((list) => {
    if (list.length === 1) {
      list[0].smooth = { enabled: true, type: "continuous", roundness: 0.35 };
      return;
    }
    list.forEach((e, i) => {
      e.smooth = {
        enabled: true,
        type: i % 2 === 0 ? "curvedCW" : "curvedCCW",
        roundness: Math.min(0.8, 0.2 + i * 0.18),
      };
    });
  });
}

export function buildVisNodes(stage: PipelineStage, rawNodes: PipelineNode[]): VisNode[] {
  const isSeeds = stage.id === "seeds";
  const isTextbook = stage.id === "textbook" || stage.id === "correct";
  return rawNodes.map((n) => {
    const isImpFiltered = Boolean(n.filtered_by_importance);
    const style = isImpFiltered
      ? KIND_STYLE.importance_filtered
      : kindStyle(n.kind);
    const isSolid = !!style.solid && !isImpFiltered;
    const isSeedKind =
      n.kind === "seed" ||
      n.kind === "seed_alias" ||
      n.kind === "seed_embedding" ||
      String(n.kind || "").startsWith("seed_");
    const baseSize = isSeeds
      ? String(n.kind || "").startsWith("seed_filtered")
        ? 14
        : n.kind === "seed_embedding"
          ? 22
          : 20
      : isTextbook && isSeedKind
        ? 20
        : n.kind === "new" || n.kind === "class_only"
          ? 22
          : 16;
    const size = n.size != null ? Number(n.size) : baseSize;
    const fontSize = isSeeds
      ? String(n.kind || "").startsWith("seed_filtered")
        ? 12
        : 17
      : Math.max(11, Math.min(18, Math.round(11 + (size - 10) * 0.35)));
    const isFilteredSeed = String(n.kind || "").startsWith("seed_filtered");
    const isFilteredAlias = n.kind === "seed_filtered_alias";
    const isFilteredEmb = n.kind === "seed_filtered_embedding";
    const fontColor = isImpFiltered
      ? "#9ca3af"
      : isSolid
        ? "#0e1116"
        : isFilteredAlias
          ? "#a8bdb0"
          : isFilteredEmb
            ? "#9eb8c0"
            : "#e8edf5";
    const dimmed = isFilteredSeed || isImpFiltered;
    return {
      id: n.id,
      label: n.label || n.id.split("/")[0],
      title: isImpFiltered
        ? `${n.title || n.label || n.id}（重要性筛选）`
        : n.title,
      shape: "dot",
      size: isImpFiltered ? Math.max(10, size * 0.85) : size,
      _kind: n.kind || "",
      _bg: style.background,
      _border: style.border,
      _fontColor: fontColor,
      _baseOpacity: dimmed ? 0.45 : 1,
      importance: n.importance,
      importance_base: n.importance_base,
      importance_delta: n.importance_delta,
      filtered_by_importance: isImpFiltered,
      font: {
        size: isImpFiltered ? Math.max(10, fontSize - 1) : fontSize,
        color: fontColor,
        face: "IBM Plex Sans, Microsoft YaHei, sans-serif",
        strokeWidth: isSeeds && !isFilteredSeed ? 3 : isSolid ? 2 : 0,
        strokeColor:
          isSeeds && !isFilteredSeed ? "#0e1116" : isSolid ? "#f5f7fa" : undefined,
      },
      color: {
        background: style.background,
        border: style.border,
        highlight: { background: style.background, border: "#fff" },
      },
      borderWidth: dimmed ? 1.5 : isSolid ? 2 : isSeeds ? 3 : 2,
      opacity: dimmed ? 0.45 : 1,
    };
  });
}

export function buildVisEdges(rawEdges: PipelineEdge[]): VisEdge[] {
  return rawEdges.map((e) => {
    const src = e.source || "";
    const action = (e.correction_action || "").trim();
    const isDelta = src === "lecture_delta";
    const isFiltered = src === "filtered" || action === "drop";
    const isBefore = src === "textbook_before" || action === "revise_before";
    const isRevised = src === "textbook_revised" || action === "revise";
    const edgeColor = isFiltered || isBefore
      ? isBefore
        ? SOURCE_EDGE_COLOR.textbook_before
        : SOURCE_EDGE_COLOR.filtered
      : isRevised
        ? SOURCE_EDGE_COLOR.textbook_revised
        : edgeSourceColor(src, e.relation || e.label);
    const fontColor = isDelta
      ? "#93c5fd"
      : isFiltered || isBefore
        ? "#9ca3af"
        : isRevised
          ? "#fbbf24"
          : RELATION_EDGE_COLOR[(e.relation || e.label || "").trim()]
            ? edgeColor
            : "#8b97a8";
    const labelPrefix =
      action === "revise"
        ? "后·"
        : action === "revise_before"
          ? "前·"
          : action === "drop"
            ? "删除·"
            : isDelta
              ? "增量·"
              : "";
    const baseWidth = isDelta
      ? 3.0
      : isRevised
        ? 2.8
        : isBefore
          ? 1.2
          : src === "textbook"
            ? 1.8
            : isFiltered
              ? 1.0
              : 1.4;
    const stmtDir = edgeStatementDirection(e);
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label ? `${labelPrefix}${e.label}`.replace(/^增量·增量·/, "增量·") : e.label,
      title: [
        e.compare_text,
        e.changes?.length ? `变化: ${e.changes.join("、")}` : "",
        e.description && `描述: ${e.description}`,
        e.context && `依据片段: ${e.context}`,
        (e.cue_label || e.cue_id) && `片段来源: ${e.cue_label || e.cue_id}`,
        action && `修正: ${action}`,
        e.correction_reason && `理由: ${e.correction_reason}`,
        e.correction_reason_detail && `详述: ${e.correction_reason_detail}`,
        e.correction_evidence && `摘录: ${e.correction_evidence}`,
        src && `来源: ${src}`,
      ]
        .filter(Boolean)
        .join("\n"),
      arrows: relationVisArrows(e.relation || e.label, stmtDir),
      _source: src,
      _relation: e.relation || e.label || "",
      _statementDirection: stmtDir,
      _correctionAction: action,
      _edgeColor: edgeColor,
      _fontColor: fontColor,
      _baseWidth: baseWidth,
      color: { color: edgeColor, highlight: "#fff", opacity: 1 },
      width: baseWidth,
      opacity: 1,
      dashes: src === "llm_fallback" || src === "llm_only" || isFiltered || isBefore,
      font: {
        size: isDelta || isRevised ? 11 : 10,
        color: fontColor,
        strokeWidth: 0,
        align: "horizontal",
        bold: isDelta || isRevised,
      },
    };
  });
}

function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function nodeSepRadius(n: { size?: number }) {
  return Math.max(20, Number(n.size) || 16) * 2.2 + 16;
}

function isTooClose(x: number, y: number, visNodes: VisNode[], selfId: string, minExtra = 0) {
  for (const o of visNodes) {
    if (!o || String(o.id) === String(selfId)) continue;
    if (o.x == null || o.y == null) continue;
    const need = nodeSepRadius({ size: o.size as number }) + nodeSepRadius({ size: 16 }) + minExtra;
    if (Math.hypot((o.x as number) - x, (o.y as number) - y) < need) return true;
  }
  return false;
}

function findFreePosition(cx: number, cy: number, visNodes: VisNode[], selfId: string, seedAng: number) {
  const base = 90;
  for (let ring = 0; ring < 10; ring++) {
    const rad = base + ring * 48;
    const steps = 8 + ring * 4;
    for (let i = 0; i < steps; i++) {
      const ang = seedAng + (2 * Math.PI * i) / steps;
      const x = cx + rad * Math.cos(ang);
      const y = cy + rad * Math.sin(ang);
      if (!isTooClose(x, y, visNodes, selfId, 4)) return { x, y };
    }
  }
  return { x: cx + (base + 420) * Math.cos(seedAng), y: cy + (base + 420) * Math.sin(seedAng) };
}

export function applyCachedPositions(visNodes: VisNode[], cache: Record<string, { x: number; y: number }>) {
  visNodes.forEach((n) => {
    const p = cache[String(n.id)];
    if (p && p.x != null && p.y != null) {
      n.x = p.x;
      n.y = p.y;
    }
  });
}

export function placeUncachedNodes(visNodes: VisNode[], visEdges: VisEdge[]) {
  const byId: Record<string, VisNode> = {};
  visNodes.forEach((n) => {
    byId[String(n.id)] = n;
  });
  const placed = new Set<string>();
  visNodes.forEach((n) => {
    if (n.x != null && n.y != null) placed.add(String(n.id));
  });
  for (let guard = 0; guard < visNodes.length + 2; guard++) {
    let progressed = false;
    visEdges.forEach((e) => {
      const a = String(e.from);
      const b = String(e.to);
      const na = byId[a];
      const nb = byId[b];
      if (!na || !nb) return;
      if (placed.has(a) && !placed.has(b)) {
        const pos = findFreePosition(na.x!, na.y!, visNodes, b, ((hashStr(b) % 360) * Math.PI) / 180);
        nb.x = pos.x;
        nb.y = pos.y;
        placed.add(b);
        progressed = true;
      } else if (placed.has(b) && !placed.has(a)) {
        const pos = findFreePosition(nb.x!, nb.y!, visNodes, a, ((hashStr(a) % 360) * Math.PI) / 180);
        na.x = pos.x;
        na.y = pos.y;
        placed.add(a);
        progressed = true;
      }
    });
    if (!progressed) break;
  }
  const missing = visNodes.filter((n) => n.x == null || n.y == null);
  missing.forEach((n, i) => {
    const pos = findFreePosition(0, 0, visNodes, n.id, (2 * Math.PI * i) / Math.max(1, missing.length));
    n.x = pos.x;
    n.y = pos.y;
  });
}

export function resolveNodeOverlaps(visNodes: VisNode[], movableIds: Set<string> | null) {
  const nodes = visNodes.filter((n) => n && n.x != null && n.y != null);
  for (let iter = 0; iter < 50; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x! - a.x!;
        let dy = b.y! - a.y!;
        let dist = Math.hypot(dx, dy);
        const minD = nodeSepRadius(a) + nodeSepRadius(b);
        if (dist >= minD) continue;
        if (dist < 1e-3) {
          const ang = (((hashStr(a.id) + hashStr(b.id)) % 360) * Math.PI) / 180;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          dist = 1;
        }
        const push = (minD - dist) / 2 + 3;
        const ux = dx / dist;
        const uy = dy / dist;
        const aMov = !movableIds || movableIds.has(String(a.id));
        const bMov = !movableIds || movableIds.has(String(b.id));
        if (aMov && bMov) {
          a.x! -= ux * push;
          a.y! -= uy * push;
          b.x! += ux * push;
          b.y! += uy * push;
        } else if (aMov) {
          a.x! -= ux * push * 2;
          a.y! -= uy * push * 2;
        } else if (bMov) {
          b.x! += ux * push * 2;
          b.y! += uy * push * 2;
        } else {
          a.x! -= ux * push * 0.6;
          a.y! -= uy * push * 0.6;
          b.x! += ux * push * 0.6;
          b.y! += uy * push * 0.6;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

export function stageHighlightFilters(
  stage: PipelineStage,
  mode: string,
  lectureIds: string[] = []
): HlFilter[] {
  if (!stage || stage.focus === "text" || stage.id === "seeds") return [];
  const a = lectureIds[0] || "A";
  const b = lectureIds[1] || "B";
  if (stage.id === "textbook" || stage.id.startsWith("textbook_")) {
    const isSlice = stage.id !== "textbook";
    return [
      ...(isSlice
        ? [{ key: "n_tb", label: "教材实体", color: "#3ecf8e", nodeKinds: ["textbook"] }]
        : [
            { key: "n_seed_alias", label: "种子·别名", color: "#f0b429", nodeKinds: ["seed", "seed_alias"] },
            { key: "n_seed_emb", label: "种子·向量", color: "#2dd4bf", nodeKinds: ["seed_embedding"] },
            { key: "n_tb", label: "扩展实体", color: "#3ecf8e", nodeKinds: ["textbook"] },
          ]),
      ...RELATION_TYPE_FILTERS,
      ...(!isSlice
        ? [{ key: "e_filt", label: "过滤边", color: "#6b7280", edgeSources: ["filtered"] }]
        : []),
      ...(stage.id.startsWith("textbook_kg")
        ? [{ key: "n_new", label: "课堂新实体", color: "#e879a9", nodeKinds: ["new"] }]
        : []),
    ];
  }
  if (stage.id === "correct" || stage.id.startsWith("correct")) {
    return [
      { key: "n_seed_alias", label: "种子·别名", color: "#f0b429", nodeKinds: ["seed", "seed_alias"] },
      { key: "n_seed_emb", label: "种子·向量", color: "#2dd4bf", nodeKinds: ["seed_embedding"] },
      { key: "n_tb", label: "教材实体", color: "#3ecf8e", nodeKinds: ["textbook"] },
      { key: "e_keep", label: "保留", color: "#3ecf8e", edgeSources: ["textbook"] },
      { key: "e_before", label: "修订前", color: "#9ca3af", edgeSources: ["textbook_before"] },
      { key: "e_rev", label: "修订后", color: "#f0b429", edgeSources: ["textbook_revised"] },
      { key: "e_drop", label: "删除", color: "#6b7280", edgeSources: ["filtered"] },
    ];
  }
  if (stage.id === "delta") {
    return [
      { key: "n_tb", label: "教材实体", color: "#3ecf8e", nodeKinds: ["textbook"] },
      { key: "n_new", label: "新实体", color: "#e879a9", nodeKinds: ["new"] },
      { key: "n_delta", label: "其他增量节点", color: "#5b8def", nodeKinds: ["delta"] },
    ];
  }
  if (stage.id === "cross_cue") {
    return [
      CROSS_CUE_HIGHLIGHT_FILTER,
      { key: "e_dedupe", label: "去重掉", color: "#6b7280", edgeSources: ["filtered"] },
      ...RELATION_TYPE_FILTERS,
      { key: "n_delta", label: "跨段节点", color: "#7dd3fc", nodeKinds: ["delta"] },
    ];
  }
  if (stage.id === "merge" || stage.id.startsWith("merge__")) {
    return [
      { key: "e_tb", label: "教材边", color: "#3ecf8e", edgeSources: ["textbook"] },
      { key: "e_rev", label: "课堂修订", color: "#f0b429", edgeSources: ["textbook_revised"] },
      { key: "e_delta", label: "课堂增量", color: "#5b8def", edgeSources: ["lecture_delta"] },
      CROSS_CUE_HIGHLIGHT_FILTER,
      { key: "e_fb", label: "LLM回退", color: "#f0b429", edgeSources: ["llm_fallback", "llm_only"] },
      { key: "n_new", label: "新实体", color: "#e879a9", nodeKinds: ["new"] },
      { key: "n_delta", label: "增量节点", color: "#7dd3fc", nodeKinds: ["delta"] },
      ...RELATION_TYPE_FILTERS,
    ];
  }
  if (
    stage.id === "session_merge" ||
    stage.id === "course_merge" ||
    stage.id.startsWith("course_merge__")
  ) {
    // 边色优先按关系类型；图例先给跨段 / 谓词，再给讲次归属 / 节点角色
    return [
      CROSS_CUE_HIGHLIGHT_FILTER,
      ...RELATION_TYPE_FILTERS,
      { key: "e_both", label: "边·两讲共有", color: "#86efac", edgeSources: ["both"] },
      { key: "e_lec_a", label: `边·仅第${a}讲`, color: "#93c5fd", edgeSources: [`lecture_${a}`] },
      { key: "e_lec_b", label: `边·仅第${b}讲`, color: "#f9a8d4", edgeSources: [`lecture_${b}`] },
      { key: "n_tb", label: "教材独有", color: "#3ecf8e", nodeKinds: ["tb_only"] },
      { key: "n_class", label: "上课独有", color: "#5b8def", nodeKinds: ["class_only"] },
      { key: "n_shared", label: "两者共有", color: "#d4a017", nodeKinds: ["shared"] },
    ];
  }
  if (isSessionLectureStage(mode, stage)) {
    return [
      { key: "e_tb", label: "教材边", color: "#3ecf8e", edgeSources: ["textbook"] },
      { key: "e_delta", label: "增量边", color: "#5b8def", edgeSources: ["lecture_delta"] },
      { key: "e_filt", label: "过滤边", color: "#6b7280", edgeSources: ["filtered"] },
      { key: "n_tb", label: "仅教材节点", color: "#86efac", nodeKinds: ["textbook"] },
      { key: "n_mixed", label: "教材+增量节点", color: "#2dd4bf", nodeKinds: ["mixed"] },
      { key: "n_delta", label: "仅增量节点", color: "#93c5fd", nodeKinds: ["delta"] },
      { key: "n_new", label: "新实体", color: "#e879a9", nodeKinds: ["new"] },
    ];
  }
  return [
    { key: "e_tb", label: "边·教材", color: "#3ecf8e", edgeSources: ["textbook"] },
    { key: "e_delta", label: "边·增量", color: "#5b8def", edgeSources: ["lecture_delta"] },
    { key: "n_new", label: "节点·新实体", color: "#e879a9", nodeKinds: ["new"] },
  ];
}

export function filterHasMatches(
  mode: string,
  stage: PipelineStage,
  filter: HlFilter,
  hideFiltered: boolean
) {
  return countFilterMatches(mode, stage, filter, hideFiltered) > 0;
}

/** 图例项匹配数量：优先按关系类型 / 边来源计边，否则按节点角色计节点。 */
export function countFilterMatches(
  mode: string,
  stage: PipelineStage,
  filter: HlFilter,
  hideFiltered: boolean
): number {
  const nodes = stage.nodes || [];
  const edges = stageEdgesForDisplay(mode, stage, hideFiltered);
  if (filter.edgeRelations?.length) {
    return edges.filter((e) =>
      filter.edgeRelations!.includes((e.relation || e.label || "").trim())
    ).length;
  }
  if (filter.edgeSources?.length) {
    return edges.filter((e) => filter.edgeSources!.includes(e.source || "")).length;
  }
  if (filter.nodeKinds?.length) {
    return nodes.filter((n) => filter.nodeKinds!.includes(n.kind || "")).length;
  }
  return 0;
}

/** 「全部」按钮旁：当前图可见边数（关系总数）。 */
export function countVisibleEdges(
  mode: string,
  stage: PipelineStage,
  hideFiltered: boolean
): number {
  return stageEdgesForDisplay(mode, stage, hideFiltered).length;
}

export const HL_DIM = 0.42;
export const HL_NODE_FADE_BG = "#2c3440";
export const HL_NODE_FADE_BORDER = "#465062";
export const HL_EDGE_FADE = "#4a5568";
export const HL_FONT_FADE = "#6b7688";

export function graphLayoutOptions(stage: PipelineStage, physicsEnabled = true) {
  const isSeeds = stage.id === "seeds";
  const barnes = isSeeds
    ? {
        gravitationalConstant: -2800,
        centralGravity: 0.45,
        springLength: 55,
        springConstant: 0.12,
        damping: 0.5,
        avoidOverlap: 0.85,
      }
    : {
        gravitationalConstant: -9000,
        centralGravity: 0.2,
        springLength: 120,
        springConstant: 0.04,
        damping: 0.4,
        avoidOverlap: 0.85,
      };
  return {
    physics: {
      enabled: physicsEnabled,
      barnesHut: barnes,
      stabilization: { iterations: physicsEnabled ? (isSeeds ? 100 : 120) : 0 },
    },
    interaction: { hover: true, tooltipDelay: 80 },
    layout: { improvedLayout: physicsEnabled },
  };
}
