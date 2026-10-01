import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { GraphCanvas, type GraphCanvasHandle } from "@/components/pipeline/GraphCanvas";
import { HighlightLegend } from "@/components/pipeline/HighlightLegend";
import { LatexText } from "@/components/pipeline/LatexText";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import { ResizableSplit } from "@/components/pipeline/ResizableSplit";
import { CollapsiblePanel } from "@/components/pipeline/CollapsiblePanel";
import { RelatedEdges, RelatedAssetsPanel, SelectionDetail, DeletedItemsPanel, relatedEdgesOf } from "@/components/pipeline/SelectionPanels";
import { SliceTextAnnotator } from "@/components/pipeline/SliceTextAnnotator";
import { PptCarousel } from "@/components/pipeline/PptCarousel";
import {
  fmtSec,
} from "@/lib/kg/adaptToPipeline";
import {
  applyImportanceFilter,
  applyRelatedWithVisibility,
  type ImportanceFilterMode,
} from "@/lib/kg/importanceFilter";
import { firstAssetWatch, type AssetsLibrary } from "@/lib/kg/assetsLibrary";
import { reviewWatchPath } from "@/lib/apps/reviewSeek";
import { processLectureKg, type MultiRelCollapseDecision } from "@/lib/kg/lectureKgProcess";
import {
  applyMmkgEnrichmentToNodes,
  buildKgViewFromPipeline,
  collectPptFromCues,
  enrichPipelineNodesWithImportance,
  loadCoursePipelineData,
  loadLecturePipelineData,
  loadMmkgEntityEnrichment,
  loadMmkgEntityEnrichmentForLectures,
  mergeMmkgEnrichmentMaps,
  type MmkgEntityEnrichment,
  type PipelineCueBundle,
} from "@/lib/kg/pipelineMergeSource";
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
import { propagateImportanceToParents } from "@/lib/kg/propagateImportance";
import { applyClassicPagerankToNodes } from "@/lib/kg/classicPagerank";
import { blendPagerankWithClassroom } from "@/lib/kg/blendPagerankWithClassroom";
import {
  getImportanceSource,
  setImportanceSource,
  type ImportanceSource,
} from "@/lib/kg/importanceSource";
import { loadManifest, type ManifestItem } from "@/lib/catalog";
import { courseDataUrl, coursePath, useCourseId } from "@/lib/course";
import {
  filterHasMatches,
  KG_LEGEND_GROUPS,
  stageEdgesForDisplay,
  stageHighlightFilters,
  stageNodesForDisplay,
  type VisNode,
} from "@/lib/pipeline/graphLogic";
import type { PipelineEdge, PipelineNode, PipelinePayload, PipelineStage } from "@/lib/pipeline/types";
import {
  deleteMmkgEdge,
  deleteMmkgNode,
  emitKnowledgeResourceOpen,
  fetchLinkedKnowledgeResources,
  fetchMmkgGraph,
  updateMmkgEdge,
  updateMmkgNode,
  type LinkedKnowledgeResource,
} from "@/lib/integration/knowledgeResources";
import shell from "@/styles/shell.module.css";
import pipe from "./PipelinePage.module.css";
import tb from "./TextbookPage.module.css";
import styles from "./KgPage.module.css";

const ALL_LECTURES = Array.from({ length: 26 }, (_, i) => String(i + 1));

function parseSessionId(raw?: string): [string, string] | null {
  const m = String(raw || "").match(/^(\d+)_(\d+)$/);
  if (!m) return null;
  return [m[1], m[2]];
}

function formatEvidenceText(raw: string): string {
  return (raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/<---\s*Page Split\s*--->/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 重要性阈值默认：去掉显式零分（τ=0.01）；无课堂分实体仍保留 */
const DEFAULT_IMPORTANCE_FILTER = 0.01;
const IMPORTANCE_MAX = 1;
const RESOURCE_LABELS: Record<LinkedKnowledgeResource["resource_type"], string> = {
  video: "视频",
  exercise: "练习",
  animation: "动画",
  formula: "公式",
};

function clampImportance(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(IMPORTANCE_MAX, Math.max(0, v));
}

/** 量化到两位小数，避免 0.1+0.2 浮点噪声 */
function roundImportance(v: number): number {
  return Math.round(clampImportance(v) * 100) / 100;
}

/** x.xx → [个位 0–1, 十分位 0–9, 百分位 0–9] */
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

export function KgPage() {
  const { lectureId, sessionId: rawSessionId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const focusParam = searchParams.get("focus");
  const integrationCourseId = String(searchParams.get("course_id") || "").trim();
  const kgLaunchToken = String(searchParams.get("kg_token") || "").trim();
  const embedMode = String(searchParams.get("embed") || "").trim();
  const requestedParentOrigin = String(searchParams.get("parent_origin") || "").trim();
  const course = useCourseId();
  const sessionPair = useMemo(() => parseSessionId(rawSessionId), [rawSessionId]);
  const scope = sessionPair ? "session" : lectureId ? "lecture" : "course";
  const sessionId = sessionPair ? `${sessionPair[0]}_${sessionPair[1]}` : "";

  const [catalog, setCatalog] = useState<ManifestItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** 主图：各片段流水线 merge；辅：文本/媒体 */
  const [pipelineCues, setPipelineCues] = useState<PipelineCueBundle[]>([]);
  /** 当前范围整讲 OCR PPT（两讲合并时为两讲拼接） */
  const [pptGallery, setPptGallery] = useState<string[]>([]);
  const [multiRelDecisions, setMultiRelDecisions] = useState<
    Record<string, MultiRelCollapseDecision>
  >({});
  const [mmkgEnrichment, setMmkgEnrichment] = useState<Map<string, MmkgEntityEnrichment>>(
    () => new Map()
  );
  const [importanceScores, setImportanceScores] = useState<Record<string, number> | null>(
    null
  );
  const [importanceClassroom, setImportanceClassroom] = useState<Record<
    string,
    number
  > | null>(null);
  const [importancePagerank, setImportancePagerank] = useState<Record<
    string,
    number
  > | null>(null);
  const [importanceSource, setImportanceSourceState] = useState<ImportanceSource>(() =>
    typeof window !== "undefined" ? getImportanceSource() : "classroom"
  );
  const [importanceContributions, setImportanceContributions] = useState<Record<
    string,
    Record<string, number>
  > | null>(null);
  const [importanceByContext, setImportanceByContext] = useState<Record<
    string,
    {
      scores?: Record<string, number>;
      classroom?: Record<string, number>;
      pagerank?: Record<string, number>;
      entities?: Record<
        string,
        {
          score?: number;
          classroom_norm?: number;
          contributions?: Record<string, number>;
        }
      >;
      top?: Array<{ name?: string; classroom_norm?: number }>;
    }
  > | null>(null);
  const [assetsLibrary, setAssetsLibrary] = useState<AssetsLibrary | null>(null);
  const [importanceBase, setImportanceBase] = useState<Record<string, number> | null>(null);
  const [importanceMin, setImportanceMin] = useState(DEFAULT_IMPORTANCE_FILTER);
  /** 三位数字草稿（编辑中可暂时为空）；提交后与 importanceMin 同步 */
  const [importanceDigitDraft, setImportanceDigitDraft] = useState<
    [string, string, string]
  >(() => {
    const [a, b, c] = importanceDigits(DEFAULT_IMPORTANCE_FILTER);
    return [String(a), String(b), String(c)];
  });
  /** reveal=临时显示被重要性阈值筛掉的实体（灰色弱化）；hide=删除 */
  const [revealFilteredEntities, setRevealFilteredEntities] = useState(false);

  const syncImportanceDigits = (v: number) => {
    const [a, b, c] = importanceDigits(v);
    setImportanceDigitDraft([String(a), String(b), String(c)]);
  };

  const commitImportanceMin = (next: number) => {
    const v = roundImportance(next);
    setImportanceMin(v);
    syncImportanceDigits(v);
    if (v <= 0) setRevealFilteredEntities(false);
  };

  const setImportanceDigit = (pos: 0 | 1 | 2, digit: number) => {
    let [a, b, c] = importanceDigits(importanceMin);
    if (pos === 0) {
      a = digit <= 0 ? 0 : 1;
      if (a === 1) {
        b = 0;
        c = 0;
      }
    } else if (pos === 1) {
      b = Math.min(9, Math.max(0, digit));
      if (a === 1) a = 0;
    } else {
      c = Math.min(9, Math.max(0, digit));
      if (a === 1) a = 0;
    }
    commitImportanceMin(digitsToImportance(a, b, c));
  };

  /** 按位 ±1，低位满 9 进位、为 0 退位（在 0.00～1.00 内） */
  const nudgeImportanceDigit = (pos: 0 | 1 | 2, delta: number) => {
    const step = pos === 0 ? 100 : pos === 1 ? 10 : 1;
    const cents = Math.round(roundImportance(importanceMin) * 100);
    const next = Math.min(100, Math.max(0, cents + delta * step));
    commitImportanceMin(next / 100);
  };

  const [lecFilter, setLecFilter] = useState("");
  const [cueFilter, setCueFilter] = useState<string | null>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<VisNode | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [kgPatch, setKgPatch] = useState<KgEditPatch>(() => emptyKgEditPatch());
  const [editBusy, setEditBusy] = useState(false);
  const [liveGraphVersion, setLiveGraphVersion] = useState(0);
  const [focusEdgeIds, setFocusEdgeIds] = useState<string[] | null>(null);
  const [showEvidence, setShowEvidence] = useState(true);
  const [hideRelatedWith, setHideRelatedWith] = useState(true);
  const [entityQuery, setEntityQuery] = useState("");
  const [entitySearchOpen, setEntitySearchOpen] = useState(false);
  const [focusNodeRequest, setFocusNodeRequest] = useState<{
    id: string;
    seq: number;
  } | null>(null);
  const [exportingPng, setExportingPng] = useState(false);
  const entitySearchRef = useRef<HTMLDivElement>(null);
  const posCacheRef = useRef<Record<string, { x: number; y: number }>>({});
  const graphRef = useRef<GraphCanvasHandle>(null);
  const resourceMenuRef = useRef<HTMLDivElement>(null);
  const resourceRequestSeq = useRef(0);
  const [resourceMenu, setResourceMenu] = useState<{
    nodeId: string;
    nodeLabel: string;
    x: number;
    y: number;
    loading: boolean;
    resources: LinkedKnowledgeResource[];
    warnings: string[];
    error: string;
  } | null>(null);

  const parentOrigin = useMemo(() => {
    if (typeof document === "undefined" || !document.referrer) return "";
    try {
      const referrerOrigin = new URL(document.referrer).origin;
      if (!requestedParentOrigin) return referrerOrigin;
      return new URL(requestedParentOrigin).origin === referrerOrigin
        ? referrerOrigin
        : "";
    } catch {
      return "";
    }
  }, [requestedParentOrigin]);

  const notifyNodeSelected = async (id: string, meta?: VisNode | null) => {
    if (embedMode !== "video-search" || !parentOrigin || window.parent === window) return;
    let segmentIds: string[] = [];
    if (integrationCourseId && kgLaunchToken) {
      try {
        const linked = await fetchLinkedKnowledgeResources({
          courseId: integrationCourseId,
          knowledgePointId: id,
          kgToken: kgLaunchToken,
        });
        segmentIds = linked.resources
          .filter((item) => item.resource_type === "video")
          .map((item) => item.resource_id);
      } catch {
        // The keyword remains useful to VideoSearch when no relation is available.
      }
    }
    window.parent.postMessage(
      {
        type: "kg:node-selected",
        payload: {
          id,
          name: meta?.label || id.split("/")[0] || id,
          keyword: meta?.label || id.split("/")[0] || id,
          segment_ids: segmentIds,
        },
      },
      parentOrigin,
    );
  };

  const openResourceMenu = async (
    nodeId: string,
    meta: VisNode,
    point: { clientX: number; clientY: number },
  ) => {
    setSelectedNode(meta);
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    const seq = ++resourceRequestSeq.current;
    const x = Math.min(Math.max(12, point.clientX), Math.max(12, window.innerWidth - 340));
    const y = Math.min(Math.max(12, point.clientY), Math.max(12, window.innerHeight - 420));
    setResourceMenu({
      nodeId,
      nodeLabel: meta.label || nodeId.split("/")[0] || nodeId,
      x,
      y,
      loading: true,
      resources: [],
      warnings: [],
      error: "",
    });
    if (!integrationCourseId) {
      setResourceMenu((current) => current && current.nodeId === nodeId
        ? { ...current, loading: false, error: "嵌入地址缺少 course_id" }
        : current);
      return;
    }
    try {
      const result = await fetchLinkedKnowledgeResources({
        courseId: integrationCourseId,
        knowledgePointId: nodeId,
        kgToken: kgLaunchToken,
      });
      if (seq !== resourceRequestSeq.current) return;
      setResourceMenu((current) => current && current.nodeId === nodeId
        ? {
            ...current,
            loading: false,
            resources: result.resources,
            warnings: result.warnings,
          }
        : current);
    } catch (reason) {
      if (seq !== resourceRequestSeq.current) return;
      setResourceMenu((current) => current && current.nodeId === nodeId
        ? {
            ...current,
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
          }
        : current);
    }
  };

  const openLinkedResource = (resource: LinkedKnowledgeResource) => {
    if (embedMode === "ai-teaching" && parentOrigin) {
      emitKnowledgeResourceOpen(resource, parentOrigin);
      setResourceMenu(null);
      return;
    }
    if (resource.url) {
      window.open(resource.url, "_blank", "noopener,noreferrer");
      setResourceMenu(null);
      return;
    }
    window.alert("该资源需要从 AI-Teaching 嵌入页面打开");
  };

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!resourceMenuRef.current?.contains(event.target as Node)) setResourceMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setResourceMenu(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, []);

  useEffect(() => {
    loadManifest(course)
      .then((m) => setCatalog(m.items || []))
      .catch(() => setCatalog([]));
  }, [course]);

  useEffect(() => {
    fetch(`${courseDataUrl(course, "entity_importance_lookup.json")}?t=${Date.now()}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (j: {
          scores?: Record<string, number>;
          base?: Record<string, number>;
          classroom?: Record<string, number>;
          pagerank?: Record<string, number>;
          contributions?: Record<string, Record<string, number>>;
          by_context?: Record<
            string,
            {
              scores?: Record<string, number>;
              classroom?: Record<string, number>;
              pagerank?: Record<string, number>;
              entities?: Record<
                string,
                {
                  score?: number;
                  classroom_norm?: number;
                  contributions?: Record<string, number>;
                }
              >;
              top?: Array<{ name?: string; classroom_norm?: number }>;
            }
          >;
        } | null) => {
          setImportanceScores(j?.scores && typeof j.scores === "object" ? j.scores : null);
          setImportanceBase(j?.base && typeof j.base === "object" ? j.base : null);
          setImportanceClassroom(
            j?.classroom && typeof j.classroom === "object" ? j.classroom : null
          );
          setImportancePagerank(
            j?.pagerank && typeof j.pagerank === "object" ? j.pagerank : null
          );
          setImportanceContributions(
            j?.contributions && typeof j.contributions === "object" ? j.contributions : null
          );
          setImportanceByContext(
            j?.by_context && typeof j.by_context === "object" ? j.by_context : null
          );
        }
      )
      .catch(() => {
        setImportanceScores(null);
        setImportanceBase(null);
        setImportanceClassroom(null);
        setImportancePagerank(null);
        setImportanceContributions(null);
        setImportanceByContext(null);
      });
  }, [course]);

  useEffect(() => {
    fetch(`${courseDataUrl(course, "assets_library.json")}?t=${Date.now()}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: AssetsLibrary | null) => {
        setAssetsLibrary(j && Array.isArray(j.cards) ? j : null);
      })
      .catch(() => setAssetsLibrary(null));
  }, [course]);

  const readyLectures = useMemo(() => {
    const s = new Set<string>();
    for (const it of catalog) {
      if (it.type === "pipeline" && it.lectureId) s.add(String(it.lectureId));
      if (it.scope === "lecture" && it.lectureId && it.type === "pipeline") {
        s.add(String(it.lectureId));
      }
    }
    // manifest 里 mmkg 讲次也视为可导航；主图仍要求 pipeline_build
    for (const it of catalog) {
      if (it.scope === "lecture" && it.lectureId && (it.type === "mmkg" || it.type === "kg")) {
        s.add(String(it.lectureId));
      }
    }
    return s;
  }, [catalog]);

  const sessionItems = useMemo(() => {
    const seen = new Set<string>();
    return catalog
      .filter((i) => i.scope === "session" && i.sessionId)
      .filter((i) => {
        const sid = String(i.sessionId);
        if (seen.has(sid)) return false;
        seen.add(sid);
        return true;
      })
      .slice()
      .sort((a, b) => {
        const aa = a.lectureIds?.[0] || String(a.sessionId || "").split("_")[0];
        const bb = b.lectureIds?.[0] || String(b.sessionId || "").split("_")[0];
        return Number(aa || 0) - Number(bb || 0);
      });
  }, [catalog]);

  /** 有图谱但未进入「奇偶成对」session 的讲次（如 17 考试无图 → 18 落单） */
  const orphanLectures = useMemo(() => {
    const covered = new Set<string>();
    for (const it of sessionItems) {
      const ids = it.lectureIds?.length
        ? it.lectureIds
        : String(it.sessionId || "").split("_");
      for (const id of ids) {
        if (id) covered.add(String(id));
      }
    }
    const withPipeline = new Set<string>();
    for (const it of catalog) {
      if (it.type === "pipeline" && it.lectureId) {
        withPipeline.add(String(it.lectureId));
      }
    }
    return [...readyLectures]
      .filter((id) => /^\d+$/.test(id) && !covered.has(id) && withPipeline.has(id))
      .sort((a, b) => Number(a) - Number(b));
  }, [catalog, readyLectures, sessionItems]);

  type KgNavEntry =
    | { kind: "session"; sessionId: string; a: string; b: string; title?: string; sortKey: number }
    | { kind: "lecture"; lectureId: string; sortKey: number };

  const kgNavEntries = useMemo(() => {
    const entries: KgNavEntry[] = [];
    for (const it of sessionItems) {
      const sid = String(it.sessionId || "");
      const ids = it.lectureIds?.length ? it.lectureIds : sid.split("_");
      const a = String(ids[0] || "");
      const b = String(ids[1] || a);
      entries.push({
        kind: "session",
        sessionId: sid,
        a,
        b,
        title: it.title,
        sortKey: Number(a || 0),
      });
    }
    for (const lid of orphanLectures) {
      entries.push({ kind: "lecture", lectureId: lid, sortKey: Number(lid) });
    }
    entries.sort((x, y) => x.sortKey - y.sortKey || x.kind.localeCompare(y.kind));
    return entries;
  }, [sessionItems, orphanLectures]);

  const courseReady = useMemo(
    () =>
      catalog.some((i) => i.type === "pipeline" && i.lectureId) ||
      [...readyLectures].length > 0,
    [catalog, readyLectures]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    setHighlightKey(null);
    setLecFilter("");
    setCueFilter(null);
    setPipelineCues([]);
    setPptGallery([]);
    setMultiRelDecisions({});
    setMmkgEnrichment(new Map());
    setEntityQuery("");
    setEntitySearchOpen(false);
    setFocusNodeRequest(null);
    setKgPatch(emptyKgEditPatch(course, "course"));
    posCacheRef.current = {};

    const patchScopeId =
      scope === "lecture" && lectureId
        ? String(lectureId)
        : scope === "session" && sessionPair
          ? `${sessionPair[0]}_${sessionPair[1]}`
          : "course";

    const run = async () => {
      if (embedMode && integrationCourseId && kgLaunchToken) {
        const live = await fetchMmkgGraph(integrationCourseId, kgLaunchToken, "fused");
        if (cancelled) return;
        const nodes = (Array.isArray(live.nodes) ? live.nodes : []).map((node) => ({
          ...node,
          id: String(node.id || ""),
          label: String(node.zh_name || node.name || node.en_name || node.id || ""),
          title: String(node.info || node.description || ""),
        })).filter((node) => node.id);
        const edges = (Array.isArray(live.edges) ? live.edges : []).map((edge, index) => ({
          ...edge,
          id: String(edge.id || `mmkg-edge:${index}`),
          from: String(edge.source || edge.from || ""),
          to: String(edge.target || edge.to || ""),
          label: String(edge.relation || edge.label || ""),
          relation: String(edge.relation || edge.label || ""),
        })).filter((edge) => edge.from && edge.to);
        if (parentOrigin && window.parent !== window) {
          window.parent.postMessage(
            {
              type: "kg:graph-ready",
              payload: {
                course_id: integrationCourseId,
                nodes,
              },
            },
            parentOrigin,
          );
        }
        setPipelineCues([{
          cueId: "mmkg-live",
          lectureId: "all",
          text: "",
          nodes,
          edges,
          edgeCount: edges.length,
        }]);
        setPptGallery([]);
        setMultiRelDecisions({});
        setMmkgEnrichment(new Map());
        setKgPatch(emptyKgEditPatch(course, "course"));
        setLoading(false);
        return;
      }
      const patchPromise = fetchKgEdits(course, patchScopeId).catch(() =>
        emptyKgEditPatch(course, patchScopeId)
      );

      const loadCollapse = async (lec: string) => {
        try {
          const res = await fetch(
            `${courseDataUrl(course, `pipeline/multi_rel_collapse_lecture_${lec}.json`)}?t=${Date.now()}`,
            { cache: "no-store" }
          );
          if (!res.ok) return {} as Record<string, MultiRelCollapseDecision>;
          const data = await res.json();
          return (data?.decisions || {}) as Record<string, MultiRelCollapseDecision>;
        } catch {
          return {} as Record<string, MultiRelCollapseDecision>;
        }
      };

      if (scope === "course") {
        // 等 manifest 给出讲次列表；若暂无则试 ALL_LECTURES 中实际存在的 pipeline
        const lecIds = readyLectures.size
          ? [...readyLectures]
          : ALL_LECTURES;
        const [loaded, enrich, patch, ...collapseMaps] = await Promise.all([
          loadCoursePipelineData(lecIds, course),
          loadMmkgEntityEnrichmentForLectures(course, lecIds.map(String)),
          patchPromise,
          ...lecIds.map((id) => loadCollapse(String(id))),
        ]);
        const merged: Record<string, MultiRelCollapseDecision> = {};
        for (const m of collapseMaps) Object.assign(merged, m);
        if (cancelled) return;
        setPipelineCues(loaded.cues);
        setPptGallery(loaded.pptGallery);
        setMultiRelDecisions(merged);
        setMmkgEnrichment(enrich);
        setKgPatch(patch);
        setLoading(false);
        return;
      }

      if (scope === "session" && sessionPair) {
        const [a, b] = sessionPair;
        const [loadedA, loadedB, enrichA, enrichB, decA, decB, patch] = await Promise.all([
          loadLecturePipelineData(a, course),
          loadLecturePipelineData(b, course),
          loadMmkgEntityEnrichment(course, a),
          loadMmkgEntityEnrichment(course, b),
          loadCollapse(a),
          loadCollapse(b),
          patchPromise,
        ]);
        if (cancelled) return;
        const cues = [...loadedA.cues, ...loadedB.cues].map((c, i) => ({
          ...c,
          edges: c.edges.map((e) => ({
            ...e,
            cue_label: `片段 ${i + 1}${
              c.startSec != null ? ` · ${Math.round(c.startSec)}s` : ""
            }`,
          })),
          edgeCount: c.edges.length,
        }));
        const enrich = mergeMmkgEnrichmentMaps(enrichA, enrichB);
        setPipelineCues(cues);
        setPptGallery(
          [...new Set([...loadedA.pptGallery, ...loadedB.pptGallery].filter(Boolean))]
        );
        setMultiRelDecisions({ ...decA, ...decB });
        setMmkgEnrichment(enrich);
        setKgPatch(patch);
        setLoading(false);
        return;
      }

      if (scope === "lecture" && lectureId) {
        const [loaded, enrich, decisions, patch] = await Promise.all([
          loadLecturePipelineData(String(lectureId), course),
          loadMmkgEntityEnrichment(course, String(lectureId)),
          loadCollapse(String(lectureId)),
          patchPromise,
        ]);
        if (cancelled) return;
        setPipelineCues(loaded.cues);
        setPptGallery(loaded.pptGallery);
        setMultiRelDecisions(decisions);
        setMmkgEnrichment(enrich);
        setKgPatch(patch);
        setLoading(false);
        return;
      }

      throw new Error("无效的图谱范围");
    };

    run().catch((e) => {
      if (!cancelled) {
        setError(String(e.message || e));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    scope,
    lectureId,
    sessionPair,
    course,
    embedMode,
    integrationCourseId,
    kgLaunchToken,
    parentOrigin,
    liveGraphVersion,
    // 仅整课依赖讲次清单；避免 catalog 晚到时重载单讲
    scope === "course" ? [...readyLectures].sort().join(",") : "",
  ]);

  const contextKey = useMemo(() => {
    if (scope === "lecture" && lectureId) return `lecture:${lectureId}`;
    if (scope === "session" && sessionPair)
      return `session:${sessionPair[0]}_${sessionPair[1]}`;
    return "course";
  }, [scope, lectureId, sessionPair]);

  const editScopeId = useMemo(() => {
    if (scope === "lecture" && lectureId) return String(lectureId);
    if (scope === "session" && sessionPair)
      return `${sessionPair[0]}_${sessionPair[1]}`;
    return "course";
  }, [scope, lectureId, sessionPair]);

  const handleRenameEntity = async (currentId: string, newId: string) => {
    const nextName = String(newId || "").trim();
    if (!nextName || nextName === currentId) return;
    setEditBusy(true);
    try {
      if (embedMode && integrationCourseId && kgLaunchToken) {
        const names = splitCanonicalName(nextName);
        await updateMmkgNode(integrationCourseId, kgLaunchToken, currentId, {
          id: nextName,
          zh_name: names.zh,
          en_name: names.en || null,
          name: names.zh || nextName,
        });
        setSelectedNode(null);
        setSelectedEdgeId(null);
        setLiveGraphVersion((value) => value + 1);
        return;
      }
      const renames = withEntityRename(kgPatch.entityRenames || {}, currentId, nextName);
      const saved = await saveKgEdits(course, editScopeId, {
        replaceEntityRenames: true,
        entityRenames: renames,
      });
      setKgPatch(saved);
      setSelectedNode((prev) =>
        prev && String(prev.id) === currentId
          ? {
              ...prev,
              id: nextName,
              label: splitCanonicalName(nextName).zh || nextName,
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
      if (embedMode && integrationCourseId && kgLaunchToken) {
        const edge = pipelineCues
          .flatMap((cue) => cue.edges || [])
          .find((item) => String(item.id) === edgeId);
        if (!edge) throw new Error(`未找到关系 ${edgeId}`);
        await updateMmkgEdge(integrationCourseId, kgLaunchToken, edgeId, {
          source: edit.reversed ? edge.to : edge.from,
          target: edit.reversed ? edge.from : edge.to,
          relation: edit.relation || edit.label || edge.relation || edge.label || "related_to",
        });
        setSelectedEdgeId(null);
        setLiveGraphVersion((value) => value + 1);
        return;
      }
      const saved = await saveKgEdits(course, editScopeId, {
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
      const saved = await saveKgEdits(course, editScopeId, {
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
      if (embedMode && integrationCourseId && kgLaunchToken) {
        await deleteMmkgNode(integrationCourseId, kgLaunchToken, currentId);
        setSelectedNode(null);
        setSelectedEdgeId(null);
        setLiveGraphVersion((value) => value + 1);
        return;
      }
      const saved = await saveKgEdits(course, editScopeId, {
        deletedEntities: { [original]: true },
      });
      setKgPatch(saved);
      setSelectedNode(null);
      setSelectedEdgeId(null);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleDeleteEdge = async (edgeId: string) => {
    setEditBusy(true);
    try {
      if (embedMode && integrationCourseId && kgLaunchToken) {
        await deleteMmkgEdge(integrationCourseId, kgLaunchToken, edgeId);
        setSelectedEdgeId(null);
        setLiveGraphVersion((value) => value + 1);
        return;
      }
      const saved = await saveKgEdits(course, editScopeId, {
        deletedEdges: { [edgeId]: true },
        // clear relation edits for this edge (optional cleanup)
        edgeEdits: { [edgeId]: null },
      });
      setKgPatch(saved);
      setSelectedEdgeId(null);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleRestoreEntity = async (originalId: string) => {
    setEditBusy(true);
    try {
      const saved = await saveKgEdits(course, editScopeId, {
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
      const saved = await saveKgEdits(course, editScopeId, {
        deletedEdges: { [edgeId]: null },
      });
      setKgPatch(saved);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleDeletePpt = async (url: string) => {
    const key = String(url || "").trim();
    if (!key) return;
    setEditBusy(true);
    try {
      const saved = await saveKgEdits(course, editScopeId, {
        deletedPptUrls: { [key]: true },
      });
      setKgPatch(saved);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const handleRestorePpt = async (url: string) => {
    setEditBusy(true);
    try {
      const saved = await saveKgEdits(course, editScopeId, {
        deletedPptUrls: { [url]: null },
      });
      setKgPatch(saved);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const scopedImportance = useMemo(() => {
    const ctx = importanceByContext?.[contextKey];
    const hasCtxScores = ctx?.scores && Object.keys(ctx.scores).length;
    const hasCtxPr = ctx?.pagerank && Object.keys(ctx.pagerank).length;
    const hasCtxClassroom =
      (ctx?.classroom && Object.keys(ctx.classroom).length > 0) ||
      (ctx?.top || []).some((r) => Number.isFinite(Number(r?.classroom_norm))) ||
      Object.values(ctx?.entities || {}).some((r) =>
        Number.isFinite(Number(r?.classroom_norm))
      );

    /** 只写入有效课堂分；includeZero=false 时跳过 0（避免整课海量 0 分把后几讲筛空） */
    const mergeClassroom = (
      target: Record<string, number>,
      src: Record<string, number> | null | undefined,
      includeZero: boolean
    ) => {
      if (!src) return;
      for (const [name, raw] of Object.entries(src)) {
        const cn = Number(raw);
        if (!Number.isFinite(cn)) continue;
        if (cn > 1e-12) {
          target[name] =
            target[name] == null ? cn : Math.max(target[name], cn);
        } else if (includeZero) {
          target[name] = 0;
        }
      }
    };

    const classroom: Record<string, number> = {};
    // 讲次/堂次：整课课堂分只作「正分先验」；0 分表示无课堂证据，不当作显式零
    // 整课视图：保留显式 0，便于「去掉零分」筛掉无课堂信号实体
    mergeClassroom(classroom, importanceClassroom, scope === "course");

    const pagerank: Record<string, number> = {
      ...(importancePagerank || {}),
    };
    const contrib: Record<string, Record<string, number>> = {
      ...(importanceContributions || {}),
    };

    if (hasCtxScores || hasCtxPr || hasCtxClassroom) {
      // 当前讲/堂上下文：允许显式 0（该讲确实无课堂信号）
      mergeClassroom(classroom, ctx?.classroom, true);
      if (ctx?.pagerank && typeof ctx.pagerank === "object") {
        Object.assign(pagerank, ctx.pagerank);
      }
      for (const [name, rec] of Object.entries(ctx?.entities || {})) {
        if (rec?.contributions) contrib[name] = rec.contributions;
        const cn = Number(rec?.classroom_norm);
        // entities 里大量缺省 0；只吸收正分，显式零改由 top / classroom 扁平表提供
        if (Number.isFinite(cn) && cn > 1e-12) {
          classroom[name] =
            classroom[name] == null ? cn : Math.max(classroom[name], cn);
        }
      }
      for (const row of ctx?.top || []) {
        const name = String(row?.name || "").trim();
        if (!name) continue;
        const cn = Number(row?.classroom_norm);
        if (!Number.isFinite(cn)) continue;
        if (cn > 1e-12) {
          classroom[name] =
            classroom[name] == null ? cn : Math.max(classroom[name], cn);
        } else {
          // top 列表中的显式课堂 0：本讲可筛掉
          classroom[name] = 0;
        }
      }
      return {
        scores: {
          ...(importanceScores || {}),
          ...((ctx?.scores as Record<string, number>) || {}),
        },
        classroom,
        pagerank,
        contributions: contrib,
      };
    }
    return {
      scores: importanceScores,
      classroom,
      pagerank: importancePagerank,
      contributions: importanceContributions,
    };
  }, [
    importanceByContext,
    contextKey,
    scope,
    importanceScores,
    importanceClassroom,
    importancePagerank,
    importanceContributions,
  ]);

  /** 筛选与节点大小一律以课堂分为准；PR 模式仅作实验叠加，不替代课堂分做阈值 */
  const displayClassroom = useMemo(() => {
    return scopedImportance.classroom;
  }, [scopedImportance]);

  // 管线：merge 并集 → 去重/规则/节点/孤立处理 → 重要性 → related_with
  const pipelineView = useMemo(() => {
    if (loading || error) return null;
    if (!pipelineCues.length) return null;
    const built = buildKgViewFromPipeline({
      scope:
        scope === "course" ? "course" : scope === "session" ? "session" : "lecture",
      lectureId: lectureId ? String(lectureId) : undefined,
      sessionPair,
      cues: pipelineCues,
      cueFilter,
      hideRelatedWith: false,
      lectureFilter: scope === "course" ? lecFilter || null : null,
      courseId: course,
    });
    const processed = processLectureKg(
      built.stage.nodes || [],
      built.stage.edges || [],
      { multiRelDecisions }
    );
    const edited = applyKgEdits(processed.nodes, processed.edges, kgPatch);
    let nodes = enrichPipelineNodesWithImportance(edited.nodes, {
      scores: scopedImportance.scores,
      base: importanceBase,
      classroom: displayClassroom,
      contributions:
        importanceSource === "pagerank" ? null : scopedImportance.contributions,
      displayMode: "classroom",
    });
    nodes = applyMmkgEnrichmentToNodes(nodes, mmkgEnrichment);
    // 重要性只作用于保留边；处理删除边原样挂回供图例
    const keptOnly = edited.edges.filter(
      (e) =>
        (e.source || "") !== "process_rule" &&
        (e.source || "") !== "process_node" &&
        (e.source || "") !== "process_isolated"
    );
    const processOnly = edited.edges.filter(
      (e) =>
        (e.source || "") === "process_rule" ||
        (e.source || "") === "process_node" ||
        (e.source || "") === "process_isolated"
    );
    // 阈值筛选始终基于课堂分（enrich 结果）；PR 仅在筛后叠加展示
    let propStats = { layers: 0, boosted_nodes: 0 };
    if (importanceSource !== "pagerank") {
      const propagated = propagateImportanceToParents(nodes, keptOnly);
      nodes = propagated.nodes;
      propStats = propagated.stats;
    }
    const mode: ImportanceFilterMode = revealFilteredEntities ? "reveal" : "hide";
    const imp = applyImportanceFilter(nodes, keptOnly, {
      tau: importanceMin > 0 ? importanceMin : null,
      mode,
    });
    let displayNodes = imp.nodes;
    let displayEdges = imp.edges;
    if (importanceSource === "pagerank") {
      const prEdges = hideRelatedWith
        ? displayEdges.filter((e) => {
            const r = String(e.relation || e.label || "")
              .split("|")[0]
              .trim()
              .toLowerCase();
            return r !== "related_with" && !String(e.source || "").startsWith("process_");
          })
        : displayEdges.filter((e) => !String(e.source || "").startsWith("process_"));
      displayNodes = applyClassicPagerankToNodes(displayNodes, prEdges);
      displayNodes = blendPagerankWithClassroom(displayNodes, {
        classroom: scopedImportance.classroom,
        contributions: scopedImportance.contributions,
      });
    }
    // 处理删除边的端点：高亮处理类时需要节点占位
    const nodeMap = new Map(displayNodes.map((n) => [n.id, n]));
    const builtNodeById = new Map(
      (built.stage.nodes || []).map((n) => [n.id, n])
    );
    for (const e of processOnly) {
      for (const id of [e.from, e.to]) {
        if (!id || nodeMap.has(id)) continue;
        const prev = builtNodeById.get(id);
        nodeMap.set(id, {
          id,
          label: prev?.label || id.split("/")[0],
          kind: "filtered",
          title: `${id}\n（后处理删除相关）`,
        });
      }
    }
    /** 重要性 / related_with 筛选前的全量，供顶部「总数」稳定展示 */
    const fullStage: PipelineStage = {
      ...built.stage,
      nodes,
      edges: keptOnly,
    };
    const stage: PipelineStage = {
      ...built.stage,
      blurb:
        (built.stage.blurb || "") +
        " · 后处理：去重合并→层次规则删边→不合适节点→孤立/短路径子图" +
        (importanceSource === "pagerank"
          ? " · 筛选=课堂重要性；展示：PR + 课堂轻量修正"
          : " · 重要性：课堂初值→沿图谱层次边（属于/组成/依赖）向上传递"),
      nodes: [...nodeMap.values()],
      edges: [...displayEdges, ...processOnly],
      stats: {
        ...(built.stage.stats || {}),
        total: displayEdges.length,
        process_rule_removed: processed.stats.rule_removed,
        process_node_removed: processed.stats.node_removed,
        process_isolated_removed: processed.stats.isolated_removed,
        process_kept: processed.stats.kept_edges,
        importance_filtered_nodes: imp.filteredCount,
        importance_min: importanceMin > 0 ? importanceMin : 0,
        importance_prop_layers: propStats.layers,
        importance_prop_boosted: propStats.boosted_nodes,
      },
    };
    return {
      payload: built.payload,
      stage,
      fullStage,
      cues: built.cues,
      activeCue: built.activeCue,
    };
  }, [
    loading,
    error,
    pipelineCues,
    scope,
    lectureId,
    sessionPair,
    cueFilter,
    lecFilter,
    scopedImportance,
    displayClassroom,
    importanceSource,
    importanceBase,
    mmkgEnrichment,
    importanceMin,
    revealFilteredEntities,
    multiRelDecisions,
    hideRelatedWith,
    kgPatch,
  ]);

  const payload: PipelinePayload | null = pipelineView?.payload || null;
  const displayStage: PipelineStage | null = pipelineView?.stage
    ? applyRelatedWithVisibility(pipelineView.stage, hideRelatedWith)
    : null;

  /** 与 GraphCanvas 一致：默认隐藏 process_* / filtered 边时的可见节点·边 */
  const showProcessEdges = Boolean(
    highlightKey && ["p_rule", "p_node", "p_iso"].includes(highlightKey)
  );
  const graphHideFiltered = !showProcessEdges;
  const visibleGraph = useMemo(() => {
    if (!displayStage || !payload) {
      return { nodes: [] as PipelineNode[], edges: [] as PipelineEdge[] };
    }
    const mode = payload.mode || "lecture";
    const edges = stageEdgesForDisplay(mode, displayStage, graphHideFiltered);
    const nodes = stageNodesForDisplay(mode, displayStage, edges, graphHideFiltered);
    return { nodes, edges };
  }, [displayStage, payload, graphHideFiltered]);

  /** 未做重要性 / related_with 筛选的全量规模（调课堂分时总数保持稳定） */
  const totalGraph = useMemo(() => {
    if (!pipelineView?.fullStage || !payload) {
      return { nodes: 0, edges: 0 };
    }
    const mode = payload.mode || "lecture";
    const edges = stageEdgesForDisplay(mode, pipelineView.fullStage, true);
    const nodes = stageNodesForDisplay(
      mode,
      pipelineView.fullStage,
      edges,
      true
    );
    return { nodes: nodes.length, edges: edges.length };
  }, [pipelineView, payload]);

  const cueList: {
    cueId: string;
    startSec?: number;
    edgeCount: number;
  }[] = pipelineCues.map((c) => ({
    cueId: c.cueId,
    startSec: c.startSec,
    edgeCount: c.edgeCount,
  }));

  const relatedWithCount = useMemo(() => {
    return (pipelineView?.stage.edges || []).filter(
      (e) => (e.relation || e.label || "") === "related_with"
    ).length;
  }, [pipelineView]);

  const importanceFilteredCount = useMemo(() => {
    return Number(pipelineView?.stage.stats?.importance_filtered_nodes || 0);
  }, [pipelineView]);

  const joinedEvidence = useMemo(() => {
    const annEdges: PipelineEdge[] = (displayStage?.edges || []).map((pe) => ({
      ...pe,
      context: (pe.context || "").trim(),
    }));
    if (cueFilter) {
      const hit = pipelineCues.find((c) => c.cueId === cueFilter);
      return { text: hit?.text || "", annEdges };
    }
    const cues =
      scope === "course" && lecFilter
        ? pipelineCues.filter((c) => String(c.lectureId) === String(lecFilter))
        : pipelineCues;
    return {
      text: formatEvidenceText(
        cues
          .map((c) => c.text)
          .filter(Boolean)
          .join("\n\n")
      ),
      annEdges,
    };
  }, [scope, displayStage, cueFilter, pipelineCues, lecFilter]);

  const hasEvidenceText = joinedEvidence.text.length > 0;
  const evidenceVisible = showEvidence && hasEvidenceText;

  const mode = payload?.mode || "lecture";
  const hlGroups = useMemo(() => {
    if (!displayStage || !pipelineView?.stage) return [];
    const fullStage = pipelineView.stage;
    return KG_LEGEND_GROUPS.filter((g) => g.id !== "process")
      .map((g) => ({
        ...g,
        filters: g.filters.filter((f) => {
          if (cueFilter && f.key === "e_cross") return false;
          // related_with 默认隐藏：图例仍按全量边计数，保证关系类中可见
          if (f.key === "e_rel") {
            return filterHasMatches(mode, fullStage, f, true);
          }
          return filterHasMatches(mode, displayStage, f, true);
        }),
      }))
      .filter((g) => g.filters.length > 0);
  }, [displayStage, pipelineView, mode, cueFilter]);
  const hlFilters = useMemo(() => {
    if (hlGroups.length) return hlGroups.flatMap((g) => g.filters);
    if (!displayStage) return [];
    return stageHighlightFilters(displayStage, mode, payload?.lecture_ids || []).filter((f) =>
      filterHasMatches(mode, displayStage, f, false)
    );
  }, [hlGroups, displayStage, mode, payload]);

  useEffect(() => {
    setSelectedNode(null);
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    setHighlightKey(null);
    setEntityQuery("");
    setEntitySearchOpen(false);
  }, [cueFilter, lecFilter, hideRelatedWith, importanceMin]);

  useEffect(() => {
    const onDoc = (ev: MouseEvent) => {
      if (!entitySearchRef.current?.contains(ev.target as Node)) {
        setEntitySearchOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selectEdgesFromText = (id: string | null, groupIds?: string[]) => {
    if (id == null) {
      setSelectedEdgeId(null);
      setFocusEdgeIds(null);
      return;
    }
    const ids = (groupIds?.length ? groupIds : [id]).map(String);
    setFocusEdgeIds(ids);
    setSelectedEdgeId(ids.length === 1 ? ids[0] : null);
    setSelectedNode(null);
  };

  const selectedPipeEdge =
    selectedEdgeId && displayStage
      ? (displayStage.edges || []).find((e) => e.id === selectedEdgeId) || null
      : null;

  const activePipelineCue =
    (cueFilter && pipelineCues.find((c) => c.cueId === cueFilter)) ||
    null;

  /** 全部片段：整讲/两讲 OCR 全量；单片段：该片段时间窗对应页 */
  const mediaPptUrls = useMemo(() => {
    if (cueFilter && activePipelineCue) {
      if (activePipelineCue.pptPages?.length) return activePipelineCue.pptPages;
      if (activePipelineCue.ppt) return [activePipelineCue.ppt];
      return [];
    }
    const scopedCues =
      scope === "course" && lecFilter
        ? pipelineCues.filter((c) => String(c.lectureId) === String(lecFilter))
        : pipelineCues;
    if (pptGallery.length) {
      if (scope === "course" && lecFilter) {
        const fromCues = collectPptFromCues(scopedCues);
        if (fromCues.length) return fromCues;
      }
      return pptGallery;
    }
    return collectPptFromCues(scopedCues);
  }, [cueFilter, activePipelineCue, pptGallery, pipelineCues, scope, lecFilter]);

  const visiblePptUrls = useMemo(() => {
    const hidden = kgPatch.deletedPptUrls || {};
    if (!Object.keys(hidden).length) return mediaPptUrls;
    return mediaPptUrls.filter((u) => u && !hidden[u]);
  }, [mediaPptUrls, kgPatch.deletedPptUrls]);

  const mediaClip = cueFilter
    ? activePipelineCue?.clip || ""
    : pipelineCues[0]?.clip || payload?.items?.[0]?.media?.clip || "";

  const mediaMeta = cueFilter && activePipelineCue
    ? [
        activePipelineCue.cueId,
        activePipelineCue.startSec != null || activePipelineCue.endSec != null
          ? `${fmtSec(activePipelineCue.startSec)}–${fmtSec(activePipelineCue.endSec)}`
          : "",
        visiblePptUrls.length > 1 ? `${visiblePptUrls.length} 张 PPT` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : visiblePptUrls.length
      ? scope === "session"
        ? `本堂全部 PPT · ${visiblePptUrls.length} 张`
        : `全部片段 · ${visiblePptUrls.length} 张 PPT`
      : "";

  const pptCarouselLabel = cueFilter
    ? "本片段 PPT"
    : scope === "session"
      ? "本堂全部 PPT"
      : "全部 PPT";

  const edgeLectures = useMemo(() => {
    if (scope !== "course") return [] as string[];
    const s = new Set<string>();
    for (const e of pipelineCues.flatMap((c) => c.edges)) {
      String(e.lecture_id || "")
        .split(/[+]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((x) => s.add(x));
    }
    return Array.from(s).sort((a, b) => Number(a) - Number(b));
  }, [scope, pipelineCues]);

  const goCourse = () => navigate(coursePath(course, "/kg/course"));
  const goLecture = (id: string) => navigate(coursePath(course, `/kg/lecture/${id}`));
  const goSession = (id: string) => navigate(coursePath(course, `/kg/session/${id}`));

  const title =
    displayStage?.title ||
    (scope === "session" && sessionPair
      ? `第 ${sessionPair[0]}–${sessionPair[1]} 讲 · 相邻两讲`
      : scope === "course"
        ? "整课 · 流水线融合并集"
        : `第 ${lectureId} 讲 · 融合图谱`);

  const hasGraph = Boolean(payload && displayStage && visibleGraph.edges.length > 0);

  const exportCurrentGraphPng = async () => {
    if (!graphRef.current || exportingPng || !hasGraph) return;
    setExportingPng(true);
    try {
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[:T]/g, "-");
      let name = `kg-${scope}`;
      if (scope === "lecture" && lectureId) name += `-L${lectureId}`;
      else if (scope === "session" && sessionPair) {
        name += `-L${sessionPair[0]}_${sessionPair[1]}`;
      } else if (scope === "course") {
        name += lecFilter ? `-L${lecFilter}` : "-all";
      }
      if (cueFilter) name += "-cue";
      if (highlightKey) name += `-hl-${highlightKey}`;
      name += `-${stamp}.png`;
      const ok = await graphRef.current.exportPng({
        scale: 3,
        filename: name,
        background: "#0b1220",
      });
      if (!ok) {
        window.alert("导出失败：当前图谱尚未就绪，请稍后重试");
      }
    } finally {
      setExportingPng(false);
    }
  };

  const entityMatches = useMemo(() => {
    const q = entityQuery.trim().toLowerCase();
    if (!q || !displayStage?.nodes?.length) return [];
    const scored = displayStage.nodes
      .map((n) => {
        const id = String(n.id || "");
        const label = String(n.label || "");
        const title = String(n.title || "");
        const zh = id.split("/")[0] || label;
        const aliasHay = (n.aliases || [])
          .map((a) => String(a || ""))
          .join(" ");
        const hay = `${id} ${label} ${title} ${zh} ${aliasHay}`.toLowerCase();
        if (!hay.includes(q)) return null;
        let score = 0;
        if (zh.toLowerCase() === q || label.toLowerCase() === q || id.toLowerCase() === q) {
          score = 300;
        } else if (
          zh.toLowerCase().startsWith(q) ||
          label.toLowerCase().startsWith(q) ||
          id.toLowerCase().startsWith(q)
        ) {
          score = 200;
        } else if (aliasHay.toLowerCase().includes(q)) {
          score = 180;
        } else {
          score = 100;
        }
        score += Math.min(40, Number(n.importance) || 0) * 10;
        return { id, label: label || zh || id, kind: n.kind || "", score };
      })
      .filter(Boolean) as { id: string; label: string; kind: string; score: number }[];
    scored.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, "zh"));
    return scored.slice(0, 12);
  }, [entityQuery, displayStage]);

  const focusEntity = (nodeId: string) => {
    const n = displayStage?.nodes?.find((x) => String(x.id) === nodeId);
    if (!n) return;
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    setHighlightKey(null);
    setSelectedNode({
      id: String(n.id),
      label: n.label || String(n.id).split("/")[0] || String(n.id),
      title: n.title || n.label || String(n.id),
      _kind: n.kind || "",
    });
    setFocusNodeRequest((prev) => ({
      id: String(n.id),
      seq: (prev?.seq || 0) + 1,
    }));
    setEntityQuery(n.label || String(n.id).split("/")[0] || String(n.id));
    setEntitySearchOpen(false);
  };

  // URL ?focus= 实体 → 选中并居中（支持全名或中文主名）
  useEffect(() => {
    if (!focusParam || !displayStage?.nodes?.length || loading) return;
    const raw = decodeURIComponent(focusParam).trim();
    if (!raw) return;
    const zh = raw.split("/")[0].trim().toLowerCase();
    const nodes = displayStage.nodes;
    const hit =
      nodes.find((n) => String(n.id) === raw) ||
      nodes.find((n) => String(n.id).split("/")[0].trim().toLowerCase() === zh) ||
      nodes.find(
        (n) =>
          String(n.label || "")
            .split("/")[0]
            .trim()
            .toLowerCase() === zh
      );
    if (!hit) return;
    if (selectedNode?.id === String(hit.id)) return;
    focusEntity(String(hit.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to URL/graph load
  }, [focusParam, displayStage, loading]);

  // 选中实体/关系时展开右栏并打开「选中详情」
  useEffect(() => {
    if (selectedNode?.id != null || selectedEdgeId) {
      setDetailCollapsed(false);
      setDetailPanelOpen(true);
    }
  }, [selectedNode?.id, selectedEdgeId]);

  return (
    <>
    <ResizableShell
      storagePrefix="shell-kg"
      detailFixedRightPx={detailCollapsed ? 32 : undefined}
      detailMinRightPx={220}
      detailInitialRightPx={340}
      nav={
        <aside className={shell.sidebar}>
          <div className={shell.sideHead}>
            <Link className={shell.back} to={coursePath(course)}>
              <span className={shell.backIcon} aria-hidden>
                ←
              </span>
              <span className={shell.backBrand}>
                Edu<em>KG</em>
              </span>
            </Link>
            <p className={shell.eyebrow}>Classroom Graph</p>
            <h1 className={shell.sideTitle}>课堂级图谱</h1>
          </div>

          <div className={shell.navBlock}>
            <button
              type="button"
              className={scope === "course" ? shell.navItemActive : shell.navItem}
              disabled={!courseReady}
              onClick={goCourse}
            >
              <span>整课总览</span>
            </button>
          </div>

          {kgNavEntries.length > 0 ? (
            <div className={`${shell.navBlock} ${shell.navBlockGrow}`}>
              <p className={shell.navLabel}>单课列表</p>
              <div className={shell.navScroll}>
                {kgNavEntries.map((entry) => {
                  if (entry.kind === "session") {
                    const active = scope === "session" && sessionId === entry.sessionId;
                    return (
                      <button
                        key={`s-${entry.sessionId}`}
                        type="button"
                        className={active ? shell.navItemActive : shell.navItem}
                        onClick={() => goSession(entry.sessionId)}
                        title={entry.title || `第 ${entry.a}–${entry.b} 讲`}
                      >
                        <span>
                          第 {entry.a}–{entry.b} 次课
                        </span>
                      </button>
                    );
                  }
                  const active = scope === "lecture" && String(lectureId) === entry.lectureId;
                  return (
                    <button
                      key={`l-${entry.lectureId}`}
                      type="button"
                      className={active ? shell.navItemActive : shell.navItem}
                      onClick={() => goLecture(entry.lectureId)}
                      title={`第 ${entry.lectureId} 讲（相邻讲次无图谱，单独展示）`}
                    >
                      <span>第 {entry.lectureId} 次课</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </aside>
      }
      main={
        <main className={pipe.mainCol}>
          <header className={styles.kgTopbar}>
            <div className={styles.kgToolbar}>
              {scope === "course" && edgeLectures.length > 0 ? (
                <div className={styles.kgToolGroup} data-group="scope">
                  <select
                    className={styles.kgSelect}
                    value={lecFilter}
                    onChange={(e) => setLecFilter(e.target.value)}
                    aria-label="讲次筛选"
                  >
                    <option value="">全部讲次</option>
                    {edgeLectures.map((l) => (
                      <option key={l} value={l}>
                        第 {l} 次课
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <button
                type="button"
                className={`${styles.kgChip} ${
                  importanceSource === "classroom" ? styles.kgChipActive : ""
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
                className={styles.importanceFilter}
                title="重要性阈值：保留课堂分≥该值的节点；低阈值(≤0.15)时未标注实体保留，避免整图被筛空"
              >
                <span className={styles.importanceDigits} aria-label="重要性阈值 x.xx">
                  {([0, 1, 2] as const).map((pos) => {
                    const max = pos === 0 ? 1 : 9;
                    // 进退位后：仅在端点禁用上下（低位 9 仍可上、0 仍可下）
                    const atMax = importanceMin >= IMPORTANCE_MAX;
                    const atMin = importanceMin <= 0;
                    return (
                      <span key={pos} className={styles.importanceDigitWrap}>
                        {pos === 1 ? (
                          <span className={styles.importanceDot} aria-hidden>
                            .
                          </span>
                        ) : null}
                        <span className={styles.importanceDigit}>
                          <button
                            type="button"
                            className={styles.importanceDigitBtn}
                            disabled={atMax}
                            onClick={() => nudgeImportanceDigit(pos, 1)}
                            title={pos === 0 ? "个位 +1" : pos === 1 ? "十分位 +1" : "百分位 +1"}
                            aria-label={
                              pos === 0
                                ? "个位加一"
                                : pos === 1
                                  ? "十分位加一"
                                  : "百分位加一"
                            }
                          >
                            ▲
                          </button>
                          <input
                            type="text"
                            inputMode="numeric"
                            maxLength={1}
                            className={styles.importanceDigitInput}
                            value={importanceDigitDraft[pos]}
                            onChange={(e) => {
                              const raw = e.target.value.replace(/\D/g, "").slice(-1);
                              setImportanceDigitDraft((prev) => {
                                const next: [string, string, string] = [
                                  prev[0],
                                  prev[1],
                                  prev[2],
                                ];
                                next[pos] = raw;
                                return next;
                              });
                              const parsed = parseDigitChar(raw, max);
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
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.currentTarget.blur();
                              } else if (e.key === "ArrowUp") {
                                e.preventDefault();
                                nudgeImportanceDigit(pos, 1);
                              } else if (e.key === "ArrowDown") {
                                e.preventDefault();
                                nudgeImportanceDigit(pos, -1);
                              }
                            }}
                            aria-label={
                              pos === 0
                                ? "个位，0 或 1"
                                : pos === 1
                                  ? "十分位，0～9"
                                  : "百分位，0～9"
                            }
                          />
                          <button
                            type="button"
                            className={styles.importanceDigitBtn}
                            disabled={atMin}
                            onClick={() => nudgeImportanceDigit(pos, -1)}
                            title={pos === 0 ? "个位 −1" : pos === 1 ? "十分位 −1" : "百分位 −1"}
                            aria-label={
                              pos === 0
                                ? "个位减一"
                                : pos === 1
                                  ? "十分位减一"
                                  : "百分位减一"
                            }
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
                className={`${styles.kgChip} ${
                  revealFilteredEntities ? styles.kgChipAccent : ""
                }`}
                disabled={!hasGraph}
                onClick={() => {
                  setRevealFilteredEntities((on) => {
                    const next = !on;
                    if (next && importanceMin <= 0) {
                      commitImportanceMin(DEFAULT_IMPORTANCE_FILTER);
                    }
                    return next;
                  });
                }}
                title={
                  !hasGraph
                    ? "暂无图谱"
                    : revealFilteredEntities
                      ? `正在显示 ${importanceFilteredCount} 个被筛实体（灰色弱化）`
                      : importanceMin <= 0
                        ? "点击后将阈值设为 0.01 并灰色显示被筛实体"
                        : `当前隐藏约 ${importanceFilteredCount} 个低重要性实体`
                }
              >
                {revealFilteredEntities ? "隐藏被筛实体" : "显示被筛实体"}
              </button>
              <button
                type="button"
                className={`${styles.kgChip} ${evidenceVisible ? styles.kgChipActive : ""}`}
                disabled={!hasEvidenceText}
                onClick={() => setShowEvidence((v) => !v)}
              >
                {evidenceVisible ? "隐藏文本" : "显示文本"}
              </button>

              <div className={styles.kgStats} aria-label="图谱规模">
                <div
                  title={
                    loading || !displayStage
                      ? undefined
                      : `当前图谱节点数 ${visibleGraph.nodes.length} / 总节点数 ${totalGraph.nodes}`
                  }
                >
                  <strong>
                    {loading || !displayStage
                      ? "—"
                      : `${visibleGraph.nodes.length}/${totalGraph.nodes}`}
                  </strong>
                  <span>节点</span>
                </div>
                <div
                  title={
                    loading || !displayStage
                      ? undefined
                      : `当前图谱边数 ${visibleGraph.edges.length} / 总边数 ${totalGraph.edges}`
                  }
                >
                  <strong>
                    {loading || !displayStage
                      ? "—"
                      : `${visibleGraph.edges.length}/${totalGraph.edges}`}
                  </strong>
                  <span>关系</span>
                </div>
              </div>
            </div>
          </header>

          <div className={pipe.stageBody}>
            <ResizableSplit
              className={`${tb.split} ${styles.graphSplit}`}
              storageKey="split-kg-text-graph-v2"
              initialLeftRatio={0.5}
              minLeftPx={260}
              minRightPx={300}
              enabled={evidenceVisible}
              leftClassName={tb.slicePane}
              rightClassName={`${pipe.viewport} ${styles.graphViewport}`}
              left={
                <>
                  <div className={tb.sliceHead}>
                    <strong>处理文本</strong>
                  </div>
                  <div className={tb.sliceScroll}>
                    {hasEvidenceText ? (
                      <SliceTextAnnotator
                        text={joinedEvidence.text}
                        edges={joinedEvidence.annEdges}
                        selectedEdgeId={selectedEdgeId}
                        focusEdgeIds={focusEdgeIds}
                        tone="new"
                        onSelectEdge={(id, groupIds) => selectEdgesFromText(id, groupIds)}
                      />
                    ) : (
                      <p className={styles.emptyEvidence}>当前筛选下暂无处理文本</p>
                    )}
                  </div>
                </>
              }
              right={
                <>
                  <div className={styles.graphChrome}>
                    <div className={styles.entitySearch} ref={entitySearchRef}>
                      <input
                        type="search"
                        className={styles.entitySearchInput}
                        value={entityQuery}
                        disabled={!hasGraph}
                        placeholder="搜索实体…"
                        aria-label="搜索实体"
                        autoComplete="off"
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
                      {entitySearchOpen && entityQuery.trim() && (
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
                                <em>
                                  {m.id.includes("/")
                                    ? m.id.split("/").slice(1).join("/")
                                    : m.kind}
                                </em>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                    <div className={styles.graphChromeEnd}>
                      <label
                        className={`${styles.editModeToggle} ${editMode ? styles.editModeOn : ""}`}
                        title="开启后可修改实体名、关系，并删除 PPT / 板书截图"
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
                        className={styles.kgExportBtn}
                        disabled={!hasGraph || exportingPng}
                        onClick={() => void exportCurrentGraphPng()}
                        title="按当前筛选、高亮与视口导出高清 PNG"
                      >
                        {exportingPng ? "导出中…" : "导出图片"}
                      </button>
                    </div>
                  </div>
                  <div className={styles.graphBody}>
                    {loading && <div className={pipe.emptyPane}>加载图谱…</div>}
                    {error && <div className={pipe.emptyPane}>{error}</div>}
                    {!loading && !error && !hasGraph && (
                      <div className={pipe.emptyPane}>
                        当前筛选下无边，或尚未导出流水线融合结果
                      </div>
                    )}
                    {!loading && !error && hasGraph && payload && displayStage && (
                      <GraphCanvas
                        ref={graphRef}
                        payload={payload}
                        stage={displayStage}
                        hideFiltered={!showProcessEdges}
                        highlightKey={highlightKey}
                        highlightFilters={hlFilters}
                        selectedEdgeId={selectedEdgeId}
                        focusEdgeIds={focusEdgeIds}
                        selectedNodeId={
                          selectedNode?.id != null ? String(selectedNode.id) : null
                        }
                        posCacheRef={posCacheRef}
                        keepLayout={scope === "session"}
                        focusNodeRequest={focusNodeRequest}
                        onFocusNodeConsumed={() => setFocusNodeRequest(null)}
                        onSelectNode={(_id, meta) => {
                          setFocusNodeRequest(null);
                          setSelectedNode(meta || null);
                          if (_id) {
                            setSelectedEdgeId(null);
                            setFocusEdgeIds(null);
                            void notifyNodeSelected(String(_id), meta);
                          }
                        }}
                        onContextNode={(id, meta, point) => {
                          void openResourceMenu(id, meta, point);
                        }}
                        onSelectEdge={(id, groupIds) => {
                          setFocusNodeRequest(null);
                          selectEdgesFromText(id, groupIds);
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
                            stage={displayStage}
                            mode={mode}
                            hideFiltered={!showProcessEdges}
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
                                        if (!hideRelatedWith && highlightKey === "e_rel") {
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
                </>
              }
            />
          </div>
        </main>
      }
      detail={
        detailCollapsed ? (
          <aside className={styles.kgSideRail} aria-label="详情栏（已收起）">
            <button
              type="button"
              className={styles.kgSideRailBtn}
              title="展开详情"
              aria-label="展开详情"
              onClick={() => setDetailCollapsed(false)}
            >
              <span aria-hidden>‹</span>
            </button>
          </aside>
        ) : (
        <aside className={`${pipe.side} ${styles.kgSidePanel}`}>
          <button
            type="button"
            className={styles.kgSideEdgeBtn}
            title="收起详情"
            aria-label="收起详情"
            onClick={() => setDetailCollapsed(true)}
          >
            <span aria-hidden>›</span>
          </button>
          <CollapsiblePanel
            title={scope === "session" ? "本堂片段" : "本讲片段"}
            storageKey="kg-panel-cues-v2"
            defaultOpen={false}
          >
            <div className={pipe.cueList}>
              {!cueList.length ? (
                <div className={pipe.sideEmpty}>暂无片段</div>
              ) : (
                <>
                  <button
                    type="button"
                    className={`${pipe.cueBtn} ${!cueFilter ? pipe.cueOn : ""}`}
                    onClick={() => setCueFilter(null)}
                  >
                    全部片段
                  </button>
                  {cueList.map((c, i) => (
                    <button
                      key={c.cueId}
                      type="button"
                      className={`${pipe.cueBtn} ${
                        cueFilter === c.cueId ? pipe.cueOn : ""
                      }`}
                      onClick={() =>
                        setCueFilter((v) => (v === c.cueId ? null : c.cueId))
                      }
                    >
                      片段 {i + 1}
                    </button>
                  ))}
                </>
              )}
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel
            title="选中详情"
            storageKey="kg-panel-detail-v2"
            defaultOpen={false}
            open={detailPanelOpen}
            onOpenChange={setDetailPanelOpen}
          >
            {displayStage ? (
              <>
                <SelectionDetail
                  stage={displayStage}
                  selectedNodeId={
                    selectedNode?.id != null ? String(selectedNode.id) : null
                  }
                  selectedEdgeId={selectedEdgeId}
                  hideFiltered={false}
                  mode={mode}
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
                  permanentDelete={Boolean(embedMode)}
                />
                {editMode && !embedMode ? (
                  <DeletedItemsPanel
                    kgPatch={kgPatch}
                    busy={editBusy}
                    onRestoreEntity={handleRestoreEntity}
                    onRestoreEdge={handleRestoreEdge}
                    onRestorePpt={handleRestorePpt}
                  />
                ) : null}
                {((scope === "lecture" && lectureId) ||
                  (scope === "session" && sessionPair)) &&
                selectedNode?.id != null &&
                !selectedEdgeId ? (
                  <div className={styles.reviewJump}>
                    <Link
                      to={reviewWatchPath(
                        course,
                        scope === "session" && sessionPair
                          ? `${sessionPair[0]}_${sessionPair[1]}`
                          : String(lectureId),
                        {
                          kp: String(selectedNode.id),
                          lec:
                            scope === "lecture"
                              ? lectureId
                              : sessionPair?.[0],
                          t: firstAssetWatch(
                            assetsLibrary,
                            String(selectedNode.id),
                            {
                              lectureId:
                                scope === "lecture"
                                  ? lectureId
                                  : sessionPair?.[0],
                              lectureOnly: scope === "lecture",
                            }
                          )?.startSec,
                        }
                      )}
                    >
                      在单课复习中查看
                    </Link>
                  </div>
                ) : null}
              </>
            ) : (
              <div className={pipe.sideEmpty}>点击图中实体或关系查看详情</div>
            )}
          </CollapsiblePanel>

          {selectedNode?.id != null && !selectedEdgeId ? (
            <CollapsiblePanel
              title="相关资产"
              storageKey="kg-panel-assets-v2"
              defaultOpen={false}
            >
              <RelatedAssetsPanel
                entityId={String(selectedNode.id)}
                library={assetsLibrary}
                lectureId={scope === "lecture" ? lectureId : null}
                lectureOnly={scope === "lecture"}
              />
            </CollapsiblePanel>
          ) : null}

          {selectedNode?.id != null ? (
            <CollapsiblePanel
              title={`相关关系-${
                displayStage
                  ? relatedEdgesOf(displayStage, String(selectedNode.id), {
                      hideFiltered: false,
                      mode,
                    }).length
                  : 0
              }`}
              storageKey="kg-panel-edges-v2"
              defaultOpen={false}
            >
              {displayStage ? (
                <RelatedEdges
                  stage={displayStage}
                  nodeId={String(selectedNode.id)}
                  selectedEdgeId={selectedEdgeId}
                  hideFiltered={false}
                  mode={mode}
                  onSelect={(id) => {
                    if (id == null) {
                      setSelectedEdgeId(null);
                      setFocusEdgeIds(null);
                      return;
                    }
                    setFocusEdgeIds([id]);
                    setSelectedEdgeId(id);
                  }}
                />
              ) : (
                <div className={pipe.sideEmpty}>暂无</div>
              )}
            </CollapsiblePanel>
          ) : null}

          <CollapsiblePanel title="多模态证据" storageKey="kg-panel-media-v2" defaultOpen={false}>
            <div className={pipe.mm}>
              <div>
                <div className={pipe.mmLabel}>课堂切片</div>
                {mediaClip ? (
                  <video controls src={mediaClip} preload="metadata" />
                ) : (
                  <div className={pipe.sideEmpty}>暂无视频</div>
                )}
              </div>
              <div>
                <div className={pipe.mmLabel}>板书 / PPT</div>
                {visiblePptUrls.length ? (
                  <PptCarousel
                    images={visiblePptUrls}
                    alt="板书 / PPT"
                    label={pptCarouselLabel}
                    canDelete={editMode}
                    deleteBusy={editBusy}
                    onDelete={handleDeletePpt}
                  />
                ) : (
                  <div className={pipe.sideEmpty}>暂无帧图</div>
                )}
              </div>
            </div>
          </CollapsiblePanel>
        </aside>
        )
      }
    />
    {resourceMenu ? (
      <div
        ref={resourceMenuRef}
        className={styles.resourceMenu}
        style={{ left: resourceMenu.x, top: resourceMenu.y }}
        role="dialog"
        aria-label={`${resourceMenu.nodeLabel} 关联资源`}
      >
        <div className={styles.resourceMenuHead}>
          <div>
            <strong>{resourceMenu.nodeLabel}</strong>
            <span>关联资源</span>
          </div>
          <button type="button" onClick={() => setResourceMenu(null)} aria-label="关闭">
            ×
          </button>
        </div>
        {resourceMenu.loading ? (
          <div className={styles.resourceMenuState}>正在查询视频、练习、动画与公式…</div>
        ) : resourceMenu.error ? (
          <div className={styles.resourceMenuError}>{resourceMenu.error}</div>
        ) : resourceMenu.resources.length ? (
          <div className={styles.resourceMenuGroups}>
            {(["video", "exercise", "animation", "formula"] as const).map((kind) => {
              const rows = resourceMenu.resources.filter((item) => item.resource_type === kind);
              if (!rows.length) return null;
              return (
                <section key={kind}>
                  <h3>{RESOURCE_LABELS[kind]} · {rows.length}</h3>
                  {rows.map((resource) => (
                    <button
                      type="button"
                      key={`${kind}:${resource.resource_id}`}
                      onClick={() => openLinkedResource(resource)}
                    >
                      <span>{resource.title || `${RESOURCE_LABELS[kind]} ${resource.resource_id}`}</span>
                      <em>{resource.resource_id}</em>
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
        ) : (
          <div className={styles.resourceMenuState}>该知识结点暂无关联资源</div>
        )}
        {resourceMenu.warnings.length ? (
          <details className={styles.resourceMenuWarnings}>
            <summary>部分服务暂不可用</summary>
            {resourceMenu.warnings.map((warning, index) => (
              <p key={`${index}:${warning}`}>{warning}</p>
            ))}
          </details>
        ) : null}
      </div>
    ) : null}
    </>
  );
}
