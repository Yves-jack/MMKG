import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { GraphCanvas } from "@/components/pipeline/GraphCanvas";
import { HighlightLegend } from "@/components/pipeline/HighlightLegend";
import { CollapsiblePanel } from "@/components/pipeline/CollapsiblePanel";
import { RelatedEdges, SelectionDetail, relatedEdgesOf } from "@/components/pipeline/SelectionPanels";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import { ResizableSplit } from "@/components/pipeline/ResizableSplit";
import { SliceTextAnnotator } from "@/components/pipeline/SliceTextAnnotator";
import type { PipelinePayload, PipelineStage } from "@/lib/pipeline/types";
import { filterHasMatches, stageHighlightFilters } from "@/lib/pipeline/graphLogic";
import { applyMmkgEnrichmentToNodes, loadMmkgEntityEnrichment, type MmkgEntityEnrichment } from "@/lib/kg/pipelineMergeSource";
import { courseDataUrl, coursePath, useCourseId } from "@/lib/course";
import { withBase } from "@/lib/withBase";
import shell from "@/styles/shell.module.css";
import pipe from "./PipelinePage.module.css";
import styles from "./TextbookPage.module.css";

type TextbookSlice = {
  id: string;
  title: string;
  chapter: string;
  triple_count: number;
  node_count: number;
  text?: string;
  nodes: PipelineStage["nodes"];
  edges: PipelineStage["edges"];
};

type TextbookPayload = {
  title: string;
  subtitle?: string;
  source_dir?: string;
  file_id?: string;
  stats?: Record<string, number>;
  overview: TextbookSlice;
  slices: TextbookSlice[];
};

type CatalogFile = {
  id: string;
  title: string;
  path?: string;
  extract_path?: string | null;
  chapter_count?: number;
  available?: boolean;
  reason?: string;
  dataUrl?: string;
};

type Catalog = {
  default_file_id?: string;
  files: CatalogFile[];
};

function stageFromSlice(slice: TextbookSlice): PipelineStage {
  const nodes = slice.nodes || [];
  const edges = slice.edges || [];
  return {
    id: `textbook_${slice.id}`,
    title: slice.title,
    subtitle: `${slice.node_count} 实体 · ${slice.triple_count} 关系`,
    blurb: "课件划分 · extract 对齐",
    focus: "graph",
    nodes,
    edges,
    stats: {
      nodes: slice.node_count,
      relations: slice.triple_count,
    },
  };
}

function formatSliceText(raw: string): string {
  return (raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/<---\s*Page Split\s*--->/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 课内教材分片 URL；兼容 catalog 里旧的 /data/textbook_kg/... */
function resolveTextbookFileUrl(courseId: string, entry: CatalogFile): string {
  const id = String(entry.id || "").trim();
  if (!id) {
    return entry.dataUrl || courseDataUrl(courseId, "textbook_kg_showcase.json");
  }
  const encodedId = encodeURIComponent(id).replace(/%2B/gi, "+");
  const local = courseDataUrl(courseId, `textbook_kg/${encodedId}.json`);
  const raw = String(entry.dataUrl || "");
  // 旧导出写死了扁平路径；改走课内副本，避免 404 / HTML 回退
  if (!raw || raw.startsWith("/data/textbook_kg/")) {
    return local;
  }
  if (raw.startsWith("/data/courses/")) {
    return withBase(raw);
  }
  return local;
}

export function TextbookPage() {
  const courseId = useCourseId();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [fileId, setFileId] = useState<string>("");
  const [data, setData] = useState<TextbookPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [sliceId, setSliceId] = useState<string>("");
  const [showSliceText, setShowSliceText] = useState(true);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [focusEdgeIds, setFocusEdgeIds] = useState<string[] | null>(null);
  const [entityQuery, setEntityQuery] = useState("");
  const [entitySearchOpen, setEntitySearchOpen] = useState(false);
  const [focusNodeRequest, setFocusNodeRequest] = useState<{
    id: string;
    seq: number;
  } | null>(null);
  /** 跨课件跳转后等 stage 就绪再居中 */
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [mmkgEnrichment, setMmkgEnrichment] = useState<Map<string, MmkgEntityEnrichment>>(
    () => new Map()
  );
  const posCacheRef = useRef<Record<string, { x: number; y: number }>>({});
  const entitySearchRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<string | null>(null);

  useEffect(() => {
    pendingFocusRef.current = pendingFocusId;
  }, [pendingFocusId]);

  useEffect(() => {
    let cancelled = false;
    loadMmkgEntityEnrichment(courseId, null).then((m) => {
      if (!cancelled) setMmkgEnrichment(m);
    });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  useEffect(() => {
    fetch(`${courseDataUrl(courseId, "textbook_kg/catalog.json")}?t=${Date.now()}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (r.ok) return r.json();
        // 兼容旧单文件
        const legacy = await fetch(
          `${courseDataUrl(courseId, "textbook_kg_showcase.json")}?t=${Date.now()}`,
          {
            cache: "no-store",
          }
        );
        if (!legacy.ok) throw new Error("缺少 textbook_kg/catalog.json，请先导出并 sync-data");
        const j = await legacy.json();
        return {
          default_file_id: j.file_id || "legacy",
          files: [
            {
              id: j.file_id || "legacy",
              title: j.title || "教材级图谱",
              available: true,
              dataUrl: courseDataUrl(courseId, "textbook_kg_showcase.json"),
              chapter_count: j.slices?.length || 0,
            },
          ],
        } as Catalog;
      })
      .then((c: Catalog) => {
        setCatalog(c);
        const firstAvail =
          c.files.find((f) => f.available && f.id === c.default_file_id) ||
          c.files.find((f) => f.available) ||
          c.files[0];
        if (firstAvail) setFileId(firstAvail.id);
      })
      .catch((e) => setError(String(e.message || e)));
  }, [courseId]);

  useEffect(() => {
    if (!catalog || !fileId) return;
    const entry = catalog.files.find((f) => f.id === fileId);
    if (!entry) return;
    if (!entry.available) {
      setData(null);
      setError(entry.reason ? `不可用：${entry.reason}` : "该文件不可用");
      return;
    }
    const url = resolveTextbookFileUrl(courseId, entry);
    setLoadingFile(true);
    setError(null);
    fetch(`${url}?t=${Date.now()}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          // 课内路径失败时再试扁平旧路径（兼容未 re-sync）
          const legacyUrl = withBase(
            `/data/textbook_kg/${encodeURIComponent(entry.id).replace(/%2B/gi, "+")}.json`
          );
          const legacy = await fetch(`${legacyUrl}?t=${Date.now()}`, { cache: "no-store" });
          if (!legacy.ok) {
            throw new Error(`缺少教材图谱数据（${entry.id}），请运行 npm run sync-data`);
          }
          const ct = legacy.headers.get("content-type") || "";
          if (ct.includes("text/html")) {
            throw new Error("教材图谱接口返回了页面而非 JSON，请检查文件名编码后重新 sync-data");
          }
          return legacy.json();
        }
        const ct = r.headers.get("content-type") || "";
        if (ct.includes("text/html")) {
          throw new Error("教材图谱接口返回了页面而非 JSON，请检查文件名编码后重新 sync-data");
        }
        return r.json();
      })
      .then((j: TextbookPayload) => {
        setData(j);
        const first = j.slices?.[0]?.id || "__all__";
        setSliceId(first);
        setShowSliceText(first !== "__all__");
      })
      .catch((e) => {
        setData(null);
        setError(String(e.message || e));
      })
      .finally(() => setLoadingFile(false));
  }, [catalog, fileId, courseId]);

  const active: TextbookSlice | null = useMemo(() => {
    if (!data || !sliceId) return null;
    if (sliceId === "__all__") return data.overview;
    return data.slices.find((s) => s.id === sliceId) || data.slices[0] || null;
  }, [data, sliceId]);

  const stage = useMemo(() => {
    if (!active) return undefined;
    const raw = stageFromSlice(active);
    return {
      ...raw,
      nodes: applyMmkgEnrichmentToNodes(raw.nodes || [], mmkgEnrichment),
    };
  }, [active, mmkgEnrichment]);

  const payload: PipelinePayload | null = useMemo(() => {
    if (!data || !stage || !active) return null;
    return {
      brand: "TeachKG",
      product: "教材级图谱",
      mode: "lecture",
      course_id: courseId,
      title: data.title,
      subtitle: data.subtitle,
      items: [
        {
          cue_id: active.id,
          stages: [stage],
        },
      ],
    };
  }, [data, stage, active, courseId]);

  useEffect(() => {
    pendingFocusRef.current = pendingFocusId;
  }, [pendingFocusId]);

  useEffect(() => {
    posCacheRef.current = {};
    setSelectedNode(null);
    setSelectedEdge(null);
    setFocusEdgeIds(null);
    setHighlightKey(null);
    setEntitySearchOpen(false);
    if (!pendingFocusRef.current) {
      setEntityQuery("");
      setFocusNodeRequest(null);
    }
  }, [sliceId, fileId]);

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
      setSelectedEdge(null);
      setFocusEdgeIds(null);
      return;
    }
    const ids = (groupIds?.length ? groupIds : [id]).map(String);
    setFocusEdgeIds(ids);
    setSelectedEdge(ids.length === 1 ? ids[0] : null);
    setSelectedNode(null);
  };

  const coursewareList = useMemo(() => data?.slices || [], [data]);

  const sliceBody = useMemo(
    () => formatSliceText(active?.text || ""),
    [active?.text]
  );
  const hasSliceText = sliceBody.length > 0;
  const slicePanelVisible = showSliceText && hasSliceText;

  const hlFilters = useMemo(() => {
    if (!stage) return [];
    return stageHighlightFilters(stage, "lecture").filter((f) =>
      filterHasMatches("lecture", stage, f, false)
    );
  }, [stage]);

  const availableFiles = catalog?.files.filter((f) => f.available) || [];
  const unavailableFiles = catalog?.files.filter((f) => !f.available) || [];

  const findSliceForNode = (nodeId: string): string => {
    if (!data) return "__all__";
    if (sliceId !== "__all__") {
      const cur = data.slices.find((s) => s.id === sliceId);
      if (cur?.nodes?.some((n) => String(n.id) === nodeId)) return sliceId;
    }
    for (const s of data.slices || []) {
      if (s.nodes?.some((n) => String(n.id) === nodeId)) return s.id;
    }
    return "__all__";
  };

  const entityMatches = useMemo(() => {
    const q = entityQuery.trim().toLowerCase();
    if (!q || !data) return [];
    type Hit = {
      id: string;
      label: string;
      kind: string;
      score: number;
      sliceId: string;
      sliceTitle: string;
      inCurrent: boolean;
    };
    const scoreNode = (
      n: NonNullable<TextbookSlice["nodes"]>[number],
      sid: string,
      stitle: string,
      inCurrent: boolean
    ): Hit | null => {
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
      if (inCurrent) score += 40;
      return {
        id,
        label: label || zh || id,
        kind: n.kind || "",
        score,
        sliceId: sid,
        sliceTitle: stitle,
        inCurrent,
      };
    };

    const byId = new Map<string, Hit>();
    const curNodes = stage?.nodes || [];
    for (const n of curNodes) {
      const hit = scoreNode(n, sliceId || "__all__", active?.title || "当前", true);
      if (hit) byId.set(hit.id, hit);
    }
    // 全书索引：便于在单份课件视图也能搜到其他课件实体
    const pool: { slice: TextbookSlice; sid: string }[] = [
      ...(data.slices || []).map((s) => ({ slice: s, sid: s.id })),
    ];
    if (data.overview) {
      pool.push({ slice: data.overview, sid: "__all__" });
    }
    for (const { slice, sid } of pool) {
      const stitle = sid === "__all__" ? "全部" : slice.title || sid;
      for (const n of slice.nodes || []) {
        const id = String(n.id || "");
        if (byId.has(id)) continue;
        const hit = scoreNode(n, sid === "__all__" ? findSliceForNode(id) : sid, stitle, false);
        if (hit) {
          // 若命中全书节点，优先落到真实课件名
          if (sid === "__all__" && hit.sliceId !== "__all__") {
            const cw = data.slices.find((s) => s.id === hit.sliceId);
            hit.sliceTitle = cw?.title || hit.sliceTitle;
          }
          byId.set(id, hit);
        }
      }
    }
    const scored = [...byId.values()];
    scored.sort(
      (a, b) => b.score - a.score || a.label.localeCompare(b.label, "zh")
    );
    return scored.slice(0, 12);
    // findSliceForNode 依赖 data/sliceId，已在闭包内
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityQuery, data, stage, sliceId, active?.title]);

  const applyFocusOnStage = (nodeId: string) => {
    const n = stage?.nodes?.find((x) => String(x.id) === nodeId);
    if (!n) return false;
    setSelectedEdge(null);
    setFocusEdgeIds(null);
    setHighlightKey(null);
    setSelectedNode(String(n.id));
    setFocusNodeRequest((prev) => ({
      id: String(n.id),
      seq: (prev?.seq || 0) + 1,
    }));
    setEntityQuery(n.label || String(n.id).split("/")[0] || String(n.id));
    setEntitySearchOpen(false);
    return true;
  };

  const focusEntity = (nodeId: string, targetSliceId?: string) => {
    const dest = targetSliceId || findSliceForNode(nodeId);
    if (dest !== sliceId) {
      setPendingFocusId(nodeId);
      setSliceId(dest);
      setShowSliceText(dest !== "__all__");
      setEntitySearchOpen(false);
      return;
    }
    applyFocusOnStage(nodeId);
  };

  useEffect(() => {
    if (!pendingFocusId) return;
    if (!stage?.nodes?.some((n) => String(n.id) === pendingFocusId)) return;
    applyFocusOnStage(pendingFocusId);
    setPendingFocusId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocusId, stage, sliceId]);

  return (
    <ResizableShell
      storagePrefix="shell-textbook"
      nav={
      <aside className={shell.sidebar}>
        <div className={shell.sideHead}>
          <Link to={coursePath(courseId)} className={shell.back}>
            <span className={shell.backIcon} aria-hidden>
              ←
            </span>
            <span className={shell.backBrand}>
              Teach<em>KG</em>
            </span>
          </Link>
          <p className={shell.eyebrow}>Textbook KG</p>
          <h1 className={shell.sideTitle}>教材级图谱</h1>
        </div>

        {availableFiles.length > 1 || unavailableFiles.length > 0 ? (
          <div className={shell.navBlock}>
            <p className={shell.navLabel}>教材</p>
            <div className={`${shell.navScroll} ${styles.fileScroll}`}>
              {availableFiles.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={fileId === f.id ? shell.navItemActive : shell.navItem}
                  title={f.title}
                  onClick={() => setFileId(f.id)}
                >
                  <span>{f.title}</span>
                </button>
              ))}
              {unavailableFiles.length > 0 ? (
                <p className={styles.fileDisabledHint}>
                  另有 {unavailableFiles.length} 项缺 MD/extract
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className={`${shell.navBlock} ${shell.navBlockGrow}`}>
          <p className={shell.navLabel}>课件划分</p>
          <div className={shell.navScroll}>
            <button
              type="button"
              className={sliceId === "__all__" ? shell.navItemActive : shell.navItem}
              onClick={() => {
                setSliceId("__all__");
                setShowSliceText(false);
              }}
            >
              <span>全部合并</span>
            </button>

            {coursewareList.map((s) => (
              <button
                key={s.id}
                type="button"
                className={sliceId === s.id ? shell.navItemActive : shell.navItem}
                onClick={() => {
                  setSliceId(s.id);
                  setShowSliceText(true);
                }}
              >
                <span title={s.title}>{s.title}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>
      }
      main={
      <main className={styles.mainCol}>
        <header className={shell.topbar}>
          <div className={shell.topbarText}>
            <h2>{active?.title || data?.title || "教材级图谱"}</h2>
          </div>
          <div className={shell.tools}>
            <div className={styles.entitySearch} ref={entitySearchRef}>
              <input
                type="search"
                className={styles.entitySearchInput}
                value={entityQuery}
                disabled={!data || loadingFile}
                placeholder="搜索实体…"
                aria-label="搜索教材实体"
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
                    focusEntity(entityMatches[0].id, entityMatches[0].sliceId);
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
                        onClick={() => focusEntity(m.id, m.sliceId)}
                        title={m.id}
                      >
                        <span>{m.label}</span>
                        <em>
                          {m.inCurrent
                            ? m.id.includes("/")
                              ? m.id.split("/").slice(1).join("/")
                              : m.kind || "当前"
                            : m.sliceTitle}
                        </em>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              className={shell.toolBtn}
              disabled={!hasSliceText}
              onClick={() => setShowSliceText((v) => !v)}
              title={slicePanelVisible ? "隐藏课件正文" : "显示课件正文"}
            >
              {slicePanelVisible ? "隐藏正文" : "显示正文"}
            </button>
          </div>
          <div className={shell.stats}>
            <div>
              <strong>{active?.node_count ?? "—"}</strong>
              <span>实体</span>
            </div>
            <div>
              <strong>{active?.triple_count ?? "—"}</strong>
              <span>关系</span>
            </div>
          </div>
        </header>

        <div className={styles.body}>
          {error && <p className="empty-hint">{error}</p>}
          {(loadingFile || (!data && !error)) && (
            <p className="empty-hint">{loadingFile ? "加载所选教材…" : "加载目录…"}</p>
          )}

          {payload && stage && (
            <ResizableSplit
              className={styles.split}
              storageKey="split-textbook-md-graph-v2"
              initialLeftRatio={0.5}
              minLeftPx={260}
              minRightPx={300}
              enabled={slicePanelVisible}
              leftClassName={styles.slicePane}
              rightClassName={styles.viewport}
              left={
                <>
                  <div className={styles.sliceHead}>
                    <strong>课件正文</strong>
                  </div>
                  <div className={styles.sliceScroll}>
                    <SliceTextAnnotator
                      text={sliceBody}
                      edges={active?.edges || []}
                      selectedEdgeId={selectedEdge}
                      focusEdgeIds={focusEdgeIds}
                      tone="new"
                      onSelectEdge={(id, groupIds) => {
                        selectEdgesFromText(id, groupIds);
                        if (id && hasSliceText) setShowSliceText(true);
                      }}
                    />
                  </div>
                </>
              }
              right={
                <>
                  <GraphCanvas
                    key={`${fileId}-${active?.id || "all"}`}
                    payload={payload}
                    stage={stage}
                    hideFiltered={false}
                    highlightKey={highlightKey}
                    highlightMode="dim"
                    selectedEdgeId={selectedEdge}
                    focusEdgeIds={focusEdgeIds}
                    selectedNodeId={selectedNode}
                    focusNodeRequest={focusNodeRequest}
                    onFocusNodeConsumed={() => setFocusNodeRequest(null)}
                    posCacheRef={posCacheRef}
                    keepLayout={false}
                    onSelectNode={(id) => {
                      setSelectedNode(id);
                      if (id) {
                        setSelectedEdge(null);
                        setFocusEdgeIds(null);
                      }
                    }}
                    onSelectEdge={(id, groupIds) => {
                      selectEdgesFromText(id, groupIds);
                      if (id && hasSliceText) setShowSliceText(true);
                    }}
                    legend={
                      <HighlightLegend
                        filters={hlFilters}
                        highlightKey={highlightKey}
                        onHighlightKey={setHighlightKey}
                        stage={stage}
                        mode="lecture"
                        hideFiltered={false}
                        className={styles.legend}
                      />
                    }
                  />
                </>
              }
            />
          )}
        </div>
      </main>
      }
      detail={
      <aside className={pipe.side}>
        <CollapsiblePanel title="选中详情" storageKey="textbook-panel-detail" defaultOpen>
          {stage ? (
            <SelectionDetail
              stage={stage}
              selectedNodeId={selectedNode}
              selectedEdgeId={selectedEdge}
              hideFiltered={false}
              mode="lecture"
              importanceMode="textbook"
            />
          ) : (
            <div className={pipe.sideEmpty}>点击图中实体或关系查看详情</div>
          )}
        </CollapsiblePanel>

        {selectedNode && stage ? (
          <CollapsiblePanel
            title={`相关关系-${
              relatedEdgesOf(stage, selectedNode, {
                hideFiltered: false,
                mode: "lecture",
              }).length
            }`}
            storageKey="textbook-panel-edges"
            defaultOpen
          >
            <RelatedEdges
              stage={stage}
              nodeId={selectedNode}
              selectedEdgeId={selectedEdge}
              hideFiltered={false}
              mode="lecture"
              onSelect={(id) => {
                selectEdgesFromText(id, id != null ? [id] : undefined);
              }}
            />
          </CollapsiblePanel>
        ) : null}
      </aside>
      }
    />
  );
}
