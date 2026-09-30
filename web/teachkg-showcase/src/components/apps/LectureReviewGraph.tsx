import { useEffect, useMemo, useRef, useState } from "react";
import { DataSet } from "vis-data";
import { Network } from "vis-network";
import { ReviewGraphDetailCard } from "@/components/apps/ReviewGraphDetailCard";
import { zhName, type AppReviewPoint } from "@/lib/apps/data";
import { loadReviewClassroomGraph } from "@/lib/apps/loadReviewClassroomGraph";
import {
  getImportanceSource,
  importanceSourceLabel,
  setImportanceSource,
  type ImportanceSource,
} from "@/lib/kg/importanceSource";
import { applyImportanceFilter } from "@/lib/kg/importanceFilter";
import {
  applyKgEdits,
  emptyKgEditPatch,
  fetchKgEdits,
  findOriginalEntityId,
  saveKgEdits,
  splitCanonicalName,
  withEntityRename,
  type EdgeEdit,
  type KgEditPatch,
} from "@/lib/kg/kgEdits";
import { ResizableSplit } from "@/components/pipeline/ResizableSplit";
import {
  DeletedItemsPanel,
  SelectionDetail,
} from "@/components/pipeline/SelectionPanels";
import type { AssetsLibrary } from "@/lib/kg/assetsLibrary";
import { courseDataUrl } from "@/lib/course";
import { exportVisNetworkPng } from "@/lib/pipeline/exportVisNetworkPng";
import {
  assignElasticSprings,
  assignParallelCurves,
  buildVisEdges,
  buildVisNodes,
  graphLayoutOptions,
  HL_EDGE_FADE,
  HL_FONT_FADE,
  HL_NODE_FADE_BG,
  HL_NODE_FADE_BORDER,
  reduceEdgeCrossings,
  RELATION_TYPE_FILTERS,
  seedClusterCircleLayout,
  type VisEdge,
  type VisNode,
} from "@/lib/pipeline/graphLogic";
import type { PipelineEdge, PipelineNode, PipelineStage } from "@/lib/pipeline/types";
import kgStyles from "@/pages/KgPage.module.css";
import styles from "./LectureReviewGraph.module.css";

type Props = {
  points: AppReviewPoint[];
  highlightIds?: string[];
  courseId: string;
  lectureId: string;
  onCollapse?: () => void;
  /** 点实体时传入知识点；点空白 / 关闭详情时传 null 以取消选中 */
  onSelectNode?: (point: AppReviewPoint | null) => void;
};

type GNode = {
  id: string;
  label: string;
  title?: string;
  point?: AppReviewPoint;
  pipeline: PipelineNode;
  importance: number;
};

type GEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
  statement?: string;
  predicate?: string;
  relationKey: string;
  pipeline: PipelineEdge;
};

type Selection =
  | { kind: "node"; node: GNode }
  | { kind: "edge"; edge: GEdge; fromLabel: string; toLabel: string }
  | null;

/** 与课堂图谱 merge 阶段共用视觉构建（KIND_STYLE / 来源边色） */
const REVIEW_VIS_STAGE: PipelineStage = {
  id: "merge",
  title: "单课复习图谱",
};

const DEFAULT_IMPORTANCE_FILTER = 0.01;
const IMPORTANCE_MAX = 1;

function clampImportance(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(IMPORTANCE_MAX, Math.max(0, v));
}

function roundImportance(v: number): number {
  return Math.round(clampImportance(v) * 100) / 100;
}

function importanceDigits(v: number): [number, number, number] {
  const c = Math.round(roundImportance(v) * 100);
  return [Math.floor(c / 100), Math.floor((c % 100) / 10), c % 10];
}

function digitsToImportance(ones: number, tenths: number, hundredths: number): number {
  return roundImportance(
    Math.min(1, Math.max(0, ones)) +
      Math.min(9, Math.max(0, tenths)) / 10 +
      Math.min(9, Math.max(0, hundredths)) / 100
  );
}

function parseDigitChar(raw: string, max: number): number | null {
  const t = String(raw || "").trim();
  if (t === "") return null;
  if (!/^\d$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(max, n);
}

const REL_LABEL_ZH: Record<string, string> = {
  belong_to: "归属",
  part_of: "组成",
  depend_on: "依赖",
  synonym_of: "同义",
  property_of: "属性",
  related_with: "相关",
};

function normalizeRelation(raw?: string | null): string {
  const t = String(raw || "").trim();
  if (!t) return "related_with";
  const lower = t.toLowerCase();
  if (
    lower === "belong_to" ||
    lower === "part_of" ||
    lower === "depend_on" ||
    lower === "synonym_of" ||
    lower === "property_of" ||
    lower === "related_with"
  ) {
    return lower;
  }
  if (/归属|属于|属于类/.test(t)) return "belong_to";
  if (/组成|部分|包含于/.test(t)) return "part_of";
  if (/依赖|依赖关系/.test(t)) return "depend_on";
  if (/同义|等价/.test(t)) return "synonym_of";
  if (/属性|性质/.test(t)) return "property_of";
  if (/相关/.test(t)) return "related_with";
  return "related_with";
}

function matchReviewPoint(
  points: AppReviewPoint[],
  nodeId: string,
  label?: string
): AppReviewPoint | undefined {
  const zh = zhName(nodeId);
  const lab = (label || "").trim();
  return points.find(
    (p) =>
      p.id === nodeId ||
      p.zh === lab ||
      p.zh === zh ||
      zhName(p.id) === zh ||
      zhName(p.id) === lab
  );
}

function isHighlighted(n: GNode, hl: Set<string>) {
  if (hl.has(n.id) || hl.has(n.label) || hl.has(zhName(n.id))) return true;
  if (n.point && (hl.has(n.point.id) || hl.has(n.point.zh))) return true;
  for (const h of hl) {
    if (!h) continue;
    if (n.id === h || n.label === h || zhName(n.id) === h) return true;
    if (n.id.startsWith(`${h}/`)) return true;
    if (n.point && (n.point.id === h || n.point.zh === h)) return true;
  }
  return false;
}

function toGraph(
  pipelineNodes: PipelineNode[],
  pipelineEdges: PipelineEdge[],
  points: AppReviewPoint[]
) {
  const nodeIds = new Set(pipelineNodes.map((n) => n.id).filter(Boolean));

  // 丢弃缺端点 / 处理类边（课堂图例用的 process_* 不进复习图）
  const edges: GEdge[] = pipelineEdges
    .filter((e) => {
      const src = String(e.source || "");
      if (
        src === "process_rule" ||
        src === "process_node" ||
        src === "process_isolated"
      ) {
        return false;
      }
      return Boolean(e.from && e.to && nodeIds.has(e.from) && nodeIds.has(e.to));
    })
    .map((e, i) => {
      const relationKey = normalizeRelation(e.relation || e.label);
      return {
        id: e.id || `e${i}`,
        from: e.from,
        to: e.to,
        label: e.label || e.relation || relationKey,
        statement: e.statement || e.description || e.context,
        predicate: e.relation || e.label,
        relationKey,
        pipeline: e,
      };
    });

  // 重要性 hide / 编辑删边后，process_* 边被滤掉会留下孤立点；复习图只保留仍有边的节点
  const connected = new Set<string>();
  for (const e of edges) {
    if (e.from) connected.add(e.from);
    if (e.to) connected.add(e.to);
  }
  const nodes: GNode[] = pipelineNodes
    .filter((n) => n.id && connected.has(n.id))
    .map((n) => {
      const label = String(n.label || zhName(n.id) || n.id);
      const point = matchReviewPoint(points, n.id, label);
      const imp =
        n.importance != null && Number.isFinite(Number(n.importance))
          ? Number(n.importance)
          : point?.importance ?? 0.05;
      return {
        id: n.id,
        label,
        title: n.description || n.title || point?.summary || label,
        point,
        pipeline: n,
        importance: imp,
      };
    });

  return { nodes, edges };
}

function buildReviewVis(rawNodes: PipelineNode[], rawEdges: PipelineEdge[]) {
  const nodes = buildVisNodes(REVIEW_VIS_STAGE, rawNodes);
  const edges = buildVisEdges(rawEdges);
  assignParallelCurves(edges);
  assignElasticSprings(nodes, edges);
  seedClusterCircleLayout(nodes, edges);
  return { nodes, edges };
}

/** 本讲复习图谱：课堂级讲次图谱（含后处理）；点击节点/边展示信息卡片 */
export function LectureReviewGraph({
  points,
  highlightIds = [],
  courseId,
  lectureId,
  onCollapse,
  onSelectNode,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const netRef = useRef<Network | null>(null);
  const nodeDsRef = useRef<DataSet<VisNode> | null>(null);
  const edgeDsRef = useRef<DataSet<VisEdge> | null>(null);
  const baseVisRef = useRef<{ nodes: VisNode[]; edges: VisEdge[] } | null>(null);
  const nodeMapRef = useRef<Map<string, GNode>>(new Map());
  const edgeMapRef = useRef<Map<string, GEdge>>(new Map());
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;
  const lastFocusKeyRef = useRef<string>("");
  const viewReadyRef = useRef(false);

  const [selection, setSelection] = useState<Selection>(null);
  const [highlightRel, setHighlightRel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entityQuery, setEntityQuery] = useState("");
  const [entitySearchOpen, setEntitySearchOpen] = useState(false);
  const entitySearchRef = useRef<HTMLDivElement | null>(null);
  const [importanceSource, setImportanceSourceState] = useState<ImportanceSource>(() =>
    typeof window !== "undefined" ? getImportanceSource() : "pagerank"
  );
  const [importanceMin, setImportanceMin] = useState(DEFAULT_IMPORTANCE_FILTER);
  const [importanceDigitDraft, setImportanceDigitDraft] = useState<
    [string, string, string]
  >(() => {
    const [a, b, c] = importanceDigits(DEFAULT_IMPORTANCE_FILTER);
    return [String(a), String(b), String(c)];
  });
  const [revealFiltered, setRevealFiltered] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [kgPatch, setKgPatch] = useState<KgEditPatch>(() =>
    emptyKgEditPatch(courseId, lectureId)
  );
  const [exportingPng, setExportingPng] = useState(false);
  const [raw, setRaw] = useState<{
    nodes: PipelineNode[];
    edges: PipelineEdge[];
  } | null>(null);
  const [assetsLibrary, setAssetsLibrary] = useState<AssetsLibrary | null>(null);

  const syncImportanceDigits = (v: number) => {
    const [a, b, c] = importanceDigits(v);
    setImportanceDigitDraft([String(a), String(b), String(c)]);
  };

  const commitImportanceMin = (v: number) => {
    const next = roundImportance(v);
    setImportanceMin(next);
    syncImportanceDigits(next);
  };

  const setImportanceDigit = (pos: 0 | 1 | 2, digit: number) => {
    let [a, b, c] = importanceDigits(importanceMin);
    if (pos === 0) a = digit;
    else if (pos === 1) b = digit;
    else c = digit;
    commitImportanceMin(digitsToImportance(a, b, c));
  };

  const nudgeImportanceDigit = (pos: 0 | 1 | 2, delta: 1 | -1) => {
    const cents = Math.round(roundImportance(importanceMin) * 100);
    const step = pos === 0 ? 100 : pos === 1 ? 10 : 1;
    commitImportanceMin((cents + delta * step) / 100);
  };

  useEffect(() => {
    fetch(`${courseDataUrl(courseId, "assets_library.json")}?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAssetsLibrary(d && Array.isArray(d.cards) ? d : null))
      .catch(() => setAssetsLibrary(null));
  }, [courseId]);

  useEffect(() => {
    let cancelled = false;
    fetchKgEdits(courseId, lectureId)
      .then((p) => {
        if (!cancelled) setKgPatch(p);
      })
      .catch(() => {
        if (!cancelled) setKgPatch(emptyKgEditPatch(courseId, lectureId));
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, lectureId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRaw(null);
    setSelection(null);
    setHighlightRel(null);
    setEntityQuery("");
    setEntitySearchOpen(false);

    loadReviewClassroomGraph(courseId, lectureId, { importanceSource })
      .then((g) => {
        if (cancelled) return;
        setRaw({ nodes: g.nodes, edges: g.edges });
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message || e));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [courseId, lectureId, importanceSource]);

  const filtered = useMemo(() => {
    if (!raw) {
      return { nodes: [] as PipelineNode[], edges: [] as PipelineEdge[], filteredCount: 0 };
    }
    const edited = applyKgEdits(raw.nodes, raw.edges, kgPatch);
    const imp = applyImportanceFilter(edited.nodes, edited.edges, {
      tau: importanceMin > 0 ? importanceMin : null,
      mode: revealFiltered ? "reveal" : "hide",
    });
    return {
      nodes: imp.nodes,
      edges: imp.edges,
      filteredCount: imp.filteredCount,
    };
  }, [raw, kgPatch, importanceMin, revealFiltered]);

  const graph = useMemo(
    () => toGraph(filtered.nodes, filtered.edges, points),
    [filtered.nodes, filtered.edges, points]
  );

  const detailStage: PipelineStage = useMemo(
    () => ({
      id: "merge",
      title: "单课复习图谱",
      nodes: graph.nodes.map((n) => n.pipeline),
      edges: graph.edges.map((e) => e.pipeline),
    }),
    [graph.nodes, graph.edges]
  );

  /** 拓扑签名：仅结构变化时重建 Network，避免 points 更新导致缩放/拖动被重置 */
  const topologyKey = useMemo(() => {
    const n = filtered.nodes.map((x) => x.id).join("\0");
    const e = filtered.edges
      .map((x) => `${x.id}|${x.from}|${x.to}|${x.relation || x.label}`)
      .join("\0");
    return `${n}#${e}#${importanceMin}#${revealFiltered ? 1 : 0}`;
  }, [filtered.nodes, filtered.edges, importanceMin, revealFiltered]);

  const handleRenameEntity = async (currentId: string, newId: string) => {
    const nextName = String(newId || "").trim();
    if (!nextName || nextName === currentId) return;
    setEditBusy(true);
    try {
      const renames = withEntityRename(kgPatch.entityRenames || {}, currentId, nextName);
      const saved = await saveKgEdits(courseId, lectureId, {
        replaceEntityRenames: true,
        entityRenames: renames,
      });
      setKgPatch(saved);
      setSelection((prev) =>
        prev?.kind === "node" && prev.node.id === currentId
          ? {
              kind: "node",
              node: {
                ...prev.node,
                id: nextName,
                label: splitCanonicalName(nextName).zh || nextName,
                pipeline: {
                  ...prev.node.pipeline,
                  id: nextName,
                  label: splitCanonicalName(nextName).zh || nextName,
                },
              },
            }
          : prev
      );
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleSaveEdgeEdit = async (edgeId: string, edit: EdgeEdit) => {
    setEditBusy(true);
    try {
      const saved = await saveKgEdits(courseId, lectureId, {
        edgeEdits: { [edgeId]: edit },
      });
      setKgPatch(saved);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleClearEdgeEdit = async (edgeId: string) => {
    setEditBusy(true);
    try {
      const saved = await saveKgEdits(courseId, lectureId, {
        edgeEdits: { [edgeId]: null },
      });
      setKgPatch(saved);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleDeleteEntity = async (currentId: string) => {
    const original = findOriginalEntityId(currentId, kgPatch.entityRenames || {});
    setEditBusy(true);
    try {
      const saved = await saveKgEdits(courseId, lectureId, {
        deletedEntities: { [original]: true },
      });
      setKgPatch(saved);
      setSelection(null);
      onSelectNodeRef.current?.(null);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleDeleteEdge = async (edgeId: string) => {
    setEditBusy(true);
    try {
      const saved = await saveKgEdits(courseId, lectureId, {
        deletedEdges: { [edgeId]: true },
        edgeEdits: { [edgeId]: null },
      });
      setKgPatch(saved);
      setSelection(null);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleRestoreEntity = async (originalId: string) => {
    setEditBusy(true);
    try {
      const saved = await saveKgEdits(courseId, lectureId, {
        deletedEntities: { [originalId]: null },
      });
      setKgPatch(saved);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleRestoreEdge = async (edgeId: string) => {
    setEditBusy(true);
    try {
      const saved = await saveKgEdits(courseId, lectureId, {
        deletedEdges: { [edgeId]: null },
      });
      setKgPatch(saved);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const exportCurrentGraphPng = async () => {
    const net = netRef.current;
    const host = hostRef.current;
    if (!net || !host || exportingPng || !graph.nodes.length) return;
    setExportingPng(true);
    try {
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-");
      const ok = await exportVisNetworkPng(net, host, {
        scale: 3,
        filename: `review-kg-L${lectureId}-${stamp}.png`,
        background: "#0b1220",
      });
      if (!ok) window.alert("导出失败：当前图谱尚未就绪，请稍后重试");
    } finally {
      setExportingPng(false);
    }
  };

  const neighborByNode = useMemo(() => {
    const map = new Map<string, PipelineEdge[]>();
    for (const e of graph.edges) {
      if (!map.has(e.from)) map.set(e.from, []);
      if (!map.has(e.to)) map.set(e.to, []);
      map.get(e.from)!.push(e.pipeline);
      map.get(e.to)!.push(e.pipeline);
    }
    return map;
  }, [graph.edges]);

  const legendItems = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of graph.edges) {
      counts.set(e.relationKey, (counts.get(e.relationKey) || 0) + 1);
    }
    return RELATION_TYPE_FILTERS.map((f) => {
      const key = f.edgeRelations?.[0] || f.key;
      return {
        key,
        label: REL_LABEL_ZH[key] || f.label,
        color: f.color,
        count: counts.get(key) || 0,
      };
    }).filter((x) => x.count > 0);
  }, [graph.edges]);

  const entityMatches = useMemo(() => {
    const q = entityQuery.trim().toLowerCase();
    if (!q) return [];
    const scored = graph.nodes
      .map((n) => {
        const id = String(n.id);
        const zh = zhName(id).toLowerCase();
        const label = (n.label || "").toLowerCase();
        if (!zh.includes(q) && !label.includes(q) && !id.toLowerCase().includes(q)) {
          return null;
        }
        let score = 100;
        if (zh === q || label === q) score = 400;
        else if (zh.startsWith(q) || label.startsWith(q)) score = 200;
        score += Math.min(40, n.importance || 0) * 10;
        return { id, label: n.label, score };
      })
      .filter(Boolean) as { id: string; label: string; score: number }[];
    scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, "zh"));
    return scored.slice(0, 12);
  }, [entityQuery, graph.nodes]);

  const focusEntity = (nodeId: string) => {
    const node = nodeMapRef.current.get(nodeId) || graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setSelection({ kind: "node", node });
    setEntityQuery(node.label);
    setEntitySearchOpen(false);
    const point = node.point || {
      id: node.id,
      zh: node.label,
      importance: node.importance || 0,
      origin: "",
      summary: "",
    };
    onSelectNodeRef.current?.(point);
    const net = netRef.current;
    if (!net) return;
    try {
      net.selectNodes([nodeId]);
      const cur = typeof net.getScale === "function" ? net.getScale() : 1;
      const targetScale = Math.min(1.85, Math.max(cur < 0.85 ? 1.2 : cur, 1.05));
      net.focus(nodeId, {
        scale: targetScale,
        animation: { duration: 480, easingFunction: "easeInOutQuad" },
      });
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const onDoc = (ev: MouseEvent) => {
      if (!entitySearchRef.current?.contains(ev.target as Node)) {
        setEntitySearchOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    nodeMapRef.current = new Map(graph.nodes.map((n) => [n.id, n]));
    edgeMapRef.current = new Map(graph.edges.map((e) => [e.id, e]));
  }, [graph]);

  useEffect(() => {
    setSelection(null);
    setHighlightRel(null);
    lastFocusKeyRef.current = "";
    viewReadyRef.current = false;
  }, [topologyKey]);

  useEffect(() => {
    if (!hostRef.current || loading || error || !graph.nodes.length || !raw) return;

    const { nodes: visNodes, edges: visEdges } = buildReviewVis(
      graph.nodes.map((n) => ({
        ...n.pipeline,
        importance: n.importance,
      })),
      graph.edges.map((e) => e.pipeline)
    );
    baseVisRef.current = { nodes: visNodes, edges: visEdges };
    const nDS = new DataSet(visNodes as VisNode[]);
    const eDS = new DataSet(visEdges as VisEdge[]);
    nodeDsRef.current = nDS;
    edgeDsRef.current = eDS;

    const net = new Network(
      hostRef.current,
      { nodes: nDS, edges: eDS as unknown as any },
      graphLayoutOptions(REVIEW_VIS_STAGE, true) as object
    );

    netRef.current = net;

    const resize = () => {
      try {
        net.redraw();
      } catch {
        /* ignore */
      }
    };
    const ro = new ResizeObserver(resize);
    if (hostRef.current) ro.observe(hostRef.current);

    net.once("stabilizationIterationsDone", () => {
      net.setOptions({ physics: { enabled: false } });
      try {
        const live = (nodeDsRef.current?.get() as VisNode[]) || [];
        const liveEdges = (edgeDsRef.current?.get() as VisEdge[]) || [];
        const pos = net.getPositions(live.map((n) => String(n.id)));
        live.forEach((n) => {
          const p = pos[String(n.id)];
          if (p) {
            n.x = p.x;
            n.y = p.y;
          }
        });
        if (reduceEdgeCrossings(live, liveEdges)) {
          nodeDsRef.current?.update(
            live
              .filter((n) => n.x != null)
              .map((n) => ({ id: n.id, x: n.x, y: n.y })) as object[]
          );
        }
      } catch {
        /* ignore */
      }
      if (!viewReadyRef.current) {
        net.fit({ animation: false });
        viewReadyRef.current = true;
      }
    });

    const clearGraphSelection = () => {
      setSelection(null);
      onSelectNodeRef.current?.(null);
      try {
        net.unselectAll();
      } catch {
        /* ignore */
      }
    };

    net.on("click", (params) => {
      const nodeId = params?.nodes?.[0];
      if (nodeId != null) {
        const node = nodeMapRef.current.get(String(nodeId));
        if (!node) {
          clearGraphSelection();
          return;
        }
        setSelection({ kind: "node", node });
        const point = node.point || {
          id: node.id,
          zh: node.label,
          importance: node.importance || 0,
          origin: "",
          summary: "",
        };
        onSelectNodeRef.current?.(point);
        return;
      }
      const edgeId = params?.edges?.[0];
      if (edgeId != null) {
        const edge = edgeMapRef.current.get(String(edgeId));
        if (!edge) {
          clearGraphSelection();
          return;
        }
        const fromLabel = nodeMapRef.current.get(edge.from)?.label || zhName(edge.from);
        const toLabel = nodeMapRef.current.get(edge.to)?.label || zhName(edge.to);
        setSelection({ kind: "edge", edge, fromLabel, toLabel });
        // 选边时清掉父级实体高亮，避免 highlightIds 继续压淡化
        onSelectNodeRef.current?.(null);
        return;
      }
      clearGraphSelection();
    });

    return () => {
      ro.disconnect();
      net.destroy();
      netRef.current = null;
      nodeDsRef.current = null;
      edgeDsRef.current = null;
      baseVisRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey, loading, error]);

  /** 选中实体 / 关系类图例 → 淡化无关节点与边（课堂图谱同款淡化色） */
  useEffect(() => {
    const nDS = nodeDsRef.current;
    const eDS = edgeDsRef.current;
    const base = baseVisRef.current;
    if (!nDS || !eDS || !base || !graph.nodes.length) return;

    const focusNodes = new Set<string>();
    const focusEdges = new Set<string>();

    if (selection?.kind === "node") {
      const id = selection.node.id;
      focusNodes.add(id);
      for (const e of graph.edges) {
        if (e.from === id || e.to === id) {
          focusEdges.add(e.id);
          focusNodes.add(e.from);
          focusNodes.add(e.to);
        }
      }
    } else if (selection?.kind === "edge") {
      focusEdges.add(selection.edge.id);
      focusNodes.add(selection.edge.from);
      focusNodes.add(selection.edge.to);
    }

    const hasFocus = focusNodes.size > 0 || focusEdges.size > 0;
    const relTouch = new Set<string>();
    if (highlightRel && !hasFocus) {
      for (const e of base.edges) {
        if (String(e._relation || "") !== highlightRel) continue;
        relTouch.add(String(e.from));
        relTouch.add(String(e.to));
      }
    }

    try {
      nDS.update(
        base.nodes.map((n) => {
          const id = String(n.id);
          let active = true;
          if (hasFocus) active = focusNodes.has(id);
          else if (highlightRel) active = relTouch.has(id);
          return {
            id: n.id,
            opacity: active ? (n._baseOpacity ?? 1) : 0.22,
            color: {
              background: active ? n._bg : HL_NODE_FADE_BG,
              border: active ? n._border : HL_NODE_FADE_BORDER,
              highlight: { background: n._bg, border: "#fff" },
            },
            font: {
              ...(n.font as object),
              color: active ? n._fontColor || "#e8edf5" : HL_FONT_FADE,
            },
            borderWidth: focusNodes.has(id) ? 3 : (n.borderWidth as number) || 2,
          };
        }) as object[]
      );
      eDS.update(
        base.edges.map((e) => {
          const relOk = !highlightRel || String(e._relation || "") === highlightRel;
          let active = relOk;
          if (hasFocus) active = relOk && focusEdges.has(String(e.id));
          const baseW =
            typeof e._baseWidth === "number"
              ? e._baseWidth
              : typeof e.width === "number"
                ? e.width
                : 1.4;
          return {
            id: e.id,
            opacity: active ? 1 : 0.18,
            width: focusEdges.has(String(e.id))
              ? baseW + 1.2
              : highlightRel && relOk && !hasFocus
                ? baseW + 0.6
                : baseW,
            color: {
              color: active ? e._edgeColor : HL_EDGE_FADE,
              highlight: "#fff",
              opacity: active ? 1 : 0.18,
            },
            font: {
              ...(e.font as object),
              color: active ? e._fontColor || "#8b97a8" : HL_FONT_FADE,
              strokeWidth: 0,
            },
          };
        }) as object[]
      );
      netRef.current?.redraw();
    } catch {
      /* ignore */
    }
  }, [selection, highlightRel, graph.nodes, graph.edges]);

  useEffect(() => {
    const net = netRef.current;
    if (!net) return;
    const hl = new Set((highlightIds || []).filter(Boolean));
    const selectedFromHl = graph.nodes
      .filter((n) => isHighlighted(n, hl))
      .map((n) => n.id);
    const selectedNodes =
      selection?.kind === "node"
        ? [selection.node.id]
        : selection?.kind === "edge"
          ? [selection.edge.from, selection.edge.to]
          : selectedFromHl;
    const selectedEdges =
      selection?.kind === "edge" ? [selection.edge.id] : [];
    try {
      net.setSelection({ nodes: selectedNodes, edges: selectedEdges });
    } catch {
      /* ignore */
    }

    // 外部 highlight（侧栏点选）才自动对焦；图内点击不抢视角
    if (selection) return;
    const focusKey = selectedFromHl.slice().sort().join("|");
    if (!focusKey || focusKey === lastFocusKeyRef.current) return;
    lastFocusKeyRef.current = focusKey;
    try {
      if (selectedFromHl.length === 1) {
        const cur = typeof net.getScale === "function" ? net.getScale() : 1;
        net.focus(selectedFromHl[0], {
          scale: Math.min(1.6, Math.max(cur, 1.05)),
          animation: { duration: 280, easingFunction: "easeInOutQuad" },
        });
      } else if (selectedFromHl.length > 1) {
        net.fit({
          nodes: selectedFromHl,
          animation: { duration: 280, easingFunction: "easeInOutQuad" },
        });
      }
    } catch {
      /* ignore */
    }
  }, [highlightIds, graph.nodes, selection]);

  if (loading) {
    return <p className={styles.empty}>正在加载课堂图谱…</p>;
  }
  if (error) {
    return <p className={styles.empty}>课堂图谱加载失败：{error}</p>;
  }
  // 真无数据才整页空态；阈值滤空仍保留工具栏，否则调不回去
  if (!raw?.nodes?.length) {
    return <p className={styles.empty}>本讲暂无课堂图谱数据</p>;
  }

  const filteredEmpty = !graph.nodes.length;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headActions}>
          <div className={styles.entitySearch} ref={entitySearchRef}>
            <input
              type="search"
              className={styles.entitySearchInput}
              value={entityQuery}
              placeholder="搜索实体…"
              aria-label="搜索实体"
              autoComplete="off"
              disabled={!graph.nodes.length}
              onFocus={() => setEntitySearchOpen(true)}
              onChange={(e) => {
                setEntityQuery(e.target.value);
                setEntitySearchOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEntitySearchOpen(false);
                  return;
                }
                if (e.key === "Enter" && entityMatches[0]) {
                  e.preventDefault();
                  focusEntity(entityMatches[0].id);
                }
              }}
            />
            {entitySearchOpen && entityQuery.trim() ? (
              <div className={styles.entitySearchMenu} role="listbox">
                {entityMatches.length === 0 ? (
                  <div className={styles.entitySearchEmpty}>无匹配实体</div>
                ) : (
                  entityMatches.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      className={styles.entitySearchItem}
                      onClick={() => focusEntity(m.id)}
                      title={m.id}
                    >
                      <span>{m.label}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={`${kgStyles.kgChip} ${
              importanceSource === "classroom" ? kgStyles.kgChipActive : ""
            }`}
            title="切换重要性来源：课堂信号 ↔ PageRank 实验"
            onClick={() => {
              const next: ImportanceSource =
                importanceSource === "pagerank" ? "classroom" : "pagerank";
              setImportanceSource(next);
              setImportanceSourceState(next);
            }}
          >
            {importanceSource === "pagerank" ? "PR+" : "课堂分阈值"}
          </button>
          <div
            className={kgStyles.importanceFilter}
            title="重要性阈值：保留课堂分≥该值的节点"
          >
            <span className={kgStyles.importanceDigits} aria-label="重要性阈值 x.xx">
              {([0, 1, 2] as const).map((pos) => {
                const max = pos === 0 ? 1 : 9;
                const atMax = importanceMin >= IMPORTANCE_MAX;
                const atMin = importanceMin <= 0;
                return (
                  <span key={pos} className={kgStyles.importanceDigitWrap}>
                    {pos === 1 ? (
                      <span className={kgStyles.importanceDot} aria-hidden>
                        .
                      </span>
                    ) : null}
                    <span className={kgStyles.importanceDigit}>
                      <button
                        type="button"
                        className={kgStyles.importanceDigitBtn}
                        disabled={atMax}
                        onClick={() => nudgeImportanceDigit(pos, 1)}
                      >
                        ▲
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        className={kgStyles.importanceDigitInput}
                        value={importanceDigitDraft[pos]}
                        onChange={(e) => {
                          const rawDigit = e.target.value.replace(/\D/g, "").slice(-1);
                          setImportanceDigitDraft((prev) => {
                            const next: [string, string, string] = [
                              prev[0],
                              prev[1],
                              prev[2],
                            ];
                            next[pos] = rawDigit;
                            return next;
                          });
                          const parsed = parseDigitChar(rawDigit, max);
                          if (parsed != null) setImportanceDigit(pos, parsed);
                        }}
                        onBlur={() => {
                          const parsed = parseDigitChar(
                            importanceDigitDraft[pos],
                            max
                          );
                          if (parsed != null) setImportanceDigit(pos, parsed);
                          else syncImportanceDigits(importanceMin);
                        }}
                      />
                      <button
                        type="button"
                        className={kgStyles.importanceDigitBtn}
                        disabled={atMin}
                        onClick={() => nudgeImportanceDigit(pos, -1)}
                      >
                        ▼
                      </button>
                    </span>
                  </span>
                );
              })}
            </span>
          </div>
          <button
            type="button"
            className={`${kgStyles.kgChip} ${revealFiltered ? kgStyles.kgChipActive : ""}`}
            title={
              revealFiltered
                ? `正在显示 ${filtered.filteredCount} 个被筛实体（灰色弱化）`
                : importanceMin <= 0
                  ? "当前未启用阈值筛选"
                  : `当前隐藏约 ${filtered.filteredCount} 个低重要性实体`
            }
            onClick={() => {
              setRevealFiltered((v) => {
                const next = !v;
                if (next && importanceMin <= 0) {
                  commitImportanceMin(DEFAULT_IMPORTANCE_FILTER);
                }
                return next;
              });
            }}
          >
            {revealFiltered ? "隐藏被筛实体" : "显示被筛实体"}
          </button>
          <label
            className={`${kgStyles.editModeToggle} ${editMode ? kgStyles.editModeOn : ""}`}
            title="开启后可修改实体名、关系"
          >
            <input
              type="checkbox"
              checked={editMode}
              onChange={(e) => setEditMode(e.target.checked)}
            />
            <span>编辑</span>
          </label>
          <button
            type="button"
            className={kgStyles.kgExportBtn}
            disabled={!graph.nodes.length || exportingPng}
            onClick={() => void exportCurrentGraphPng()}
            title="按当前筛选与视口导出高清 PNG"
          >
            {exportingPng ? "导出中…" : "导出图片"}
          </button>
          {onCollapse ? (
            <button type="button" className={styles.foldBtn} onClick={onCollapse}>
              折叠
            </button>
          ) : null}
        </div>
      </div>
      <div className={styles.body}>
        <ResizableSplit
          className={styles.bodySplit}
          storageKey="split-review-graph-detail"
          sizedPane="right"
          initialRightPx={300}
          initialRightRatio={0.34}
          minLeftPx={180}
          minRightPx={220}
          enabled={Boolean(selection)}
          hideWhenDisabled="right"
          left={
              <div className={styles.graphCol}>
              <div ref={hostRef} className={styles.host} />
              {filteredEmpty ? (
                <div className={styles.filterEmpty} role="status">
                  <p>当前重要性阈值下无可见节点</p>
                  <button
                    type="button"
                    className={styles.filterEmptyBtn}
                    onClick={() => commitImportanceMin(0)}
                  >
                    清除阈值
                  </button>
                </div>
              ) : null}
              {legendItems.length > 0 ? (
                <div className={styles.legend} aria-label="关系类型图例">
                  <span className={styles.hlHint}>关系类</span>
                  <button
                    type="button"
                    className={`${styles.hlBtn} ${!highlightRel ? styles.hlOn : ""}`}
                    onClick={() => setHighlightRel(null)}
                  >
                    全部 · {graph.edges.length}
                  </button>
                  {legendItems.map((it) => (
                    <button
                      key={it.key}
                      type="button"
                      className={`${styles.hlBtn} ${highlightRel === it.key ? styles.hlOn : ""}`}
                      style={{ ["--hl-color" as string]: it.color }}
                      onClick={() => setHighlightRel((cur) => (cur === it.key ? null : it.key))}
                      title={it.key}
                    >
                      <i className={styles.dot} style={{ background: it.color }} />
                      {it.label} · {it.count}
                    </button>
                  ))}
                </div>
              ) : null}
              {!selection ? (
                <p className={styles.hint}>点击节点或边查看详情（属性已折叠进实体特性）</p>
              ) : null}
            </div>
          }
          right={
            <div className={styles.card}>
              <div className={styles.cardToolbar}>
                <span>选中详情</span>
                <button
                  type="button"
                  className={styles.cardClose}
                  onClick={() => {
                    setSelection(null);
                    onSelectNodeRef.current?.(null);
                    try {
                      netRef.current?.unselectAll();
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  关闭
                </button>
              </div>
              {selection?.kind === "node" ? (
                <>
                  {editMode ? (
                    <SelectionDetail
                      stage={detailStage}
                      selectedNodeId={selection.node.id}
                      selectedEdgeId={null}
                      hideFiltered={false}
                      mode="lecture"
                      importanceMode="classroom"
                      editMode={editMode}
                      kgPatch={kgPatch}
                      editBusy={editBusy}
                      onRenameEntity={handleRenameEntity}
                      onSaveEdgeEdit={handleSaveEdgeEdit}
                      onClearEdgeEdit={handleClearEdgeEdit}
                      onDeleteEntity={handleDeleteEntity}
                      onDeleteEdge={handleDeleteEdge}
                      onRestoreEntity={handleRestoreEntity}
                      onRestoreEdge={handleRestoreEdge}
                    />
                  ) : (
                    <ReviewGraphDetailCard
                      mode="node"
                      courseId={courseId}
                      lectureId={lectureId}
                      point={selection.node.point || null}
                      nodeId={selection.node.id}
                      nodeLabel={selection.node.label}
                      pipelineNode={selection.node.pipeline}
                      relatedEdges={neighborByNode.get(selection.node.id) || []}
                      assetsLibrary={assetsLibrary}
                    />
                  )}
                </>
              ) : selection?.kind === "edge" ? (
                <>
                  {editMode ? (
                    <SelectionDetail
                      stage={detailStage}
                      selectedNodeId={null}
                      selectedEdgeId={selection.edge.id}
                      hideFiltered={false}
                      mode="lecture"
                      importanceMode="classroom"
                      editMode={editMode}
                      kgPatch={kgPatch}
                      editBusy={editBusy}
                      onRenameEntity={handleRenameEntity}
                      onSaveEdgeEdit={handleSaveEdgeEdit}
                      onClearEdgeEdit={handleClearEdgeEdit}
                      onDeleteEntity={handleDeleteEntity}
                      onDeleteEdge={handleDeleteEdge}
                      onRestoreEntity={handleRestoreEntity}
                      onRestoreEdge={handleRestoreEdge}
                    />
                  ) : (
                    <ReviewGraphDetailCard
                      mode="edge"
                      courseId={courseId}
                      lectureId={lectureId}
                      edge={selection.edge}
                      fromLabel={selection.fromLabel}
                      toLabel={selection.toLabel}
                      fromPoint={
                        graph.nodes.find((n) => n.id === selection.edge.from)?.point ||
                        null
                      }
                      toPoint={
                        graph.nodes.find((n) => n.id === selection.edge.to)?.point || null
                      }
                      pipelineEdge={selection.edge.pipeline}
                    />
                  )}
                </>
              ) : null}
              {editMode ? (
                <DeletedItemsPanel
                  kgPatch={kgPatch}
                  busy={editBusy}
                  onRestoreEntity={handleRestoreEntity}
                  onRestoreEdge={handleRestoreEdge}
                />
              ) : null}
            </div>
          }
        />
      </div>
    </div>
  );
}
