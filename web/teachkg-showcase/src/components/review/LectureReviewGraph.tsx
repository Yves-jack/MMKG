/**
 * 视频复习图谱：只读浏览（无右键编辑 / 无本地改图补丁）。
 * 嵌入图谱板块 GraphCanvas（淡化 / livePhysics / 搜索聚焦同款），
 * 外挂检索·重要性工具栏；图例与右侧详情折叠复用图谱板块（KgPage）同款。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { CollapsiblePanel } from "@/components/graph/CollapsiblePanel";
import { GraphCanvas, type GraphCanvasHandle } from "@/components/graph/GraphCanvas";
import { HighlightLegend } from "@/components/graph/HighlightLegend";
import { ResizableSplit } from "@/components/graph/ResizableSplit";
import { SelectionDetail } from "@/components/graph/SelectionPanels";
import { courseDataUrl } from "@/lib/course";
import {
  applyImportanceFilter,
  applyRelatedWithVisibility,
} from "@/lib/kg/importanceFilter";
import {
  getImportanceSource,
  setImportanceSource,
  type ImportanceSource,
} from "@/lib/kg/importanceSource";
import { SHARED_PANEL_KEYS } from "@/lib/kg/sharedEntitySelection";
import {
  KG_LEGEND_GROUPS,
  filterHasMatches,
  type VisNode,
} from "@/lib/graph/graphLogic";
import type {
  PipelineEdge,
  PipelineNode,
  PipelinePayload,
  PipelineStage,
} from "@/lib/graph/types";
import { dedupeEntityMatchesByZh } from "@/lib/entitySearchDedupe";
import { zhName, type AppReviewPoint } from "@/lib/review/data";
import {
  loadReviewClassroomGraph,
  loadReviewCourseGraph,
} from "@/lib/review/loadReviewClassroomGraph";
import { isPaperEmbedTheme } from "@/styles/embedTheme";
import pipe from "@/styles/panels.module.css";
import kgStyles from "@/pages/KgPage.module.css";
import styles from "./LectureReviewGraph.module.css";

type Props = {
  points: AppReviewPoint[];
  highlightIds?: string[];
  courseId: string;
  lectureId: string;
  graphScope?: "course" | "lecture";
  onCollapse?: () => void;
  onSelectNode?: (point: AppReviewPoint | null) => void;
};

type Selection =
  | { kind: "node"; nodeId: string }
  | { kind: "edge"; edgeId: string }
  | null;

const DEFAULT_IMPORTANCE_KEEP_PERCENT = 100;
const IMPORTANCE_PERCENT_MIN = 1;
const IMPORTANCE_PERCENT_MAX = 100;
const DETAIL_RAIL_PX = 32;

function clampKeepPercent(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_IMPORTANCE_KEEP_PERCENT;
  return Math.min(
    IMPORTANCE_PERCENT_MAX,
    Math.max(IMPORTANCE_PERCENT_MIN, Math.round(v)),
  );
}

function importancePercentAtPointer(
  el: HTMLElement,
  clientX: number,
): { percent: number; ratio: number } {
  const rect = el.getBoundingClientRect();
  const thumb = 14;
  const usable = Math.max(1, rect.width - thumb);
  const x = Math.min(
    rect.width - thumb / 2,
    Math.max(thumb / 2, clientX - rect.left),
  );
  const ratio = Math.min(1, Math.max(0, (x - thumb / 2) / usable));
  const percent = clampKeepPercent(
    IMPORTANCE_PERCENT_MIN +
      ratio * (IMPORTANCE_PERCENT_MAX - IMPORTANCE_PERCENT_MIN),
  );
  return { percent, ratio };
}

function matchReviewPoint(
  points: AppReviewPoint[],
  nodeId: string,
  label?: string,
): AppReviewPoint | undefined {
  const zh = zhName(nodeId);
  const lab = (label || "").trim();
  return points.find(
    (p) =>
      p.id === nodeId ||
      p.zh === lab ||
      p.zh === zh ||
      zhName(p.id) === zh ||
      zhName(p.id) === lab,
  );
}

function dropProcessIsolates(nodes: PipelineNode[], edges: PipelineEdge[]) {
  const keptEdges = edges.filter((e) => {
    const rel = String(e.relation || e.label || "");
    return !rel.startsWith("process_");
  });
  const connected = new Set<string>();
  for (const e of keptEdges) {
    if (e.from) connected.add(String(e.from));
    if (e.to) connected.add(String(e.to));
  }
  return {
    nodes: nodes.filter((n) => n.id && connected.has(String(n.id))),
    edges: keptEdges,
  };
}

export function LectureReviewGraph({
  points,
  highlightIds = [],
  courseId,
  lectureId,
  graphScope = "lecture",
  onCollapse,
  onSelectNode,
}: Props) {
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;
  const graphRef = useRef<GraphCanvasHandle>(null);
  const posCacheRef = useRef<Record<string, { x: number; y: number }>>({});
  const entitySearchRef = useRef<HTMLDivElement | null>(null);

  const [selection, setSelection] = useState<Selection>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [detailCollapsed, setDetailCollapsed] = useState(() =>
    isPaperEmbedTheme(),
  );
  const [detailPanelOpen, setDetailPanelOpen] = useState(true);
  const [hideRelatedWith, setHideRelatedWith] = useState(true);
  const isAiTeachingEmbed = isPaperEmbedTheme();
  const [focusNodeRequest, setFocusNodeRequest] = useState<{
    id: string;
    seq: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entityQuery, setEntityQuery] = useState("");
  const [entitySearchOpen, setEntitySearchOpen] = useState(false);
  const [importanceSource, setImportanceSourceState] = useState<ImportanceSource>(
    () => (typeof window !== "undefined" ? getImportanceSource() : "pagerank"),
  );
  const [importanceKeepPercent, setImportanceKeepPercent] = useState(
    DEFAULT_IMPORTANCE_KEEP_PERCENT,
  );
  const [importancePercentDraft, setImportancePercentDraft] = useState(
    String(DEFAULT_IMPORTANCE_KEEP_PERCENT),
  );
  const [importanceSliderActive, setImportanceSliderActive] = useState(false);
  const [importanceSliderHover, setImportanceSliderHover] = useState<{
    percent: number;
    ratio: number;
  } | null>(null);
  const [revealFiltered, setRevealFiltered] = useState(false);
  const [exportingPng, setExportingPng] = useState(false);
  const [raw, setRaw] = useState<{
    nodes: PipelineNode[];
    edges: PipelineEdge[];
  } | null>(null);
  const [entityDefinitions, setEntityDefinitions] = useState<
    Record<string, string>
  >({});
  const [forceRelayoutToken, setForceRelayoutToken] = useState(0);

  const commitImportanceKeepPercent = (next: number) => {
    const v = clampKeepPercent(next);
    setImportanceKeepPercent(v);
    setImportancePercentDraft(String(v));
    if (v >= 100) setRevealFiltered(false);
  };

  useEffect(() => {
    fetch(
      `${courseDataUrl(courseId, "entity_definitions.json")}?t=${Date.now()}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((j) =>
        setEntityDefinitions(j && typeof j === "object" ? j : {}),
      )
      .catch(() => setEntityDefinitions({}));
  }, [courseId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRaw(null);
    setSelection(null);
    setHighlightKey(null);
    setEntityQuery("");
    setEntitySearchOpen(false);
    posCacheRef.current = {};
    setForceRelayoutToken((n) => n + 1);

    const loader =
      graphScope === "course"
        ? loadReviewCourseGraph(courseId, {
            importanceSource,
            hideRelatedWith: false,
          })
        : loadReviewClassroomGraph(courseId, lectureId, {
            importanceSource,
            hideRelatedWith: false,
          });
    loader
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
      setLoading(false);
    };
  }, [courseId, lectureId, graphScope, importanceSource]);

  const filtered = useMemo(() => {
    if (!raw) {
      return { nodes: [] as PipelineNode[], edges: [] as PipelineEdge[] };
    }
    const imp = applyImportanceFilter(raw.nodes, raw.edges, {
      keepPercent: importanceKeepPercent,
      mode: revealFiltered ? "reveal" : "hide",
      dropIsolates: true,
    });
    return dropProcessIsolates(imp.nodes, imp.edges);
  }, [raw, importanceKeepPercent, revealFiltered]);

  const fullStage: PipelineStage = useMemo(
    () => ({
      id: "merge",
      title: graphScope === "course" ? "整课知识图谱" : "单课复习图谱",
      focus: "graph",
      nodes: filtered.nodes,
      edges: filtered.edges,
    }),
    [filtered.nodes, filtered.edges, graphScope],
  );

  // 与 KgPage 一致：图例可切换 related_with；复习图谱不做隐藏后短路径二次剪枝
  const canvasStage: PipelineStage = useMemo(
    () =>
      applyRelatedWithVisibility(fullStage, hideRelatedWith, {
        pruneShortPaths: false,
      }),
    [fullStage, hideRelatedWith],
  );

  const canvasPayload: PipelinePayload = useMemo(
    () => ({
      mode: "lecture",
      course_id: courseId,
      lecture_id: lectureId,
      lecture_ids: [lectureId],
      title: canvasStage.title,
      items: [
        {
          cue_id: `review-${lectureId}`,
          lecture_id: lectureId,
          stages: [canvasStage],
        },
      ],
    }),
    [courseId, lectureId, canvasStage],
  );

  const relatedWithCount = useMemo(
    () =>
      (fullStage.edges || []).filter(
        (e) => (e.relation || e.label || "") === "related_with",
      ).length,
    [fullStage.edges],
  );

  const hlGroups = useMemo(() => {
    return KG_LEGEND_GROUPS.filter((g) => g.id !== "process")
      .map((g) => ({
        ...g,
        filters: g.filters.filter((f) => {
          if (f.key === "e_rel") {
            return filterHasMatches("lecture", fullStage, f, true);
          }
          return filterHasMatches("lecture", canvasStage, f, true);
        }),
      }))
      .filter((g) => g.filters.length > 0);
  }, [fullStage, canvasStage]);

  const hlFilters = useMemo(
    () => hlGroups.flatMap((g) => g.filters),
    [hlGroups],
  );

  const nodeById = useMemo(() => {
    const m = new Map<string, PipelineNode>();
    for (const n of canvasStage.nodes || []) m.set(String(n.id), n);
    return m;
  }, [canvasStage.nodes]);

  const edgeById = useMemo(() => {
    const m = new Map<string, PipelineEdge>();
    for (const e of canvasStage.edges || []) m.set(String(e.id), e);
    return m;
  }, [canvasStage.edges]);

  const selectedNodeId =
    selection?.kind === "node" ? selection.nodeId : null;
  const selectedEdgeId =
    selection?.kind === "edge" ? selection.edgeId : null;

  const notifyPoint = (nodeId: string | null, label?: string) => {
    if (!nodeId) {
      onSelectNodeRef.current?.(null);
      return;
    }
    const pipeline = nodeById.get(nodeId);
    const point =
      matchReviewPoint(points, nodeId, label || pipeline?.label) ||
      ({
        id: nodeId,
        zh: label || zhName(nodeId),
        importance: Number(pipeline?.importance) || 0,
        origin: "",
        summary: "",
      } as AppReviewPoint);
    onSelectNodeRef.current?.(point);
  };

  const selectNode = (
    nodeId: string,
    meta?: VisNode | null,
    opts?: { focus?: boolean },
  ) => {
    const pipeline = nodeById.get(nodeId);
    if (!pipeline) return;
    const label =
      String(meta?.label || pipeline.label || zhName(nodeId) || nodeId);
    setSelection({ kind: "node", nodeId });
    setHighlightKey(null);
    if (!isAiTeachingEmbed) setDetailCollapsed(false);
    setDetailPanelOpen(true);
    notifyPoint(nodeId, label);
    if (opts?.focus) {
      setFocusNodeRequest((prev) => ({
        id: nodeId,
        seq: (prev?.seq || 0) + 1,
      }));
    }
  };

  const selectEdge = (edgeId: string) => {
    if (!edgeById.get(edgeId)) return;
    setSelection({ kind: "edge", edgeId });
    setHighlightKey(null);
    if (!isAiTeachingEmbed) setDetailCollapsed(false);
    setDetailPanelOpen(true);
    notifyPoint(null);
  };

  const clearSelection = () => {
    setSelection(null);
    notifyPoint(null);
  };

  // 外部 highlightIds：有则同步选中；空则清掉节点选中（不碰边选中）
  useEffect(() => {
    const id = (highlightIds || []).map(String).find(Boolean);
    if (!id) {
      if (selection?.kind === "node") clearSelection();
      return;
    }
    const nodes = canvasStage.nodes || [];
    if (!nodes.length) return;
    const hit =
      nodeById.get(id) ||
      nodes.find((n) => {
        const nid = String(n.id);
        const zh = zhName(nid);
        const label = String(n.label || "");
        return (
          nid === id ||
          zh === id ||
          label === id ||
          zhName(id) === zh ||
          nid.startsWith(`${id}/`)
        );
      });
    if (!hit) return;
    const hitId = String(hit.id);
    if (selection?.kind === "node" && selection.nodeId === hitId) return;
    selectNode(hitId, null, { focus: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIds, canvasStage.nodes]);

  const selectionKey =
    selection?.kind === "node"
      ? `n:${selection.nodeId}`
      : selection?.kind === "edge"
        ? `e:${selection.edgeId}`
        : null;

  // 选中实体/关系时展开「选中详情」（嵌入态不强制展开侧栏）
  useEffect(() => {
    if (!selectionKey) return;
    if (!isAiTeachingEmbed) setDetailCollapsed(false);
    setDetailPanelOpen(true);
  }, [selectionKey, isAiTeachingEmbed]);

  const entityMatches = useMemo(() => {
    const q = entityQuery.trim().toLowerCase();
    if (!q) return [];
    const scored = (canvasStage.nodes || [])
      .map((n) => {
        const id = String(n.id);
        const zh = zhName(id).toLowerCase();
        const label = String(n.label || "").toLowerCase();
        if (
          !zh.includes(q) &&
          !label.includes(q) &&
          !id.toLowerCase().includes(q)
        ) {
          return null;
        }
        let score = 100;
        if (zh === q || label === q) score = 400;
        else if (zh.startsWith(q) || label.startsWith(q)) score = 200;
        score += Math.min(40, Number(n.importance) || 0) * 10;
        return {
          id,
          label: String(n.label || zhName(id) || id),
          score,
        };
      })
      .filter(Boolean) as { id: string; label: string; score: number }[];
    const deduped = dedupeEntityMatchesByZh(scored);
    deduped.sort(
      (a, b) => b.score - a.score || a.label.localeCompare(b.label, "zh"),
    );
    return deduped.slice(0, 12);
  }, [entityQuery, canvasStage.nodes]);

  const focusEntity = (nodeId: string) => {
    const n = nodeById.get(nodeId);
    if (!n) return;
    setEntityQuery(String(n.label || zhName(nodeId) || nodeId));
    setEntitySearchOpen(false);
    selectNode(nodeId, null, { focus: true });
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

  const exportCurrentGraphPng = async () => {
    if (exportingPng || !filtered.nodes.length) return;
    setExportingPng(true);
    try {
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-");
      const ok = await graphRef.current?.exportPng({
        scale: 3,
        filename: `review-kg-L${lectureId}-${stamp}.png`,
        background: "transparent",
      });
      if (!ok) window.alert("导出失败：当前图谱尚未就绪，请稍后重试");
    } finally {
      setExportingPng(false);
    }
  };

  if (loading) {
    return <p className={styles.empty}>正在加载课堂图谱…</p>;
  }
  if (error && !raw) {
    return <p className={styles.empty}>课堂图谱加载失败：{error}</p>;
  }
  if (!raw?.nodes?.length) {
    return <p className={styles.empty}>本讲暂无课堂图谱数据</p>;
  }

  const filteredEmpty = !(canvasStage.nodes || []).length;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.entitySearch} ref={entitySearchRef}>
          <input
            type="search"
            className={styles.entitySearchInput}
            value={entityQuery}
            placeholder="搜索实体…"
            aria-label="搜索实体"
            autoComplete="off"
            disabled={!filtered.nodes.length}
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
        <div className={styles.headEnd}>
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
            {importanceSource === "pagerank" ? "PR+" : "课堂分"}
          </button>
          <div
            className={kgStyles.importanceFilter}
            title="按课堂重要性保留排名前 x% 的节点；筛选后去掉无边孤立点"
          >
            <label
              className={kgStyles.importancePercentLabel}
              htmlFor="review-importance-percent"
            >
              保留
            </label>
            <div
              className={kgStyles.importancePercentSliderWrap}
              data-tip={`${
                importanceSliderActive
                  ? Number(importancePercentDraft) || importanceKeepPercent
                  : importanceSliderHover?.percent ?? importanceKeepPercent
              }%`}
              data-active={importanceSliderActive ? "1" : "0"}
              data-hover={importanceSliderHover ? "1" : "0"}
              style={
                {
                  ["--imp-ratio"]: String(
                    importanceSliderActive
                      ? ((Number(importancePercentDraft) ||
                          importanceKeepPercent) -
                          IMPORTANCE_PERCENT_MIN) /
                          (IMPORTANCE_PERCENT_MAX - IMPORTANCE_PERCENT_MIN)
                      : (importanceSliderHover?.ratio ??
                          (importanceKeepPercent - IMPORTANCE_PERCENT_MIN) /
                            (IMPORTANCE_PERCENT_MAX -
                              IMPORTANCE_PERCENT_MIN)),
                  ),
                } as CSSProperties
              }
            >
              <input
                type="range"
                className={kgStyles.importancePercentSlider}
                min={IMPORTANCE_PERCENT_MIN}
                max={IMPORTANCE_PERCENT_MAX}
                step={1}
                value={
                  importanceSliderActive
                    ? Number(importancePercentDraft) || importanceKeepPercent
                    : importanceKeepPercent
                }
                aria-label="重要性保留百分比滑条"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setImportanceSliderActive(true);
                  const next = importancePercentAtPointer(
                    e.currentTarget,
                    e.clientX,
                  );
                  setImportanceSliderHover(next);
                  setImportancePercentDraft(String(next.percent));
                }}
                onPointerMove={(e) => {
                  const next = importancePercentAtPointer(
                    e.currentTarget,
                    e.clientX,
                  );
                  setImportanceSliderHover(next);
                  if (importanceSliderActive || e.buttons === 1) {
                    setImportancePercentDraft(String(next.percent));
                  }
                }}
                onPointerUp={(e) => {
                  const next = importancePercentAtPointer(
                    e.currentTarget,
                    e.clientX,
                  );
                  commitImportanceKeepPercent(next.percent);
                  setImportanceSliderActive(false);
                  setImportanceSliderHover(null);
                  try {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  } catch {
                    /* ignore */
                  }
                }}
                onPointerCancel={() => {
                  commitImportanceKeepPercent(
                    Number(importancePercentDraft) || importanceKeepPercent,
                  );
                  setImportanceSliderActive(false);
                  setImportanceSliderHover(null);
                }}
                onBlur={() => {
                  if (importanceSliderActive) {
                    commitImportanceKeepPercent(
                      Number(importancePercentDraft) || importanceKeepPercent,
                    );
                  }
                  setImportanceSliderActive(false);
                  setImportanceSliderHover(null);
                }}
                onPointerLeave={() => {
                  if (!importanceSliderActive) setImportanceSliderHover(null);
                }}
                onChange={(e) => {
                  if (importanceSliderActive) return;
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) commitImportanceKeepPercent(n);
                }}
              />
            </div>
            <input
              id="review-importance-percent"
              type="number"
              min={IMPORTANCE_PERCENT_MIN}
              max={IMPORTANCE_PERCENT_MAX}
              step={1}
              inputMode="numeric"
              className={kgStyles.importancePercentInput}
              value={importancePercentDraft}
              aria-label="重要性保留百分比"
              onChange={(e) => {
                const rawVal = e.target.value.replace(/[^\d]/g, "");
                setImportancePercentDraft(rawVal);
                if (rawVal === "") return;
                const n = Number(rawVal);
                if (Number.isFinite(n)) commitImportanceKeepPercent(n);
              }}
              onBlur={() => {
                const n = Number(importancePercentDraft);
                if (Number.isFinite(n)) commitImportanceKeepPercent(n);
                else setImportancePercentDraft(String(importanceKeepPercent));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  commitImportanceKeepPercent(importanceKeepPercent + 1);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  commitImportanceKeepPercent(importanceKeepPercent - 1);
                }
              }}
            />
            <span className={kgStyles.importancePercentSuffix}>%</span>
          </div>
          <button
            type="button"
            className={kgStyles.kgExportBtn}
            disabled={!filtered.nodes.length || exportingPng}
            onClick={() => void exportCurrentGraphPng()}
            title="按当前筛选导出整图高清 PNG（含被面板遮挡的节点）"
          >
            {exportingPng ? "导出中…" : "导出图片"}
          </button>
          {onCollapse ? (
            <button
              type="button"
              className={styles.foldBtn}
              onClick={onCollapse}
            >
              折叠
            </button>
          ) : null}
        </div>
      </div>
      <div className={styles.body}>
        <ResizableSplit
          className={styles.bodySplit}
          storageKey={
            detailCollapsed ? undefined : "split-review-graph-detail"
          }
          sizedPane="right"
          initialRightPx={detailCollapsed ? DETAIL_RAIL_PX : 340}
          initialRightRatio={0.34}
          minLeftPx={180}
          minRightPx={detailCollapsed ? DETAIL_RAIL_PX : 220}
          fixedSizedPx={detailCollapsed ? DETAIL_RAIL_PX : undefined}
          left={
            <div className={styles.graphCol}>
              {filteredEmpty ? (
                <div className={styles.filterEmpty} role="status">
                  <p>当前保留比例下无可见节点</p>
                  <button
                    type="button"
                    className={styles.filterEmptyBtn}
                    onClick={() => commitImportanceKeepPercent(100)}
                  >
                    显示全部
                  </button>
                </div>
              ) : (
                <GraphCanvas
                  ref={graphRef}
                  payload={canvasPayload}
                  stage={canvasStage}
                  hideFiltered
                  highlightKey={highlightKey}
                  highlightFilters={hlFilters}
                  highlightMode="dim"
                  selectedNodeId={selectedNodeId}
                  selectedEdgeId={selectedEdgeId}
                  posCacheRef={posCacheRef}
                  keepLayout={false}
                  softFilterHide={false}
                  preferFullRelayout={false}
                  forceRelayoutToken={forceRelayoutToken}
                  livePhysics
                  focusNodeRequest={focusNodeRequest}
                  onFocusNodeConsumed={() => setFocusNodeRequest(null)}
                  onSelectNode={(id, meta) => {
                    setFocusNodeRequest(null);
                    if (id) selectNode(String(id), meta || null);
                    else clearSelection();
                  }}
                  onSelectEdge={(id) => {
                    setFocusNodeRequest(null);
                    if (id) selectEdge(String(id));
                    else clearSelection();
                  }}
                  legend={
                    <HighlightLegend
                      filters={hlFilters}
                      groups={hlGroups}
                      highlightKey={highlightKey}
                      onHighlightKey={(key) => {
                        setFocusNodeRequest(null);
                        setHighlightKey(key);
                      }}
                      stage={canvasStage}
                      mode="lecture"
                      hideFiltered
                      countHideFiltered
                      edgeVisibility={
                        relatedWithCount > 0
                          ? [
                              {
                                filterKey: "e_rel",
                                hidden: hideRelatedWith,
                                count: relatedWithCount,
                                onToggle: () => {
                                  setFocusNodeRequest(null);
                                  if (
                                    !hideRelatedWith &&
                                    highlightKey === "e_rel"
                                  ) {
                                    setHighlightKey(null);
                                  }
                                  setHideRelatedWith((v) => !v);
                                },
                              },
                            ]
                          : undefined
                      }
                    />
                  }
                />
              )}
            </div>
          }
          right={
            detailCollapsed ? (
              <aside
                className={kgStyles.kgSideRail}
                aria-label="详情栏（已收起）"
              >
                <button
                  type="button"
                  className={kgStyles.kgSideRailBtn}
                  title="展开详情"
                  aria-label="展开详情"
                  onClick={() => setDetailCollapsed(false)}
                >
                  <span aria-hidden>‹</span>
                </button>
              </aside>
            ) : (
              <aside className={`${pipe.side} ${kgStyles.kgSidePanel}`}>
                <button
                  type="button"
                  className={kgStyles.kgSideEdgeBtn}
                  title="收起详情"
                  aria-label="收起详情"
                  onClick={() => setDetailCollapsed(true)}
                >
                  <span aria-hidden>›</span>
                </button>
                <div className={kgStyles.kgSideScroll}>
                  <CollapsiblePanel
                    title="选中详情"
                    storageKey={SHARED_PANEL_KEYS.detail}
                    defaultOpen
                    open={detailPanelOpen}
                    onOpenChange={setDetailPanelOpen}
                    bodyClassName={kgStyles.sideCardBody}
                  >
                    <SelectionDetail
                      stage={canvasStage}
                      selectedNodeId={
                        selection?.kind === "node" ? selection.nodeId : null
                      }
                      selectedEdgeId={
                        selection?.kind === "edge" ? selection.edgeId : null
                      }
                      hideFiltered={false}
                      mode="lecture"
                      importanceMode="classroom"
                      editMode={false}
                      entityDefinitions={entityDefinitions}
                    />
                  </CollapsiblePanel>
                </div>
              </aside>
            )
          }
        />
      </div>
    </div>
  );
}
