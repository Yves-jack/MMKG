import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { GraphCanvas, type GraphCanvasHandle } from "@/components/graph/GraphCanvas";
import { HighlightLegend } from "@/components/graph/HighlightLegend";
import { LatexText } from "@/components/graph/LatexText";
import { ResizableShell } from "@/components/graph/ResizableShell";
import { ResizableSplit } from "@/components/graph/ResizableSplit";
import { CollapsiblePanel } from "@/components/graph/CollapsiblePanel";
import { RelatedEdges, RelatedAssetsPanel, SelectionDetail, DeletedItemsPanel, relatedEdgesOf } from "@/components/graph/SelectionPanels";
import {
  LinkedResourceCardList,
  LinkedResourceJumpBar,
  ResourceCardFold,
  RESOURCE_LABELS,
  videoSegmentKey,
} from "@/components/graph/LinkedResourceCards";
import { SliceTextAnnotator } from "@/components/graph/SliceTextAnnotator";
import { PptCarousel } from "@/components/graph/PptCarousel";
import {
  fmtSec,
} from "@/lib/kg/adaptToPipeline";
import {
  applyImportanceFilter,
  applyRelatedWithVisibility,
  type ImportanceFilterMode,
} from "@/lib/kg/importanceFilter";
import { dedupeEntityMatchesByZh } from "@/lib/entitySearchDedupe";
import {
  ensureAssetsLibraryIndexes,
  RELATED_ASSET_KINDS,
  type AssetsLibrary,
} from "@/lib/kg/assetsLibrary";
import {
  readSharedEntitySelection,
  SHARED_PANEL_KEYS,
  writeSharedEntitySelection,
} from "@/lib/kg/sharedEntitySelection";
import { canEditKnowledgeGraph } from "@/lib/integration/editPermission";
import {
  isProcessEdgeSource,
  processLectureKg,
  type MultiRelCollapseDecision,
} from "@/lib/kg/lectureKgProcess";
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
  parseLectureFilterIds,
  type MmkgEntityEnrichment,
  type PipelineCueBundle,
} from "@/lib/kg/pipelineMergeSource";
import { tryLoadKgProcessed } from "@/lib/kg/loadKgProcessed";
import type { KgProcessedArtifact } from "@/lib/kg/kgProcessedArtifact";
import {
  applyPropertyMergeDecisions,
  tryLoadPropertyMerge,
  type PropertyMergeDecision,
} from "@/lib/kg/propertyMerge";
import { scoreFragmentClassroomImportance } from "@/lib/pipeline/classroomFactors";
import { pairLecturesIntoSessions } from "@/lib/review/reviewSession";
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
  type VisEdge,
  type VisNode,
} from "@/lib/graph/graphLogic";
import type { PipelineEdge, PipelineNode, PipelinePayload, PipelineStage } from "@/lib/graph/types";
import {
  deleteMmkgEdge,
  deleteMmkgNode,
  emitKnowledgeResourceOpen,
  fetchLinkedKnowledgeResources,
  matchedKnowledgePointId,
  matchedKnowledgePointLabel,
  resolvePracticeSeedKp,
  fetchMmkgGraph,
  mmkgCachedRole,
  mmkgLogin,
  updateMmkgEdge,
  updateMmkgNode,
  type LinkedKnowledgeResource,
} from "@/lib/integration/knowledgeResources";
import shell from "@/styles/shell.module.css";
import pipe from "@/styles/panels.module.css";
import tb from "@/styles/kgChrome.module.css";
import styles from "./KgPage.module.css";

const ALL_LECTURES = Array.from({ length: 44 }, (_, i) => String(i + 1));

/** live 融合图按讲次过滤：依据节点 video_anchors / lecture_id */
function filterLiveGraphByLectures(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  lectureIds: string[],
): { nodes: PipelineNode[]; edges: PipelineEdge[] } {
  const want = new Set(lectureIds.map(String).filter(Boolean));
  if (!want.size) return { nodes, edges };
  const keep = new Set<string>();
  for (const n of nodes) {
    const id = String(n.id || "");
    if (!id) continue;
    const raw = n as PipelineNode & {
      lecture_id?: unknown;
      video_anchors?: Array<{ lecture_id?: unknown; video_id?: unknown }>;
    };
    if (want.has(String(raw.lecture_id || ""))) {
      keep.add(id);
      continue;
    }
    for (const a of raw.video_anchors || []) {
      if (want.has(String(a.lecture_id || ""))) {
        keep.add(id);
        break;
      }
      const vid = Number(a.video_id);
      if (Number.isFinite(vid) && want.has(String(vid + 1))) {
        keep.add(id);
        break;
      }
    }
  }
  if (!keep.size) return { nodes, edges };
  const nextEdges = edges.filter(
    (e) => keep.has(String(e.from)) && keep.has(String(e.to)),
  );
  const deg = new Set<string>();
  for (const e of nextEdges) {
    if (e.from) deg.add(String(e.from));
    if (e.to) deg.add(String(e.to));
  }
  return {
    nodes: nodes.filter((n) => deg.has(String(n.id))),
    edges: nextEdges,
  };
}

function parseSessionId(raw?: string): [string, string] | null {
  const m = String(raw || "").match(/^(\d+)_(\d+)$/);
  if (!m) return null;
  return [m[1], m[2]];
}

function clampMenuPos(point: { clientX: number; clientY: number }, w = 280, h = 280) {
  const gutter = 12;
  const width = Math.min(w, Math.max(0, window.innerWidth - gutter * 2));
  const height = Math.min(h, Math.max(0, window.innerHeight - gutter * 2));
  return {
    x: Math.min(
      Math.max(gutter, point.clientX),
      Math.max(gutter, window.innerWidth - width - gutter),
    ),
    y: Math.min(
      Math.max(gutter, point.clientY),
      Math.max(gutter, window.innerHeight - height - gutter),
    ),
  };
}

function applyGraphHides(
  stage: PipelineStage,
  hiddenNodes: Record<string, string>,
  hiddenEdges: Record<string, string>,
): PipelineStage {
  const hideN = Object.keys(hiddenNodes);
  const hideE = Object.keys(hiddenEdges);
  if (!hideN.length && !hideE.length) return stage;
  const nodeSet = new Set(hideN);
  const edgeSet = new Set(hideE);
  const edges = (stage.edges || []).filter((e) => {
    if (edgeSet.has(String(e.id))) return false;
    if (nodeSet.has(String(e.from)) || nodeSet.has(String(e.to))) return false;
    return true;
  });
  const nodes = (stage.nodes || []).filter((n) => !nodeSet.has(String(n.id)));
  return { ...stage, nodes, edges };
}

function edgeMenuLabel(edge: { from?: string; to?: string; relation?: string; label?: string }) {
  const pred = String(edge.relation || edge.label || "related_with").trim();
  const from = String(edge.from || "").split("/")[0] || "?";
  const to = String(edge.to || "").split("/")[0] || "?";
  return `${from} —[${pred}]→ ${to}`;
}

function formatEvidenceText(raw: string): string {
  return (raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/<---\s*Page Split\s*--->/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 重要性：保留前百分之几的高分节点 */
const DEFAULT_COURSE_IMPORTANCE_KEEP = 5;
const DEFAULT_LECTURE_IMPORTANCE_KEEP = 20;
const IMPORTANCE_PERCENT_MIN = 1;
const IMPORTANCE_PERCENT_MAX = 100;
const IMPORTANCE_KEEP_STORAGE_PREFIX = "teachkg-imp-keep-v1";

function defaultImportanceKeepForScope(scope: "course" | "lecture" | "session"): number {
  return scope === "course"
    ? DEFAULT_COURSE_IMPORTANCE_KEEP
    : DEFAULT_LECTURE_IMPORTANCE_KEEP;
}

function importanceKeepStorageKey(courseId: string, contextKey: string): string {
  return `${IMPORTANCE_KEEP_STORAGE_PREFIX}:${courseId}:${contextKey}`;
}

function readStoredImportanceKeep(
  courseId: string,
  contextKey: string,
  scope: "course" | "lecture" | "session",
): number {
  try {
    const raw = window.sessionStorage.getItem(
      importanceKeepStorageKey(courseId, contextKey),
    );
    if (raw != null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        return Math.min(
          IMPORTANCE_PERCENT_MAX,
          Math.max(IMPORTANCE_PERCENT_MIN, Math.round(n)),
        );
      }
    }
  } catch {
    /* ignore */
  }
  return defaultImportanceKeepForScope(scope);
}

function writeStoredImportanceKeep(
  courseId: string,
  contextKey: string,
  value: number,
) {
  try {
    window.sessionStorage.setItem(
      importanceKeepStorageKey(courseId, contextKey),
      String(value),
    );
  } catch {
    /* ignore */
  }
}
function linkedResourceNodeContext(
  node?: { aliases?: unknown; [key: string]: unknown } | null,
) {
  const aliases = Array.isArray(node?.aliases)
    ? node.aliases.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  return {
    nodeName: String(
      node?.label || node?.name || node?.zh_name || "",
    ).trim(),
    nodeAliases: aliases,
    nodeContent: String(
      node?.description || node?.info || "",
    ).trim(),
  };
}

function intersectVideoResources(
  left: LinkedKnowledgeResource[],
  right: LinkedKnowledgeResource[],
): LinkedKnowledgeResource[] {
  const rightKeys = new Set(
    right
      .filter((r) => r.resource_type === "video")
      .map(videoSegmentKey)
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const out: LinkedKnowledgeResource[] = [];
  for (const resource of left) {
    if (resource.resource_type !== "video") continue;
    const key = videoSegmentKey(resource);
    if (!key || !rightKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(resource);
  }
  return out;
}

/** 关系侧练习：合并两端实体上的练习资源（去重） */
function unionExerciseResources(
  left: LinkedKnowledgeResource[],
  right: LinkedKnowledgeResource[],
): LinkedKnowledgeResource[] {
  const seen = new Set<string>();
  const out: LinkedKnowledgeResource[] = [];
  for (const resource of [...left, ...right]) {
    if (resource.resource_type !== "exercise") continue;
    const key = String(resource.resource_id || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(resource);
  }
  return out;
}

function clampKeepPercent(v: number, fallback = DEFAULT_COURSE_IMPORTANCE_KEEP): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(IMPORTANCE_PERCENT_MAX, Math.max(IMPORTANCE_PERCENT_MIN, Math.round(v)));
}

/** 根据鼠标在滑条上的水平位置，估算对应百分比（与松手提交共用） */
function importancePercentAtPointer(
  el: HTMLElement,
  clientX: number
): { percent: number; ratio: number } {
  const rect = el.getBoundingClientRect();
  const thumb = 14;
  const usable = Math.max(1, rect.width - thumb);
  const x = Math.min(
    rect.width - thumb / 2,
    Math.max(thumb / 2, clientX - rect.left)
  );
  const ratio = Math.min(1, Math.max(0, (x - thumb / 2) / usable));
  const percent = clampKeepPercent(
    IMPORTANCE_PERCENT_MIN +
      ratio * (IMPORTANCE_PERCENT_MAX - IMPORTANCE_PERCENT_MIN)
  );
  return { percent, ratio };
}

export function KgPage() {
  const { lectureId, sessionId: rawSessionId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const focusParam = searchParams.get("focus");
  const integrationCourseId = String(searchParams.get("course_id") || "").trim();
  const resourceCourseId = String(
    searchParams.get("resource_course_id") || integrationCourseId,
  ).trim();
  const kgLaunchToken = String(searchParams.get("kg_token") || "").trim();
  const embedMode = String(searchParams.get("embed") || "").trim();
  const roleParam = String(searchParams.get("role") || "").trim();
  const isAiTeachingEmbed = embedMode === "ai-teaching";
  const isVideoSearchEmbed = embedMode === "video-search";
  const isEmbeddedGraph = isAiTeachingEmbed || isVideoSearchEmbed;
  /** 视频旁动态图谱：只保留画布 + 搜索，不展示工具条/侧栏详情 */
  const isGraphOnlyEmbed = isVideoSearchEmbed;
  const requestedParentOrigin = String(searchParams.get("parent_origin") || "").trim();
  const [verifiedRole, setVerifiedRole] = useState("");
  const canEditGraph = useMemo(
    () =>
      canEditKnowledgeGraph({
        embedMode,
        role: roleParam || verifiedRole || mmkgCachedRole(kgLaunchToken),
        kgToken: kgLaunchToken,
      }),
    [embedMode, roleParam, verifiedRole, kgLaunchToken],
  );
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
  const [propertyMergeDecisions, setPropertyMergeDecisions] = useState<
    Record<string, PropertyMergeDecision>
  >({});
  const [precomputedKg, setPrecomputedKg] = useState<KgProcessedArtifact | null>(null);
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
  const [importanceSource, setImportanceSourceState] = useState<ImportanceSource>(() => {
    if (typeof window === "undefined") return "classroom";
    const embed = new URLSearchParams(window.location.search).get("embed");
    if (embed === "ai-teaching") return "classroom";
    return getImportanceSource();
  });
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
  const [entityDefinitions, setEntityDefinitions] = useState<Record<string, string>>({});
  const [importanceBase, setImportanceBase] = useState<Record<string, number> | null>(null);
  const [importanceKeepPercent, setImportanceKeepPercent] = useState(
    DEFAULT_COURSE_IMPORTANCE_KEEP,
  );
  const [importancePercentDraft, setImportancePercentDraft] = useState(
    String(DEFAULT_COURSE_IMPORTANCE_KEEP),
  );
  const [importanceSliderActive, setImportanceSliderActive] = useState(false);
  const [importanceSliderHover, setImportanceSliderHover] = useState<{
    percent: number;
    ratio: number;
  } | null>(null);
  /** reveal=临时显示被重要性筛选掉的实体（灰色弱化）；hide=删除 */
  const [revealFilteredEntities, setRevealFilteredEntities] = useState(false);

  const [lecFilter, setLecFilter] = useState("");
  const [cueFilter, setCueFilter] = useState<string | null>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<VisNode | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [detailCollapsed, setDetailCollapsed] = useState(
    () => String(searchParams.get("embed") || "").trim() === "ai-teaching",
  );
  const [detailPanelOpen, setDetailPanelOpen] = useState(true);
  /** 选中实体/关系时仅展开「选中详情」，其余侧栏卡片默认收起 */
  const [edgesPanelOpen, setEdgesPanelOpen] = useState(false);
  const [assetsPanelOpen, setAssetsPanelOpen] = useState(true);
  const [mediaPanelOpen, setMediaPanelOpen] = useState(false);
  const [hiddenPanelOpen, setHiddenPanelOpen] = useState(false);
  const [panelEditMode, setPanelEditMode] = useState(false);
  const [hiddenNodeIds, setHiddenNodeIds] = useState<Record<string, string>>({});
  const [hiddenEdgeIds, setHiddenEdgeIds] = useState<Record<string, string>>({});
  const [kgPatch, setKgPatch] = useState<KgEditPatch>(() => emptyKgEditPatch());
  const [editBusy, setEditBusy] = useState(false);
  const [liveGraphVersion, setLiveGraphVersion] = useState(0);
  const [focusEdgeIds, setFocusEdgeIds] = useState<string[] | null>(null);
  const [showEvidence, setShowEvidence] = useState(true);
  const [hideRelatedWith, setHideRelatedWith] = useState(true);
  const [entityQuery, setEntityQuery] = useState("");
  const [entitySearchOpen, setEntitySearchOpen] = useState(false);
  /** 搜索选中但当前重要性过滤未保留的节点，强制钉回画布（含一跳邻居）；再调过滤即清除 */
  const [pinnedEntityIds, setPinnedEntityIds] = useState<string[]>([]);
  const [focusNodeRequest, setFocusNodeRequest] = useState<{
    id: string;
    seq: number;
  } | null>(null);
  const [exportingPng, setExportingPng] = useState(false);
  const entitySearchRef = useRef<HTMLDivElement>(null);
  const posCacheRef = useRef<Record<string, { x: number; y: number }>>({});
  /** 钉回后等节点进入 displayStage 再发 focus，避免搜到过滤外实体时居中空转 */
  const pendingFocusAfterPinRef = useRef<string | null>(null);
  /** 整课过滤累计 |Δ%|；≥5 触发重画并清零（仅 ≤500 节点软布局时） */
  const importanceDeltaAccumRef = useRef(0);
  const visibleNodeCountRef = useRef(0);
  const [forceRelayoutToken, setForceRelayoutToken] = useState(0);
  /** 整课动态布局节点上限：以内用单课式软增减+力导向，以上整图重画 */
  const COURSE_SOFT_LAYOUT_MAX = 500;
  /** 避免改重要性筛网时反复用共享选中 focusEntity，造成「未点击却高亮」 */
  const focusRestoreKeyRef = useRef("");
  const graphRef = useRef<GraphCanvasHandle>(null);
  const resourceMenuRef = useRef<HTMLDivElement>(null);
  const resourceRequestSeq = useRef(0);
  const sideResourceSeq = useRef(0);
  const [sideLinkedResources, setSideLinkedResources] = useState<{
    targetKey: string;
    mode: "node" | "edge";
    loading: boolean;
    resources: LinkedKnowledgeResource[];
    warnings: string[];
    error: string;
    /** AI-Teaching 匹配到的知识点 id，练习 seed 必须用这个 */
    matchedKpId?: string;
    matchedKpLabel?: string;
  } | null>(null);
  const [graphCtxMenu, setGraphCtxMenu] = useState<
    | {
        kind: "node";
        nodeId: string;
        nodeLabel: string;
        nodeAliases: string[];
        meta: VisNode;
        x: number;
        y: number;
        loading: boolean;
        resources: LinkedKnowledgeResource[];
        warnings: string[];
        error: string;
        matchedKpId?: string;
        matchedKpLabel?: string;
      }
    | {
        kind: "edge";
        edgeId: string;
        label: string;
        x: number;
        y: number;
      }
    | null
  >(null);

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
    let videoRefs: Array<{ video_id: string; start_sec: number }> = [];
    if (resourceCourseId && kgLaunchToken) {
      try {
        const linked = await fetchLinkedKnowledgeResources({
          courseId: resourceCourseId,
          knowledgePointId: id,
          kgToken: kgLaunchToken,
          ...linkedResourceNodeContext(meta),
        });
        const videos = linked.resources.filter((item) => item.resource_type === "video");
        videoRefs = videos.flatMap((item) => {
          const videoId = String(item.metadata?.video_id || item.resource_id).trim();
          const startSec = Number(item.start_sec);
          if (!videoId || item.start_sec == null || !Number.isFinite(startSec)) return [];
          return [{ video_id: videoId, start_sec: startSec }];
        });
      } catch {
        // No fallback: an unavailable relation stays unavailable.
      }
    }
    window.parent.postMessage(
      {
        type: "kg:node-selected",
        payload: {
          course_id: resourceCourseId,
          id,
          name: meta?.label || id.split("/")[0] || id,
          video_refs: videoRefs,
        },
      },
      parentOrigin,
    );
  };

  const openNodeContextMenu = async (
    nodeId: string,
    meta: VisNode,
    point: { clientX: number; clientY: number },
  ) => {
    setSelectedNode(meta);
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    const seq = ++resourceRequestSeq.current;
    const pos = clampMenuPos(point, 320, 420);
    const nodeAliases = Array.isArray(meta.aliases)
      ? meta.aliases.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    setGraphCtxMenu({
      kind: "node",
      nodeId,
      nodeLabel: meta.label || nodeId.split("/")[0] || nodeId,
      nodeAliases,
      meta,
      x: pos.x,
      y: pos.y,
      loading: Boolean(resourceCourseId),
      resources: [],
      warnings: [],
      error: "",
    });
    if (!resourceCourseId) return;
    try {
      const result = await fetchLinkedKnowledgeResources({
        courseId: resourceCourseId,
        knowledgePointId: nodeId,
        kgToken: kgLaunchToken,
        ...linkedResourceNodeContext(meta),
      });
      if (seq !== resourceRequestSeq.current) return;
      setGraphCtxMenu((current) =>
        current && current.kind === "node" && current.nodeId === nodeId
          ? {
              ...current,
              loading: false,
              resources: result.resources,
              warnings: result.warnings,
              matchedKpId: matchedKnowledgePointId(result.match) || undefined,
              matchedKpLabel: matchedKnowledgePointLabel(result.match) || undefined,
            }
          : current,
      );
    } catch (reason) {
      if (seq !== resourceRequestSeq.current) return;
      setGraphCtxMenu((current) =>
        current && current.kind === "node" && current.nodeId === nodeId
          ? {
              ...current,
              loading: false,
              error: reason instanceof Error ? reason.message : String(reason),
            }
          : current,
      );
    }
  };

  const openEdgeContextMenu = (
    edgeId: string,
    meta: VisEdge,
    point: { clientX: number; clientY: number },
  ) => {
    const pos = clampMenuPos(point, 260, 200);
    setGraphCtxMenu({
      kind: "edge",
      edgeId,
      label: edgeMenuLabel({
        from: String(meta.from || ""),
        to: String(meta.to || ""),
        relation: String(meta._relation || ""),
      }),
      x: pos.x,
      y: pos.y,
    });
  };

  const hideEntity = (nodeId: string, label: string) => {
    setHiddenNodeIds((prev) => ({ ...prev, [nodeId]: label || nodeId.split("/")[0] || nodeId }));
    if (selectedNode?.id != null && String(selectedNode.id) === nodeId) {
      setSelectedNode(null);
    }
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    setPanelEditMode(false);
    setGraphCtxMenu(null);
  };

  const hideEdge = (edgeId: string, label: string) => {
    setHiddenEdgeIds((prev) => ({ ...prev, [edgeId]: label || edgeId }));
    if (selectedEdgeId === edgeId) {
      setSelectedEdgeId(null);
      setFocusEdgeIds(null);
    }
    setPanelEditMode(false);
    setGraphCtxMenu(null);
  };

  const unhideEntity = (nodeId: string) => {
    setHiddenNodeIds((prev) => {
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
  };

  const unhideEdge = (edgeId: string) => {
    setHiddenEdgeIds((prev) => {
      const next = { ...prev };
      delete next[edgeId];
      return next;
    });
  };

  const beginEditEntity = (meta: VisNode) => {
    if (!canEditGraph) return;
    setSelectedNode(meta);
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    setPanelEditMode(true);
    setDetailCollapsed(false);
    setDetailPanelOpen(true);
    setGraphCtxMenu(null);
  };

  const beginEditEdge = (edgeId: string) => {
    if (!canEditGraph) return;
    setFocusNodeRequest(null);
    setSelectedNode(null);
    setSelectedEdgeId(edgeId);
    setFocusEdgeIds([edgeId]);
    setPanelEditMode(true);
    setDetailCollapsed(false);
    setDetailPanelOpen(true);
    setGraphCtxMenu(null);
  };

  const openLinkedResource = (resource: LinkedKnowledgeResource) => {
    const selectedKp = String(selectedNode?.id || "").trim();
    const edgeEndpointKp =
      selectedEdgeId && displayStage
        ? String(
            (displayStage.edges || []).find(
              (e) => String(e.id) === String(selectedEdgeId),
            )?.from || "",
          ).trim()
        : "";
    const matchedKp =
      String(sideLinkedResources?.matchedKpId || "").trim() ||
      (graphCtxMenu?.kind === "node"
        ? String(graphCtxMenu.matchedKpId || "").trim()
        : "");
    const matchedLabel =
      String(sideLinkedResources?.matchedKpLabel || "").trim() ||
      (graphCtxMenu?.kind === "node"
        ? String(graphCtxMenu.matchedKpLabel || "").trim()
        : "") ||
      String(selectedNode?.label || "").trim();
    // 练习库按 AT 知识点 id 精确过滤；图谱节点 id 对不上会回落整课题，界面就像「跳错知识点」
    const seedKp = resolvePracticeSeedKp({
      matchedKpId: matchedKp,
      selectedNodeId: selectedKp,
      edgeEndpointId: edgeEndpointKp,
    });
    const baseMeta: Record<string, unknown> = {
      ...(resource.metadata || {}),
      course_id:
        (resource.metadata as Record<string, unknown> | undefined)?.course_id ||
        resourceCourseId ||
        course,
    };
    const withCourse: LinkedKnowledgeResource = {
      ...resource,
      course_id: resource.course_id || resourceCourseId || course,
      metadata: baseMeta,
    };
    const enriched: LinkedKnowledgeResource =
      seedKp &&
      (withCourse.resource_type === "video" ||
        withCourse.resource_type === "exercise")
        ? {
            ...withCourse,
            // 练习：resource_id 用 seed KP，避免 AT 把题目 id 当成知识点
            resource_id:
              withCourse.resource_type === "exercise"
                ? seedKp
                : withCourse.resource_id,
            knowledge_point_ids:
              withCourse.resource_type === "exercise" ? [seedKp] : withCourse.knowledge_point_ids,
            metadata: {
              ...baseMeta,
              // 始终覆盖资源自带 KP，保证练习页 seed = 当前选中（匹配后）知识点
              knowledge_point_id: seedKp,
              seed_knowledge_point_id: seedKp,
              seed_knowledge_point_label: matchedLabel || undefined,
              knowledge_point_ids: [seedKp],
              kp: seedKp,
              practice_mode:
                withCourse.resource_type === "exercise"
                  ? "knowledge_point"
                  : baseMeta.practice_mode,
              graph_node_id: selectedKp || edgeEndpointKp || undefined,
            },
          }
        : withCourse;
    if (embedMode === "ai-teaching" && parentOrigin) {
      emitKnowledgeResourceOpen(enriched, parentOrigin);
      setGraphCtxMenu(null);
      return;
    }
    if (enriched.resource_type === "video") {
      const videoId = String(
        enriched.metadata?.video_id || enriched.resource_id || "",
      ).trim();
      const startSec = Number(enriched.start_sec);
      const lectureGuess = Number.isFinite(Number(videoId))
        ? String(Math.floor(Number(videoId)) + 1)
        : videoId || "1";
      const next = new URLSearchParams();
      if (selectedKp) next.set("kp", selectedKp);
      if (Number.isFinite(startSec)) next.set("t", String(Math.floor(startSec)));
      if (videoId) {
        next.set("video_id", videoId);
        next.set("lec", lectureGuess);
      }
      if (parentOrigin) next.set("parent_origin", parentOrigin);
      if (kgLaunchToken) next.set("kg_token", kgLaunchToken);
      const qs = next.toString();
      navigate(
        `${coursePath(course, `/apps/review/${lectureGuess}`)}${qs ? `?${qs}` : ""}`,
      );
      setGraphCtxMenu(null);
      return;
    }
    if (enriched.url) {
      window.open(enriched.url, "_blank", "noopener,noreferrer");
      setGraphCtxMenu(null);
      return;
    }
    window.alert("该资源需要从 AI-Teaching 嵌入页面打开");
  };

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!resourceMenuRef.current?.contains(event.target as Node)) setGraphCtxMenu(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGraphCtxMenu(null);
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
        setAssetsLibrary(
          j && Array.isArray(j.cards) ? ensureAssetsLibraryIndexes(j) : null
        );
      })
      .catch(() => setAssetsLibrary(null));
  }, [course]);

  useEffect(() => {
    fetch(`${courseDataUrl(course, "entity_definitions.json")}?t=${Date.now()}`, {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Record<string, string> | null) => {
        setEntityDefinitions(j && typeof j === "object" ? j : {});
      })
      .catch(() => setEntityDefinitions({}));
  }, [course]);

  useEffect(() => {
    if (!isAiTeachingEmbed && !isVideoSearchEmbed) return;
    if (importanceSource !== "classroom") {
      setImportanceSourceState("classroom");
      setImportanceSource("classroom");
    }
  }, [isAiTeachingEmbed, isVideoSearchEmbed, importanceSource]);

  useEffect(() => {
    if (!embedMode || !kgLaunchToken) {
      setVerifiedRole("");
      return;
    }
    let cancelled = false;
    mmkgLogin(kgLaunchToken)
      .then((claims) => {
        if (!cancelled) setVerifiedRole(claims.role || "");
      })
      .catch(() => {
        if (!cancelled) setVerifiedRole("");
      });
    return () => {
      cancelled = true;
    };
  }, [embedMode, kgLaunchToken]);

  useEffect(() => {
    if (!canEditGraph && panelEditMode) setPanelEditMode(false);
  }, [canEditGraph, panelEditMode]);

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

  // 切范围才清空课堂筛选；勿在加载 effect 里清，否则选单课会立刻跳回整课
  useEffect(() => {
    setLecFilter("");
  }, [scope, lectureId, rawSessionId, course]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    setHighlightKey(null);
    setCueFilter(null);
    setPipelineCues([]);
    setPptGallery([]);
    setMultiRelDecisions({});
    setPropertyMergeDecisions({});
    setPrecomputedKg(null);
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

    const finishLoaded = (entry: {
      precomputedKg: KgProcessedArtifact | null;
      pipelineCues: PipelineCueBundle[];
      pptGallery: string[];
      multiRelDecisions: Record<string, MultiRelCollapseDecision>;
      propertyMergeDecisions: Record<string, PropertyMergeDecision>;
      mmkgEnrichment: Map<string, MmkgEntityEnrichment>;
      kgPatch: KgEditPatch;
    }) => {
      if (cancelled) return;
      setPrecomputedKg(entry.precomputedKg);
      setPipelineCues(entry.pipelineCues);
      setPptGallery(entry.pptGallery);
      setMultiRelDecisions(entry.multiRelDecisions);
      setPropertyMergeDecisions(entry.propertyMergeDecisions);
      setMmkgEnrichment(entry.mmkgEnrichment);
      setKgPatch(entry.kgPatch);
      setLoading(false);
    };

    const run = async () => {
      if (isGraphOnlyEmbed && integrationCourseId && !kgLaunchToken) {
        if (cancelled) return;
        setError("缺少 kg_token，无法加载动态知识图谱");
        setLoading(false);
        return;
      }
      if (embedMode && integrationCourseId && kgLaunchToken) {
        try {
          // 单课/课堂：优先本地 kg_processed（含边）；整课才拉 live fused
          const patchPromiseEmbed = fetchKgEdits(course, patchScopeId).catch(() =>
            emptyKgEditPatch(course, patchScopeId),
          );
          if (scope === "lecture" && lectureId) {
            const pre = await tryLoadKgProcessed(course, "lecture", {
              lectureId: String(lectureId),
            });
            if (pre) {
              const [enrich, patch, propMerge] = await Promise.all([
                loadMmkgEntityEnrichment(course, String(lectureId)),
                patchPromiseEmbed,
                tryLoadPropertyMerge(course, {
                  scope: "lecture",
                  lectureId: String(lectureId),
                }),
              ]);
              if (cancelled) return;
              finishLoaded({
                precomputedKg: pre,
                pipelineCues: [],
                pptGallery: [],
                multiRelDecisions: {},
                propertyMergeDecisions: propMerge,
                mmkgEnrichment: enrich,
                kgPatch: patch,
              });
              return;
            }
          }
          if (scope === "session" && sessionPair) {
            const pre = await tryLoadKgProcessed(course, "session", {
              sessionPair,
            });
            if (pre) {
              const [a, b] = sessionPair;
              const [enrichA, enrichB, patch, propA, propB] = await Promise.all([
                loadMmkgEntityEnrichment(course, a),
                loadMmkgEntityEnrichment(course, b),
                patchPromiseEmbed,
                tryLoadPropertyMerge(course, { scope: "lecture", lectureId: a }),
                tryLoadPropertyMerge(course, { scope: "lecture", lectureId: b }),
              ]);
              if (cancelled) return;
              finishLoaded({
                precomputedKg: pre,
                pipelineCues: [],
                pptGallery: [],
                multiRelDecisions: {},
                propertyMergeDecisions: { ...propA, ...propB },
                mmkgEnrichment: mergeMmkgEnrichmentMaps(enrichA, enrichB),
                kgPatch: patch,
              });
              return;
            }
          }
          if (scope === "course" && lecFilter) {
            const ids = parseLectureFilterIds(lecFilter);
            if (ids.length === 2) {
              const pre = await tryLoadKgProcessed(course, "session", {
                sessionPair: [ids[0], ids[1]],
              });
              if (pre) {
                const [enrichA, enrichB, patch] = await Promise.all([
                  loadMmkgEntityEnrichment(course, ids[0]),
                  loadMmkgEntityEnrichment(course, ids[1]),
                  patchPromiseEmbed,
                ]);
                if (cancelled) return;
                finishLoaded({
                  precomputedKg: pre,
                  pipelineCues: [],
                  pptGallery: [],
                  multiRelDecisions: {},
                  propertyMergeDecisions: {},
                  mmkgEnrichment: mergeMmkgEnrichmentMaps(enrichA, enrichB),
                  kgPatch: patch,
                });
                return;
              }
            } else if (ids.length === 1) {
              const pre = await tryLoadKgProcessed(course, "lecture", {
                lectureId: ids[0],
              });
              if (pre) {
                const [enrich, patch] = await Promise.all([
                  loadMmkgEntityEnrichment(course, ids[0]),
                  patchPromiseEmbed,
                ]);
                if (cancelled) return;
                finishLoaded({
                  precomputedKg: pre,
                  pipelineCues: [],
                  pptGallery: [],
                  multiRelDecisions: {},
                  propertyMergeDecisions: {},
                  mmkgEnrichment: enrich,
                  kgPatch: patch,
                });
                return;
              }
            }
          }

          const live = await fetchMmkgGraph(integrationCourseId, kgLaunchToken, "fused");
          if (cancelled) return;
          const nodes = (Array.isArray(live.nodes) ? live.nodes : []).map((node) => {
            const impRaw = node.importance;
            const impNum = impRaw != null ? Number(impRaw) : NaN;
            return {
              ...node,
              id: String(node.id || ""),
              label: String(node.zh_name || node.name || node.en_name || node.id || ""),
              title: String(node.info || node.description || ""),
              ...(Number.isFinite(impNum) ? { importance: impNum } : {}),
            };
          }).filter((node) => node.id);
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
          finishLoaded({
            precomputedKg: null,
            pipelineCues: [{
              cueId: "mmkg-live",
              lectureId: "all",
              text: "",
              nodes,
              edges,
              edgeCount: edges.length,
            }],
            pptGallery: [],
            multiRelDecisions: {},
            propertyMergeDecisions: {},
            mmkgEnrichment: new Map(),
            kgPatch: emptyKgEditPatch(course, "course"),
          });
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "动态知识图谱加载失败");
          setLoading(false);
        }
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
        const pre = await tryLoadKgProcessed(course, "course");
        if (pre) {
          const [enrich, patch, propMerge] = await Promise.all([
            loadMmkgEntityEnrichmentForLectures(course, lecIds.map(String)),
            patchPromise,
            tryLoadPropertyMerge(course, { scope: "course" }),
          ]);
          if (cancelled) return;
          finishLoaded({
            precomputedKg: pre,
            pipelineCues: [],
            pptGallery: [],
            multiRelDecisions: {},
            propertyMergeDecisions: propMerge,
            mmkgEnrichment: enrich,
            kgPatch: patch,
          });
          return;
        }
        const [loaded, enrich, patch, propMerge, ...collapseMaps] = await Promise.all([
          loadCoursePipelineData(lecIds, course),
          loadMmkgEntityEnrichmentForLectures(course, lecIds.map(String)),
          patchPromise,
          tryLoadPropertyMerge(course, { scope: "course" }),
          ...lecIds.map((id) => loadCollapse(String(id))),
        ]);
        const merged: Record<string, MultiRelCollapseDecision> = {};
        for (const m of collapseMaps) Object.assign(merged, m);
        if (cancelled) return;
        finishLoaded({
          precomputedKg: null,
          pipelineCues: loaded.cues,
          pptGallery: loaded.pptGallery,
          multiRelDecisions: merged,
          propertyMergeDecisions: propMerge,
          mmkgEnrichment: enrich,
          kgPatch: patch,
        });
        return;
      }

      if (scope === "session" && sessionPair) {
        const [a, b] = sessionPair;
        const pre = await tryLoadKgProcessed(course, "session", { sessionPair });
        if (pre) {
          const [enrichA, enrichB, patch, loadedA, loadedB, propA, propB] =
            await Promise.all([
              loadMmkgEntityEnrichment(course, a),
              loadMmkgEntityEnrichment(course, b),
              patchPromise,
              loadLecturePipelineData(a, course).catch(() => null),
              loadLecturePipelineData(b, course).catch(() => null),
              tryLoadPropertyMerge(course, { scope: "lecture", lectureId: a }),
              tryLoadPropertyMerge(course, { scope: "lecture", lectureId: b }),
            ]);
          if (cancelled) return;
          finishLoaded({
            precomputedKg: pre,
            pipelineCues: [],
            pptGallery: [
              ...new Set(
                [
                  ...(loadedA?.pptGallery || []),
                  ...(loadedB?.pptGallery || []),
                ].filter(Boolean),
              ),
            ],
            multiRelDecisions: {},
            propertyMergeDecisions: { ...propA, ...propB },
            mmkgEnrichment: mergeMmkgEnrichmentMaps(enrichA, enrichB),
            kgPatch: patch,
          });
          return;
        }
        const [loadedA, loadedB, enrichA, enrichB, decA, decB, patch, propA, propB] =
          await Promise.all([
            loadLecturePipelineData(a, course),
            loadLecturePipelineData(b, course),
            loadMmkgEntityEnrichment(course, a),
            loadMmkgEntityEnrichment(course, b),
            loadCollapse(a),
            loadCollapse(b),
            patchPromise,
            tryLoadPropertyMerge(course, { scope: "lecture", lectureId: a }),
            tryLoadPropertyMerge(course, { scope: "lecture", lectureId: b }),
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
        finishLoaded({
          precomputedKg: null,
          pipelineCues: cues,
          pptGallery: [
            ...new Set([...loadedA.pptGallery, ...loadedB.pptGallery].filter(Boolean)),
          ],
          multiRelDecisions: { ...decA, ...decB },
          propertyMergeDecisions: { ...propA, ...propB },
          mmkgEnrichment: mergeMmkgEnrichmentMaps(enrichA, enrichB),
          kgPatch: patch,
        });
        return;
      }

      if (scope === "lecture" && lectureId) {
        const pre = await tryLoadKgProcessed(course, "lecture", {
          lectureId: String(lectureId),
        });
        if (pre) {
          const [enrich, patch, loaded, propMerge] = await Promise.all([
            loadMmkgEntityEnrichment(course, String(lectureId)),
            patchPromise,
            loadLecturePipelineData(String(lectureId), course).catch(() => null),
            tryLoadPropertyMerge(course, {
              scope: "lecture",
              lectureId: String(lectureId),
            }),
          ]);
          if (cancelled) return;
          finishLoaded({
            precomputedKg: pre,
            pipelineCues: [],
            pptGallery: loaded?.pptGallery || [],
            multiRelDecisions: {},
            propertyMergeDecisions: propMerge,
            mmkgEnrichment: enrich,
            kgPatch: patch,
          });
          return;
        }
        const [loaded, enrich, decisions, patch, propMerge] = await Promise.all([
          loadLecturePipelineData(String(lectureId), course),
          loadMmkgEntityEnrichment(course, String(lectureId)),
          loadCollapse(String(lectureId)),
          patchPromise,
          tryLoadPropertyMerge(course, {
            scope: "lecture",
            lectureId: String(lectureId),
          }),
        ]);
        if (cancelled) return;
        finishLoaded({
          precomputedKg: null,
          pipelineCues: loaded.cues,
          pptGallery: loaded.pptGallery,
          multiRelDecisions: decisions,
          propertyMergeDecisions: propMerge,
          mmkgEnrichment: enrich,
          kgPatch: patch,
        });
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
    isGraphOnlyEmbed,
    integrationCourseId,
    kgLaunchToken,
    parentOrigin,
    liveGraphVersion,
    // 仅整课依赖讲次清单；避免 catalog 晚到时重载单讲
    scope === "course" ? [...readyLectures].sort().join(",") : "",
    // 整课下拉课堂筛选：切到对应 session/lecture 预计算
    scope === "course" ? lecFilter : "",
  ]);

  const contextKey = useMemo(() => {
    if (scope === "lecture" && lectureId) return `lecture:${lectureId}`;
    if (scope === "session" && sessionPair)
      return `session:${sessionPair[0]}_${sessionPair[1]}`;
    return "course";
  }, [scope, lectureId, sessionPair]);

  // 整课默认 5%、单课/课堂默认 20%；各 context 独立记住当前过滤值
  useEffect(() => {
    const v = readStoredImportanceKeep(course, contextKey, scope);
    setImportanceKeepPercent(v);
    setImportancePercentDraft(String(v));
    setImportanceSliderActive(false);
    setImportanceSliderHover(null);
    importanceDeltaAccumRef.current = 0;
    if (v >= 100) setRevealFilteredEntities(false);
  }, [course, contextKey, scope]);

  const clearSearchRevealPins = () => {
    setPinnedEntityIds([]);
    pendingFocusAfterPinRef.current = null;
  };

  const commitImportanceKeepPercent = (next: number) => {
    const v = clampKeepPercent(next, defaultImportanceKeepForScope(scope));
    // 累计 |Δ%|≥5 整图重画：仅整课且可见节点 >500 时生效；≤500 只做软增减
    if (scope === "course" && visibleNodeCountRef.current > COURSE_SOFT_LAYOUT_MAX) {
      const delta = Math.abs(v - importanceKeepPercent);
      importanceDeltaAccumRef.current += delta;
      if (importanceDeltaAccumRef.current >= 5) {
        importanceDeltaAccumRef.current = 0;
        posCacheRef.current = {};
        setForceRelayoutToken((t) => t + 1);
      }
    }
    // 再调过滤：搜索临时钉回失效，节点重新受筛选约束
    if (v !== importanceKeepPercent) clearSearchRevealPins();
    setImportanceKeepPercent(v);
    setImportancePercentDraft(String(v));
    writeStoredImportanceKeep(course, contextKey, v);
    if (v >= 100) setRevealFilteredEntities(false);
  };

  const editScopeId = useMemo(() => {
    if (scope === "lecture" && lectureId) return String(lectureId);
    if (scope === "session" && sessionPair)
      return `${sessionPair[0]}_${sessionPair[1]}`;
    return "course";
  }, [scope, lectureId, sessionPair]);

  const handleRenameEntity = async (currentId: string, newId: string) => {
    if (!canEditGraph) return;
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
    if (!canEditGraph) return;
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
    if (!canEditGraph) return;
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
    if (!canEditGraph) return;
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
    if (!canEditGraph) return;
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
    if (!canEditGraph) return;
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
    if (!canEditGraph) return;
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
    if (!canEditGraph) return;
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
    if (!canEditGraph) return;
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

  // 管线：优先预计算 kg_processed；否则 merge → process（与百分比筛选拆开）
  const preparedKg = useMemo(() => {
    if (loading || error) return null;

    // 有预计算（含 embed 单课/课堂 kg_processed）优先；整课 live 时 precomputed 为空才走下方
    if (precomputedKg) {
      const patchNeedsRescore =
        Object.keys(kgPatch.entityRenames || {}).length > 0 ||
        Object.keys(kgPatch.edgeEdits || {}).length > 0 ||
        Object.keys(kgPatch.deletedEntities || {}).length > 0 ||
        Object.keys(kgPatch.deletedEdges || {}).length > 0;
      let nodes = applyPropertyMergeDecisions(
        precomputedKg.nodes,
        propertyMergeDecisions
      );
      const baseEdges = [
        ...precomputedKg.kept_edges,
        ...(isAiTeachingEmbed ? [] : precomputedKg.process_edges),
      ];
      const edited = applyKgEdits(nodes, baseEdges, kgPatch);
      const keptOnly = edited.edges.filter((e) => !isProcessEdgeSource(e.source));
      const processOnly = isAiTeachingEmbed
        ? []
        : edited.edges.filter((e) => isProcessEdgeSource(e.source));
      nodes = applyMmkgEnrichmentToNodes(edited.nodes, mmkgEnrichment);
      let propStats = {
        layers: precomputedKg.propagate_stats.layers,
        boosted_nodes: precomputedKg.propagate_stats.boosted_nodes,
      };
      if (patchNeedsRescore) {
        nodes = scoreFragmentClassroomImportance(
          nodes,
          keptOnly,
          precomputedKg.extract_texts || []
        );
        const propagated = propagateImportanceToParents(nodes, keptOnly);
        nodes = propagated.nodes;
        propStats = {
          layers: propagated.stats.layers,
          boosted_nodes: propagated.stats.boosted_nodes,
        };
      }
      const stage: PipelineStage = {
        id: `kg_processed_${precomputedKg.scope}`,
        title: precomputedKg.title || `kg_processed_${precomputedKg.scope}`,
        focus: "graph",
        nodes,
        edges: [...keptOnly, ...processOnly],
        stats: { total: keptOnly.length },
      };
      const payload: PipelinePayload = {
        brand: "MMKG",
        product: "TeachKG",
        mode: precomputedKg.scope === "session" ? "session" : "lecture",
        course_id: course,
        title: precomputedKg.title,
        items: [],
        ppt_gallery: [],
      };
      return {
        live: false as const,
        payload,
        built: {
          stage,
          payload,
          cues: [] as PipelineCueBundle[],
          activeCue: null,
        },
        nodes,
        keptOnly,
        processOnly,
        propStats,
        processStats: precomputedKg.process_stats,
        cues: [] as PipelineCueBundle[],
        activeCue: null,
      };
    }

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
    if (embedMode && integrationCourseId) {
      // 动态图谱 live 数据同样挂课堂重要性，供默认保留 5% 筛选
      let nodes = enrichPipelineNodesWithImportance(built.stage.nodes || [], {
        scores: scopedImportance.scores,
        base: importanceBase,
        classroom: displayClassroom,
        contributions:
          importanceSource === "pagerank" ? null : scopedImportance.contributions,
        displayMode: "classroom",
      });
      nodes = applyMmkgEnrichmentToNodes(nodes, mmkgEnrichment);
      let keptOnly = (built.stage.edges || []).filter(
        (e) => !isProcessEdgeSource(e.source),
      );
      if (scope === "course" && lecFilter) {
        const filtered = filterLiveGraphByLectures(
          nodes,
          keptOnly,
          parseLectureFilterIds(lecFilter),
        );
        nodes = filtered.nodes;
        keptOnly = filtered.edges;
      }
      let propStats = { layers: 0, boosted_nodes: 0 };
      if (importanceSource !== "pagerank") {
        const propagated = propagateImportanceToParents(nodes, keptOnly);
        nodes = propagated.nodes;
        propStats = propagated.stats;
      }
      return {
        live: true as const,
        payload: built.payload,
        built,
        nodes,
        keptOnly,
        processOnly: [] as PipelineEdge[],
        propStats,
        processStats: { rule_removed: 0, node_removed: 0, isolated_removed: 0, kept_edges: keptOnly.length },
        cues: built.cues,
        activeCue: built.activeCue,
      };
    }
    const processed = processLectureKg(
      built.stage.nodes || [],
      built.stage.edges || [],
      { multiRelDecisions }
    );
    let mergedNodes = applyPropertyMergeDecisions(
      processed.nodes,
      propertyMergeDecisions
    );
    const edited = applyKgEdits(mergedNodes, processed.edges, kgPatch);
    let nodes = enrichPipelineNodesWithImportance(edited.nodes, {
      scores: scopedImportance.scores,
      base: importanceBase,
      classroom: displayClassroom,
      contributions:
        importanceSource === "pagerank" ? null : scopedImportance.contributions,
      displayMode: "classroom",
    });
    nodes = applyMmkgEnrichmentToNodes(nodes, mmkgEnrichment);
    const keptOnly = edited.edges.filter((e) => !isProcessEdgeSource(e.source));
    const processOnly = isAiTeachingEmbed
      ? []
      : edited.edges.filter((e) => isProcessEdgeSource(e.source));
    let propStats = { layers: 0, boosted_nodes: 0 };
    if (importanceSource !== "pagerank") {
      const propagated = propagateImportanceToParents(nodes, keptOnly);
      nodes = propagated.nodes;
      propStats = propagated.stats;
    }
    return {
      live: false as const,
      payload: built.payload,
      built,
      nodes,
      keptOnly,
      processOnly,
      propStats,
      processStats: processed.stats,
      cues: built.cues,
      activeCue: built.activeCue,
    };
  }, [
    loading,
    error,
    precomputedKg,
    propertyMergeDecisions,
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
    multiRelDecisions,
    embedMode,
    integrationCourseId,
    kgPatch,
    isAiTeachingEmbed,
    course,
  ]);

  const pipelineView = useMemo(() => {
    if (!preparedKg) return null;
    if (preparedKg.live) {
      const mode: ImportanceFilterMode = revealFilteredEntities ? "reveal" : "hide";
      let imp = applyImportanceFilter(preparedKg.nodes, preparedKg.keptOnly, {
        keepPercent: importanceKeepPercent,
        mode,
        forceKeepIds: pinnedEntityIds,
      });
      // 筛选结果无边但原图有边时回退，避免把动态图谱剪成空白
      if (
        importanceKeepPercent < 100 &&
        !imp.edges.length &&
        preparedKg.keptOnly.length > 0
      ) {
        imp = applyImportanceFilter(preparedKg.nodes, preparedKg.keptOnly, {
          keepPercent: 100,
          mode,
          forceKeepIds: pinnedEntityIds,
        });
      }
      const fullStage: PipelineStage = {
        ...preparedKg.built.stage,
        id: "mmkg-live",
        focus: "graph",
        nodes: preparedKg.nodes,
        edges: preparedKg.keptOnly,
        stats: {
          ...(preparedKg.built.stage.stats || {}),
          total: preparedKg.keptOnly.length,
        },
      };
      const stage: PipelineStage = {
        ...fullStage,
        nodes: imp.nodes,
        edges: imp.edges,
        stats: {
          ...(fullStage.stats || {}),
          total: imp.edges.length,
          importance_filtered_nodes: imp.filteredCount,
          importance_keep_percent: importanceKeepPercent,
        },
      };
      return {
        payload: preparedKg.payload,
        stage,
        fullStage,
        cues: preparedKg.cues,
        activeCue: preparedKg.activeCue,
      };
    }
    const mode: ImportanceFilterMode = revealFilteredEntities ? "reveal" : "hide";
    let imp = applyImportanceFilter(preparedKg.nodes, preparedKg.keptOnly, {
      keepPercent: importanceKeepPercent,
      mode,
      forceKeepIds: pinnedEntityIds,
    });
    // 单课/课堂节点少时 5% 易剪成无边；与 live 一致回退全量，避免空白画布
    if (
      importanceKeepPercent < 100 &&
      !imp.edges.length &&
      preparedKg.keptOnly.length > 0
    ) {
      imp = applyImportanceFilter(preparedKg.nodes, preparedKg.keptOnly, {
        keepPercent: 100,
        mode,
        forceKeepIds: pinnedEntityIds,
      });
    }
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
    const nodeMap = new Map(displayNodes.map((n) => [n.id, n]));
    const builtNodeById = new Map(
      (preparedKg.built.stage.nodes || []).map((n) => [n.id, n])
    );
    for (const e of preparedKg.processOnly) {
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
    const fullStage: PipelineStage = {
      ...preparedKg.built.stage,
      nodes: preparedKg.nodes,
      edges: preparedKg.keptOnly,
    };
    const stage: PipelineStage = {
      ...preparedKg.built.stage,
      blurb:
        (preparedKg.built.stage.blurb || "") +
        " · 后处理：去重合并→层次规则删边→不合适节点→孤立/短路径子图" +
        (importanceSource === "pagerank"
          ? " · 筛选=课堂重要性；展示：PR + 课堂轻量修正"
          : " · 重要性：课堂初值→沿图谱层次边（属于/组成/依赖）向上传递"),
      nodes: [...nodeMap.values()],
      edges: [...displayEdges, ...preparedKg.processOnly],
      stats: {
        ...(preparedKg.built.stage.stats || {}),
        total: displayEdges.length,
        process_rule_removed: preparedKg.processStats.rule_removed,
        process_node_removed: preparedKg.processStats.node_removed,
        process_isolated_removed: preparedKg.processStats.isolated_removed,
        process_kept: preparedKg.processStats.kept_edges,
        importance_filtered_nodes: imp.filteredCount,
        importance_keep_percent: importanceKeepPercent,
        importance_prop_layers: preparedKg.propStats.layers,
        importance_prop_boosted: preparedKg.propStats.boosted_nodes,
      },
    };
    return {
      payload: preparedKg.payload,
      stage,
      fullStage,
      cues: preparedKg.cues,
      activeCue: preparedKg.activeCue,
    };
  }, [
    preparedKg,
    revealFilteredEntities,
    importanceKeepPercent,
    importanceSource,
    hideRelatedWith,
    scopedImportance,
    pinnedEntityIds,
  ]);

  const payload: PipelinePayload | null = pipelineView?.payload || null;
  const selectedAnimationResources = (sideLinkedResources?.resources || []).filter(
    (resource) => resource.resource_type === "animation",
  );
  // 必须 memo：hideRelatedWith 默认 true 时 applyRelatedWithVisibility 每次 render 都会新建 stage，
  // 若直接传给 GraphCanvas 会在点选时触发 syncInPlace/全图 update，主线程卡死。
  const displayStage: PipelineStage | null = useMemo(() => {
    if (!pipelineView?.stage) return null;
    return applyGraphHides(
      applyRelatedWithVisibility(pipelineView.stage, hideRelatedWith, {
        forceKeepIds: pinnedEntityIds,
      }),
      hiddenNodeIds,
      hiddenEdgeIds,
    );
  }, [
    pipelineView?.stage,
    hideRelatedWith,
    hiddenNodeIds,
    hiddenEdgeIds,
    pinnedEntityIds,
  ]);

  // AI-Teaching 嵌入：选中实体 → 视频/练习/动画；选中关系 → 两端共现视频片段
  useEffect(() => {
    if (!isAiTeachingEmbed) {
      setSideLinkedResources(null);
      return;
    }

    const credError = !resourceCourseId
      ? "嵌入地址缺少 course_id"
      : !kgLaunchToken
        ? "缺少知识图谱访问凭据"
        : "";

    if (selectedEdgeId) {
      const edge =
        (displayStage?.edges || []).find(
          (e) => String(e.id) === String(selectedEdgeId),
        ) || null;
      if (!edge) {
        setSideLinkedResources(null);
        return;
      }
      const fromId = String(edge.from || "");
      const toId = String(edge.to || "");
      const targetKey = `edge:${selectedEdgeId}`;
      if (!fromId || !toId) {
        setSideLinkedResources({
          targetKey,
          mode: "edge",
          loading: false,
          resources: [],
          warnings: [],
          error: "关系缺少端点",
        });
        return;
      }
      if (credError) {
        setSideLinkedResources({
          targetKey,
          mode: "edge",
          loading: false,
          resources: [],
          warnings: [],
          error: credError,
        });
        return;
      }
      const fromNode =
        (displayStage?.nodes || []).find((n) => String(n.id) === fromId) || null;
      const toNode =
        (displayStage?.nodes || []).find((n) => String(n.id) === toId) || null;
      const seq = ++sideResourceSeq.current;
      setSideLinkedResources({
        targetKey,
        mode: "edge",
        loading: true,
        resources: [],
        warnings: [],
        error: "",
      });
      void Promise.all([
        fetchLinkedKnowledgeResources({
          courseId: resourceCourseId,
          knowledgePointId: fromId,
          kgToken: kgLaunchToken,
          ...linkedResourceNodeContext(fromNode),
        }),
        fetchLinkedKnowledgeResources({
          courseId: resourceCourseId,
          knowledgePointId: toId,
          kgToken: kgLaunchToken,
          ...linkedResourceNodeContext(toNode),
        }),
      ])
        .then(([left, right]) => {
          if (seq !== sideResourceSeq.current) return;
          setSideLinkedResources({
            targetKey,
            mode: "edge",
            loading: false,
            // 关系侧只要共现视频 + 练习；动画卡片仅实体选中时展示
            resources: [
              ...intersectVideoResources(left.resources, right.resources),
              ...unionExerciseResources(left.resources, right.resources),
            ],
            warnings: [...(left.warnings || []), ...(right.warnings || [])],
            error: "",
            // 关系练习以 from 端匹配 KP 为 seed
            matchedKpId:
              matchedKnowledgePointId(left.match) ||
              matchedKnowledgePointId(right.match) ||
              undefined,
            matchedKpLabel:
              matchedKnowledgePointLabel(left.match) ||
              matchedKnowledgePointLabel(right.match) ||
              undefined,
          });
        })
        .catch((reason) => {
          if (seq !== sideResourceSeq.current) return;
          setSideLinkedResources({
            targetKey,
            mode: "edge",
            loading: false,
            resources: [],
            warnings: [],
            error: reason instanceof Error ? reason.message : String(reason),
          });
        });
      return;
    }

    if (!selectedNode?.id) {
      setSideLinkedResources(null);
      return;
    }
    const nodeId = String(selectedNode.id);
    const targetKey = `node:${nodeId}`;
    if (credError) {
      setSideLinkedResources({
        targetKey,
        mode: "node",
        loading: false,
        resources: [],
        warnings: [],
        error: credError,
      });
      return;
    }
    const seq = ++sideResourceSeq.current;
    setSideLinkedResources({
      targetKey,
      mode: "node",
      loading: true,
      resources: [],
      warnings: [],
      error: "",
    });
    void fetchLinkedKnowledgeResources({
      courseId: resourceCourseId,
      knowledgePointId: nodeId,
      kgToken: kgLaunchToken,
      ...linkedResourceNodeContext(selectedNode),
    })
      .then((result) => {
        if (seq !== sideResourceSeq.current) return;
        setSideLinkedResources({
          targetKey,
          mode: "node",
          loading: false,
          resources: result.resources,
          warnings: result.warnings,
          error: "",
          matchedKpId: matchedKnowledgePointId(result.match) || undefined,
          matchedKpLabel: matchedKnowledgePointLabel(result.match) || undefined,
        });
      })
      .catch((reason) => {
        if (seq !== sideResourceSeq.current) return;
        setSideLinkedResources({
          targetKey,
          mode: "node",
          loading: false,
          resources: [],
          warnings: [],
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
  }, [
    isAiTeachingEmbed,
    selectedEdgeId,
    selectedNode,
    displayStage,
    resourceCourseId,
    kgLaunchToken,
  ]);


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
    // 嵌入与独立页一致：默认隐藏 process_isolated 等后处理删边
    const edges = stageEdgesForDisplay(mode, displayStage, graphHideFiltered);
    const nodes = stageNodesForDisplay(mode, displayStage, edges, graphHideFiltered);
    return { nodes, edges };
  }, [
    displayStage,
    payload,
    graphHideFiltered,
  ]);
  visibleNodeCountRef.current = visibleGraph.nodes.length;
  /** 整课始终软增减；≤500 另开持续力导向。>500 靠计数器触发重画 */
  const courseSoftLayout = scope === "course";
  const courseLivePhysics =
    scope === "course" && visibleGraph.nodes.length <= COURSE_SOFT_LAYOUT_MAX;

  /**
   * 未做重要性筛选的全量规模；与当前图同一套 related_with / 隐藏 / process 边规则，
   * 这样拉到 100% 时「当前」应等于「总数」。
   */
  const totalGraph = useMemo(() => {
    if (!pipelineView?.fullStage || !payload) {
      return { nodes: 0, edges: 0 };
    }
    const mode = payload.mode || "lecture";
    const stage = applyGraphHides(
      applyRelatedWithVisibility(pipelineView.fullStage, hideRelatedWith, {
        forceKeepIds: pinnedEntityIds,
      }),
      hiddenNodeIds,
      hiddenEdgeIds
    );
    const edges = stageEdgesForDisplay(mode, stage, graphHideFiltered);
    const nodes = stageNodesForDisplay(mode, stage, edges, graphHideFiltered);
    return { nodes: nodes.length, edges: edges.length };
  }, [
    pipelineView,
    payload,
    hideRelatedWith,
    hiddenNodeIds,
    hiddenEdgeIds,
    graphHideFiltered,
    pinnedEntityIds,
  ]);

  const relatedWithCount = useMemo(() => {
    return (pipelineView?.stage.edges || []).filter(
      (e) => (e.relation || e.label || "") === "related_with"
    ).length;
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
        ? pipelineCues.filter((c) =>
            parseLectureFilterIds(lecFilter).includes(String(c.lectureId))
          )
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
    // 不把 importanceKeepPercent 放进依赖：改滑条不应清选中，否则会触发共享选中回写高亮
  }, [cueFilter, lecFilter, hideRelatedWith]);

  // 重要性筛掉当前选中节点时再清选中（不清共享态，也不重新 focus）
  useEffect(() => {
    if (!selectedNode?.id || loading || !displayStage?.nodes?.length) return;
    const still = displayStage.nodes.some(
      (n) => String(n.id) === String(selectedNode.id),
    );
    if (!still) {
      setSelectedNode(null);
      setFocusNodeRequest(null);
      setFocusEdgeIds(null);
    }
  }, [displayStage, selectedNode?.id, loading]);

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
        ? pipelineCues.filter((c) =>
            parseLectureFilterIds(lecFilter).includes(String(c.lectureId))
          )
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
    const s = new Set<string>();
    const addLecture = (raw: unknown) => {
      String(raw || "")
        .split(/[+_,]/)
        .map((x) => x.trim())
        .filter((x) => /^\d+$/.test(x))
        .forEach((x) => s.add(x));
    };
    for (const cue of pipelineCues) {
      addLecture(cue.lectureId);
      for (const e of cue.edges || []) {
        addLecture((e as { lecture_id?: unknown }).lecture_id);
      }
      for (const n of cue.nodes || []) {
        const node = n as {
          lecture_id?: unknown;
          video_anchors?: Array<{ lecture_id?: unknown; video_id?: unknown }>;
        };
        addLecture(node.lecture_id);
        for (const a of node.video_anchors || []) {
          addLecture(a.lecture_id);
          // video_id 0–43 → 讲次 1–44
          const vid = Number(a.video_id);
          if (Number.isFinite(vid) && vid >= 0 && vid < 80) s.add(String(vid + 1));
        }
      }
    }
    // live 融合图常无 lecture_id：用目录/清单补课堂列表
    if (!s.size) {
      for (const it of catalog) {
        if (it.lectureId) addLecture(it.lectureId);
      }
    }
    if (!s.size) {
      for (const id of readyLectures) s.add(String(id));
    }
    if (!s.size) {
      for (const id of ALL_LECTURES) s.add(id);
    }
    return Array.from(s).sort((a, b) => Number(a) - Number(b));
  }, [pipelineCues, catalog, readyLectures]);

  const courseSessionOptions = useMemo(
    () => pairLecturesIntoSessions(edgeLectures),
    [edgeLectures]
  );

  const sessionSelectValue = useMemo(() => {
    if (scope === "session" && sessionPair) {
      return `${sessionPair[0]}_${sessionPair[1]}`;
    }
    if (scope === "lecture" && lectureId) return String(lectureId);
    return lecFilter;
  }, [scope, sessionPair, lectureId, lecFilter]);

  const navigateWithinKg = (pathname: string) => {
    const query = searchParams.toString();
    navigate({
      pathname,
      search: query ? `?${query}` : "",
    });
  };
  const goCourse = () => navigateWithinKg(coursePath(course, "/kg/course"));
  const goLecture = (id: string) =>
    navigateWithinKg(coursePath(course, `/kg/lecture/${id}`));
  const goSession = (id: string) =>
    navigateWithinKg(coursePath(course, `/kg/session/${id}`));

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
        background: "transparent",
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
    const pool = pipelineView?.fullStage?.nodes?.length
      ? pipelineView.fullStage.nodes
      : displayStage?.nodes || [];
    if (!q || !pool.length) return [];
    const visibleIds = new Set(
      (displayStage?.nodes || []).map((n) => String(n.id)),
    );
    const scored = pool
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
        const visible = visibleIds.has(id);
        if (!visible) score -= 15;
        return {
          id,
          label: label || zh || id,
          kind: n.kind || "",
          score,
          visible,
        };
      })
      .filter(Boolean) as {
      id: string;
      label: string;
      kind: string;
      score: number;
      visible: boolean;
    }[];
    const deduped = dedupeEntityMatchesByZh(scored);
    deduped.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, "zh"));
    return deduped.slice(0, 12);
  }, [entityQuery, displayStage, pipelineView?.fullStage]);

  const focusEntity = (nodeId: string) => {
    const n =
      pipelineView?.fullStage?.nodes?.find((x) => String(x.id) === nodeId) ||
      displayStage?.nodes?.find((x) => String(x.id) === nodeId);
    if (!n) return;
    const id = String(n.id);
    const visible = (displayStage?.nodes || []).some(
      (x) => String(x.id) === id,
    );
    // 过滤外：临时钉回该点（importanceFilter 会自动带一跳邻居）；覆盖旧钉，避免越搜越多
    if (!visible) {
      setPinnedEntityIds([id]);
      pendingFocusAfterPinRef.current = id;
    } else {
      pendingFocusAfterPinRef.current = null;
    }
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    setHighlightKey(null);
    const next = {
      id,
      label: n.label || id.split("/")[0] || id,
      title: n.title || n.label || id,
      _kind: n.kind || "",
    };
    setSelectedNode(next);
    writeSharedEntitySelection({ id: next.id, label: next.label });
    if (visible) {
      setFocusNodeRequest((prev) => ({
        id,
        seq: (prev?.seq || 0) + 1,
      }));
    }
    setEntityQuery(n.label || id.split("/")[0] || id);
    setEntitySearchOpen(false);
    setDetailCollapsed(false);
    setDetailPanelOpen(true);
  };

  // 钉回完成并进入当前显示集合后再居中
  useEffect(() => {
    const id = pendingFocusAfterPinRef.current;
    if (!id) return;
    const onCanvas = (displayStage?.nodes || []).some((n) => String(n.id) === id);
    if (!onCanvas) return;
    pendingFocusAfterPinRef.current = null;
    setFocusNodeRequest((prev) => ({
      id,
      seq: (prev?.seq || 0) + 1,
    }));
  }, [displayStage, pinnedEntityIds]);

  // 切课堂/单课后允许再次用 URL/共享选中恢复一次；清空搜索钉住
  useEffect(() => {
    focusRestoreKeyRef.current = "";
    clearSearchRevealPins();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on context switch
  }, [contextKey]);

  // URL ?focus= / 导图共享选中 → 选中并居中（仅每个来源恢复一次，避免改重要性时反复高亮）
  useEffect(() => {
    const pool = pipelineView?.fullStage?.nodes?.length
      ? pipelineView.fullStage.nodes
      : displayStage?.nodes;
    if (!pool?.length || loading) return;
    const shared = readSharedEntitySelection();
    const raw = String(focusParam || shared?.id || shared?.label || "").trim();
    if (!raw) return;
    const sourceKey = `${String(focusParam || "").trim()}||${shared?.id || ""}||${shared?.updatedAt || 0}`;
    if (focusRestoreKeyRef.current === sourceKey) return;
    const decoded = (() => {
      try {
        return decodeURIComponent(raw).trim();
      } catch {
        return raw;
      }
    })();
    const zh = decoded.split("/")[0].trim().toLowerCase();
    const hit =
      pool.find((n) => String(n.id) === decoded) ||
      pool.find((n) => String(n.id).split("/")[0].trim().toLowerCase() === zh) ||
      pool.find(
        (n) =>
          String(n.label || "")
            .split("/")[0]
            .trim()
            .toLowerCase() === zh
      );
    if (!hit) return;
    focusRestoreKeyRef.current = sourceKey;
    if (selectedNode?.id === String(hit.id)) return;
    focusEntity(String(hit.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to URL/graph load
  }, [focusParam, displayStage, loading]);

  // 选中实体/关系时展开右栏「选中详情」
  useEffect(() => {
    if (selectedNode?.id != null || selectedEdgeId) {
      setDetailCollapsed(false);
      setDetailPanelOpen(true);
      setEdgesPanelOpen(false);
      setAssetsPanelOpen(true);
      setMediaPanelOpen(false);
      setHiddenPanelOpen(false);
    }
  }, [selectedNode?.id, selectedEdgeId]);

  const importanceKeepControl = (inputId: string) => (
    <div
      className={styles.importanceFilter}
      title="按课堂重要性保留排名前 x% 的节点；筛选后去掉无边孤立点"
    >
      <label className={styles.importancePercentLabel} htmlFor={inputId}>
        保留
      </label>
      <div
        className={styles.importancePercentSliderWrap}
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
                ? ((Number(importancePercentDraft) || importanceKeepPercent) -
                    IMPORTANCE_PERCENT_MIN) /
                    (IMPORTANCE_PERCENT_MAX - IMPORTANCE_PERCENT_MIN)
                : (importanceSliderHover?.ratio ??
                    (importanceKeepPercent - IMPORTANCE_PERCENT_MIN) /
                      (IMPORTANCE_PERCENT_MAX - IMPORTANCE_PERCENT_MIN))
            ),
          } as CSSProperties
        }
      >
        <input
          type="range"
          className={styles.importancePercentSlider}
          min={IMPORTANCE_PERCENT_MIN}
          max={IMPORTANCE_PERCENT_MAX}
          step={1}
          value={
            importanceSliderActive
              ? Number(importancePercentDraft) || importanceKeepPercent
              : importanceKeepPercent
          }
          aria-label="重要性保留百分比滑条"
          title={`${
            importanceSliderHover?.percent ??
            (importanceSliderActive
              ? Number(importancePercentDraft) || importanceKeepPercent
              : importanceKeepPercent)
          }%`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setImportanceSliderActive(true);
            const next = importancePercentAtPointer(e.currentTarget, e.clientX);
            setImportanceSliderHover(next);
            setImportancePercentDraft(String(next.percent));
          }}
          onPointerMove={(e) => {
            const next = importancePercentAtPointer(e.currentTarget, e.clientX);
            setImportanceSliderHover(next);
            if (importanceSliderActive || e.buttons === 1) {
              setImportancePercentDraft(String(next.percent));
            }
          }}
          onPointerUp={(e) => {
            const next = importancePercentAtPointer(e.currentTarget, e.clientX);
            commitImportanceKeepPercent(next.percent);
            setImportanceSliderActive(false);
            setImportanceSliderHover(null);
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
          }}
          onPointerCancel={(e) => {
            commitImportanceKeepPercent(
              Number(importancePercentDraft) || importanceKeepPercent,
            );
            setImportanceSliderActive(false);
            setImportanceSliderHover(null);
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
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
        id={inputId}
        type="number"
        min={IMPORTANCE_PERCENT_MIN}
        max={IMPORTANCE_PERCENT_MAX}
        step={1}
        inputMode="numeric"
        className={styles.importancePercentInput}
        value={importancePercentDraft}
        aria-label="重要性保留百分比"
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d]/g, "");
          setImportancePercentDraft(raw);
          if (raw === "") return;
          const n = Number(raw);
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
      <span className={styles.importancePercentSuffix}>%</span>
    </div>
  );

  return (
    <>
    <ResizableShell
      storagePrefix="shell-kg"
      detailFixedRightPx={detailCollapsed ? 32 : undefined}
      detailMinRightPx={220}
      detailInitialRightPx={340}
      nav={isEmbeddedGraph ? undefined : (
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
                        title={
                          entry.title ||
                          `第 ${Math.ceil(Number(entry.a) / 2)} 次课（第 ${entry.a}–${entry.b} 讲）`
                        }
                      >
                        <span>{Math.ceil(Number(entry.a) / 2)}</span>
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
                      title={`第 ${Math.ceil(Number(entry.lectureId) / 2)} 次课（第 ${entry.lectureId} 讲，落单）`}
                    >
                      <span>{Math.ceil(Number(entry.lectureId) / 2)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </aside>
      )}
      main={
        <main className={`${pipe.mainCol} ${isEmbeddedGraph ? styles.embeddedMain : ""}`}>
          {!isGraphOnlyEmbed ? (
          <header className={styles.kgTopbar}>
            <div className={styles.kgToolbar}>
              {isAiTeachingEmbed ? (
                <>
                  <button
                    type="button"
                    className={`${styles.kgChip} ${styles.kgChipAccent}`}
                    title="打开本课程知识导图"
                    onClick={() => {
                      const id =
                        selectedNode?.id != null ? String(selectedNode.id) : "";
                      if (id) {
                        writeSharedEntitySelection({
                          id,
                          label: String(selectedNode?.label || ""),
                        });
                      }
                      const q = new URLSearchParams(searchParams.toString());
                      if (id) q.set("focus", id);
                      navigate({
                        pathname: coursePath(course, "/mindmap"),
                        search: q.toString() ? `?${q}` : "",
                      });
                    }}
                  >
                    查看知识导图
                  </button>
                </>
              ) : null}

              {courseSessionOptions.length > 0 ? (
                <div className={styles.kgToolGroup} data-group="scope">
                  <select
                    className={styles.kgSelect}
                    value={sessionSelectValue}
                    onChange={(e) => {
                      const v = String(e.target.value || "").trim();
                      if (!v) {
                        setLecFilter("");
                        goCourse();
                        return;
                      }
                      const ids = parseLectureFilterIds(v);
                      // 真正切到 session/lecture 路由，避免仍加载整课预计算导致「内容不变」
                      if (ids.length === 2) {
                        setLecFilter(v);
                        goSession(`${ids[0]}_${ids[1]}`);
                        return;
                      }
                      if (ids.length === 1) {
                        setLecFilter(v);
                        goLecture(ids[0]);
                        return;
                      }
                      setLecFilter(v);
                    }}
                    aria-label="课堂筛选"
                  >
                    <option value="">全部课堂</option>
                    {courseSessionOptions.map((s, i) => {
                      const value = s.lectureIds.join("_");
                      const label = `第 ${i + 1} 次课`;
                      return (
                        <option key={value} value={value} title={s.label || label}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                </div>
              ) : null}

              {!isAiTeachingEmbed ? (
              <button
                type="button"
                className={`${styles.kgChip} ${
                  importanceSource === "classroom" ? styles.kgChipActive : ""
                }`}
                title="切换重要性来源：课堂信号 ↔ PageRank 实验"
                onClick={() => {
                  const next: ImportanceSource =
                    importanceSource === "pagerank" ? "classroom" : "pagerank";
                  clearSearchRevealPins();
                  setImportanceSource(next);
                  setImportanceSourceState(next);
                }}
              >
                {importanceSource === "pagerank" ? "PR+" : "课堂分"}
              </button>
              ) : null}
              {importanceKeepControl("kg-importance-percent")}
              {!isEmbeddedGraph ? (<button
                type="button"
                className={`${styles.kgChip} ${evidenceVisible ? styles.kgChipActive : ""}`}
                disabled={!hasEvidenceText}
                onClick={() => setShowEvidence((v) => !v)}
              >
                {evidenceVisible ? "隐藏文本" : "显示文本"}
              </button>) : null}

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
          ) : null}

          <div className={pipe.stageBody}>
            <ResizableSplit
              className={`${tb.split} ${styles.graphSplit} ${isEmbeddedGraph ? styles.embeddedGraphSplit : ""} ${isGraphOnlyEmbed ? styles.graphOnlyEmbed : ""}`}
              storageKey="split-kg-text-graph-v2"
              initialLeftRatio={0.5}
              minLeftPx={260}
              minRightPx={300}
              enabled={!isEmbeddedGraph && evidenceVisible}
              hideWhenDisabled="left"
              leftClassName={tb.slicePane}
              rightClassName={`${pipe.viewport} ${styles.graphViewport}`}
              left={
                isGraphOnlyEmbed ? null : (
                <>
                  <div className={tb.sliceHead}>
                    <strong>处理文本</strong>
                  </div>
                  <div className={tb.sliceScroll}>
                    {hasEvidenceText && !isEmbeddedGraph ? (
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
                )
              }
              right={
                <>
                  <div className={styles.graphChrome}>
                    <div className={styles.entitySearch} ref={entitySearchRef}>
                      <div className={styles.entitySearchField}>
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
                        {entityQuery.trim() ? (
                          <button
                            type="button"
                            className={styles.entitySearchClear}
                            aria-label="清除搜索"
                            title="清除"
                            disabled={!hasGraph}
                            onClick={() => {
                              setEntityQuery("");
                              setEntitySearchOpen(false);
                              setSelectedNode(null);
                              setFocusNodeRequest(null);
                              clearSearchRevealPins();
                              writeSharedEntitySelection(null);
                            }}
                          >
                            ×
                          </button>
                        ) : null}
                      </div>
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
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  setEntitySearchOpen(false);
                                  const fullNode =
                                    displayStage?.nodes?.find(
                                      (node) => String(node.id) === m.id,
                                    ) ||
                                    pipelineView?.fullStage?.nodes?.find(
                                      (node) => String(node.id) === m.id,
                                    );
                                  void openNodeContextMenu(
                                    m.id,
                                    {
                                      ...fullNode,
                                      id: m.id,
                                      label: m.label,
                                      _kind: fullNode?.kind || m.kind || "entity",
                                    },
                                    { clientX: event.clientX, clientY: event.clientY },
                                  );
                                }}
                                title={m.visible ? m.id : `${m.id}（当前过滤未显示，点击将临时钉回）`}
                              >
                                <span>
                                  {m.label}
                                  {!m.visible ? (
                                    <em style={{ marginLeft: 6, opacity: 0.7 }}>未显示</em>
                                  ) : null}
                                </span>
                                <em>
                                  {m.id.includes("/")
                                    ? m.id.split("/").slice(1).join("/")                                    : m.kind}
                                </em>
                              </button>
                            ))
                        )}
                        </div>
                      )}
                    </div>
                    {isGraphOnlyEmbed ? importanceKeepControl("kg-importance-percent-embed") : null}
                    <div className={styles.graphChromeEnd}>
                      {!isEmbeddedGraph ? (
                      <button
                        type="button"
                        className={styles.kgExportBtn}
                        disabled={!selectedNode?.id || !resourceCourseId}
                        onClick={() => void openNodeContextMenu(
                          String(selectedNode?.id || ""),
                          selectedNode || ({ id: "", label: "" } as VisNode),
                          { clientX: window.innerWidth / 2, clientY: 160 },
                        )}
                      >
                        关联资源
                      </button>
                      ) : null}
                      {!isGraphOnlyEmbed ? (
                      <button
                        type="button"
                        className={styles.kgExportBtn}
                        disabled={!hasGraph || exportingPng}
                        onClick={() => void exportCurrentGraphPng()}
                        title="按当前筛选与高亮导出整图高清 PNG（含被面板遮挡的节点）"
                      >
                        {exportingPng ? "导出中…" : "导出图片"}
                      </button>
                      ) : null}
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
                        keepLayout={scope === "session" || courseSoftLayout}
                        softFilterHide={courseSoftLayout}
                        preferFullRelayout={false}
                        forceRelayoutToken={forceRelayoutToken}
                        livePhysics={
                          scope === "lecture" ||
                          scope === "session" ||
                          courseLivePhysics
                        }
                        focusNodeRequest={focusNodeRequest}
                        onFocusNodeConsumed={() => setFocusNodeRequest(null)}
                        onSelectNode={(_id, meta) => {
                          setFocusNodeRequest(null);
                          setPanelEditMode(false);
                          if (_id) {
                            setSelectedEdgeId(null);
                            setFocusEdgeIds(null);
                            void notifyNodeSelected(String(_id), meta);
                            setSelectedNode(meta || null);
                            writeSharedEntitySelection({
                              id: String(_id),
                              label: String(meta?.label || ""),
                            });
                            setDetailCollapsed(false);
                            setDetailPanelOpen(true);
                          } else {
                            setSelectedNode(null);
                            writeSharedEntitySelection(null);
                          }
                        }}
                        onContextNode={(id, meta, point) => {
                          void openNodeContextMenu(id, meta, point);
                        }}
                        onContextEdge={(id, meta, point) => {
                          openEdgeContextMenu(id, meta, point);
                        }}
                        onSelectEdge={(id, groupIds) => {
                          setFocusNodeRequest(null);
                          setPanelEditMode(false);
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
                                        clearSearchRevealPins();
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
      detail={isGraphOnlyEmbed ? undefined : (
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
          <div className={styles.kgSideScroll}>
          {selectedNode?.id != null && !selectedEdgeId ? (
            <CollapsiblePanel
              title="相关资源"
              storageKey={SHARED_PANEL_KEYS.assets}
              defaultOpen
              open={assetsPanelOpen}
              onOpenChange={setAssetsPanelOpen}
              bodyClassName={styles.sideCardBody}
              resizable
            >
              {isAiTeachingEmbed ? (
                <LinkedResourceJumpBar
                  loading={!!sideLinkedResources?.loading}
                  resources={sideLinkedResources?.resources || []}
                  selectedNodeId={String(selectedNode.id)}
                  selectedEdgeId={null}
                  courseId={course}
                  resourceCourseId={resourceCourseId || course}
                  onOpen={openLinkedResource}
                />
              ) : null}
              <div className={styles.resourceGroupStack}>
                <RelatedAssetsPanel
                  entityId={String(selectedNode.id)}
                  entityAliases={[
                    String(selectedNode.label || ""),
                    ...(Array.isArray(selectedNode.aliases)
                      ? selectedNode.aliases.map((v) => String(v || "").trim()).filter(Boolean)
                      : []),
                  ]}
                  library={assetsLibrary}
                  lectureId={scope === "lecture" ? lectureId : null}
                  lectureOnly={false}
                  kinds={[...RELATED_ASSET_KINDS]}
                />
                {isAiTeachingEmbed &&
                (sideLinkedResources?.loading || selectedAnimationResources.length > 0) ? (
                  <ResourceCardFold title="动画" count={selectedAnimationResources.length}>
                    {sideLinkedResources?.loading ? (
                      <div className={styles.resourceMenuState}>正在查询动画…</div>
                    ) : (
                      <LinkedResourceCardList
                        resources={selectedAnimationResources}
                        kind="animation"
                        nodeLabel={String(selectedNode.label || "")}
                        onOpen={openLinkedResource}
                      />
                    )}
                  </ResourceCardFold>
                ) : null}
              </div>
            </CollapsiblePanel>
          ) : null}
          <CollapsiblePanel
            title="选中详情"
            storageKey={SHARED_PANEL_KEYS.detail}
            defaultOpen
            open={detailPanelOpen}
            onOpenChange={setDetailPanelOpen}
            bodyClassName={styles.sideCardBody}
            resizable
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
                  editMode={canEditGraph && panelEditMode}
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
                  entityDefinitions={entityDefinitions}
                />
                {!embedMode && canEditGraph ? (
                  <DeletedItemsPanel
                    kgPatch={kgPatch}
                    busy={editBusy}
                    onRestoreEntity={handleRestoreEntity}
                    onRestoreEdge={handleRestoreEdge}
                    onRestorePpt={handleRestorePpt}
                  />
                ) : null}
              </>
            ) : (
              <div className={pipe.sideEmpty}>点击图中实体或关系查看详情</div>
            )}
          </CollapsiblePanel>

          {selectedNode?.id != null && !selectedEdgeId ? (
            <CollapsiblePanel
              title={`相关关系 · ${
                displayStage
                  ? relatedEdgesOf(displayStage, String(selectedNode.id), {
                      hideFiltered: false,
                      mode,
                    }).length
                  : 0
              }`}
              storageKey={SHARED_PANEL_KEYS.edges}
              defaultOpen={false}
              open={edgesPanelOpen}
              onOpenChange={setEdgesPanelOpen}
              bodyClassName={styles.sideCardBody}
              resizable
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
                    setPanelEditMode(false);
                    setFocusEdgeIds([id]);
                    setSelectedEdgeId(id);
                  }}
                  onContextEdge={(id, edge, point) => {
                    openEdgeContextMenu(
                      id,
                      {
                        id,
                        from: String(edge.from || ""),
                        to: String(edge.to || ""),
                        _relation: String(edge.relation || edge.label || ""),
                      },
                      point,
                    );
                  }}
                />
              ) : (
                <div className={pipe.sideEmpty}>暂无</div>
              )}
            </CollapsiblePanel>
          ) : null}

          {Object.keys(hiddenNodeIds).length || Object.keys(hiddenEdgeIds).length ? (
            <CollapsiblePanel
              title={`已隐藏 · ${Object.keys(hiddenNodeIds).length + Object.keys(hiddenEdgeIds).length}`}
              storageKey="kg-panel-hidden-v1"
              defaultOpen={false}
              open={hiddenPanelOpen}
              onOpenChange={setHiddenPanelOpen}
              bodyClassName={styles.sideCardBody}
              resizable
            >
              <div className={pipe.kgEditBox}>
                {Object.entries(hiddenNodeIds).map(([id, label]) => (
                  <div key={`hn-${id}`} className={pipe.kgDeletedRow}>
                    <code title={id}>{label}</code>
                    <button
                      type="button"
                      className={pipe.kgEditBtnGhost}
                      onClick={() => unhideEntity(id)}
                    >
                      显示实体
                    </button>
                  </div>
                ))}
                {Object.entries(hiddenEdgeIds).map(([id, label]) => (
                  <div key={`he-${id}`} className={pipe.kgDeletedRow}>
                    <code title={id}>{label}</code>
                    <button
                      type="button"
                      className={pipe.kgEditBtnGhost}
                      onClick={() => unhideEdge(id)}
                    >
                      显示关系
                    </button>
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          ) : null}

          {embedMode !== "ai-teaching" ? (
            <CollapsiblePanel
              title="多模态证据"
              storageKey="kg-panel-media-v2"
              defaultOpen={false}
              open={mediaPanelOpen}
              onOpenChange={setMediaPanelOpen}
              bodyClassName={styles.sideCardBody}
              resizable
            >
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
                    canDelete={false}
                    deleteBusy={editBusy}
                    onDelete={handleDeletePpt}
                  />
                ) : (
                  <div className={pipe.sideEmpty}>暂无帧图</div>
                )}
              </div>
            </div>
            </CollapsiblePanel>
          ) : null}
          </div>
        </aside>
        )
      )}
    />
    {graphCtxMenu ? (
      <div
        ref={resourceMenuRef}
        className={styles.resourceMenu}
        style={{ left: graphCtxMenu.x, top: graphCtxMenu.y }}
        role="menu"
        aria-label={graphCtxMenu.kind === "node" ? `${graphCtxMenu.nodeLabel} 操作` : "关系操作"}
      >
        <div className={styles.resourceMenuHead}>
          <div>
            <strong>
              {graphCtxMenu.kind === "node" ? graphCtxMenu.nodeLabel : graphCtxMenu.label}
            </strong>
            <span>{graphCtxMenu.kind === "node" ? "实体操作" : "关系操作"}</span>
          </div>
          <button type="button" onClick={() => setGraphCtxMenu(null)} aria-label="关闭">
            ×
          </button>
        </div>
        {graphCtxMenu.kind === "node" ? (
          <>
            <div className={styles.graphCtxActions}>
              {canEditGraph ? (
                <button type="button" onClick={() => beginEditEntity(graphCtxMenu.meta)}>
                  修改实体
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => hideEntity(graphCtxMenu.nodeId, graphCtxMenu.nodeLabel)}
              >
                隐藏实体
              </button>
              {canEditGraph ? (
                <button
                  type="button"
                  className={styles.graphCtxDanger}
                  disabled={editBusy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `删除实体「${graphCtxMenu.nodeLabel}」？其关联关系也会一并移除${embedMode ? "，且此操作不可撤销" : "（可撤销）"}。`,
                      )
                    ) {
                      setGraphCtxMenu(null);
                      void handleDeleteEntity(graphCtxMenu.nodeId);
                    }
                  }}
                >
                  删除实体
                </button>
              ) : null}
            </div>
            {!isEmbeddedGraph ? (
              <div className={styles.resourceMenuGroups}>
                <section>
                  <h3>公式 · MMKG 内部关联</h3>
                  <RelatedAssetsPanel
                    entityId={graphCtxMenu.nodeId}
                    entityAliases={[graphCtxMenu.nodeLabel, ...graphCtxMenu.nodeAliases]}
                    library={assetsLibrary}
                    kinds={["formula"]}
                  />
                </section>
                {graphCtxMenu.loading ? (
                  <div className={styles.resourceMenuState}>正在查询视频、练习与动画…</div>
                ) : graphCtxMenu.error ? (
                  <div className={styles.resourceMenuError}>{graphCtxMenu.error}</div>
                ) : (
                  <>
                    {(["video", "exercise"] as const).map((kind) => {
                      const rows = graphCtxMenu.resources.filter((item) => item.resource_type === kind);
                      if (!rows.length) return null;
                      return (
                        <section key={kind}>
                          <h3>{RESOURCE_LABELS[kind]} · {rows.length}</h3>
                          <LinkedResourceCardList
                            resources={rows}
                            kind={kind}
                            nodeLabel={graphCtxMenu.nodeLabel}
                            onOpen={openLinkedResource}
                          />
                        </section>
                      );
                    })}
                  </>
                )}
              </div>
            ) : null}
            {graphCtxMenu.warnings.length ? (
              <details className={styles.resourceMenuWarnings}>
                <summary>部分服务暂不可用</summary>
                {graphCtxMenu.warnings.map((warning, index) => (
                  <p key={`${index}:${warning}`}>{warning}</p>
                ))}
              </details>
            ) : null}
          </>
        ) : (
          <div className={styles.graphCtxActions}>
            {canEditGraph ? (
              <button type="button" onClick={() => beginEditEdge(graphCtxMenu.edgeId)}>
                修改边
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => hideEdge(graphCtxMenu.edgeId, graphCtxMenu.label)}
            >
              隐藏边
            </button>
            {canEditGraph ? (
              <button
                type="button"
                className={styles.graphCtxDanger}
                disabled={editBusy}
                onClick={() => {
                  if (
                    window.confirm(
                      `删除关系「${graphCtxMenu.label}」？${embedMode ? "此操作不可撤销。" : "（可撤销）"}`,
                    )
                  ) {
                    const id = graphCtxMenu.edgeId;
                    setGraphCtxMenu(null);
                    void handleDeleteEdge(id);
                  }
                }}
              >
                删除边
              </button>
            ) : null}
          </div>
        )}
      </div>
    ) : null}
    </>
  );
}
