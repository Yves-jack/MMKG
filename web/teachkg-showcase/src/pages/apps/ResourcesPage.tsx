import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AppsChrome } from "@/components/apps/AppsChrome";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import {
  classifyKpKind,
  firstEvidenceSec,
  loadAllReviewPoints,
  loadImportanceScores,
  zhName,
  type KpKind,
} from "@/lib/apps/data";
import { reviewWatchPath } from "@/lib/apps/reviewSeek";
import { loadFocus, saveFocus } from "@/lib/apps/focus";
import {
  loadRecFeedback,
  loadRecResults,
  loadRecResultsIndex,
  saveRecResults,
  upsertRecFeedback,
  type RecFeedbackRating,
  type RecFeedbackStore,
} from "@/lib/apps/localDb";
import {
  applyFeedbackRerank,
  fetchExternalRecs,
  mergeRecItems,
  ratingForUrl,
  type ExternalRecItem,
  type ExternalRecKind,
} from "@/lib/apps/recommendSearch";
import { coursePath, useCourseId } from "@/lib/course";
import shell from "@/styles/shell.module.css";
import styles from "./Apps.module.css";
import r from "./Resources.module.css";

type ConceptItem = {
  kind: "concept";
  title: string;
  reason: string;
  href: string;
  lectureId: string;
  entityId: string;
  score: number;
  kpKind: KpKind;
  /** 课内释义，供相关度比对 */
  context: string;
};

const KIND_LABEL: Record<ExternalRecKind, string> = {
  web: "网页",
  video: "视频",
};

const KP_KINDS: Array<KpKind | "all"> = ["all", "原理", "技术", "定理"];

/** 1–5 课内贴合度说明 */
const RATING_DETAIL: Record<RecFeedbackRating, string> = {
  1: "很不相关",
  2: "较弱相关",
  3: "一般可用",
  4: "较贴合",
  5: "非常贴合",
};

function ratingCaption(rating: RecFeedbackRating | null) {
  if (rating == null) return null;
  return `${rating}/5 · ${RATING_DETAIL[rating]}`;
}

/** 右侧正文/简介摘录最大字数 */
const EXCERPT_MAX = 180;
/** 资源说明展示最大字数 */
const DESC_MAX = 260;

function clipText(s: string, max: number) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** 模糊检索用规范化：去空白与常见标点 */
function fuzzyNorm(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s·:：,，.。、\-_/（）()【】\[\]「」""'']+/g, "");
}

/**
 * 0–1：needle 对 haystack 的模糊匹配分。
 * 短查询只允许「紧凑」命中，避免在长释义里用隔很远的字拼出假阳性（如「欧拉」误中「哈夫曼」）。
 */
function fuzzyScore(haystack: string, needle: string): number {
  const h = fuzzyNorm(haystack);
  const n = fuzzyNorm(needle);
  if (!n) return 1;
  if (!h) return 0;
  if (h === n) return 1;
  if (h.includes(n)) {
    return 0.95 + Math.min(0.05, n.length / Math.max(h.length, 1));
  }

  // 子序列须紧凑：匹配跨度不能比查询长太多（「色定」→「四色定理」可以，「欧…拉」跨整段释义不行）
  let hi = 0;
  let first = -1;
  let subOk = true;
  for (const ch of n) {
    const idx = h.indexOf(ch, hi);
    if (idx < 0) {
      subOk = false;
      break;
    }
    if (first < 0) first = idx;
    hi = idx + 1;
  }
  if (subOk && first >= 0) {
    const span = hi - first;
    const maxSpan = Math.max(n.length + 2, Math.ceil(n.length * 2));
    if (span <= maxSpan) {
      return 0.75 + Math.min(0.15, n.length / Math.max(h.length, 1));
    }
  }

  // 字符袋/2-gram 仅用于短文本（标题级），长释义一律不走散字重合
  if (h.length > Math.max(16, n.length * 5)) return 0;

  const setH = new Set([...h]);
  let hit = 0;
  for (const ch of n) if (setH.has(ch)) hit += 1;
  const cover = hit / n.length;
  if (cover < 0.7) return 0;

  let biHit = 0;
  let biTotal = 0;
  if (n.length >= 2 && h.length >= 2) {
    const hBi = new Set<string>();
    for (let i = 0; i < h.length - 1; i++) hBi.add(h.slice(i, i + 2));
    for (let i = 0; i < n.length - 1; i++) {
      biTotal += 1;
      if (hBi.has(n.slice(i, i + 2))) biHit += 1;
    }
  }
  const bi = biTotal ? biHit / biTotal : 0;
  // 两字查询必须至少命中该 bigram，否则「欧+拉」散落也会过
  if (n.length <= 2 && bi < 1) return 0;
  const score = cover * 0.45 + bi * 0.55;
  return score >= 0.62 ? score * 0.78 : 0;
}

function conceptFuzzyScore(c: ConceptItem, query: string): number {
  const q = query.trim();
  if (!q) return 1;

  // 标题为主；释义只做整词包含，避免散字误伤
  const titleScore = fuzzyScore(c.title, q);
  const kindScore = fuzzyScore(c.kpKind, q) * 0.85;
  const lecScore = fuzzyScore(`第${c.lectureId}讲`, q);
  const n = fuzzyNorm(q);
  const ctx = fuzzyNorm(c.context.slice(0, 120));
  const ctxScore = n.length >= 2 && ctx.includes(n) ? 0.58 : 0;
  const reason = fuzzyNorm(c.reason);
  const reasonScore = n.length >= 2 && reason.includes(n) ? 0.55 : 0;

  let best = Math.max(titleScore, kindScore, lecScore, ctxScore, reasonScore);

  const parts = q.split(/[\s,，、+/]+/).filter((p) => fuzzyNorm(p).length >= 1);
  if (parts.length > 1) {
    let partHits = 0;
    for (const p of parts) {
      if (fuzzyScore(c.title, p) >= 0.7) partHits += 1;
    }
    best = Math.max(best, (partHits / parts.length) * 0.88);
  }
  return best;
}

/** 资源推荐：联网读取正文/视频简介，与知识点比对相关度 */
export function ResourcesPage() {
  const courseId = useCourseId() || "数理逻辑";
  const [concepts, setConcepts] = useState<ConceptItem[]>([]);
  const [kp, setKp] = useState<{
    lectureId: string;
    entityId: string;
    zh: string;
    kpKind: KpKind;
    context: string;
  } | null>(null);
  const [loadingConcepts, setLoadingConcepts] = useState(true);
  const [searching, setSearching] = useState(false);
  const [externals, setExternals] = useState<ExternalRecItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | ExternalRecKind>("all");
  const [kpFilter, setKpFilter] = useState<KpKind | "all">("all");
  const [kpQuery, setKpQuery] = useState("");
  const [feedback, setFeedback] = useState<RecFeedbackStore>({
    courseId,
    entries: [],
    updatedAt: 0,
  });
  const [focusRec, setFocusRec] = useState<ExternalRecItem | null>(null);
  const [cachedPoints, setCachedPoints] = useState<Set<string>>(new Set());
  const [fromCache, setFromCache] = useState(false);
  const [cacheAt, setCacheAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingConcepts(true);
      const [scores, points, fb, idx] = await Promise.all([
        loadImportanceScores(courseId),
        loadAllReviewPoints(courseId),
        loadRecFeedback(courseId),
        loadRecResultsIndex(courseId),
      ]);
      if (cancelled) return;
      setFeedback(fb);
      setCachedPoints(new Set(idx.points || []));

      const recs: ConceptItem[] = [];
      for (const { lectureId, point } of points) {
        const kpKind = classifyKpKind(point.zh) || classifyKpKind(point.id);
        if (!kpKind) continue;
        const prior = scores[point.id] ?? scores[zhName(point.id)] ?? 0;
        const score = point.importance * 0.7 + prior * 0.3;
        const context = String(point.definition || point.summary || "").trim();
        recs.push({
          kind: "concept",
          title: point.zh,
          reason: `${kpKind} · 第${lectureId}讲 · 重要性 ${point.importance.toFixed(2)}`,
          href: reviewWatchPath(courseId, lectureId, {
            kp: point.id,
            t: firstEvidenceSec(point.evidence),
          }),
          lectureId,
          entityId: point.id,
          score,
          kpKind,
          context,
        });
      }

      const seenZh = new Set(recs.map((r) => r.title));
      for (const [id, prior] of Object.entries(scores)) {
        const kpKind = classifyKpKind(id);
        if (!kpKind) continue;
        const title = zhName(id);
        if (!title || seenZh.has(title)) continue;
        const hit = points.find(
          (p) =>
            p.point.id === id || p.point.zh === title || zhName(p.point.id) === title
        );
        const lectureId = hit?.lectureId || "1";
        const entityId = hit?.point.id || id;
        recs.push({
          kind: "concept",
          title,
          reason: hit
            ? `${kpKind} · 第${lectureId}讲 · 图谱重要性 ${Number(prior).toFixed(3)}`
            : `${kpKind} · 图谱重要性 ${Number(prior).toFixed(3)}`,
          href: reviewWatchPath(courseId, lectureId, {
            kp: entityId,
            t: firstEvidenceSec(hit?.point.evidence),
          }),
          lectureId,
          entityId,
          score: Number(prior) || 0,
          kpKind,
          context: String(hit?.point.definition || hit?.point.summary || "").trim(),
        });
        seenZh.add(title);
      }

      const best = new Map<string, ConceptItem>();
      for (const r of recs.sort((a, b) => b.score - a.score)) {
        if (!best.has(r.title)) best.set(r.title, r);
      }
      const list = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 60);
      setConcepts(list);

      const pinned = loadFocus(courseId);
      const seed =
        (pinned &&
          list.find(
            (c) => c.entityId === pinned.entityId || c.title === pinned.zh
          )) ||
        list[0] ||
        null;
      if (seed) {
        setKp({
          lectureId: seed.lectureId,
          entityId: seed.entityId,
          zh: seed.title,
          kpKind: seed.kpKind,
          context: seed.context,
        });
      } else {
        setKp(null);
      }
      setLoadingConcepts(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const applyBundle = useCallback(
    (
      items: ExternalRecItem[],
      meta: {
        error?: string;
        cached: boolean;
        fetchedAt?: number;
        knowledgePoint: string;
      },
      fb: RecFeedbackStore
    ) => {
      setError(meta.error || null);
      setExternals(items);
      setFromCache(meta.cached);
      setCacheAt(meta.fetchedAt ?? null);
      setFeedback(fb);
      const rankedNow = applyFeedbackRerank(items, fb, meta.knowledgePoint);
      setFocusRec(rankedNow[0] || null);
    },
    []
  );

  const runSearch = useCallback(
    async (force: boolean, signal?: { cancelled: boolean }) => {
      if (!kp?.zh) {
        setExternals([]);
        setFocusRec(null);
        setFromCache(false);
        setCacheAt(null);
        return;
      }
      const kpZh = kp.zh;
      const entityId = kp.entityId;
      const context = kp.context;
      setError(null);
      setSearching(true);

      // 切换知识点时清空；重新检索则保留当前列表，避免闪空
      if (!force) {
        setExternals([]);
        setFocusRec(null);
        setFromCache(false);
        setCacheAt(null);
      }

      try {
        const cached = await loadRecResults(courseId, kpZh);
        if (signal?.cancelled) return;
        const prevItems = (cached?.items || []) as ExternalRecItem[];

        if (!force && prevItems.length) {
          const fb = await loadRecFeedback(courseId);
          if (signal?.cancelled) return;
          applyBundle(
            prevItems,
            {
              cached: true,
              fetchedAt: cached?.fetchedAt,
              knowledgePoint: kpZh,
            },
            fb
          );
          setSearching(false);
          return;
        }

        // 重新检索时若 UI 已空，先回填数据库里的旧结果
        if (force && prevItems.length) {
          setExternals(prevItems);
          setFromCache(true);
          setCacheAt(cached?.fetchedAt ?? null);
        }

        const res = await fetchExternalRecs({
          query: kpZh,
          knowledgePoint: kpZh,
          context,
        });
        if (signal?.cancelled) return;
        const fresh = res.items || [];
        // 重新检索：与库内已有结果去重合并；首次检索直接用新结果
        const items = force ? mergeRecItems(prevItems, fresh) : fresh;
        const fb = await loadRecFeedback(courseId);
        if (signal?.cancelled) return;
        applyBundle(
          items,
          {
            error: res.error,
            cached: force && prevItems.length > 0,
            fetchedAt: Date.now(),
            knowledgePoint: kpZh,
          },
          fb
        );
        if (items.length) {
          const prevProviders = cached?.providers || [];
          await saveRecResults(courseId, {
            knowledgePoint: kpZh,
            entityId,
            items,
            providers: [...new Set([...prevProviders, ...(res.providers || [])])],
            notice: null,
          });
          if (signal?.cancelled) return;
          setCachedPoints((prev) => {
            const next = new Set(prev);
            next.add(kpZh);
            return next;
          });
          setCacheAt(Date.now());
          setFromCache(true);
        }
      } catch (e) {
        if (signal?.cancelled) return;
        setError(String((e as Error)?.message || e));
        // 重新检索失败时不抹掉已有展示
        if (!force) {
          setExternals([]);
          setFocusRec(null);
          setFromCache(false);
        }
      } finally {
        if (!signal?.cancelled) setSearching(false);
      }
    },
    [applyBundle, courseId, kp]
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void runSearch(false, signal);
    return () => {
      signal.cancelled = true;
    };
  }, [courseId, kp?.zh, kp?.entityId, runSearch]);

  const visibleConcepts = useMemo(() => {
    const q = kpQuery.trim();
    const byKind =
      kpFilter === "all"
        ? concepts
        : concepts.filter((c) => c.kpKind === kpFilter);
    if (!q) return byKind;
    return byKind
      .map((c) => ({ c, score: conceptFuzzyScore(c, q) }))
      .filter((x) => x.score >= 0.58)
      .sort((a, b) => b.score - a.score || b.c.score - a.c.score)
      .map((x) => x.c);
  }, [concepts, kpFilter, kpQuery]);

  const ranked = useMemo(() => {
    if (!kp) return [];
    const base = applyFeedbackRerank(externals, feedback, kp.zh);
    if (filter === "all") return base;
    return base.filter((i) => i.kind === filter);
  }, [externals, feedback, kp, filter]);

  useEffect(() => {
    if (!ranked.length) {
      setFocusRec(null);
      return;
    }
    setFocusRec((prev) => {
      if (prev && ranked.some((r) => r.url === prev.url)) return prev;
      return ranked[0];
    });
  }, [ranked]);

  const selectConcept = (c: ConceptItem) => {
    if (kp?.entityId === c.entityId && kp?.zh === c.title) return;
    setExternals([]);
    setFocusRec(null);
    setError(null);
    setFromCache(false);
    setCacheAt(null);
    setSearching(true);
    setKp({
      lectureId: c.lectureId,
      entityId: c.entityId,
      zh: c.title,
      kpKind: c.kpKind,
      context: c.context,
    });
    saveFocus(courseId, {
      lectureId: c.lectureId,
      entityId: c.entityId,
      zh: c.title,
    });
  };

  const onRate = async (it: ExternalRecItem, rating: RecFeedbackRating) => {
    if (!kp) return;
    const current = ratingForUrl(feedback, it.url, kp.zh);
    const store = await upsertRecFeedback(courseId, {
      url: it.url,
      domain: it.domain,
      knowledgePoint: kp.zh,
      // 再点同一分取消评分
      rating: current === rating ? null : rating,
    });
    setFeedback(store);
  };

  const cacheHint = useMemo(() => {
    if (!fromCache || !cacheAt) return null;
    try {
      return `已保存 · ${new Date(cacheAt).toLocaleString()}`;
    } catch {
      return "已保存本地结果";
    }
  }, [fromCache, cacheAt]);

  return (
    <ResizableShell
      storagePrefix="shell-app-resources"
      detailInitialRightPx={320}
      nav={
        <aside className={shell.sidebar}>
          <div className={shell.sideHead}>
            <Link className={shell.back} to={coursePath(courseId)}>
              <span className={shell.backIcon}>←</span>
              <span className={shell.backBrand}>
                Teach<em>KG</em>
              </span>
            </Link>
            <p className={shell.eyebrow}>推荐</p>
            <p className={shell.sideLead}>按知识点检索外链</p>
          </div>
          <div className={r.navTools}>
            <div className={r.navFilterRow}>
              {KP_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={kpFilter === k ? styles.chipActive : styles.chip}
                  onClick={() => setKpFilter(k)}
                >
                  {k === "all" ? "全部" : k}
                </button>
              ))}
            </div>
            <input
              className={r.navSearch}
              value={kpQuery}
              placeholder="搜索知识点…"
              onChange={(e) => setKpQuery(e.target.value)}
              aria-label="检索知识点"
            />
          </div>
          {loadingConcepts && <p className={r.emptyNav}>加载知识点…</p>}
          {!loadingConcepts && visibleConcepts.length === 0 && (
            <p className={r.emptyNav}>
              {kpQuery.trim() ? "无匹配知识点" : "暂无原理/技术/定理类知识点"}
            </p>
          )}
          <ul className={r.navList}>
            {visibleConcepts.map((c) => {
              const on = kp?.entityId === c.entityId || kp?.zh === c.title;
              const saved = cachedPoints.has(c.title);
              return (
                <li key={c.entityId + c.title}>
                  <button
                    type="button"
                    className={on ? r.navItemOn : r.navItem}
                    onClick={() => selectConcept(c)}
                    title={c.reason}
                  >
                    <span className={r.navItemTitle}>
                      <span className={styles.kpKindTag}>{c.kpKind}</span>
                      {c.title}
                    </span>
                    <span className={r.navItemMeta}>
                      {saved ? <span className={r.savedDot} title="已保存推荐" /> : null}
                      第{c.lectureId}讲
                      {saved ? " · 已存" : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      }
      main={
        <main className={styles.page}>
          <AppsChrome
            courseId={courseId}
            lectureId={kp?.lectureId}
            title="资源推荐"
            extra={
              kp ? (
                <button
                  type="button"
                  className={styles.ghostBtn}
                  disabled={searching}
                  onClick={() => void runSearch(true)}
                >
                  {searching ? "检索中…" : "重新检索"}
                </button>
              ) : null
            }
          />
          <div className={styles.body}>
            <div className={styles.panel}>
              <div className={r.kpBlock}>
                <p className={styles.headLabel}>当前知识点</p>
                {kp ? (
                  <>
                    <h3>
                      <span className={styles.kpKindTag}>{kp.kpKind}</span>
                      {kp.zh}
                    </h3>
                    {kp.context ? <p>{clipText(kp.context, 160)}</p> : null}
                  </>
                ) : (
                  <p className={styles.empty}>请选择左侧知识点</p>
                )}
              </div>

              <div className={r.sectionHead}>
                <p className={r.sectionHeadLabel}>推荐资源</p>
                {cacheHint && !searching ? (
                  <p className={r.metaHint}>{cacheHint}</p>
                ) : null}
              </div>
              <div className={styles.filterRow}>
                {(["all", "web", "video"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={filter === k ? styles.chipActive : styles.chip}
                    onClick={() => setFilter(k)}
                  >
                    {k === "all" ? "全部" : KIND_LABEL[k]}
                  </button>
                ))}
              </div>

              {searching && (
                <p className={r.statusLine}>正在检索「{kp?.zh}」相关资源…</p>
              )}
              {error && <p className={styles.warn}>{error}</p>}

              {!searching && ranked.length === 0 && kp && (
                <p className={styles.empty}>
                  暂无可用资源。可点「重新检索」或换知识点。
                </p>
              )}

              <ul className={r.list}>
                {ranked.map((it) => {
                  const rating = kp ? ratingForUrl(feedback, it.url, kp.zh) : null;
                  const on = focusRec?.url === it.url;
                  return (
                    <li key={it.url} className={on ? r.itemOn : r.item}>
                      <button
                        type="button"
                        className={r.pick}
                        title="单击查看说明 · 双击打开资源"
                        onClick={() => setFocusRec(it)}
                        onDoubleClick={() => {
                          window.open(it.url, "_blank", "noopener,noreferrer");
                        }}
                      >
                        <span className={r.pickTop}>
                          <span className={r.kindBadge}>{KIND_LABEL[it.kind]}</span>
                          {typeof it.relevance === "number" ? (
                            <span className={r.relBadge}>
                              相关 {Math.round(it.relevance * 100)}%
                            </span>
                          ) : null}
                          {rating != null ? (
                            <span className={r.relBadge}>
                              {ratingCaption(rating)}
                            </span>
                          ) : null}
                        </span>
                        <span className={r.itemTitle}>{it.title}</span>
                        {it.tags && it.tags.length > 0 ? (
                          <span className={r.tags}>
                            {it.tags.map((t) => (
                              <em key={t} className={r.tag}>
                                {t}
                              </em>
                            ))}
                          </span>
                        ) : null}
                        <span className={r.pickHint}>双击打开</span>
                      </button>
                      <div
                        className={r.rateBox}
                        title="按课内贴合度打分；再点同一档可取消"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className={r.rateLabel}>贴合度</span>
                        <div className={r.rateRow}>
                          {([1, 2, 3, 4, 5] as const).map((n) => (
                            <button
                              key={n}
                              type="button"
                              className={
                                rating === n ? r.rateBtnOn : r.rateBtn
                              }
                              title={`${n} 分 · ${RATING_DETAIL[n]}`}
                              aria-label={`${n} 分，${RATING_DETAIL[n]}`}
                              aria-pressed={rating === n}
                              onClick={() => void onRate(it, n)}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                        <span className={r.rateHint}>
                          {rating != null
                            ? RATING_DETAIL[rating]
                            : "1 很不相关 · 5 非常贴合"}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </main>
      }
      detail={
        <aside className={styles.panelAside} aria-label="资源说明">
          <p className={styles.headLabel}>资源说明</p>
          {focusRec ? (
            <div>
              <p className={r.asideMeta}>
                <span className={r.kindBadge}>{KIND_LABEL[focusRec.kind]}</span>
                {typeof focusRec.relevance === "number" ? (
                  <span className={r.relBadge}>
                    相关 {Math.round(focusRec.relevance * 100)}%
                  </span>
                ) : null}
                {kp && ratingForUrl(feedback, focusRec.url, kp.zh) != null ? (
                  <span className={r.relBadge}>
                    {ratingCaption(ratingForUrl(feedback, focusRec.url, kp.zh))}
                  </span>
                ) : null}
              </p>
              {kp ? (
                <div className={r.rateBox} style={{ alignItems: "flex-start", marginBottom: 12 }}>
                  <span className={r.rateLabel}>课内贴合度</span>
                  <div className={r.rateRow}>
                    {([1, 2, 3, 4, 5] as const).map((n) => {
                      const rating = ratingForUrl(feedback, focusRec.url, kp.zh);
                      return (
                        <button
                          key={n}
                          type="button"
                          className={rating === n ? r.rateBtnOn : r.rateBtn}
                          title={`${n} 分 · ${RATING_DETAIL[n]}`}
                          aria-label={`${n} 分，${RATING_DETAIL[n]}`}
                          onClick={() => void onRate(focusRec, n)}
                        >
                          {n}
                        </button>
                      );
                    })}
                  </div>
                  <span className={r.rateHint} style={{ textAlign: "left", maxWidth: "100%" }}>
                    {(() => {
                      const rating = ratingForUrl(feedback, focusRec.url, kp.zh);
                      return rating != null
                        ? `当前：${rating} 分 · ${RATING_DETAIL[rating]}（再点可取消）`
                        : "1 很不相关 · 2 较弱 · 3 一般 · 4 较贴合 · 5 非常贴合";
                    })()}
                  </span>
                </div>
              ) : null}
              {focusRec.tags && focusRec.tags.length > 0 ? (
                <div className={r.tags} style={{ marginBottom: 10 }}>
                  {focusRec.tags.map((t) => (
                    <em key={t} className={r.tag}>
                      {t}
                    </em>
                  ))}
                </div>
              ) : null}
              <h3 className={r.asideTitle}>{focusRec.title}</h3>
              <p className={r.asideBody}>
                {clipText(
                  focusRec.description ||
                    focusRec.snippet ||
                    "暂无生成说明。双击主区资源可直接打开。",
                  DESC_MAX
                )}
              </p>
              {focusRec.content ? (
                <>
                  <p className={styles.headLabel}>
                    {focusRec.kind === "video" ? "视频简介摘录" : "正文摘录"}
                  </p>
                  <p className={r.excerpt}>
                    {clipText(focusRec.content, EXCERPT_MAX)}
                  </p>
                </>
              ) : null}
              <p className={styles.mutedNote}>双击主区条目即可打开资源</p>
            </div>
          ) : (
            <p className={styles.empty}>
              {searching ? "正在生成资源说明…" : "单击资源查看说明，双击打开"}
            </p>
          )}
        </aside>
      }
    />
  );
}
