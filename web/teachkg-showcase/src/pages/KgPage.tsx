import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { GraphCanvas, type GraphCanvasHandle } from "@/components/pipeline/GraphCanvas";
import { HighlightLegend } from "@/components/pipeline/HighlightLegend";
import { LatexText } from "@/components/pipeline/LatexText";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import { ResizableSplit } from "@/components/pipeline/ResizableSplit";
import { RelatedEdges, RelatedAssetsPanel, SelectionDetail } from "@/components/pipeline/SelectionPanels";
import { SliceTextAnnotator } from "@/components/pipeline/SliceTextAnnotator";
import { ZoomableImage } from "@/components/pipeline/ZoomableImage";
import {
  fmtSec,
} from "@/lib/kg/adaptToPipeline";
import {
  applyImportanceFilter,
  applyRelatedWithVisibility,
  type ImportanceFilterMode,
} from "@/lib/kg/importanceFilter";
import type { AssetsLibrary } from "@/lib/kg/assetsLibrary";
import {
  applyMmkgEnrichmentToNodes,
  buildKgViewFromPipeline,
  enrichPipelineNodesWithImportance,
  loadCoursePipelineUnion,
  loadLecturePipelineCues,
  loadMmkgEntityEnrichment,
  type MmkgEntityEnrichment,
  type PipelineCueBundle,
} from "@/lib/kg/pipelineMergeSource";
import { loadManifest, type ManifestItem } from "@/lib/catalog";
import {
  CROSS_CUE_HIGHLIGHT_FILTER,
  filterHasMatches,
  RELATION_TYPE_FILTERS,
  stageHighlightFilters,
  type VisNode,
} from "@/lib/pipeline/graphLogic";
import type { PipelineEdge, PipelinePayload, PipelineStage } from "@/lib/pipeline/types";
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

export function KgPage() {
  const { lectureId, sessionId: rawSessionId } = useParams();
  const navigate = useNavigate();
  const sessionPair = useMemo(() => parseSessionId(rawSessionId), [rawSessionId]);
  const scope = sessionPair ? "session" : lectureId ? "lecture" : "course";
  const course = "shuliluoji";
  const sessionId = sessionPair ? `${sessionPair[0]}_${sessionPair[1]}` : "";

  const [catalog, setCatalog] = useState<ManifestItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** 主图：各片段流水线 merge；辅：文本/媒体 */
  const [pipelineCues, setPipelineCues] = useState<PipelineCueBundle[]>([]);
  const [mmkgEnrichment, setMmkgEnrichment] = useState<Map<string, MmkgEntityEnrichment>>(
    () => new Map()
  );
  const [importanceScores, setImportanceScores] = useState<Record<string, number> | null>(
    null
  );
  const [importanceContributions, setImportanceContributions] = useState<Record<
    string,
    Record<string, number>
  > | null>(null);
  const [importanceByContext, setImportanceByContext] = useState<Record<
    string,
    { scores?: Record<string, number>; entities?: Record<string, { score?: number; contributions?: Record<string, number> }> }
  > | null>(null);
  const [assetsLibrary, setAssetsLibrary] = useState<AssetsLibrary | null>(null);
  const [importanceBase, setImportanceBase] = useState<Record<string, number> | null>(null);
  const [importanceMin, setImportanceMin] = useState(0);
  /** reveal=临时显示被重要性阈值筛掉的实体（灰色弱化）；hide=删除 */
  const [revealFilteredEntities, setRevealFilteredEntities] = useState(false);

  const [lecFilter, setLecFilter] = useState("");
  const [cueFilter, setCueFilter] = useState<string | null>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<VisNode | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [focusEdgeIds, setFocusEdgeIds] = useState<string[] | null>(null);
  const [showEvidence, setShowEvidence] = useState(true);
  const [hideRelatedWith, setHideRelatedWith] = useState(true);
  const [sessionNavOpen, setSessionNavOpen] = useState(true);
  const [lectureNavOpen, setLectureNavOpen] = useState(true);
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

  useEffect(() => {
    loadManifest()
      .then((m) => setCatalog(m.items || []))
      .catch(() => setCatalog([]));
  }, []);

  useEffect(() => {
    fetch(`/data/entity_importance_lookup.json?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (j: {
          scores?: Record<string, number>;
          base?: Record<string, number>;
          contributions?: Record<string, Record<string, number>>;
          by_context?: Record<
            string,
            {
              scores?: Record<string, number>;
              entities?: Record<
                string,
                { score?: number; contributions?: Record<string, number> }
              >;
            }
          >;
        } | null) => {
          setImportanceScores(j?.scores && typeof j.scores === "object" ? j.scores : null);
          setImportanceBase(j?.base && typeof j.base === "object" ? j.base : null);
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
        setImportanceContributions(null);
        setImportanceByContext(null);
      });
  }, []);

  useEffect(() => {
    fetch(`/data/assets_library.json?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: AssetsLibrary | null) => {
        setAssetsLibrary(j && Array.isArray(j.cards) ? j : null);
      })
      .catch(() => setAssetsLibrary(null));
  }, []);

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
    setMmkgEnrichment(new Map());
    setEntityQuery("");
    setEntitySearchOpen(false);
    setFocusNodeRequest(null);
    posCacheRef.current = {};

    const run = async () => {
      if (scope === "course") {
        // 等 manifest 给出讲次列表；若暂无则试 ALL_LECTURES 中实际存在的 pipeline
        const lecIds = readyLectures.size
          ? [...readyLectures]
          : ALL_LECTURES;
        const cues = await loadCoursePipelineUnion(lecIds);
        const enrich = await loadMmkgEntityEnrichment(course, null);
        if (cancelled) return;
        setPipelineCues(cues);
        setMmkgEnrichment(enrich);
        setLoading(false);
        return;
      }

      if (scope === "session" && sessionPair) {
        const [a, b] = sessionPair;
        const [cuesA, cuesB, enrichA, enrichB] = await Promise.all([
          loadLecturePipelineCues(a),
          loadLecturePipelineCues(b),
          loadMmkgEntityEnrichment(course, a),
          loadMmkgEntityEnrichment(course, b),
        ]);
        if (cancelled) return;
        const cues = [...cuesA, ...cuesB].map((c, i) => ({
          ...c,
          edges: c.edges.map((e) => ({
            ...e,
            cue_label: `片段 ${i + 1}${
              c.startSec != null ? ` · ${Math.round(c.startSec)}s` : ""
            }`,
          })),
          edgeCount: c.edges.length,
        }));
        const enrich = new Map<string, MmkgEntityEnrichment>([...enrichA, ...enrichB]);
        setPipelineCues(cues);
        setMmkgEnrichment(enrich);
        setLoading(false);
        return;
      }

      if (scope === "lecture" && lectureId) {
        const [cues, enrich] = await Promise.all([
          loadLecturePipelineCues(String(lectureId)),
          loadMmkgEntityEnrichment(course, String(lectureId)),
        ]);
        if (cancelled) return;
        setPipelineCues(cues);
        setMmkgEnrichment(enrich);
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
    // 仅整课依赖讲次清单；避免 catalog 晚到时重载单讲
    scope === "course" ? [...readyLectures].sort().join(",") : "",
  ]);

  const contextKey = useMemo(() => {
    if (scope === "lecture" && lectureId) return `lecture:${lectureId}`;
    if (scope === "session" && sessionPair)
      return `session:${sessionPair[0]}_${sessionPair[1]}`;
    return "course";
  }, [scope, lectureId, sessionPair]);

  const scopedImportance = useMemo(() => {
    const ctx = importanceByContext?.[contextKey];
    if (ctx?.scores && Object.keys(ctx.scores).length) {
      const contrib: Record<string, Record<string, number>> = {};
      for (const [name, rec] of Object.entries(ctx.entities || {})) {
        if (rec?.contributions) contrib[name] = rec.contributions;
      }
      return {
        scores: ctx.scores as Record<string, number>,
        contributions: Object.keys(contrib).length
          ? contrib
          : importanceContributions,
      };
    }
    return {
      scores: importanceScores,
      contributions: importanceContributions,
    };
  }, [importanceByContext, contextKey, importanceScores, importanceContributions]);

  // 管线：pipeline merge 并集 → 补重要性 → mmkg 描述 → 重要性筛选 → related_with
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
    });
    let nodes = enrichPipelineNodesWithImportance(built.stage.nodes || [], {
      scores: scopedImportance.scores,
      base: importanceBase,
      contributions: scopedImportance.contributions,
    });
    nodes = applyMmkgEnrichmentToNodes(nodes, mmkgEnrichment);
    const mode: ImportanceFilterMode = revealFilteredEntities ? "reveal" : "hide";
    const imp = applyImportanceFilter(nodes, built.stage.edges || [], {
      tau: importanceMin > 0 ? importanceMin : null,
      mode,
    });
    const stage: PipelineStage = {
      ...built.stage,
      nodes: imp.nodes,
      edges: imp.edges,
      stats: {
        ...(built.stage.stats || {}),
        total: imp.edges.length,
        importance_filtered_nodes: imp.filteredCount,
        importance_min: importanceMin > 0 ? importanceMin : 0,
      },
    };
    return {
      payload: built.payload,
      stage,
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
    importanceBase,
    mmkgEnrichment,
    importanceMin,
    revealFilteredEntities,
  ]);

  const payload: PipelinePayload | null = pipelineView?.payload || null;
  const displayStage: PipelineStage | null = pipelineView?.stage
    ? applyRelatedWithVisibility(pipelineView.stage, hideRelatedWith)
    : null;

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
    if (scope === "course") {
      const parts: string[] = [];
      const seen = new Set<string>();
      for (const e of annEdges) {
        const t = (e.context || "").trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          parts.push(t);
        }
      }
      return { text: formatEvidenceText(parts.join("\n\n")), annEdges };
    }
    if (cueFilter) {
      const hit = pipelineCues.find((c) => c.cueId === cueFilter);
      return { text: hit?.text || "", annEdges };
    }
    return {
      text: formatEvidenceText(
        pipelineCues
          .map((c) => c.text)
          .filter(Boolean)
          .join("\n\n")
      ),
      annEdges,
    };
  }, [scope, displayStage, cueFilter, pipelineCues]);

  const hasEvidenceText = joinedEvidence.text.length > 0;
  const evidenceVisible =
    (scope === "lecture" || scope === "session") && showEvidence && hasEvidenceText;

  const mode = payload?.mode || "lecture";
  const hlFilters = useMemo(() => {
    if (!displayStage) return [];
    // 讲次/课堂全图：跨段边高亮 + 关系类型；段级（选了片段）不含跨段边
    const cross =
      !cueFilter
        ? [CROSS_CUE_HIGHLIGHT_FILTER].filter((f) =>
            filterHasMatches(mode, displayStage, f, false)
          )
        : [];
    const rel = RELATION_TYPE_FILTERS.filter((f) =>
      filterHasMatches(mode, displayStage, f, false)
    );
    if (cross.length || rel.length) return [...cross, ...rel];
    return stageHighlightFilters(displayStage, mode, payload?.lecture_ids || []).filter((f) =>
      filterHasMatches(mode, displayStage, f, false)
    );
  }, [displayStage, mode, payload, cueFilter]);

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
    pipelineCues[0] ||
    null;

  const mediaClip = activePipelineCue?.clip || payload?.items?.[0]?.media?.clip || "";
  const mediaPpt = activePipelineCue?.ppt || payload?.items?.[0]?.media?.ppt || "";
  const mediaMeta = activePipelineCue
    ? [
        activePipelineCue.cueId,
        activePipelineCue.startSec != null || activePipelineCue.endSec != null
          ? `${fmtSec(activePipelineCue.startSec)}–${fmtSec(activePipelineCue.endSec)}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

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

  const goCourse = () => navigate("/kg/course");
  const goLecture = (id: string) => navigate(`/kg/lecture/${id}`);
  const goSession = (id: string) => navigate(`/kg/session/${id}`);

  const title =
    displayStage?.title ||
    (scope === "session" && sessionPair
      ? `第 ${sessionPair[0]}–${sessionPair[1]} 讲 · 一堂课融合`
      : scope === "course"
        ? "整课 · 流水线融合并集"
        : `第 ${lectureId} 讲 · 融合图谱`);

  const hasGraph = Boolean(payload && displayStage && (displayStage.edges?.length || 0) > 0);

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
        const hay = `${id} ${label} ${title} ${zh}`.toLowerCase();
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

  return (
    <ResizableShell
      storagePrefix="shell-kg"
      nav={
        <aside className={shell.sidebar}>
          <div className={shell.sideHead}>
            <Link className={shell.back} to="/">
              <span className={shell.backIcon} aria-hidden>
                ←
              </span>
              <span className={shell.backBrand}>
                Teach<em>KG</em>
              </span>
            </Link>
            <p className={shell.eyebrow}>Knowledge Graph</p>
            <h1 className={shell.sideTitle}>知识图谱</h1>
            <p className={shell.sideLead}>
              主图 = 各片段流水线「融合结果」并集（与流水线页同源）
            </p>
          </div>

          <div className={shell.navBlock}>
            <p className={shell.navLabel}>课程</p>
            <button
              type="button"
              className={scope === "course" ? shell.navItemActive : shell.navItem}
              disabled={!courseReady}
              onClick={goCourse}
            >
              <span>整课总览</span>
              <em>{courseReady ? "融合并集" : "未就绪"}</em>
            </button>
          </div>

          {sessionItems.length > 0 ? (
            <div
              className={`${shell.navBlock} ${shell.navBlockCollapsible} ${
                sessionNavOpen ? "" : shell.navBlockCollapsed
              }`}
            >
              <button
                type="button"
                className={shell.navLabelToggle}
                aria-expanded={sessionNavOpen}
                onClick={() => setSessionNavOpen((v) => !v)}
              >
                <span>一堂课（相邻两讲）</span>
                <em>{sessionNavOpen ? "收起" : "展开"}</em>
              </button>
              {sessionNavOpen ? (
                <div className={`${shell.navScroll} ${shell.navScrollCap}`}>
                  {sessionItems.map((it) => {
                    const sid = String(it.sessionId || "");
                    const active = scope === "session" && sessionId === sid;
                    const ids = it.lectureIds || sid.split("_");
                    const [a, b] = ids;
                    return (
                      <button
                        key={sid}
                        type="button"
                        className={active ? shell.navItemActive : shell.navItem}
                        onClick={() => goSession(sid)}
                      >
                        <span>
                          第 {a}–{b} 讲
                        </span>
                        <em>融合</em>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            className={`${shell.navBlock} ${shell.navBlockGrow} ${
              lectureNavOpen ? "" : shell.navBlockCollapsed
            }`}
          >
            <button
              type="button"
              className={shell.navLabelToggle}
              aria-expanded={lectureNavOpen}
              onClick={() => setLectureNavOpen((v) => !v)}
            >
              <span>讲次</span>
              <em>{lectureNavOpen ? "收起" : "展开"}</em>
            </button>
            {lectureNavOpen ? (
              <div className={shell.navScroll}>
                {ALL_LECTURES.map((id) => {
                  const ready = readyLectures.has(id);
                  const active = scope === "lecture" && lectureId === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={active ? shell.navItemActive : shell.navItem}
                      disabled={!ready}
                      onClick={() => ready && goLecture(id)}
                      title={ready ? `第 ${id} 讲` : `第 ${id} 讲尚未处理`}
                    >
                      <span>第 {id} 讲</span>
                      <em>{ready ? "就绪" : "未处理"}</em>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </aside>
      }
      main={
        <main className={pipe.mainCol}>
          <header className={shell.topbar}>
            <div className={shell.topbarText}>
              <h2>{title}</h2>
              <p>
                {displayStage?.blurb || (loading ? "加载中…" : "暂无数据")}
                {hasEvidenceText ? ` · 处理文本 ${joinedEvidence.text.length} 字` : ""}
              </p>
            </div>
            <div className={shell.stats}>
              <div>
                <strong>{displayStage?.nodes?.length ?? "—"}</strong>
                <span>节点</span>
              </div>
              <div>
                <strong>{displayStage?.edges?.length ?? "—"}</strong>
                <span>关系</span>
              </div>
              <div>
                <strong>{cueList.length || "—"}</strong>
                <span>片段</span>
              </div>
            </div>
            <div className={shell.tools}>
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
                          <em>{m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.kind}</em>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              {scope === "course" && edgeLectures.length > 0 && (
                <select
                  value={lecFilter}
                  onChange={(e) => setLecFilter(e.target.value)}
                  aria-label="讲次筛选"
                >
                  <option value="">全部讲次边</option>
                  {edgeLectures.map((l) => (
                    <option key={l} value={l}>
                      第 {l} 讲
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className={shell.toolBtn}
                disabled={!relatedWithCount}
                onClick={() => setHideRelatedWith((v) => !v)}
                title={
                  relatedWithCount
                    ? hideRelatedWith
                      ? `已隐藏 ${relatedWithCount} 条 related_with`
                      : `当前显示 ${relatedWithCount} 条 related_with`
                    : "本图无 related_with"
                }
              >
                {hideRelatedWith ? "显示 related_with" : "隐藏 related_with"}
              </button>
              <label
                className={styles.importanceFilter}
                title="重要性筛选：保留 score≥阈值的核节点及其 1-hop 邻接；其余为被筛实体"
              >
                <span>重要性≥{importanceMin.toFixed(2)}</span>
                <input
                  type="range"
                  min={0}
                  max={0.6}
                  step={0.02}
                  value={importanceMin}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setImportanceMin(v);
                    if (v <= 0) setRevealFilteredEntities(false);
                  }}
                />
              </label>
              <button
                type="button"
                className={`${shell.toolBtn} ${revealFilteredEntities ? styles.filterOn : ""}`}
                disabled={!hasGraph}
                onClick={() => {
                  setRevealFilteredEntities((on) => {
                    const next = !on;
                    // 开启「显示被筛」时若尚未设阈值，自动给一个常用默认值
                    if (next && importanceMin <= 0) setImportanceMin(0.2);
                    return next;
                  });
                }}
                title={
                  !hasGraph
                    ? "暂无图谱"
                    : revealFilteredEntities
                      ? `正在显示 ${importanceFilteredCount} 个被筛实体（灰色弱化）`
                      : importanceMin <= 0
                        ? "点击后将设重要性≥0.20 并显示被筛实体"
                        : `当前隐藏约 ${importanceFilteredCount} 个低重要性实体`
                }
              >
                {revealFilteredEntities
                  ? `隐藏被筛实体${importanceFilteredCount ? ` (${importanceFilteredCount})` : ""}`
                  : `显示被筛实体${
                      importanceMin > 0 && importanceFilteredCount
                        ? ` (${importanceFilteredCount})`
                        : ""
                    }`}
              </button>
              {(scope === "lecture" || scope === "session") && (
                <button
                  type="button"
                  className={shell.toolBtn}
                  disabled={!hasEvidenceText}
                  onClick={() => setShowEvidence((v) => !v)}
                >
                  {evidenceVisible ? "隐藏文本" : "显示文本"}
                </button>
              )}
              <button
                type="button"
                className={shell.toolBtn}
                disabled={!hasGraph || exportingPng}
                onClick={() => void exportCurrentGraphPng()}
                title="按当前筛选、高亮与视口导出高清 PNG"
              >
                {exportingPng ? "导出中…" : "导出高清图"}
              </button>
            </div>
          </header>

          <div className={pipe.stageBody}>
            {displayStage?.stats && !loading && !error && (
              <div className={pipe.statsRow}>
                {Object.entries(displayStage.stats).map(([k, v]) =>
                  v == null ? null : (
                    <span key={k}>
                      {k}: {String(v)}
                    </span>
                  )
                )}
              </div>
            )}

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
                    <span className={tb.sliceHint}>
                      {cueFilter
                        ? "当前片段 · 流水线融合正文"
                        : "流水线融合正文 · 按片段顺序拼接"}{" "}
                      · context 划线
                    </span>
                    <button
                      type="button"
                      className={tb.sliceHide}
                      onClick={() => setShowEvidence(false)}
                    >
                      隐藏
                    </button>
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
                      hideFiltered={false}
                      highlightKey={highlightKey}
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
                        }
                      }}
                      onSelectEdge={(id, groupIds) => {
                        setFocusNodeRequest(null);
                        selectEdgesFromText(id, groupIds);
                      }}
                      legend={
                        <HighlightLegend
                          filters={hlFilters}
                          highlightKey={highlightKey}
                          onHighlightKey={(key) => {
                            setFocusNodeRequest(null);
                            setHighlightKey(key);
                          }}
                          stage={displayStage}
                          mode={mode}
                          hideFiltered={false}
                        />
                      }
                    />
                  )}
                </>
              }
            />

            <div className={pipe.transport}>
              <span className={pipe.chip}>
                流水线融合
                {scope === "session"
                  ? " · 一堂课"
                  : scope === "course"
                    ? lecFilter
                      ? ` · 第${lecFilter}讲`
                      : " · 整课"
                    : cueFilter
                      ? " · 片段筛选"
                      : " · 全讲"}
              </span>
              <div className={pipe.progress}>
                <i
                  style={{
                    width: cueFilter ? "40%" : cueList.length ? "100%" : "0%",
                  }}
                />
              </div>
              <div className={pipe.transportRight}>
                <Link
                  to={
                    scope === "session" && sessionPair
                      ? `/pipeline/session_${sessionPair[0]}_${sessionPair[1]}`
                      : lectureId
                        ? `/pipeline/${lectureId}`
                        : "/pipeline/1"
                  }
                  className={styles.pipelineLink}
                >
                  查看构建流水线 →
                </Link>
              </div>
            </div>
          </div>
        </main>
      }
      detail={
        <aside className={pipe.side}>
          <div className={pipe.panel}>
            <h3>{scope === "session" ? "本堂片段" : "本讲片段"}</h3>
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
                    全部片段 · {cueList.reduce((n, c) => n + c.edgeCount, 0)} 边
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
                      {c.startSec != null ? ` · ${Math.round(c.startSec)}s` : ""}
                      <em className={styles.cueCount}> · {c.edgeCount} 边</em>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          <div className={pipe.panel}>
            <h3>选中详情</h3>
            {displayStage ? (
              <SelectionDetail
                stage={displayStage}
                selectedNodeId={
                  selectedNode?.id != null ? String(selectedNode.id) : null
                }
                selectedEdgeId={selectedEdgeId}
                hideFiltered={false}
                mode={mode}
                importanceMode="full"
              />
            ) : (
              <div className={pipe.sideEmpty}>点击图中实体或关系查看详情</div>
            )}
          </div>

          {selectedNode?.id != null && !selectedEdgeId ? (
            <div className={pipe.panel}>
              <h3>相关定理·原理·方法</h3>
              <RelatedAssetsPanel
                entityId={String(selectedNode.id)}
                library={assetsLibrary}
              />
            </div>
          ) : null}

          {selectedNode?.id != null ? (
            <div className={pipe.panel}>
              <h3>相关关系</h3>
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
            </div>
          ) : null}

          <div className={pipe.panel}>
            <h3>多模态证据</h3>
            {selectedPipeEdge?.context ? (
              <p className={styles.mediaContext}>
                <LatexText text={selectedPipeEdge.context} as="div" compact />
              </p>
            ) : null}
            {mediaMeta ? <p className={styles.mediaMetaLine}>{mediaMeta}</p> : null}
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
                {mediaPpt ? (
                  <ZoomableImage src={mediaPpt} alt="板书 / PPT" />
                ) : (
                  <div className={pipe.sideEmpty}>暂无帧图</div>
                )}
              </div>
            </div>
          </div>
        </aside>
      }
    />
  );
}
