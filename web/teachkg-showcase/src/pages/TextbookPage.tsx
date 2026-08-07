import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { GraphCanvas } from "@/components/pipeline/GraphCanvas";
import { HighlightLegend } from "@/components/pipeline/HighlightLegend";
import { RelatedEdges, SelectionDetail } from "@/components/pipeline/SelectionPanels";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import { ResizableSplit } from "@/components/pipeline/ResizableSplit";
import { SliceTextAnnotator } from "@/components/pipeline/SliceTextAnnotator";
import type { PipelinePayload, PipelineStage } from "@/lib/pipeline/types";
import {
  filterHasMatches,
  stageHighlightFilters,
} from "@/lib/pipeline/graphLogic";
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
    blurb: "MD 分章 · extract 对齐",
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

export function TextbookPage() {
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
  const posCacheRef = useRef<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    fetch(`/data/textbook_kg/catalog.json?t=${Date.now()}`, { cache: "no-store" })
      .then(async (r) => {
        if (r.ok) return r.json();
        // 兼容旧单文件
        const legacy = await fetch(`/data/textbook_kg_showcase.json?t=${Date.now()}`, {
          cache: "no-store",
        });
        if (!legacy.ok) throw new Error("缺少 textbook_kg/catalog.json，请先导出并 sync-data");
        const j = await legacy.json();
        return {
          default_file_id: j.file_id || "legacy",
          files: [
            {
              id: j.file_id || "legacy",
              title: j.title || "教材知识图谱",
              available: true,
              dataUrl: "/data/textbook_kg_showcase.json",
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
  }, []);

  useEffect(() => {
    if (!catalog || !fileId) return;
    const entry = catalog.files.find((f) => f.id === fileId);
    if (!entry) return;
    if (!entry.available) {
      setData(null);
      setError(entry.reason ? `不可用：${entry.reason}` : "该文件不可用");
      return;
    }
    const url = entry.dataUrl || `/data/textbook_kg/${entry.id}.json`;
    setLoadingFile(true);
    setError(null);
    fetch(`${url}?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`缺少 ${url}，请先导出该文件`);
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
  }, [catalog, fileId]);

  const active: TextbookSlice | null = useMemo(() => {
    if (!data || !sliceId) return null;
    if (sliceId === "__all__") return data.overview;
    return data.slices.find((s) => s.id === sliceId) || data.slices[0] || null;
  }, [data, sliceId]);

  const stage = useMemo(() => (active ? stageFromSlice(active) : undefined), [active]);

  const payload: PipelinePayload | null = useMemo(() => {
    if (!data || !stage || !active) return null;
    return {
      brand: "TeachKG",
      product: "教材知识图谱",
      mode: "lecture",
      course_id: "shuliluoji",
      title: data.title,
      subtitle: data.subtitle,
      items: [
        {
          cue_id: active.id,
          stages: [stage],
        },
      ],
    };
  }, [data, stage, active]);

  useEffect(() => {
    posCacheRef.current = {};
    setSelectedNode(null);
    setSelectedEdge(null);
    setFocusEdgeIds(null);
    setHighlightKey(null);
  }, [sliceId, fileId]);

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

  const chapterList = useMemo(() => data?.slices || [], [data]);

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

  return (
    <ResizableShell
      storagePrefix="shell-textbook"
      nav={
      <aside className={shell.sidebar}>
        <div className={shell.sideHead}>
          <Link to="/" className={shell.back}>
            <span className={shell.backIcon} aria-hidden>
              ←
            </span>
            <span className={shell.backBrand}>
              Teach<em>KG</em>
            </span>
          </Link>
          <p className={shell.eyebrow}>Textbook KG</p>
          <h1 className={shell.sideTitle}>教材知识图谱</h1>
          <p className={shell.sideLead}>
            {data?.subtitle || "选择 MD 文件 · 按章对齐 extract 三元组"}
          </p>
        </div>

        <div className={shell.navBlock}>
          <p className={shell.navLabel}>教材文件</p>
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
                <em>{f.chapter_count ?? "—"}章</em>
              </button>
            ))}
            {unavailableFiles.length > 0 ? (
              <p className={styles.fileDisabledHint}>
                另有 {unavailableFiles.length} 项缺 MD/extract
              </p>
            ) : null}
          </div>
        </div>

        <div className={`${shell.navBlock} ${shell.navBlockGrow}`}>
          <p className={shell.navLabel}>章节</p>
          <div className={shell.navScroll}>
            <button
              type="button"
              className={sliceId === "__all__" ? shell.navItemActive : shell.navItem}
              onClick={() => {
                setSliceId("__all__");
                setShowSliceText(false);
              }}
            >
              <span>全书合并</span>
            </button>

            {chapterList.map((s) => (
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
            <h2>{active?.title || data?.title || "教材知识图谱"}</h2>
            <p>
              {data?.source_dir ? `来源 ${data.source_dir}` : "MD 分章"}
              {data?.stats
                ? ` · ${data.stats.slices} 章 / ${data.stats.entities} 实体 / ${data.stats.relations} 关系`
                : ""}
              {data?.stats?.aligned_triples != null
                ? ` · 对齐 ${data.stats.aligned_triples}`
                : ""}
              {hasSliceText ? ` · 正文 ${sliceBody.length} 字` : ""}
            </p>
          </div>
          <div className={shell.tools}>
            <button
              type="button"
              className={shell.toolBtn}
              disabled={!hasSliceText}
              onClick={() => setShowSliceText((v) => !v)}
              title={slicePanelVisible ? "隐藏章节正文" : "显示章节正文"}
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
                    <strong>章节正文</strong>
                    <span className={styles.sliceHint}>MD 章节原文</span>
                    <button
                      type="button"
                      className={styles.sliceHide}
                      onClick={() => setShowSliceText(false)}
                    >
                      隐藏
                    </button>
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
        <div className={pipe.panel}>
          <h3>当前章节</h3>
          <p className={styles.panelLead}>{active?.title || "—"}</p>
          <div className={styles.statGrid}>
            <div>
              <b>{active?.node_count ?? 0}</b>
              <span>实体</span>
            </div>
            <div>
              <b>{active?.triple_count ?? 0}</b>
              <span>关系</span>
            </div>
          </div>
        </div>

        <div className={pipe.panel}>
          <h3>选中详情</h3>
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
        </div>

        {selectedNode && stage ? (
          <div className={pipe.panel}>
            <h3>相关关系</h3>
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
          </div>
        ) : null}
      </aside>
      }
    />
  );
}
