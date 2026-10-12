import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ForwardedRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { DataSet } from "vis-data";
import { Network } from "vis-network";
import type { PipelinePayload, PipelineStage } from "@/lib/graph/types";
import { exportVisNetworkPng } from "@/lib/graph/exportVisNetworkPng";
import {
  applyCachedPositions,
  assignElasticSprings,
  assignParallelCurves,
  buildVisEdges,
  buildVisNodes,
  filterHasMatches,
  forceAtlas2KgPhysics,
  graphLayoutOptions,
  graphHighlightChrome,
  placeUncachedNodes,
  reduceEdgeCrossings,
  resolveNodeOverlaps,
  shortenLongEdges,
  seedClusterCircleLayout,
  stageEdgesForDisplay,
  stageHighlightFilters,
  stageNodesForDisplay,
  type HlFilter,
  type VisEdge,
  type VisNode,
} from "@/lib/graph/graphLogic";
import { CorrectSourceHighlight } from "./CorrectSourceHighlight";
import { LatexText } from "./LatexText";
import { ResizableSplit } from "./ResizableSplit";
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
  /**
   * 稳定后继续力导向（类 Neo4j 拖拽联动）。
   * 适合讲次/课次（~30–150 节点）；整课总览应关闭。
   */
  livePhysics?: boolean;
  /**
   * 过滤收紧时隐藏节点/边（保留坐标），放宽时再显示；
   * 与 forceRelayoutToken 配合：累计变更过大时整图重画。
   */
  softFilterHide?: boolean;
  /** 递增时强制整图重布局（清空坐标缓存） */
  forceRelayoutToken?: number;
  /** 为 true 时同 stage 过滤变化也整图重画（整课 >500 节点） */
  preferFullRelayout?: boolean;
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
  onContextEdge?: (
    id: string,
    meta: VisEdge,
    point: { clientX: number; clientY: number },
  ) => void;
};

/**
 * 重要性从紧到松会突然补回节点。旧逻辑清空坐标缓存再整图力导向，
 * 容易把图「揉成一团」；改为始终走原地增补（保留缓存坐标）。
 */
function shouldRelayoutForNodeGrowth(_haveCount: number, _addedCount: number): boolean {
  return false;
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
    livePhysics = false,
    softFilterHide = false,
    forceRelayoutToken = 0,
    preferFullRelayout = false,
    selectedEdgeId = null,
    focusEdgeIds = null,
    selectedNodeId = null,
    focusNodeRequest = null,
    onFocusNodeConsumed,
    legend = null,
    onSelectNode,
    onSelectEdge,
    onContextNode,
    onContextEdge,
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
  const onContextEdgeRef = useRef(onContextEdge);
  const onFocusConsumedRef = useRef(onFocusNodeConsumed);
  const livePhysicsRef = useRef(livePhysics);
  const softFilterHideRef = useRef(softFilterHide);
  const preferFullRelayoutRef = useRef(preferFullRelayout);
  const lastForceTokenRef = useRef(forceRelayoutToken);
  /** 软过滤隐藏的 id；applyHighlight 不得把它们重新显示（兼容旧路径） */
  const softHiddenNodesRef = useRef<Set<string>>(new Set());
  const softHiddenEdgesRef = useRef<Set<string>>(new Set());
  /** 软过滤暂存：移出 DataSet 但保留坐标，升高过滤时原位加回 */
  const softParkedNodesRef = useRef<Map<string, VisNode>>(new Map());
  const softParkedEdgesRef = useRef<Map<string, VisEdge>>(new Map());
  const settlePulseTimerRef = useRef<number | null>(null);
  /** 动态调整最长时限；到期冻住当前坐标并关物理 */
  const LIVE_PHYSICS_MAX_MS = 1000;
  const livePhysicsCapTimerRef = useRef<number | null>(null);
  /** 用户/搜索视口：缩放平移后记住，避免改布局尺寸时被冲掉 */
  const viewRef = useRef<{ scale: number; position: { x: number; y: number } } | null>(
    null
  );
  onSelectNodeRef.current = onSelectNode;
  onSelectEdgeRef.current = onSelectEdge;
  onContextNodeRef.current = onContextNode;
  onContextEdgeRef.current = onContextEdge;
  onFocusConsumedRef.current = onFocusNodeConsumed;
  livePhysicsRef.current = livePhysics;
  softFilterHideRef.current = softFilterHide;
  preferFullRelayoutRef.current = preferFullRelayout;

  const clearLivePhysicsCap = () => {
    if (livePhysicsCapTimerRef.current != null) {
      window.clearTimeout(livePhysicsCapTimerRef.current);
      livePhysicsCapTimerRef.current = null;
    }
  };

  /** 冻住当前布局：关物理、写入坐标缓存 */
  const freezePhysicsNow = (net: Network) => {
    clearLivePhysicsCap();
    if (settlePulseTimerRef.current != null) {
      window.clearTimeout(settlePulseTimerRef.current);
      settlePulseTimerRef.current = null;
    }
    snapshot();
    try {
      net.setOptions({ physics: false });
    } catch {
      /* ignore */
    }
  };

  /** 每次启动动态调整时重新计 1 秒；到期自动冻住 */
  const armLivePhysicsCap = (net: Network) => {
    clearLivePhysicsCap();
    livePhysicsCapTimerRef.current = window.setTimeout(() => {
      livePhysicsCapTimerRef.current = null;
      const n = netRef.current;
      if (n) freezePhysicsNow(n);
    }, LIVE_PHYSICS_MAX_MS);
  };

  const applyPhysicsPolicy = (net: Network, opts?: { afterStabilize?: boolean }) => {
    if (livePhysicsRef.current) {
      // 持续力导向：关闭 stabilization，避免拖拽时反复「冻住」
      const phys = forceAtlas2KgPhysics(true, true);
      phys.stabilization = { enabled: false, iterations: 0, fit: false };
      net.setOptions({ physics: phys as any });
      armLivePhysicsCap(net);
      return;
    }
    clearLivePhysicsCap();
    if (opts?.afterStabilize !== false) {
      net.setOptions({ physics: false });
    }
  };

  /** 过滤增减后短脉冲力导向，让剩余节点像单课一样收拢/让位（最长 1 秒） */
  const pulsePhysicsSettle = (net: Network) => {
    if (settlePulseTimerRef.current != null) {
      window.clearTimeout(settlePulseTimerRef.current);
      settlePulseTimerRef.current = null;
    }
    const phys = forceAtlas2KgPhysics(true, true);
    phys.stabilization = { enabled: true, iterations: 90, fit: false };
    net.setOptions({ physics: phys as any });
    armLivePhysicsCap(net);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        net.off("stabilizationIterationsDone", finish);
      } catch {
        /* ignore */
      }
      if (settlePulseTimerRef.current != null) {
        window.clearTimeout(settlePulseTimerRef.current);
        settlePulseTimerRef.current = null;
      }
      freezePhysicsNow(net);
    };
    net.once("stabilizationIterationsDone", finish);
    settlePulseTimerRef.current = window.setTimeout(finish, LIVE_PHYSICS_MAX_MS);
  };

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
    const hl = graphHighlightChrome();
    if (!nDS || !eDS) return;
    const allNodes = nDS.get() as VisNode[];
    const allEdges = eDS.get() as VisEdge[];
    const solo = highlightMode === "solo";
    const softN = softHiddenNodesRef.current;
    const softE = softHiddenEdgesRef.current;
    if (!filter) {
      nDS.update(
        allNodes.map((n) => ({
          id: n.id,
          hidden: softN.has(String(n.id)),
          opacity: n._baseOpacity ?? 1,
          color: {
            background: n._bg,
            border: n._border,
            highlight: { background: n._bg, border: hl.highlightBorder },
          },
          font: { ...(n.font as object), color: n._fontColor || hl.fontHit },
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
            hidden: softE.has(String(e.id)),
            opacity: 1,
            width: baseW,
            color: { color: e._edgeColor, highlight: hl.highlightBorder, opacity: 1 },
            font: { ...(e.font as object), color: e._fontColor || hl.edgeFont, strokeWidth: 0 },
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
        const id = String(n.id);
        const hit = matchN.has(id);
        const softHidden = softN.has(id);
        if (solo) {
          return {
            id: n.id,
            hidden: softHidden || !hit,
            opacity: 1,
            color: {
              background: n._bg,
              border: n._border,
              highlight: { background: n._bg, border: hl.highlightBorder },
            },
            font: { ...(n.font as object), color: n._fontColor || hl.fontHit },
          };
        }
        return {
          id: n.id,
          hidden: softHidden,
          opacity: hit ? n._baseOpacity ?? 1 : hl.dim,
          color: {
            background: hit ? n._bg : hl.nodeFadeBg,
            border: hit ? n._border : hl.nodeFadeBorder,
            highlight: { background: hit ? n._bg : hl.nodeFadeBg, border: hl.highlightBorder },
          },
          font: { ...(n.font as object), color: hit ? n._fontColor || hl.fontHit : hl.fontFade },
        };
      }) as any
    );
    eDS.update(
      allEdges.map((e) => {
        const id = String(e.id);
        const hit = matchE.has(id);
        const softHidden = softE.has(id);
        const baseW =
          typeof (e as any)._baseWidth === "number"
            ? (e as any)._baseWidth
            : typeof (e as any).width === "number"
              ? (e as any).width
              : 1.5;
        if (solo) {
          return {
            id: e.id,
            hidden: softHidden || !hit,
            opacity: 1,
            width: baseW,
            color: { color: e._edgeColor, highlight: hl.highlightBorder, opacity: 1 },
            font: { ...(e.font as object), color: e._fontColor || hl.edgeFont, strokeWidth: 0 },
          };
        }
        // 未命中边淡化（轻度，仍可辨认）；宽度保持统一
        return {
          id: e.id,
          hidden: softHidden,
          opacity: hit ? 1 : 0.38,
          width: baseW,
          color: {
            color: hit ? e._edgeColor : hl.edgeFade,
            highlight: hit ? hl.highlightBorder : hl.edgeFade,
            hover: hit ? e._edgeColor : hl.edgeFade,
            opacity: hit ? 1 : 0.38,
          },
          font: {
            ...(e.font as object),
            color: hit ? e._fontColor || hl.edgeFont : hl.fontFade,
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
    if (!livePhysicsRef.current) {
      net.setOptions({ physics: false });
    }
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
    const softHide = softFilterHideRef.current;
    let softTopologyChanged = false;

    if (softHide) {
      // 暂存并移出 DataSet（与单课删点一样触发重排）；升高时按坐标加回
      softHiddenNodesRef.current.clear();
      softHiddenEdgesRef.current.clear();
      let allPos: Record<string, { x: number; y: number }> = {};
      try {
        allPos = net.getPositions([...haveN]) as Record<string, { x: number; y: number }>;
      } catch {
        allPos = {};
      }
      const dropN = [...haveN].filter((id) => !wantN.has(id));
      const dropE = [...haveE].filter((id) => !wantE.has(id));
      for (const id of dropN) {
        const raw = nDS.get(id) as VisNode | null;
        if (!raw) continue;
        const p = allPos[id] || posCacheRef.current[id];
        if (p) {
          posCacheRef.current[id] = { x: p.x, y: p.y };
          softParkedNodesRef.current.set(id, {
            ...raw,
            x: p.x,
            y: p.y,
            hidden: false,
          });
        } else {
          softParkedNodesRef.current.set(id, { ...raw, hidden: false });
        }
      }
      for (const id of dropE) {
        const raw = eDS.get(id) as VisEdge | null;
        if (raw) softParkedEdgesRef.current.set(id, { ...raw, hidden: false });
      }
      if (dropE.length) eDS.remove(dropE);
      if (dropN.length) nDS.remove(dropN);
      if (dropN.length || dropE.length) softTopologyChanged = true;
    } else {
      softHiddenNodesRef.current.clear();
      softHiddenEdgesRef.current.clear();
      softParkedNodesRef.current.clear();
      softParkedEdgesRef.current.clear();
      // 先移除边再移除节点，避免悬空
      eDS.remove((eDS.getIds() as string[]).filter((id) => !wantE.has(String(id))));
      nDS.remove((nDS.getIds() as string[]).filter((id) => !wantN.has(String(id))));
    }

    const haveNNow = new Set((nDS.getIds() as string[]).map(String));
    const haveENow = new Set((eDS.getIds() as string[]).map(String));

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
      const parked = softParkedNodesRef.current.get(id);
      if (parked) softParkedNodesRef.current.delete(id);
      const cached =
        posCacheRef.current[id] ||
        livePos[id] ||
        (parked && parked.x != null && parked.y != null
          ? { x: Number(parked.x), y: Number(parked.y) }
          : undefined);
      if (cached) {
        n.x = cached.x;
        n.y = cached.y;
      }
      if (haveNNow.has(id)) {
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
          hidden: false,
        };
        if (!freeze && cached) {
          patch.x = cached.x;
          patch.y = cached.y;
        }
        updN.push(patch);
      } else {
        newIds.add(id);
        addN.push({ ...n, hidden: false });
        softTopologyChanged = true;
      }
    });

    if (addN.length) {
      applyCachedPositions(addN, posCacheRef.current);
      const stillNeed = addN.filter((n) => n.x == null || n.y == null);
      if (stillNeed.length) placeUncachedNodes(stillNeed, visEdges);
      // 新节点：先疏导重叠，再把过长边拉短，最后再疏导一轮
      resolveNodeOverlaps(visNodes, newIds);
      shortenLongEdges(visNodes, visEdges, newIds, 150);
      resolveNodeOverlaps(visNodes, newIds);
      if (newIds.size >= 4) {
        shortenLongEdges(visNodes, visEdges, null, 170);
        resolveNodeOverlaps(visNodes, null);
        visNodes.forEach((n) => {
          const id = String(n.id);
          if (!haveNNow.has(id) || n.x == null || n.y == null) return;
          if (newIds.has(id)) return;
          updN.push({ id: n.id, x: n.x, y: n.y });
        });
      }
    }
    if (updN.length) nDS.update(updN);
    if (addN.length) nDS.add(addN);

    const addE: VisEdge[] = [];
    const updE: any[] = [];
    visEdges.forEach((e) => {
      const eid = String(e.id);
      const parkedE = softParkedEdgesRef.current.get(eid);
      if (parkedE) softParkedEdgesRef.current.delete(eid);
      if (haveENow.has(eid)) {
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
          hidden: false,
        };
        // 冻结布局时不改 smooth，保持边的视觉位置
        if (!freeze) patch.smooth = e.smooth;
        updE.push(patch);
      } else {
        addE.push({ ...e, hidden: false });
        softTopologyChanged = true;
      }
    });
    if (updE.length) eDS.update(updE);
    if (addE.length) {
      cacheEdgeSmooth(addE);
      eDS.add(addE);
    }
    snapshot();
    // 软过滤增减：脉冲/持续力导向，收拢空洞（对齐单课删点动态）
    if (softHide && softTopologyChanged) {
      if (livePhysicsRef.current) applyPhysicsPolicy(net);
      else pulsePhysicsSettle(net);
    } else if (livePhysicsRef.current) {
      applyPhysicsPolicy(net);
    }
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
        color: graphHighlightChrome().highlightBorder,
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
        let adj: string[] = [];
        try {
          adj = ((net as any).getConnectedEdges?.(nid) || []).map(String);
        } catch {
          adj = [];
        }
        net.setSelection({ nodes: [nid], edges: adj });
        return;
      }
      net.unselectAll();
    } catch {
      /* ignore */
    }
  };

  // 用内容指纹而不是 stage 对象引用，避免父组件每次 render 新建 stage 触发全图 sync
  const stageSyncKey = useMemo(() => {
    const nodes = stage.nodes || [];
    const edges = stage.edges || [];
    let nAcc = 0;
    let eAcc = 0;
    for (let i = 0; i < nodes.length; i++) {
      const id = String(nodes[i]?.id || "");
      for (let j = 0; j < id.length; j++) nAcc = (nAcc * 33 + id.charCodeAt(j)) | 0;
    }
    for (let i = 0; i < edges.length; i++) {
      const id = String(edges[i]?.id || "");
      for (let j = 0; j < id.length; j++) eAcc = (eAcc * 33 + id.charCodeAt(j)) | 0;
    }
    return [
      stage.id,
      stage.focus || "",
      nodes.length,
      edges.length,
      nAcc,
      eAcc,
      hideFiltered ? 1 : 0,
      payload.mode,
      keepLayout ? 1 : 0,
      softFilterHide ? 1 : 0,
      preferFullRelayout ? 1 : 0,
      forceRelayoutToken,
      highlightMode || "",
    ].join("|");
  }, [
    stage,
    hideFiltered,
    payload.mode,
    keepLayout,
    softFilterHide,
    preferFullRelayout,
    forceRelayoutToken,
    highlightMode,
  ]);

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
    const tokenBump = forceRelayoutToken !== lastForceTokenRef.current;
    if (tokenBump) lastForceTokenRef.current = forceRelayoutToken;
    const forceFullLayout =
      !!netRef.current &&
      (tokenBump || shouldRelayoutForNodeGrowth(haveIds.length, addedCount));

    if (forceFullLayout) {
      posCacheRef.current = {};
      edgeSmoothCacheRef.current = {};
      viewRef.current = null;
      stageIdRef.current = "";
      softHiddenNodesRef.current.clear();
      softHiddenEdgesRef.current.clear();
      softParkedNodesRef.current.clear();
      softParkedEdgesRef.current.clear();
      if (settlePulseTimerRef.current != null) {
        window.clearTimeout(settlePulseTimerRef.current);
        settlePulseTimerRef.current = null;
      }
      clearLivePhysicsCap();
    }

    const canKeep =
      !forceFullLayout &&
      keepLayout &&
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

    // 同一步内切换「隐藏过滤边」等：原地增删；preferFullRelayout 时整图重画
    if (
      !forceFullLayout &&
      !preferFullRelayoutRef.current &&
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
    // 强制重布局或非「可保留布局」模式：清空坐标与边曲线缓存
    if (forceFullLayout || !keepLayout) {
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
      keepLayout &&
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
    const lite = nodes.length > 48 || edges.length > 120;
    const net = new Network(
      hostRef.current,
      { nodes: nodeDS.current as any, edges: edgeDS.current as any },
      graphLayoutOptions(stage, !reuse, { lite }) as any
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
      const sourceEvent = params.event?.srcEvent || params.event;
      const point = {
        clientX: Number(sourceEvent?.clientX || 0),
        clientY: Number(sourceEvent?.clientY || 0),
      };
      const nodeHit = net.getNodeAt(params.pointer?.DOM);
      if (nodeHit != null) {
        const nodeId = String(nodeHit);
        const meta = (nodeDS.current?.get(nodeId) as unknown as VisNode | null) || {
          id: nodeId,
          label: nodeId.split("/")[0] || nodeId,
        };
        onContextNodeRef.current?.(nodeId, meta, point);
        return;
      }
      const edgeHit = net.getEdgeAt(params.pointer?.DOM);
      if (edgeHit == null) return;
      const edgeId = String(edgeHit);
      const emeta = (edgeDS.current?.get(edgeId) as unknown as VisEdge | null) || {
        id: edgeId,
        from: "",
        to: "",
      };
      onContextEdgeRef.current?.(edgeId, emeta, point);
    });
    net.on("dragStart", (params: any) => {
      const ids = (params.nodes || []).map(String);
      if (!ids.length) return;
      // 冻住后拖节点：重新启动力导向，邻居跟着动（仍最长 1 秒）
      if (livePhysicsRef.current) {
        applyPhysicsPolicy(net);
      } else if (softFilterHideRef.current) {
        pulsePhysicsSettle(net);
      }
    });
    net.on("dragEnd", () => {
      snapshot();
      captureView();
    });
    net.on("zoom", () => captureView());
    net.on("controlNodeDragEnd", () => captureView());

    if (reuse) {
      applyPhysicsPolicy(net);
      snapshot();
      restoreView();
    } else {
      net.once("stabilizationIterationsDone", () => {
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
          // 持续物理时跳过硬性重叠修正，交给力导向消化
          if (!livePhysicsRef.current) {
            if (stage.id === "seeds") {
              resolveNodeOverlaps(live, null);
            } else if (live.length <= 48 && liveEdges.length <= 120) {
              reduceEdgeCrossings(live, liveEdges);
            }
            nodeDS.current!.update(
              live.filter((n) => n.x != null).map((n) => ({ id: n.id, x: n.x, y: n.y })) as any
            );
            snapshot();
          }
        } catch {
          /* ignore */
        }
        applyPhysicsPolicy(net, { afterStabilize: true });
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
  }, [stageSyncKey]);

  // 图例切换或点选：淡化未命中；stage 已 memo，点选不会再触发全图 syncInPlace
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
  // 搜索钉回过滤外节点时，需等 syncInPlace 把点加进 DataSet，故带短重试
  useEffect(() => {
    const req = focusNodeRequest;
    if (!req?.id) return;
    const id = String(req.id);
    let cancelled = false;
    let tries = 0;
    const attempt = () => {
      if (cancelled) return;
      const net = netRef.current;
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
            onFocusConsumedRef.current?.();
            return;
          }
        }
      } catch {
        /* ignore */
      }
      tries += 1;
      if (tries < 12) {
        window.setTimeout(attempt, 50);
      } else {
        onFocusConsumedRef.current?.();
      }
    };
    const t = window.setTimeout(attempt, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
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

  if (stage.focus === "text") {
    return <LatexText text={stage.text || ""} className="text-panel" />;
  }

  const graphPane = (
    <div className={styles.graphPane}>
      <div
        ref={hostRef}
        className="graph-host"
        onContextMenu={(e) => e.preventDefault()}
      />
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
