import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { MultiEvidenceHighlight } from "@/components/graph/MultiEvidenceHighlight";
import { ResizableShell } from "@/components/graph/ResizableShell";
import { LatexText } from "@/components/graph/LatexText";
import {
  assetChapterNames,
  assetKindLabel,
  assetRoleLabel,
  assetReviewSeek,
  compareAssetsByAppearance,
  ensureAssetsLibraryIndexes,
  findPeerAssets,
  groupChaptersByPart,
  type AssetCard,
  type AssetsLibrary,
} from "@/lib/kg/assetsLibrary";
import {
  patchCardInLibrary,
  removeCardFromLibrary,
  saveAssetsLibrary,
} from "@/lib/kg/assetsLibraryApi";
import { WatchClassroom } from "@/components/review/WatchClassroom";
import { loadManifest } from "@/lib/catalog";
import { courseDataUrl, coursePath, useCourseId } from "@/lib/course";
import type { PipelinePayload } from "@/lib/graph/types";
import shell from "@/styles/shell.module.css";
import styles from "./AssetsPage.module.css";

const KIND_OPTIONS = [
  "principle",
  "theorem",
  "technique",
  "formula",
  "example",
] as const;

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

function cardsForChapter(library: AssetsLibrary | null, chapter: string): AssetCard[] {
  if (!library?.cards?.length || !chapter) return [];
  const indexed = new Set(library.index_by_chapter?.[chapter] || []);
  return library.cards
    .filter((c) => {
      if (c.source !== "llm") return false;
      if (indexed.size && indexed.has(c.asset_id)) return true;
      return assetChapterNames(c).includes(chapter);
    })
    .slice()
    .sort(compareAssetsByAppearance);
}

export function AssetsPage() {
  const courseId = useCourseId();
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
  const [lectureNavOpen, setLectureNavOpen] = useState(true);
  const [chapterNavOpen, setChapterNavOpen] = useState(true);
  const [partOpen, setPartOpen] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<{ type: "lecture" | "chapter"; key: string }>(
    () => ({ type: "lecture", key: "" })
  );
  const [editMode, setEditMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
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
        lib && Array.isArray(lib.cards)
          ? ensureAssetsLibraryIndexes(lib as AssetsLibrary)
          : null;
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
    setView({ type: "lecture", key: lectureId });
  }, [lectureId]);

  useEffect(() => {
    if (!lectureId) return;
    if (rawId && rawId !== lectureId && /^(?:lecture[_-])?\d+$/i.test(rawId)) {
      navigate(coursePath(courseId, `/assets/${lectureId}`), { replace: true });
      return;
    }
    if (view.type === "chapter") {
      setLoading(false);
      setChunks([]);
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
          // 资源库正文：优先 fluency（通畅口播），再 asr，最后 extract
          const text = String(
            it.fluency_text || it.asr_text || it.extract_text || "",
          ).trim();
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
  }, [courseId, lectureId, rawId, navigate, view.type]);

  const scopeCards = useMemo(() => {
    if (view.type === "chapter") return cardsForChapter(library, view.key);
    return cardsForLecture(library, lectureId);
  }, [library, lectureId, view]);

  const filteredCards = useMemo(() => {
    if (kindFilter === "all") return scopeCards;
    return scopeCards.filter((c) => c.kind === kindFilter);
  }, [scopeCards, kindFilter]);

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
  const selectedWatchLec = String(selected?.grounding?.lecture_id || lectureId || "");
  const selectedWatch = selected ? assetReviewSeek(selected, selectedWatchLec) : null;
  const selectedPeers = useMemo(
    () =>
      findPeerAssets(library, selected, {
        lectureId: view.type === "lecture" ? lectureId : undefined,
        lectureOnly: view.type === "lecture",
        maxItems: 8,
      }),
    [library, selected, lectureId, view.type]
  );

  const lectureNav = useMemo(() => {
    const set = new Set<string>([...readyLectures, ...assetLectures]);
    if (lectureId) set.add(lectureId);
    const list = [...set].sort((a, b) => Number(a) - Number(b));
    if (list.length) return list;
    return Array.from({ length: 44 }, (_, i) => String(i + 1));
  }, [readyLectures, assetLectures, lectureId]);

  const chapterNav = useMemo(() => {
    const names = new Set<string>();
    for (const k of Object.keys(library?.index_by_chapter || {})) {
      if (k.trim()) names.add(k.trim());
    }
    for (const c of library?.cards || []) {
      if (c.source !== "llm") continue;
      for (const name of assetChapterNames(c)) names.add(name);
    }
    // 目录里有、暂无资产的章也展示，便于规划
    for (const part of library?.chapter_catalog?.parts || []) {
      for (const ch of part.chapters || []) {
        const n = String(ch.name || "").trim();
        if (n) names.add(n);
      }
    }
    return groupChaptersByPart([...names], library?.chapter_catalog);
  }, [library]);

  const chapterCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const part of chapterNav) {
      for (const name of part.chapters) {
        m.set(name, cardsForChapter(library, name).length);
      }
    }
    return m;
  }, [chapterNav, library]);

  useEffect(() => {
    if (!chapterNav.length) return;
    setPartOpen((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const p of chapterNav) {
        if (next[p.id] === undefined) {
          next[p.id] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [chapterNav]);

  const kindCounts = useMemo(() => {
    const c = { principle: 0, theorem: 0, technique: 0, formula: 0, example: 0 };
    for (const card of scopeCards) {
      if (card.kind === "principle") c.principle += 1;
      else if (card.kind === "theorem") c.theorem += 1;
      else if (card.kind === "technique") c.technique += 1;
      else if (card.kind === "formula") c.formula += 1;
      else if (card.kind === "example") c.example += 1;
    }
    return c;
  }, [scopeCards]);

  if (!lectureId) {
    const first = lectureNav[0] || "1";
    return <Navigate to={coursePath(courseId, `/assets/${first}`)} replace />;
  }

  const goLecture = (id: string) => {
    setView({ type: "lecture", key: id });
    setSelectedId(null);
    setKindFilter("all");
    navigate(coursePath(courseId, `/assets/${id}`));
  };

  const goChapter = (name: string) => {
    setView({ type: "chapter", key: name });
    setSelectedId(null);
    setKindFilter("all");
    setChunks([]);
  };

  const updateCard = (assetId: string, patch: Partial<AssetCard>) => {
    setLibrary((prev) => {
      if (!prev) return prev;
      return patchCardInLibrary(prev, assetId, patch);
    });
    setDirty(true);
    setSaveMsg(null);
  };

  const deleteCard = (assetId: string) => {
    if (!window.confirm("删除该资产卡片？未保存前可刷新页面撤销。")) return;
    setLibrary((prev) => {
      if (!prev) return prev;
      return removeCardFromLibrary(prev, assetId);
    });
    setSelectedId((cur) => (cur === assetId ? null : cur));
    setDirty(true);
    setSaveMsg(null);
  };

  const handleSave = async () => {
    if (!library || !courseId || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const next = await saveAssetsLibrary(courseId, library);
      setLibrary(next);
      setDirty(false);
      setSaveMsg("已保存");
      const withAssets = new Set<string>();
      for (const c of next.cards || []) {
        if (c.source !== "llm") continue;
        const lid = c.grounding?.lecture_id;
        if (lid != null && String(lid) !== "") withAssets.add(String(lid));
      }
      setAssetLectures(withAssets);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const scopeTitle =
    view.type === "chapter" ? view.key : `第 ${lectureId} 讲 · 合并课堂文本`;
  const detailTitle = view.type === "chapter" ? "本章资产" : "本讲资产";
  const emptyCardsHint =
    view.type === "chapter" ? "本章暂无大模型抽取资产" : "本讲暂无大模型抽取资产";

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
                Edu<em>KG</em>
              </span>
            </Link>
            <p className={shell.eyebrow}>Assets</p>
            <h1 className={shell.sideTitle}>课程资产</h1>
          </div>

          <div
            className={`${shell.navBlock} ${shell.navBlockCollapsible} ${
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
                {lectureNav.map((id) => {
                  const ready = readyLectures.has(id);
                  const hasAssets = assetLectures.has(id);
                  const active = view.type === "lecture" && lectureId === id;
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
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div
            className={`${shell.navBlock} ${shell.navBlockGrow} ${
              chapterNavOpen ? "" : shell.navBlockCollapsed
            }`}
          >
            <button
              type="button"
              className={shell.navLabelToggle}
              aria-expanded={chapterNavOpen}
              onClick={() => setChapterNavOpen((v) => !v)}
            >
              <span>章节</span>
              <em>
                {chapterNavOpen
                  ? "收起"
                  : "展开"}
              </em>
            </button>
            {chapterNavOpen ? (
              <div className={shell.navScroll}>
                {!chapterNav.length ? (
                  <p className={styles.navEmpty}>暂无章节索引</p>
                ) : (
                  chapterNav.map((part) => {
                    const open = partOpen[part.id] !== false;
                    return (
                      <div key={part.id} className={styles.partGroup}>
                        <button
                          type="button"
                          className={styles.partToggle}
                          aria-expanded={open}
                          onClick={() =>
                            setPartOpen((prev) => ({
                              ...prev,
                              [part.id]: !open,
                            }))
                          }
                        >
                          <span>{part.title}</span>
                          <em>
                            {open ? "收起" : "展开"}
                          </em>
                        </button>
                        {open
                          ? part.chapters.map((name) => {
                              const n = chapterCounts.get(name) || 0;
                              const active =
                                view.type === "chapter" && view.key === name;
                              return (
                                <button
                                  key={name}
                                  type="button"
                                  className={
                                    active ? shell.navItemActive : shell.navItem
                                  }
                                  onClick={() => goChapter(name)}
                                  title={`${part.title} · ${name}${n ? ` · ${n} 条` : ""}`}
                                >
                                  <span>{name}</span>
                                </button>
                              );
                            })
                          : null}
                      </div>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
        </aside>
      }
      main={
        <main className={styles.mainCol}>
          <header className={shell.topbar}>
            <div className={shell.topbarText}>
              <h2>{scopeTitle}</h2>
            </div>
            <div className={shell.stats}>
              <div>
                <strong>
                  {view.type === "chapter" ? "—" : chunks.length || "—"}
                </strong>
                <span>片段</span>
              </div>
              <div>
                <strong>{scopeCards.length}</strong>
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
            {view.type === "chapter" ? (
              <div className={styles.empty}>
                章节视图：右侧浏览「{view.key}」下的资产卡片；点讲次可回到课堂合并文本。
              </div>
            ) : loading ? (
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
            <div className={styles.detailHeadRow}>
              <h3>{detailTitle}</h3>
              <div className={styles.editBar}>
                <label className={editMode ? styles.editToggleOn : styles.editToggle}>
                  <input
                    type="checkbox"
                    checked={editMode}
                    onChange={(e) => setEditMode(e.target.checked)}
                  />
                  编辑
                </label>
                <button
                  type="button"
                  className={styles.saveBtn}
                  disabled={!dirty || saving || !library}
                  onClick={() => void handleSave()}
                >
                  {saving ? "保存中…" : dirty ? "保存" : "已保存"}
                </button>
              </div>
            </div>
            {saveMsg ? (
              <p className={dirty ? styles.saveErr : styles.saveOk}>{saveMsg}</p>
            ) : null}
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
              <div className={styles.empty}>{emptyCardsHint}</div>
            ) : (
              filteredCards.map((card) => {
                const active = card.asset_id === selectedId;
                return (
                  <div
                    key={card.asset_id}
                    role="button"
                    tabIndex={0}
                    data-asset-id={card.asset_id}
                    className={active ? styles.cardActive : styles.card}
                    onClick={() => setSelectedId(card.asset_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(card.asset_id);
                      }
                    }}
                  >
                    <div className={styles.cardHead}>
                      {editMode && active ? (
                        <select
                          className={styles.kindSelect}
                          value={
                            KIND_OPTIONS.includes(card.kind as (typeof KIND_OPTIONS)[number])
                              ? card.kind
                              : "principle"
                          }
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            updateCard(card.asset_id, { kind: e.target.value })
                          }
                        >
                          {KIND_OPTIONS.map((k) => (
                            <option key={k} value={k}>
                              {assetKindLabel(k)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={styles.kindBadge}>{assetKindLabel(card.kind)}</span>
                      )}
                      {editMode && active ? (
                        <input
                          className={styles.nameInput}
                          value={card.name || ""}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            updateCard(card.asset_id, { name: e.target.value })
                          }
                        />
                      ) : (
                        <strong>{shortName(card.name)}</strong>
                      )}
                      {editMode ? (
                        <button
                          type="button"
                          className={styles.deleteBtn}
                          title="删除卡片"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteCard(card.asset_id);
                          }}
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                    {editMode && active ? (
                      <textarea
                        className={styles.fieldArea}
                        rows={2}
                        placeholder="摘要"
                        value={card.summary || ""}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          updateCard(card.asset_id, { summary: e.target.value })
                        }
                      />
                    ) : card.summary ? (
                      <div className={styles.cardSummary}>
                        <LatexText text={card.summary} />
                      </div>
                    ) : null}
                    {editMode && active && card.kind === "formula" ? (
                      <input
                        className={styles.nameInput}
                        placeholder="LaTeX"
                        value={card.latex || ""}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          updateCard(card.asset_id, { latex: e.target.value })
                        }
                      />
                    ) : card.kind === "formula" && (card.latex || "").trim() ? (
                      <div className={styles.cardLatex}>
                        <LatexText text={`$${card.latex}$`} />
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
                  </div>
                );
              })
            )}
          </div>

          {selectedWatch && !editMode ? (
            <div className={styles.selectedExtra}>
              <WatchClassroom
                courseId={courseId}
                lectureId={selectedWatch.lectureId}
                startSec={selectedWatch.startSec}
                entityId={selectedWatch.entityId}
              />
            </div>
          ) : null}
          {selectedPeers.length && !editMode ? (
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
          {selected && editMode ? (
            <div className={styles.selectedExtra}>
              <h4>陈述 / 步骤 / 依据</h4>
              <textarea
                className={styles.fieldArea}
                rows={3}
                placeholder="陈述 / 结论"
                value={selected.statement || ""}
                onChange={(e) =>
                  updateCard(selected.asset_id, { statement: e.target.value })
                }
              />
              <textarea
                className={styles.fieldArea}
                rows={4}
                placeholder="步骤（每行一条）"
                value={(selected.steps || []).join("\n")}
                onChange={(e) =>
                  updateCard(selected.asset_id, {
                    steps: e.target.value
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
              <textarea
                className={styles.fieldArea}
                rows={3}
                placeholder="原文依据（编辑用，卡片不展示）"
                value={selected.evidence || ""}
                onChange={(e) =>
                  updateCard(selected.asset_id, { evidence: e.target.value })
                }
              />
            </div>
          ) : selected?.steps?.length || selected?.statement ? (
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
