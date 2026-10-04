import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ForwardedRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { DataSet } from "vis-data";
import { Network } from "vis-network";
import type { PipelinePayload, PipelineStage } from "@/lib/pipeline/types";
import { exportVisNetworkPng } from "@/lib/pipeline/exportVisNetworkPng";
import {
  applyCachedPositions,
  assignElasticSprings,
  assignParallelCurves,
  buildVisEdges,
  buildVisNodes,
  filterHasMatches,
  graphLayoutOptions,
  HL_DIM,
  HL_EDGE_FADE,
  HL_FONT_FADE,
  HL_NODE_FADE_BG,
  HL_NODE_FADE_BORDER,
  placeUncachedNodes,
  reduceEdgeCrossings,
  resolveNodeOverlaps,
  seedClusterCircleLayout,
  stageEdgesForDisplay,
  stageHighlightFilters,
  stageNodesForDisplay,
  type HlFilter,
  type VisEdge,
  type VisNode,
} from "@/lib/pipeline/graphLogic";
import { AsrTextCompare } from "./AsrTextCompare";
import { CorrectSourceHighlight } from "./CorrectSourceHighlight";
import { LatexText } from "./LatexText";
import { ResizableSplit } from "./ResizableSplit";
import { SeedTextCompare } from "./SeedTextCompare";
import { SliceTextAnnotator } from "./SliceTextAnnotator";
import correctStyles from "./CorrectTextGraph.module.css";
import styles from "./GraphCanvas.module.css";

export type GraphCanvasHandle = {
  /** 导出当前视口图谱为高清 PNG；成功返回 true */
  exportPng: (opts?: {
    scale?: number;
    filename?: string;
    background?: string;
  }) => Promise<boolean>;
};

type Props = {
  payload: PipelinePayload;
  stage: PipelineStage;
  hideFiltered: boolean;
  highlightKey: string | null;
  /** 覆盖默认 stageHighlightFilters（课堂 KG 三类图例） */
  highlightFilters?: HlFilter[] | null;
  /** dim=淡化无关；solo=只显示高亮相关 */
  highlightMode?: "dim" | "solo";
  posCacheRef: MutableRefObject<Record<string, { x: number; y: number }>>;
  keepLayout: boolean;
  selectedEdgeId?: string | null;
  /** 正文划线聚焦的边（可多条）；优先于单选边淡化 */
  focusEdgeIds?: string[] | null;
  /** 选中实体：自身与一跳邻域高亮，其余淡化 */
  selectedNodeId?: string | null;
  /**
   * 请求将某实体移到视口中心并缩放（仅搜索定位，一次性）。
   * seq 递增可对同一节点重复触发。
   */
  focusNodeRequest?: { id: string; seq: number } | null;
  /** 居中动画已消费，父级应清空 focusNodeRequest，避免其它操作再次触发 */
  onFocusNodeConsumed?: () => void;
  /** 图例：只挂在图谱区内，不覆盖文本栏 */
  legend?: ReactNode;
  onSelectNode: (
    id: string | null,
    meta?: VisNode | null,
    point?: { clientX: number; clientY: number },
  ) => void;
  onSelectEdge: (id: string | null, groupIds?: string[]) => void;
  onContextNode?: (
    id: string,
    meta: VisNode,
    point: { clientX: number; clientY: number },
  ) => void;
};

/** 重要性从紧到松等场景会突然补回大量节点；原地塞位会乱，需整图重布局 */
function shouldRelayoutForNodeGrowth(haveCount: number, addedCount: number): boolean {
  if (addedCount <= 0) return false;
  if (haveCount <= 0) return addedCount > 0;
  if (addedCount >= 8) return true;
  return addedCount / haveCount >= 0.15;
}

function GraphCanvasInner(
  {
    payload,
    stage,
    hideFiltered,
    highlightKey,
    highlightFilters = null,
    highlightMode = "dim",
    posCacheRef,
    keepLayout,
    selectedEdgeId = null,
    focusEdgeIds = null,
    selectedNodeId = null,
    focusNodeRequest = null,
    onFocusNodeConsumed,
    legend = null,
    onSelectNode,
    onSelectEdge,
    onContextNode,
  }: Props,
  ref: ForwardedRef<GraphCanvasHandle>
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const netRef = useRef<Network | null>(null);
  const nodeDS = useRef<DataSet<VisNode> | null>(null);
  const edgeDS = useRef<DataSet<VisEdge> | null>(null);
  const stageIdRef = useRef<string>("");
  const edgeSmoothCacheRef = useRef<Record<string, VisEdge["smooth"]>>({});
  const onSelectNodeRef = useRef(onSelectNode);
  const onSelectEdgeRef = useRef(onSelectEdge);
  const onContextNodeRef = useRef(onContextNode);
  const onFocusConsumedRef = useRef(onFocusNodeConsumed);
  /** 用户/搜索视口：缩放平移后记住，避免改布局尺寸时被冲掉 */
  const viewRef = useRef<{ scale: number; position: { x: number; y: number } } | null>(
    null
  );
  onSelectNodeRef.current = onSelectNode;
  onSelectEdgeRef.current = onSelectEdge;
  onContextNodeRef.current = onContextNode;
  onFocusConsumedRef.current = onFocusNodeConsumed;

  useImperativeHandle(
    ref,
    () => ({
      exportPng: async (opts) => {
        const net = netRef.current;
        const host = hostRef.current;
        if (!net || !host) return false;
        // 文本-only 阶段无 network
        if (stage.focus === "text" || stage.id === "seeds")
          return false;
        try {
          return await exportVisNetworkPng(net, host, opts);
        } catch {
          return false;
        }
      },
    }),
    [stage.focus, stage.id]
  );

  const captureView = () => {
    const net = netRef.current;
    if (!net) return;
    try {
      viewRef.current = {
        scale: net.getScale(),
        position: { ...net.getViewPosition() },
      };
    } catch {
      /* ignore */
    }
  };

  const restoreView = () => {
    const net = netRef.current;
    const v = viewRef.current;
    if (!net || !v) return;
    try {
      net.moveTo({
        position: v.position,
        scale: v.scale,
        animation: false,
      });
    } catch {
      /* ignore */
    }
  };

  const cacheEdgeSmooth = (edges: VisEdge[]) => {
    edges.forEach((e) => {
      if (e.id != null && e.smooth != null) {
        edgeSmoothCacheRef.current[String(e.id)] = e.smooth;
      }
    });
  };

  const applyCachedEdgeSmooth = (edges: VisEdge[]) => {
    edges.forEach((e) => {
      const cached = edgeSmoothCacheRef.current[String(e.id)];
      if (cached != null) e.smooth = cached;
    });
  };

  const snapshot = () => {
    const net = netRef.current;
    const ds = nodeDS.current;
    if (!net || !ds) return;
    try {
      const ids = ds.getIds() as string[];
      const pos = net.getPositions(ids);
      Object.keys(pos).forEach((id) => {
        posCacheRef.current[id] = { x: pos[id].x, y: pos[id].y };
      });
    } catch {
      /* ignore */
    }
  };

  const applyHighlight = (filter: HlFilter | null) => {
    const nDS = nodeDS.current;
    const eDS = edgeDS.current;
    if (!nDS || !eDS) return;
    const allNodes = nDS.get() as VisNode[];
    const allEdges = eDS.get() as VisEdge[];
    const solo = highlightMode === "solo";
    if (!filter) {
      nDS.update(
        allNodes.map((n) => ({
          id: n.id,
          hidden: false,
          opacity: n._baseOpacity ?? 1,
          color: {
            background: n._bg,
            border: n._border,
            highlight: { background: n._bg, border: "#fff" },
          },
          font: { ...(n.font as object), color: n._fontColor || "#e8edf5" },
        })) as any
      );
      eDS.update(
        allEdges.map((e) => {
          const baseW =
            typeof (e as any)._baseWidth === "number"
              ? (e as any)._baseWidth
              : typeof (e as any).width === "number"
                ? (e as any).width
                : 1.5;
          return {
            id: e.id,
            hidden: false,
            opacity: 1,
            width: baseW,
            color: { color: e._edgeColor, highlight: "#fff", opacity: 1 },
            font: { ...(e.font as object), color: e._fontColor || "#8b97a8", strokeWidth: 0 },
          };
        }) as any
      );
      try {
        netRef.current?.redraw();
      } catch {
        /* ignore */
      }
      return;
    }
    const matchN = new Set<string>();
    const matchE = new Set<string>();
    const nodeKindOnly = Boolean(
      filter.nodeKinds?.length &&
        !filter.edgeSources?.length &&
        !filter.edgeRelations?.length &&
        !filter.edgeIds?.length &&
        !filter.nodeIds?.length
    );
    if (filter.nodeKinds?.length) {
      const kinds = new Set(filter.nodeKinds.map(String));
      allNodes.forEach((n) => {
        const kind = String(n._kind || "entity");
        if (kinds.has(kind)) matchN.add(String(n.id));
      });
      if (nodeKindOnly) {
        // 实体图例：只高亮同类节点；边仅当两端均命中（不把异类邻居算进高亮）
        allEdges.forEach((e) => {
          if (matchN.has(String(e.from)) && matchN.has(String(e.to))) {
            matchE.add(String(e.id));
          }
        });
      } else {
        allEdges.forEach((e) => {
          if (matchN.has(String(e.from)) || matchN.has(String(e.to))) {
            matchE.add(String(e.id));
          }
        });
      }
    }
    if (filter.edgeSources?.length) {
      const wantsCross = filter.edgeSources.some(
        (s) => s === "cross_cue" || String(s).startsWith("cross_cue")
      );
      allEdges.forEach((e) => {
        const cross = Boolean(e._isCrossCue);
        const hit = wantsCross
          ? cross
          : !cross && filter.edgeSources!.includes(String(e._source));
        if (hit) {
          matchE.add(String(e.id));
          if (e.from) matchN.add(String(e.from));
          if (e.to) matchN.add(String(e.to));
        }
      });
    }
    if (filter.edgeRelations?.length) {
      allEdges.forEach((e) => {
        const rel = String(e._relation || e.label || "").trim();
        if (filter.edgeRelations!.includes(rel)) {
          matchE.add(String(e.id));
          if (e.from) matchN.add(String(e.from));
          if (e.to) matchN.add(String(e.to));
        }
      });
    }
    if (filter.edgeIds?.length) {
      const want = new Set(filter.edgeIds.map(String));
      allEdges.forEach((e) => {
        if (want.has(String(e.id))) {
          matchE.add(String(e.id));
          if (e.from) matchN.add(String(e.from));
          if (e.to) matchN.add(String(e.to));
        }
      });
    }
    if (filter.nodeIds?.length) {
      const seeds = new Set(filter.nodeIds.map(String));
      seeds.forEach((id) => matchN.add(id));
      allEdges.forEach((e) => {
        const fr = e.from != null ? String(e.from) : "";
        const to = e.to != null ? String(e.to) : "";
        if (seeds.has(fr) || seeds.has(to)) {
          matchE.add(String(e.id));
          if (fr) matchN.add(fr);
          if (to) matchN.add(to);
        }
      });
    }
    // 边类图例：命中边的两端纳入高亮；实体类图例不扩展异类邻居
    if (!nodeKindOnly) {
      matchE.forEach((eid) => {
        const e = allEdges.find((x) => String(x.id) === eid);
        if (e?.from) matchN.add(String(e.from));
        if (e?.to) matchN.add(String(e.to));
      });
    }
    nDS.update(
      allNodes.map((n) => {
        const hit = matchN.has(String(n.id));
        if (solo) {
          return {
            id: n.id,
            hidden: !hit,
            opacity: 1,
            color: {
              background: n._bg,
              border: n._border,
              highlight: { background: n._bg, border: "#fff" },
            },
            font: { ...(n.font as object), color: n._fontColor || "#e8edf5" },
          };
        }
        return {
          id: n.id,
          hidden: false,
          opacity: hit ? n._baseOpacity ?? 1 : HL_DIM,
          color: {
            background: hit ? n._bg : HL_NODE_FADE_BG,
            border: hit ? n._border : HL_NODE_FADE_BORDER,
            highlight: { background: hit ? n._bg : HL_NODE_FADE_BG, border: "#fff" },
          },
          font: { ...(n.font as object), color: hit ? n._fontColor || "#e8edf5" : HL_FONT_FADE },
        };
      }) as any
    );
    eDS.update(
      allEdges.map((e) => {
        const hit = matchE.has(String(e.id));
        const baseW =
          typeof (e as any)._baseWidth === "number"
            ? (e as any)._baseWidth
            : typeof (e as any).width === "number"
              ? (e as any).width
              : 1.5;
        if (solo) {
          return {
            id: e.id,
            hidden: !hit,
            opacity: 1,
            width: baseW,
            color: { color: e._edgeColor, highlight: "#fff", opacity: 1 },
            font: { ...(e.font as object), color: e._fontColor || "#8b97a8", strokeWidth: 0 },
          };
        }
        // 未命中边淡化（轻度，仍可辨认）
        return {
          id: e.id,
          hidden: false,
          opacity: hit ? 1 : 0.38,
          width: hit ? Math.max(baseW, 2.2) : Math.max(0.9, baseW * 0.7),
          color: {
            color: hit ? e._edgeColor : HL_EDGE_FADE,
            highlight: hit ? "#ffffff" : HL_EDGE_FADE,
            hover: hit ? e._edgeColor : HL_EDGE_FADE,
            opacity: hit ? 1 : 0.38,
          },
          font: {
            ...(e.font as object),
            color: hit ? e._fontColor || "#8b97a8" : HL_FONT_FADE,
            strokeWidth: 0,
          },
        };
      }) as any
    );
    try {
      netRef.current?.redraw();
    } catch {
      /* ignore */
    }
  };

  const syncInPlace = (st: PipelineStage, opts?: { freezePositions?: boolean }) => {
    const net = netRef.current;
    const nDS = nodeDS.current;
    const eDS = edgeDS.current;
    if (!net || !nDS || !eDS) return false;
    const freeze = opts?.freezePositions !== false;
    snapshot();
    net.setOptions({ physics: false });
    const mode = payload.mode;
    const rawEdges = stageEdgesForDisplay(mode, st, hideFiltered);
    const visNodes = buildVisNodes(st, stageNodesForDisplay(mode, st, rawEdges, hideFiltered));
    const visEdges = buildVisEdges(rawEdges);
    if (freeze) {
      // 过滤切换：沿用首次布局的曲线，避免平行边重排导致边“跳动”
      // 若缓存为空（极少见），用全量边重算一次再套用
      if (Object.keys(edgeSmoothCacheRef.current).length === 0) {
        const allVis = buildVisEdges(stageEdgesForDisplay(mode, st, false));
        assignParallelCurves(allVis);
        cacheEdgeSmooth(allVis);
      }
      applyCachedEdgeSmooth(visEdges);
      const missing = visEdges.filter((e) => e.smooth == null);
      if (missing.length) {
        // 仍缺缓存时单独补算，但不影响已有边
        missing.forEach((e) => {
          e.smooth = { enabled: true, type: "continuous", roundness: 0.35 };
        });
        cacheEdgeSmooth(missing);
      }
    } else {
      assignParallelCurves(visEdges);
      cacheEdgeSmooth(visEdges);
    }
    assignElasticSprings(visNodes, visEdges);
    if (!freeze) {
      seedClusterCircleLayout(visNodes, visEdges);
    }

    const haveN = new Set((nDS.getIds() as string[]).map(String));
    const haveE = new Set((eDS.getIds() as string[]).map(String));
    const wantN = new Set(visNodes.map((n) => String(n.id)));
    const wantE = new Set(visEdges.map((e) => String(e.id)));

    // 先移除边再移除节点，避免悬空
    eDS.remove((eDS.getIds() as string[]).filter((id) => !wantE.has(String(id))));
    nDS.remove((nDS.getIds() as string[]).filter((id) => !wantN.has(String(id))));

    // 已有节点：只用缓存/实时坐标；冻结时不改 x/y，避免过滤切换抖动
    let livePos: Record<string, { x: number; y: number }> = {};
    try {
      livePos = net.getPositions(visNodes.map((n) => n.id)) as Record<
        string,
        { x: number; y: number }
      >;
    } catch {
      livePos = {};
    }

    const addN: VisNode[] = [];
    const updN: any[] = [];
    const newIds = new Set<string>();
    visNodes.forEach((n) => {
      const id = String(n.id);
      const cached = posCacheRef.current[id] || livePos[id];
      if (cached) {
        n.x = cached.x;
        n.y = cached.y;
      }
      if (haveN.has(id)) {
        const patch: Record<string, unknown> = {
          id: n.id,
          label: n.label,
          title: n.title,
          size: n.size,
          _kind: n._kind,
          _bg: n._bg,
          _border: n._border,
          _fontColor: n._fontColor,
          _baseOpacity: n._baseOpacity,
          font: n.font,
          color: n.color,
          borderWidth: n.borderWidth,
          opacity: n.opacity,
          importance: n.importance,
          importance_base: n.importance_base,
          importance_delta: n.importance_delta,
        };
        if (!freeze && cached) {
          patch.x = cached.x;
          patch.y = cached.y;
        }
        updN.push(patch);
      } else {
        newIds.add(id);
        addN.push(n);
      }
    });

    if (addN.length) {
      applyCachedPositions(addN, posCacheRef.current);
      const stillNeed = addN.filter((n) => n.x == null || n.y == null);
      if (stillNeed.length) placeUncachedNodes(stillNeed, visEdges);
      // 只疏导新节点，不动已有布局
      resolveNodeOverlaps(visNodes, newIds);
    }
    if (updN.length) nDS.update(updN);
    if (addN.length) nDS.add(addN);

    const addE: VisEdge[] = [];
    const updE: any[] = [];
    visEdges.forEach((e) => {
      if (haveE.has(String(e.id))) {
        const patch: Record<string, unknown> = {
          id: e.id,
          from: e.from,
          to: e.to,
          label: e.label,
          title: e.title,
          color: e.color,
          width: e.width,
          dashes: e.dashes,
          font: e.font,
          arrows: e.arrows,
          _source: e._source,
          _relation: e._relation,
          _edgeColor: e._edgeColor,
          _fontColor: e._fontColor,
        };
        // 冻结布局时不改 smooth，保持边的视觉位置
        if (!freeze) patch.smooth = e.smooth;
        updE.push(patch);
      } else {
        addE.push(e);
      }
    });
    if (updE.length) eDS.update(updE);
    if (addE.length) {
      cacheEdgeSmooth(addE);
      eDS.add(addE);
    }
    snapshot();
    return true;
  };

  const resolveActiveHighlight = (): HlFilter | null => {
    const edgeIds =
      focusEdgeIds && focusEdgeIds.length > 0
        ? focusEdgeIds
        : selectedEdgeId
          ? [selectedEdgeId]
          : null;
    if (edgeIds?.length) {
      return {
        key: "_edge_focus",
        label: "边聚焦",
        color: "#3ecf8e",
        edgeIds: edgeIds.map(String),
      };
    }
    if (selectedNodeId) {
      return {
        key: "_node_focus",
        label: "实体聚焦",
        color: "#3ecf8e",
        nodeIds: [String(selectedNodeId)],
      };
    }
    // 处理类等自定义图例：计数时不能用 hideFiltered（process_* 默认隐藏）
    const catalog =
      highlightFilters && highlightFilters.length
        ? highlightFilters
        : stageHighlightFilters(stage, payload.mode, payload.lecture_ids || []);
    const filters = catalog.filter((f) => {
      const isProcess =
        f.group === "处理类" ||
        (f.edgeSources || []).some((s) => String(s).startsWith("process_"));
      return filterHasMatches(
        payload.mode,
        stage,
        f,
        isProcess ? false : hideFiltered
      );
    });
    return filters.find((f) => f.key === highlightKey) || null;
  };

  const syncGraphSelection = () => {
    const net = netRef.current;
    if (!net) return;
    try {
      const edgeIds =
        focusEdgeIds && focusEdgeIds.length > 0
          ? focusEdgeIds.map(String)
          : selectedEdgeId
            ? [String(selectedEdgeId)]
            : [];
      if (edgeIds.length) {
        const nodeIds = new Set<string>();
        const eDS = edgeDS.current;
        edgeIds.forEach((id) => {
          const e = eDS?.get(id) as VisEdge | null;
          if (e?.from) nodeIds.add(String(e.from));
          if (e?.to) nodeIds.add(String(e.to));
        });
        net.setSelection({ nodes: [...nodeIds], edges: edgeIds });
        return;
      }
      if (selectedNodeId) {
        const nid = String(selectedNodeId);
        const adj: string[] = [];
        const eDS = edgeDS.current;
        if (eDS) {
          (eDS.get() as VisEdge[]).forEach((e) => {
            if (String(e.from) === nid || String(e.to) === nid) adj.push(String(e.id));
          });
        }
        net.setSelection({ nodes: [nid], edges: adj });
        return;
      }
      net.unselectAll();
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (stage.focus === "text" || stage.id === "seeds") {
      if (netRef.current) {
        netRef.current.destroy();
        netRef.current = null;
        nodeDS.current = null;
        edgeDS.current = null;
      }
      return;
    }
    if (!hostRef.current) return;

    const mode = payload.mode;
    const previewEdges = stageEdgesForDisplay(mode, stage, hideFiltered);
    const previewNodes = stageNodesForDisplay(
      mode,
      stage,
      previewEdges,
      hideFiltered
    );
    const haveIds = nodeDS.current
      ? (nodeDS.current.getIds() as string[]).map(String)
      : [];
    const haveSet = new Set(haveIds);
    let addedCount = 0;
    for (const n of previewNodes) {
      if (!haveSet.has(String(n.id))) addedCount += 1;
    }
    const forceFullLayout =
      !!netRef.current &&
      shouldRelayoutForNodeGrowth(haveIds.length, addedCount);

    if (forceFullLayout) {
      posCacheRef.current = {};
      edgeSmoothCacheRef.current = {};
      viewRef.current = null;
      stageIdRef.current = "";
    }

    const canKeep =
      !forceFullLayout &&
      keepLayout &&
      payload.mode === "session" &&
      netRef.current &&
      nodeDS.current &&
      edgeDS.current &&
      stageIdRef.current !== "";

    if (canKeep) {
      syncInPlace(stage, { freezePositions: true });
      stageIdRef.current = stage.id;
      applyHighlight(resolveActiveHighlight());
      return;
    }

    // 同一步内切换「隐藏过滤边」等：原地增删边/节点，保持坐标
    // 节点明显增多（如重要性从「去掉零分」回到「全部」）则走下方整图重布局
    if (
      !forceFullLayout &&
      netRef.current &&
      nodeDS.current &&
      edgeDS.current &&
      stageIdRef.current === stage.id
    ) {
      syncInPlace(stage, { freezePositions: true });
      applyHighlight(resolveActiveHighlight());
      return;
    }

    // 先对「全部边」算平行曲线并缓存，再按 hideFiltered 取子集，保证切换时曲线不变
    const allRawEdges = stageEdgesForDisplay(mode, stage, false);
    const allVisEdges = buildVisEdges(allRawEdges);
    assignParallelCurves(allVisEdges);

    if (netRef.current) {
      netRef.current.destroy();
      netRef.current = null;
    }
    // lecture 切步骤 / 强制重布局：清空坐标与边曲线缓存
    if (mode !== "session" || forceFullLayout) {
      posCacheRef.current = {};
      edgeSmoothCacheRef.current = {};
    }
    cacheEdgeSmooth(allVisEdges);

    const rawEdges = stageEdgesForDisplay(mode, stage, hideFiltered);
    const nodes = buildVisNodes(stage, stageNodesForDisplay(mode, stage, rawEdges, hideFiltered));
    const edges = buildVisEdges(rawEdges);
    applyCachedEdgeSmooth(edges);
    assignElasticSprings(nodes, edges);

    const reuse =
      !forceFullLayout &&
      mode === "session" &&
      Object.keys(posCacheRef.current).length > 0;
    if (!reuse) {
      // 全新布局：丢掉旧视口，避免把上一图的缩放套到新图上
      viewRef.current = null;
      seedClusterCircleLayout(nodes, edges);
    }
    if (reuse) {
      applyCachedPositions(nodes, posCacheRef.current);
      placeUncachedNodes(nodes, edges);
      resolveNodeOverlaps(nodes, null);
    }

    nodeDS.current = new DataSet(nodes as any);
    edgeDS.current = new DataSet(edges as any);
    const net = new Network(
      hostRef.current,
      { nodes: nodeDS.current as any, edges: edgeDS.current as any },
      graphLayoutOptions(stage, !reuse) as any
    );
    netRef.current = net;
    stageIdRef.current = stage.id;

    net.on("click", (params: any) => {
      if (params.nodes?.length) {
        const id = String(params.nodes[0]);
        const meta = (nodeDS.current?.get(id) as unknown as VisNode | null) || {
          id,
          label: id.split("/")[0] || id,
        };
        // 只通知节点选中；由页面在 id!=null 时清边，避免 onSelectEdge(null) 误清节点
        const sourceEvent = params.event?.srcEvent || params.event;
        onSelectNodeRef.current(id, meta, {
          clientX: Number(sourceEvent?.clientX || 0),
          clientY: Number(sourceEvent?.clientY || 0),
        });
        return;
      }
      if (params.edges?.length) {
        onSelectEdgeRef.current(String(params.edges[0]));
        return;
      }
      onSelectNodeRef.current(null);
      onSelectEdgeRef.current(null);
    });
    net.on("oncontext", (params: any) => {
      params.event?.preventDefault?.();
      const id = net.getNodeAt(params.pointer?.DOM);
      if (id == null) return;
      const nodeId = String(id);
      const meta = (nodeDS.current?.get(nodeId) as unknown as VisNode | null) || {
        id: nodeId,
        label: nodeId.split("/")[0] || nodeId,
      };
      const sourceEvent = params.event?.srcEvent || params.event;
      onContextNodeRef.current?.(nodeId, meta, {
        clientX: Number(sourceEvent?.clientX || 0),
        clientY: Number(sourceEvent?.clientY || 0),
      });
    });
    net.on("dragEnd", () => {
      snapshot();
      captureView();
    });
    net.on("zoom", () => captureView());
    net.on("controlNodeDragEnd", () => captureView());

    if (reuse) {
      net.setOptions({ physics: false });
      snapshot();
      restoreView();
    } else {
      net.once("stabilizationIterationsDone", () => {
        net.setOptions({ physics: false });
        snapshot();
        try {
          const live = nodeDS.current!.get() as VisNode[];
          const liveEdges = (edgeDS.current?.get() as VisEdge[]) || [];
          const pos = net.getPositions(live.map((n) => n.id));
          live.forEach((n) => {
            const p = pos[n.id];
            if (p) {
              n.x = p.x;
              n.y = p.y;
            }
          });
          if (stage.id === "seeds") {
            resolveNodeOverlaps(live, null);
          } else {
            reduceEdgeCrossings(live, liveEdges);
          }
          nodeDS.current!.update(
            live.filter((n) => n.x != null).map((n) => ({ id: n.id, x: n.x, y: n.y })) as any
          );
          snapshot();
        } catch {
          /* ignore */
        }
        try {
          net.fit({
            animation: {
              duration: stage.id === "seeds" ? 280 : 320,
              easingFunction: "easeInOutQuad",
            },
          });
        } catch {
          /* ignore */
        }
        captureView();
      });
    }

    applyHighlight(resolveActiveHighlight());

    return () => {
      /* keep network across stage updates; destroy on unmount only via empty dep cleanup below */
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, hideFiltered, payload.mode, keepLayout, highlightMode]);

  useEffect(() => {
    applyHighlight(resolveActiveHighlight());
    syncGraphSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    highlightKey,
    highlightFilters,
    highlightMode,
    focusEdgeIds,
    selectedEdgeId,
    selectedNodeId,
    hideFiltered,
  ]);

  // 仅响应搜索触发的一次性居中；消费后通知父级清空，避免点选/重挂载再次居中
  useEffect(() => {
    const req = focusNodeRequest;
    if (!req?.id) return;
    const net = netRef.current;
    const id = String(req.id);
    const run = () => {
      try {
        if (net) {
          const pos = net.getPositions([id]);
          if (pos[id] && pos[id].x != null) {
            const cur = net.getScale();
            const targetScale = Math.min(1.85, Math.max(cur < 0.85 ? 1.2 : cur, 1.05));
            net.focus(id, {
              scale: targetScale,
              locked: false,
              animation: { duration: 480, easingFunction: "easeInOutQuad" },
            });
            window.setTimeout(() => captureView(), 520);
          }
        }
      } catch {
        /* ignore */
      } finally {
        onFocusConsumedRef.current?.();
      }
    };
    const t = window.setTimeout(run, 40);
    return () => window.clearTimeout(t);
  }, [focusNodeRequest]);

  useEffect(() => {
    return () => {
      netRef.current?.destroy();
      netRef.current = null;
    };
  }, []);

  // 容器尺寸变化后只改画布大小并重绘，并恢复已记录的视口（不 fit 全图）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      const w = Math.round(cr.width);
      const h = Math.round(cr.height);
      if (w < 8 || h < 8) return;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      const net = netRef.current;
      if (!net) return;
      try {
        captureView();
        net.setSize(`${w}px`, `${h}px`);
        net.redraw();
        restoreView();
      } catch {
        /* ignore */
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [stage.id]);

  if (stage.id === "seeds") {
    return <SeedTextCompare stage={stage} />;
  }

  if (stage.focus === "text") {
    if (stage.text_compare || stage.id === "asr" || stage.id === "preprocess") {
      return <AsrTextCompare stage={stage} />;
    }
    return <LatexText text={stage.text || ""} className="text-panel" />;
  }

  const graphPane = (
    <div className={styles.graphPane}>
      <div ref={hostRef} className="graph-host" />
      {legend}
    </div>
  );

  // 修正 / 增量 / 融合 / 会话：左原文划线+关系浮层，右图谱
  // 需有 stage.text 或 text_sections；课堂 KG 复用 merge id 但无正文，避免再套一层双栏
  const sections = (stage.text_sections || []).filter((s) => (s.text || "").trim());
  const hasBody = Boolean((stage.text || "").trim() || sections.length);
  const isSessionGraph =
    payload.mode === "session" &&
    (stage.id === "session_merge" || String(stage.id).startsWith("lecture_"));
  const textGraph = hasBody
    ? stage.id === "correct" || String(stage.id).startsWith("correct")
      ? ({ storageKey: "split-pipeline-correct-v2", tone: "old" as const, label: "课堂原文 · 悬停划线查看关系" })
      : stage.id === "textbook" || String(stage.id).startsWith("textbook")
        ? ({
            storageKey: "split-pipeline-textbook-v1",
            tone: "new" as const,
            label: "处理原文 · 点边高亮课堂依据",
          })
      : stage.id === "delta" || String(stage.id).startsWith("delta")
        ? ({ storageKey: "split-pipeline-delta-v2", tone: "new" as const, label: "课堂原文 · 悬停划线查看关系" })
        : stage.id === "merge" || String(stage.id).startsWith("merge")
          ? ({ storageKey: "split-pipeline-merge-v2", tone: "new" as const, label: "课堂原文 · 悬停划线查看关系" })
          : stage.id === "cross_cue"
            ? ({
                storageKey: "split-pipeline-cross-v1",
                tone: "new" as const,
                label: "跨段窗口文本 · 多段拼接",
              })
          : isSessionGraph
            ? ({
                storageKey: "split-pipeline-session-v1",
                tone: "new" as const,
                label:
                  sections.length > 1
                    ? "一堂课处理文本 · 大标题区分讲次"
                    : "处理文本 · 悬停划线查看关系",
              })
            : null
    : null;

  if (textGraph) {
    return (
      <ResizableSplit
        storageKey={textGraph.storageKey}
        initialLeftRatio={0.5}
        minLeftPx={240}
        minRightPx={280}
        leftClassName={correctStyles.textCol}
        rightClassName={correctStyles.graphCol}
        left={
          <>
            <div className={correctStyles.textLabel}>{textGraph.label}</div>
            {stage.id === "textbook" || String(stage.id).startsWith("textbook") ? (
              <div className={correctStyles.hlLegend} aria-hidden>
                <span className={correctStyles.legEvidence}>写入边 · 课堂依据</span>
                <span className={correctStyles.legHint}>点右图边或划线查看</span>
              </div>
            ) : null}
            <div className={correctStyles.textBody}>
              {sections.length > 0 ? (
                sections.map((sec, i) => (
                  <section key={`${sec.lectureId || sec.heading}-${i}`} className={correctStyles.lecSection}>
                    {sec.heading ? (
                      <h2 className={correctStyles.lecHeading}>
                        {sec.heading}
                        <em>处理文本</em>
                      </h2>
                    ) : null}
                    {(stage.edges || []).length > 0 ? (
                      <SliceTextAnnotator
                        text={sec.text || ""}
                        edges={stage.edges || []}
                        selectedEdgeId={selectedEdgeId}
                        focusEdgeIds={focusEdgeIds}
                        onSelectEdge={(id, groupIds) => onSelectEdge(id, groupIds)}
                        tone={textGraph.tone}
                      />
                    ) : (
                      <LatexText text={sec.text || ""} className="text-panel" />
                    )}
                  </section>
                ))
              ) : (stage.edges || []).length > 0 ? (
                <SliceTextAnnotator
                  text={stage.text || ""}
                  edges={stage.edges || []}
                  selectedEdgeId={selectedEdgeId}
                  focusEdgeIds={focusEdgeIds}
                  onSelectEdge={(id, groupIds) => onSelectEdge(id, groupIds)}
                  tone={textGraph.tone}
                />
              ) : (
                <CorrectSourceHighlight
                  mode={textGraph.tone === "old" ? "correct" : "evidence"}
                  evidenceLabel="课堂依据"
                  text={stage.text || ""}
                />
              )}
            </div>
          </>
        }
        right={graphPane}
      />
    );
  }

  return graphPane;
}

export const GraphCanvas = forwardRef(GraphCanvasInner);
GraphCanvas.displayName = "GraphCanvas";
