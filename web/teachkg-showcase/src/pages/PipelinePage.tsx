import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { GraphCanvas } from "@/components/pipeline/GraphCanvas";
import { HighlightLegend } from "@/components/pipeline/HighlightLegend";
import { RelatedEdges, SelectionDetail } from "@/components/pipeline/SelectionPanels";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import { ZoomableImage } from "@/components/pipeline/ZoomableImage";
import { loadManifest } from "@/lib/catalog";
import type { PipelinePayload, PipelineStage } from "@/lib/pipeline/types";
import { ensureCrossCueWindowItems } from "@/lib/pipeline/crossCueWindows";
import {
  filterHasMatches,
  isSessionLectureStage,
  stageHighlightFilters,
} from "@/lib/pipeline/graphLogic";
import shell from "@/styles/shell.module.css";
import styles from "./PipelinePage.module.css";

const ALL_LECTURES = Array.from({ length: 26 }, (_, i) => String(i + 1));

/** 无数据时撑起左侧步骤与主区标题 */
const PLACEHOLDER_STAGES: PipelineStage[] = [
  {
    id: "asr",
    title: "课堂口述",
    subtitle: "原始 ASR ↔ PPT 校对",
    blurb: "左侧原始转写，右侧为 PPT/板书校对结果。",
    focus: "text",
    text: "",
    text_compare: true,
    compare_mode: "asr",
    raw_text: "",
    corrected_text: "",
  },
  {
    id: "preprocess",
    title: "文本预处理",
    subtitle: "校对文本 ↔ extract_text",
    blurb: "左为校对后口述，右为清洗后可抽取文本。",
    focus: "text",
    text: "",
    text_compare: true,
    compare_mode: "preprocess",
    raw_text: "",
    corrected_text: "",
  },
  {
    id: "seeds",
    title: "种子实体",
    subtitle: "原文高亮 ↔ 筛选结果",
    blurb: "左栏预处理文本高亮命中；右栏种子列表（未匹配用琥珀色）。",
    focus: "text",
    text: "",
    nodes: [],
    edges: [],
  },
  {
    id: "textbook",
    title: "教材子图写入",
    subtitle: "保留边须有课堂原文依据",
    blurb: "左栏处理原文点边高亮依据；右栏绿边写入、灰边过滤。",
    focus: "graph",
    nodes: [],
    edges: [],
  },
  {
    id: "correct",
    title: "课堂修正教材",
    subtitle: "保留 / 修订 / 删除",
    blurb: "左栏课堂原文，右栏修正图谱。绿=保留，琥珀=修订后，灰虚线=修订前/删除。",
    focus: "graph",
    nodes: [],
    edges: [],
  },
  {
    id: "delta",
    title: "课堂增量",
    subtitle: "教材未覆盖的关系",
    blurb: "左栏课堂原文，点增量边高亮依据；右栏增量图谱。",
    focus: "graph",
    nodes: [],
    edges: [],
  },
  {
    id: "merge",
    title: "融合结果",
    subtitle: "修正后教材 + 增量",
    blurb: "左栏课堂原文，点边高亮依据；右栏融合图谱。",
    focus: "multimodal",
    nodes: [],
    edges: [],
  },
];

export function PipelinePage() {
  const { lectureId: rawId } = useParams();
  const navigate = useNavigate();
  const lectureId = useMemo(() => {
    if (!rawId) return "";
    // 会话融合：session_1_2
    if (/^session_\d+_\d+$/i.test(String(rawId))) return String(rawId);
    const m = String(rawId).match(/^(?:lecture[_-])?(\d+)$/i);
    return m ? m[1] : String(rawId);
  }, [rawId]);

  const isSession = /^session_\d+_\d+$/i.test(lectureId);
  const sessionPair = useMemo(() => {
    const m = lectureId.match(/^session_(\d+)_(\d+)$/i);
    return m ? ([m[1], m[2]] as [string, string]) : null;
  }, [lectureId]);

  const [readyLectures, setReadyLectures] = useState<Set<string>>(new Set());
  const [readySessions, setReadySessions] = useState<Set<string>>(new Set());
  const [payload, setPayload] = useState<PipelinePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [cueIndex, setCueIndex] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const [hideFiltered, setHideFiltered] = useState(false);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [focusEdgeIds, setFocusEdgeIds] = useState<string[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const posCacheRef = useRef<Record<string, { x: number; y: number }>>({});
  const playRef = useRef<number | null>(null);
  const prevStageId = useRef<string>("");

  useEffect(() => {
    let cancelled = false;
    loadManifest()
      .then((m) => {
        if (cancelled) return;
        const ready = new Set<string>();
        const sessions = new Set<string>();
        for (const it of m.items || []) {
          if (it.type === "session" && it.stem) {
            sessions.add(String(it.stem));
            continue;
          }
          if (it.type !== "pipeline") continue;
          const lid =
            it.lectureId ||
            String(it.stem || "").match(/lecture[_-]?(\d+)/i)?.[1] ||
            String(it.href || "").match(/\/pipeline\/(?:lecture_)?(\d+)/)?.[1];
          if (lid) ready.add(String(lid));
        }
        setReadyLectures(ready);
        setReadySessions(sessions);
      })
      .catch(() => {
        /* layout-first：manifest 缺失也不挡界面 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!lectureId) return;
    // 兼容旧链接 /pipeline/lecture_1
    if (rawId && rawId !== lectureId && /^(?:lecture[_-])?\d+$/i.test(rawId)) {
      navigate(`/pipeline/${lectureId}`, { replace: true });
      return;
    }
    let cancelled = false;
    setPayload(null);
    setCueIndex(0);
    setStageIndex(0);
    setHideFiltered(false);
    setHighlightKey(null);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
    setPlaying(false);
    posCacheRef.current = {};
    setLoading(true);

    const stem = isSession ? lectureId : `lecture_${lectureId}`;
    fetch(`/data/pipeline/pipeline_build_${stem}.json`)
      .then((r) => {
        if (!r.ok) throw new Error("no-data");
        return r.json();
      })
      .then((d) => {
        if (!cancelled) {
          const raw = d as PipelinePayload;
          if (isSession) {
            setPayload(raw);
          } else {
            const lid = String(raw.lecture_id || lectureId || "");
            const items = ensureCrossCueWindowItems(raw.items || [], lid);
            const crossN = items.filter((it) => it.is_cross_cue).length;
            setPayload({
              ...raw,
              items,
              cue_count: raw.cue_count ?? items.filter((it) => !it.is_cross_cue).length,
              cross_cue_window_count: raw.cross_cue_window_count ?? crossN,
            });
          }
          if (isSession) {
            setReadySessions((prev) => new Set(prev).add(lectureId));
          } else {
            setReadyLectures((prev) => new Set(prev).add(lectureId));
          }
        }
      })
      .catch(() => {
        if (!cancelled) setPayload(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [lectureId, rawId, navigate, isSession]);

  const cue = payload?.items?.[cueIndex];
  const isCrossCueItem = Boolean(cue?.is_cross_cue);
  const stages: PipelineStage[] = cue?.stages?.length
    ? cue.stages.map((st) => {
        // 段级展示不含跨段边（即使旧数据误写入 merge）；跨段窗口项本身保留
        if (
          !isCrossCueItem &&
          (st.id === "delta" || st.id === "merge" || st.id?.startsWith("merge__"))
        ) {
          const edges = (st.edges || []).filter((e) => {
            const s = (e.source || "").trim();
            if (s === "cross_cue" || s.startsWith("cross_cue")) return false;
            if (s.includes("讲的第") && s.includes("段到第")) return false;
            return true;
          });
          return edges.length === (st.edges || []).length ? st : { ...st, edges };
        }
        return st;
      })
    : PLACEHOLDER_STAGES;
  const stage: PipelineStage | undefined = stages[stageIndex] || stages[0];
  const hasData = Boolean(payload && cue);
  const fragmentCount =
    payload?.cue_count ??
    (payload?.items || []).filter((it) => !it.is_cross_cue).length;
  const crossWindowCount =
    payload?.cross_cue_window_count ??
    (payload?.items || []).filter((it) => it.is_cross_cue).length;

  useEffect(() => {
    if (stage && stage.id !== prevStageId.current) {
      setHighlightKey(null);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setFocusEdgeIds(null);
      // 修正步默认显示删除边（drop 是修正结果的一部分）；教材子图默认显示全部
      if (stage.id === "correct") setHideFiltered(false);
      else if (stage.id === "textbook") setHideFiltered(false);
      else if (stage.id === "cross_cue") setHideFiltered(true); // 默认隐藏去重掉的边
      prevStageId.current = stage.id;
    }
  }, [stage]);

  useEffect(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setFocusEdgeIds(null);
  }, [cueIndex]);

  const selectEdgesFromText = (id: string | null, groupIds?: string[]) => {
    if (id == null) {
      setSelectedEdgeId(null);
      setFocusEdgeIds(null);
      return;
    }
    const ids = (groupIds?.length ? groupIds : [id]).map(String);
    setFocusEdgeIds(ids);
    setSelectedEdgeId(ids.length === 1 ? ids[0] : null);
    setSelectedNodeId(null);
  };

  useEffect(() => {
    if (!playing || !payload || !cue) return;
    playRef.current = window.setInterval(() => {
      setStageIndex((si) => {
        if (si < cue.stages.length - 1) return si + 1;
        setCueIndex((ci) => {
          if (ci < payload.items.length - 1) {
            setStageIndex(0);
            return ci + 1;
          }
          setPlaying(false);
          return ci;
        });
        return si;
      });
    }, 2800);
    return () => {
      if (playRef.current) clearInterval(playRef.current);
    };
  }, [playing, payload, cue]);

  const hlFilters = useMemo(() => {
    if (!payload || !stage || !hasData) return [];
    return stageHighlightFilters(stage, payload.mode, payload.lecture_ids || []).filter((f) =>
      filterHasMatches(payload.mode, stage, f, hideFiltered)
    );
  }, [payload, stage, hideFiltered, hasData]);

  const showFilterBtn = Boolean(
    payload &&
      stage &&
      hasData &&
      (isSessionLectureStage(payload.mode, stage) ||
        stage.id === "textbook" ||
        stage.id === "correct" ||
        stage.id === "cross_cue")
  );
  const hasCrossDedupe = Boolean(
    isCrossCueItem &&
      stage &&
      (stage.edges || []).some((e) => (e.source || "") === "filtered")
  );

  if (!lectureId) {
    return <Navigate to="/pipeline/1" replace />;
  }

  const goLecture = (id: string) => navigate(`/pipeline/${id}`);
  const goSession = (id: string) => navigate(`/pipeline/${id}`);

  return (
    <ResizableShell
      storagePrefix="shell-pipeline"
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
          <p className={shell.eyebrow}>Pipeline</p>
          <h1 className={shell.sideTitle}>构建流水线</h1>
          <p className={shell.sideLead}>按讲次分步：口述 → 预处理 → 种子 → 子图 → 增量</p>
        </div>

        {readySessions.size > 0 ? (
          <div className={shell.navBlock}>
            <p className={shell.navLabel}>一堂课融合</p>
            <div className={shell.navScroll}>
              {[...readySessions].sort().map((sid) => {
                const m = sid.match(/^session_(\d+)_(\d+)$/i);
                const label = m ? `第 ${m[1]}–${m[2]} 讲` : sid;
                const active = lectureId === sid;
                return (
                  <button
                    key={sid}
                    type="button"
                    className={active ? shell.navItemActive : shell.navItem}
                    onClick={() => goSession(sid)}
                  >
                    <span>{label}</span>
                    <em>会话</em>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className={`${shell.navBlock} ${shell.navBlockGrow}`}>
          <p className={shell.navLabel}>讲次</p>
          <div className={shell.navScroll}>
            {ALL_LECTURES.map((id) => {
              const ready = readyLectures.has(id);
              const active = !isSession && lectureId === id;
              return (
                <button
                  key={id}
                  type="button"
                  className={active ? shell.navItemActive : shell.navItem}
                  onClick={() => goLecture(id)}
                  title={ready ? `第 ${id} 讲 · 有数据` : `第 ${id} 讲 · 布局预览`}
                >
                  <span>第 {id} 讲</span>
                  <em>{ready ? "就绪" : "待填充"}</em>
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.stepBlock}>
          <p className={shell.navLabel}>{isCrossCueItem ? "跨段窗口" : "构建步骤"}</p>
          <div className={styles.stepScroll}>
            {stages.map((st, i) => (
              <button
                key={st.id}
                type="button"
                className={`${styles.step} ${i === stageIndex ? styles.stepActive : ""}`}
                onClick={() => {
                  setPlaying(false);
                  setStageIndex(i);
                }}
              >
                <span className={styles.stepIdx}>{i + 1}</span>
                <span>
                  <strong>{st.title}</strong>
                  <small>{st.subtitle}</small>
                </span>
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
            <h2>
              {isSession && sessionPair
                ? `第 ${sessionPair[0]}–${sessionPair[1]} 讲 · ${stage?.title || "一堂课融合"}`
                : isCrossCueItem
                  ? `第 ${lectureId} 讲 · ${cue?.cross_cue_span || stage?.title || "跨段抽取"}`
                  : `第 ${lectureId} 讲 · ${stage?.title || "流水线"}`}
            </h2>
            <p>
              {isCrossCueItem
                ? stage?.blurb || "多段拼接文本与跨段关系图谱"
                : stage?.blurb || "选择步骤查看本讲构建过程"}
            </p>
          </div>
          <div className={shell.stats}>
            <div>
              <strong>{hasData ? fragmentCount : "—"}</strong>
              <span>片段</span>
            </div>
            {crossWindowCount > 0 ? (
              <div>
                <strong>{crossWindowCount}</strong>
                <span>跨段窗</span>
              </div>
            ) : null}
            <div>
              <strong>{stages.length}</strong>
              <span>步骤</span>
            </div>
            <div>
              <strong>{hasData ? stageIndex + 1 : "—"}</strong>
              <span>当前步</span>
            </div>
          </div>
          <div className={shell.tools}>
            <button
              type="button"
              className={shell.toolBtn}
              disabled={!hasData || stageIndex <= 0}
              onClick={() => {
                setPlaying(false);
                setStageIndex((v) => Math.max(0, v - 1));
              }}
            >
              上一步
            </button>
            <button
              type="button"
              className={`${shell.toolBtn} ${styles.primaryBtn}`}
              disabled={!hasData || stageIndex >= stages.length - 1}
              onClick={() => {
                setPlaying(false);
                setStageIndex((v) => Math.min(stages.length - 1, v + 1));
              }}
            >
              下一步
            </button>
          </div>
        </header>

        <div className={styles.stageBody}>
          {stage?.stats && hasData && (
            <div className={styles.statsRow}>
              {Object.entries(stage.stats).map(([k, v]) =>
                v == null ? null : (
                  <span key={k}>
                    {k}: {String(v)}
                  </span>
                )
              )}
            </div>
          )}

          <div className={styles.viewport}>
            {loading ? (
              <div className={styles.emptyPane}>
                {isSession && sessionPair
                  ? `加载第 ${sessionPair[0]}–${sessionPair[1]} 讲融合…`
                  : `加载第 ${lectureId} 讲…`}
              </div>
            ) : hasData && payload && stage ? (
              <>
                <GraphCanvas
                  payload={payload}
                  stage={stage}
                  hideFiltered={hideFiltered}
                  highlightKey={highlightKey}
                  selectedEdgeId={selectedEdgeId}
                  focusEdgeIds={focusEdgeIds}
                  selectedNodeId={selectedNodeId}
                  posCacheRef={posCacheRef}
                  keepLayout={payload.mode === "session"}
                  onSelectNode={(id) => {
                    setSelectedNodeId(id);
                    if (id != null) {
                      setSelectedEdgeId(null);
                      setFocusEdgeIds(null);
                    }
                  }}
                  onSelectEdge={(id, groupIds) => selectEdgesFromText(id, groupIds)}
                  legend={
                    <HighlightLegend
                      filters={hlFilters}
                      highlightKey={highlightKey}
                      onHighlightKey={setHighlightKey}
                      stage={stage}
                      mode={payload.mode}
                      hideFiltered={hideFiltered}
                    />
                  }
                />
              </>
            ) : (
              <div className={styles.emptyPane}>
                <strong>第 {lectureId} 讲 · 暂无流水线数据</strong>
                <p>布局已就绪。导出 `pipeline_build_lecture_{lectureId}.json` 后刷新即可填充。</p>
                <ol>
                  {stages.map((st, i) => (
                    <li key={st.id} className={i === stageIndex ? styles.emptyStepOn : undefined}>
                      {st.title}
                      <em>{st.subtitle}</em>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>

          <div className={styles.transport}>
            <span className={styles.chip}>
              {stageIndex + 1} / {stages.length}
            </span>
            <div className={styles.progress}>
              <i style={{ width: `${((stageIndex + 1) / stages.length) * 100}%` }} />
            </div>
            <div className={styles.transportRight}>
              {showFilterBtn && (stage?.id !== "cross_cue" || hasCrossDedupe) && (
                <button
                  type="button"
                  className={hideFiltered ? styles.filterOn : ""}
                  onClick={() => setHideFiltered((v) => !v)}
                  title={
                    stage?.id === "cross_cue"
                      ? hideFiltered
                        ? "显示因与本讲已有边/重叠窗重复而被去掉的候选"
                        : "隐藏去重掉的候选边"
                      : undefined
                  }
                >
                  {stage?.id === "cross_cue"
                    ? hideFiltered
                      ? "显示去重结果"
                      : "隐藏去重结果"
                    : hideFiltered
                      ? "显示过滤边"
                      : "隐藏过滤边"}
                </button>
              )}
              <button
                type="button"
                disabled={!hasData}
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? "暂停" : "自动播放"}
              </button>
            </div>
          </div>
        </div>
      </main>
      }
      detail={
      <aside className={styles.side}>
        <div className={styles.panel}>
          <h3>本讲片段</h3>
          <div className={styles.cueList}>
            {hasData && payload
              ? payload.items.map((it, i) => {
                  const fragIdx = payload.items
                    .slice(0, i)
                    .filter((x) => !x.is_cross_cue).length;
                  const crossIdx = payload.items
                    .slice(0, i)
                    .filter((x) => x.is_cross_cue).length;
                  const label = it.is_cross_cue
                    ? it.start_seg != null && it.end_seg != null
                      ? `跨段 · 第${it.start_seg}–${it.end_seg}段`
                      : it.cross_cue_span || `跨段 ${crossIdx + 1}`
                    : `片段 ${fragIdx + 1} · ${Math.round(it.start_sec || 0)}s`;
                  return (
                    <button
                      key={it.cue_id}
                      type="button"
                      className={`${styles.cueBtn} ${i === cueIndex ? styles.cueOn : ""} ${
                        it.is_cross_cue ? styles.cueCross : ""
                      }`}
                      onClick={() => {
                        setCueIndex(i);
                        setStageIndex(0);
                        setPlaying(false);
                      }}
                      title={it.cross_cue_span || label}
                    >
                      {label}
                    </button>
                  );
                })
              : (
                <div className={styles.sideEmpty}>暂无片段</div>
              )}
          </div>
        </div>

        <div className={styles.panel}>
          <h3>选中详情</h3>
          {hasData && stage ? (
            <SelectionDetail
              stage={stage}
              selectedNodeId={selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              hideFiltered={hideFiltered}
              mode={payload?.mode || "lecture"}
            />
          ) : (
            <div className={styles.sideEmpty}>点击图中实体或关系查看详情</div>
          )}
        </div>

        {selectedNodeId ? (
          <div className={styles.panel}>
            <h3>相关关系</h3>
            {hasData && stage ? (
              <RelatedEdges
                stage={stage}
                nodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                hideFiltered={hideFiltered}
                mode={payload?.mode || "lecture"}
                onSelect={(id) => {
                  selectEdgesFromText(id, id != null ? [id] : undefined);
                }}
              />
            ) : (
              <div className={styles.sideEmpty}>暂无</div>
            )}
          </div>
        ) : null}

        {!isCrossCueItem ? (
          <div className={styles.panel}>
            <h3>多模态证据</h3>
            <div className={styles.mm}>
              <div>
                <div className={styles.mmLabel}>课堂切片</div>
                {cue?.media?.clip ? (
                  <video controls src={cue.media.clip} preload="metadata" />
                ) : (
                  <div className={styles.sideEmpty}>暂无视频</div>
                )}
              </div>
              <div>
                <div className={styles.mmLabel}>板书 / PPT</div>
                {cue?.media?.ppt ? (
                  <ZoomableImage src={cue.media.ppt} alt="板书 / PPT" />
                ) : (
                  <div className={styles.sideEmpty}>暂无帧图</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </aside>
      }
    />
  );
}
