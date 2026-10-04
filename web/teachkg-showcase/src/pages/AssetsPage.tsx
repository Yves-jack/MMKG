import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { MultiEvidenceHighlight } from "@/components/pipeline/MultiEvidenceHighlight";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import { LatexText } from "@/components/pipeline/LatexText";
import {
  assetKindLabel,
  assetRoleLabel,
  assetReviewSeek,
  compareAssetsByAppearance,
  findPeerAssets,
  type AssetCard,
  type AssetsLibrary,
} from "@/lib/kg/assetsLibrary";
import { WatchClassroom } from "@/components/apps/WatchClassroom";
import { loadManifest } from "@/lib/catalog";
import { courseDataUrl, coursePath, useCourseId } from "@/lib/course";
import type { PipelinePayload } from "@/lib/pipeline/types";
import shell from "@/styles/shell.module.css";
import styles from "./AssetsPage.module.css";

const ALL_LECTURES = Array.from({ length: 26 }, (_, i) => String(i + 1));

type CueChunk = {
  cueId: string;
  index: number;
  text: string;
  startSec?: number;
  endSec?: number;
};

function shortName(name: string): string {
  return (name || "").split("/")[0].trim() || name;
}

function buildMergedText(chunks: CueChunk[]): string {
  if (!chunks.length) return "";
  return chunks
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function cardsForLecture(library: AssetsLibrary | null, lectureId: string): AssetCard[] {
  if (!library?.cards?.length) return [];
  return library.cards
    .filter(
      (c) =>
        c.source === "llm" &&
        String(c.grounding?.lecture_id || "") === String(lectureId)
    )
    .slice()
    .sort(compareAssetsByAppearance);
}

export function AssetsPage() {
  const courseId = useCourseId() || "数理逻辑";
  const { lectureId: rawId } = useParams();
  const navigate = useNavigate();
  const lectureId = useMemo(() => {
    if (!rawId) return "";
    const m = String(rawId).match(/^(?:lecture[_-])?(\d+)$/i);
    return m ? m[1] : String(rawId);
  }, [rawId]);

  const [readyLectures, setReadyLectures] = useState<Set<string>>(new Set());
  const [assetLectures, setAssetLectures] = useState<Set<string>>(new Set());
  const [library, setLibrary] = useState<AssetsLibrary | null>(null);
  const [chunks, setChunks] = useState<CueChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [kindFilter, setKindFilter] = useState<
    "all" | "principle" | "theorem" | "technique" | "formula" | "example"
  >("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const cardListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadManifest(courseId).catch(() => null),
      fetch(`${courseDataUrl(courseId, "assets_library.json")}?t=${Date.now()}`, {
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([manifest, lib]) => {
      if (cancelled) return;
      const ready = new Set<string>();
      for (const it of manifest?.items || []) {
        if (it.type !== "pipeline") continue;
        const lid =
          it.lectureId ||
          String(it.stem || "").match(/lecture[_-]?(\d+)/i)?.[1];
        if (lid) ready.add(String(lid));
      }
      setReadyLectures(ready);
      const libraryData =
        lib && Array.isArray(lib.cards) ? (lib as AssetsLibrary) : null;
      setLibrary(libraryData);
      const withAssets = new Set<string>();
      for (const c of libraryData?.cards || []) {
        if (c.source !== "llm") continue;
        const lid = c.grounding?.lecture_id;
        if (lid != null && String(lid) !== "") withAssets.add(String(lid));
      }
      setAssetLectures(withAssets);
    });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  useEffect(() => {
    if (!lectureId) return;
    if (rawId && rawId !== lectureId && /^(?:lecture[_-])?\d+$/i.test(rawId)) {
      navigate(coursePath(courseId, `/assets/${lectureId}`), { replace: true });
      return;
    }
    let cancelled = false;
    setLoading(true);
    setChunks([]);
    setSelectedId(null);
    setKindFilter("all");

    fetch(courseDataUrl(courseId, `pipeline/pipeline_build_lecture_${lectureId}.json`))
      .then((r) => {
        if (!r.ok) throw new Error("no-pipeline");
        return r.json();
      })
      .then((d: PipelinePayload) => {
        if (cancelled) return;
        const items = d.items || [];
        const out: CueChunk[] = [];
        let idx = 0;
        for (const it of items) {
          if (it.is_cross_cue) continue;
          const text = String(it.asr_text || it.extract_text || "").trim();
          if (!text) continue;
          idx += 1;
          out.push({
            cueId: String(it.cue_id || `cue_${idx}`),
            index: idx,
            text,
            startSec: it.start_sec,
            endSec: it.end_sec,
          });
        }
        setChunks(out);
        setReadyLectures((prev) => new Set(prev).add(lectureId));
      })
      .catch(() => {
        if (!cancelled) setChunks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [courseId, lectureId, rawId, navigate]);

  const lectureCards = useMemo(
    () => cardsForLecture(library, lectureId),
    [library, lectureId]
  );

  const filteredCards = useMemo(() => {
    if (kindFilter === "all") return lectureCards;
    return lectureCards.filter((c) => c.kind === kindFilter);
  }, [lectureCards, kindFilter]);

  useEffect(() => {
    if (!filteredCards.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filteredCards.some((c) => c.asset_id === selectedId)) {
      setSelectedId(filteredCards[0]!.asset_id);
    }
  }, [filteredCards, selectedId]);

  // 点中间高亮文本时，右栏同步滚到对应资产卡片
  useEffect(() => {
    const root = cardListRef.current;
    if (!root || !selectedId) return;
    const el = [...root.querySelectorAll<HTMLElement>("[data-asset-id]")].find(
      (node) => node.dataset.assetId === selectedId
    );
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [selectedId, filteredCards]);

  const mergedText = useMemo(() => buildMergedText(chunks), [chunks]);

  const marks = useMemo(
    () =>
      filteredCards
        .filter((c) => (c.evidence || "").trim())
        .map((c) => ({
          id: c.asset_id,
          quote: String(c.evidence || ""),
          kind: String(c.kind || "evidence"),
          label: shortName(c.name),
        })),
    [filteredCards]
  );

  const selected = filteredCards.find((c) => c.asset_id === selectedId) || null;
  const selectedWatch = selected ? assetReviewSeek(selected, lectureId) : null;
  const selectedPeers = useMemo(
    () =>
      findPeerAssets(library, selected, {
        lectureId,
        lectureOnly: true,
        maxItems: 8,
      }),
    [library, selected, lectureId]
  );

  const kindCounts = useMemo(() => {
    const c = { principle: 0, theorem: 0, technique: 0, formula: 0, example: 0 };
    for (const card of lectureCards) {
      if (card.kind === "principle") c.principle += 1;
      else if (card.kind === "theorem") c.theorem += 1;
      else if (card.kind === "technique") c.technique += 1;
      else if (card.kind === "formula") c.formula += 1;
      else if (card.kind === "example") c.example += 1;
    }
    return c;
  }, [lectureCards]);

  if (!lectureId) {
    return <Navigate to={coursePath(courseId, "/assets/1")} replace />;
  }

  const goLecture = (id: string) => navigate(coursePath(courseId, `/assets/${id}`));

  return (
    <ResizableShell
      storagePrefix="shell-assets"
      nav={
        <aside className={shell.sidebar}>
          <div className={shell.sideHead}>
            <Link className={shell.back} to={coursePath(courseId)}>
              <span className={shell.backIcon} aria-hidden>
                ←
              </span>
              <span className={shell.backBrand}>
                Teach<em>KG</em>
              </span>
            </Link>
            <p className={shell.eyebrow}>Assets</p>
            <h1 className={shell.sideTitle}>定理 · 公式 · 例子</h1>
            <p className={shell.sideLead}>
              公式/例子从口播原文抽取；定理·原理·方法从预处理文本抽取
            </p>
          </div>

          <div className={`${shell.navBlock} ${shell.navBlockGrow}`}>
            <p className={shell.navLabel}>讲次</p>
            <div className={shell.navScroll}>
              {ALL_LECTURES.map((id) => {
                const ready = readyLectures.has(id);
                const hasAssets = assetLectures.has(id);
                const active = lectureId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className={active ? shell.navItemActive : shell.navItem}
                    onClick={() => goLecture(id)}
                    title={
                      hasAssets
                        ? `第 ${id} 讲 · 有抽取`
                        : ready
                          ? `第 ${id} 讲 · 暂无抽取`
                          : `第 ${id} 讲 · 待填充`
                    }
                  >
                    <span>第 {id} 讲</span>
                    <em>{hasAssets ? "有资产" : ready ? "无资产" : "待填充"}</em>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
      }
      main={
        <main className={styles.mainCol}>
          <header className={shell.topbar}>
            <div className={shell.topbarText}>
              <h2>第 {lectureId} 讲 · 合并课堂文本</h2>
              <p>各片段口播原文按序拼接；高亮为资产原文依据（例子在预处理中已被剔除）</p>
            </div>
            <div className={shell.stats}>
              <div>
                <strong>{chunks.length || "—"}</strong>
                <span>片段</span>
              </div>
              <div>
                <strong>{lectureCards.length}</strong>
                <span>资产</span>
              </div>
              <div>
                <strong>{kindCounts.principle}</strong>
                <span>原理</span>
              </div>
              <div>
                <strong>{kindCounts.theorem}</strong>
                <span>定理</span>
              </div>
              <div>
                <strong>{kindCounts.technique}</strong>
                <span>方法</span>
              </div>
              <div>
                <strong>{kindCounts.formula}</strong>
                <span>公式</span>
              </div>
              <div>
                <strong>{kindCounts.example}</strong>
                <span>例子</span>
              </div>
            </div>
          </header>

          <div className={styles.textPane}>
            {loading ? (
              <div className={styles.empty}>加载合并文本…</div>
            ) : !mergedText ? (
              <div className={styles.empty}>本讲暂无流水线片段文本</div>
            ) : (
              <MultiEvidenceHighlight
                text={mergedText}
                marks={marks}
                activeId={selectedId}
                onSelectMark={setSelectedId}
              />
            )}
          </div>
        </main>
      }
      detail={
        <aside className={styles.detailCol}>
          <div className={styles.detailHead}>
            <h3>本讲资产</h3>
            <div className={styles.kindTabs}>
              {(
                [
                  ["all", "全部"],
                  ["principle", "原理"],
                  ["theorem", "定理"],
                  ["technique", "方法"],
                  ["formula", "公式"],
                  ["example", "例子"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={kindFilter === k ? styles.kindTabActive : styles.kindTab}
                  onClick={() => setKindFilter(k)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.cardList} ref={cardListRef}>
            {!filteredCards.length ? (
              <div className={styles.empty}>本讲暂无大模型抽取资产</div>
            ) : (
              filteredCards.map((card) => {
                const active = card.asset_id === selectedId;
                return (
                  <button
                    key={card.asset_id}
                    type="button"
                    data-asset-id={card.asset_id}
                    className={active ? styles.cardActive : styles.card}
                    onClick={() => setSelectedId(card.asset_id)}
                  >
                    <div className={styles.cardHead}>
                      <span className={styles.kindBadge}>{assetKindLabel(card.kind)}</span>
                      <strong>{shortName(card.name)}</strong>
                    </div>
                    {card.summary ? (
                      <div className={styles.cardSummary}>
                        <LatexText text={card.summary} />
                      </div>
                    ) : null}
                    {card.evidence ? (
                      <div className={styles.cardEvidence}>
                        <span>原文依据</span>
                        <LatexText text={card.evidence} />
                      </div>
                    ) : null}
                    {(card.concepts || []).length ? (
                      <div className={styles.cardConcepts}>
                        {(card.concepts || []).map((c, i) => {
                          const lid = card.grounding?.lecture_id || lectureId;
                          return (
                            <Link
                              key={`${c.entity}-${i}`}
                              to={coursePath(
                                courseId,
                                `/kg/lecture/${lid}?focus=${encodeURIComponent(c.entity)}`
                              )}
                              onClick={(e) => e.stopPropagation()}
                              title={`${assetRoleLabel(c.role)} · 打开图谱`}
                            >
                              {assetRoleLabel(c.role)} · {shortName(c.entity)}
                            </Link>
                          );
                        })}
                      </div>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>

          {selectedWatch ? (
            <div className={styles.selectedExtra}>
              <WatchClassroom
                courseId={courseId}
                lectureId={selectedWatch.lectureId}
                startSec={selectedWatch.startSec}
                entityId={selectedWatch.entityId}
              />
            </div>
          ) : null}
          {selectedPeers.length ? (
            <div className={styles.selectedExtra}>
              <h4>相关资源</h4>
              <div className={styles.peerList}>
                {selectedPeers.map((p) => (
                  <button
                    key={p.asset_id}
                    type="button"
                    className={styles.peerChip}
                    onClick={() => setSelectedId(p.asset_id)}
                  >
                    {assetKindLabel(p.kind)} · {shortName(p.name)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {selected?.steps?.length || selected?.statement ? (
            <div className={styles.selectedExtra}>
              <h4>陈述 / 步骤</h4>
              {selected.statement ? (
                <div className={styles.statement}>
                  <LatexText text={selected.statement} as="div" />
                </div>
              ) : null}
              {selected.steps?.length ? (
                <ol className={styles.steps}>
                  {selected.steps.map((s, i) => (
                    <li key={i}>
                      <LatexText text={s} />
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
        </aside>
      }
    />
  );
}
