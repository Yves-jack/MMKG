import { useEffect, useRef, useState } from "react";
import { LatexText } from "@/components/graph/LatexText";
import type { AppReviewPoint } from "@/lib/review/data";
import {
  clearLectureNotesCache,
  loadLectureNotesCache,
  saveLectureNotesCache,
} from "@/lib/review/localDb";
import {
  attachSectionEntities,
  buildLocalLectureNotes,
  conceptSections,
  fetchLectureNotes,
  isLectureNotes,
  peekLectureNotesCache,
  pickSectionForFocus,
  type LectureNoteSection,
  type LectureNotesDoc,
  type NoteBlock,
  type NoteBlockType,
} from "@/lib/review/reviewNotes";
import styles from "./LectureStudyNotes.module.css";

const BLOCK_FALLBACK_LABEL: Record<NoteBlockType, string> = {
  hook: "说明",
  def: "定义",
  fact: "性质",
  example: "例",
  pitfall: "注",
  cue: "自测",
};

function sectionMatches(
  sec: LectureNoteSection,
  focusId: string | null,
  focusZh: string | null
) {
  const id = (focusId || "").trim();
  const f = (focusZh || "").trim();
  if (id && (sec.entityIds || []).includes(id)) return true;
  if (id && (sec.related || []).includes(id)) return true;
  if (!f) return false;
  if (sec.title === f) return true;
  return (sec.related || []).some((r) => r === f);
}

function polishOverview(text: string): string {
  return String(text || "")
    .replace(/本次课为单课复习[，,]?\s*/g, "本次课")
    .replace(/本次课\s*聚焦/g, "本次课聚焦")
    .trim();
}

/** 去掉「一、」「（一）」等中文序标，避免与「第 N 部分」重复 */
function stripCnOrdinalPrefix(text: string): string {
  return String(text || "")
    .replace(/^[（(]?[一二三四五六七八九十百千零〇]+[)）]?[、.．:：]\s*/u, "")
    .trim();
}

function NoteBlocks({ blocks }: { blocks: NoteBlock[] }) {
  const visible = blocks.filter((b) => b.type !== "def");
  if (!visible.length) return null;
  return (
    <div className={styles.blocks}>
      {visible.map((b, i) => (
        <div
          key={`${b.type}-${i}`}
          className={styles.block}
          data-type={b.type}
        >
          <span className={styles.blockLabel}>
            {b.label || BLOCK_FALLBACK_LABEL[b.type] || b.type}
          </span>
          <div className={styles.blockText}>
            <LatexText text={b.text} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PartBody({ body }: { body: string }) {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) return null;
  return (
    <div className={styles.partBody}>
      {paras.map((p, i) => (
        <p key={i}>
          <LatexText text={p} />
        </p>
      ))}
    </div>
  );
}

type Props = {
  courseId: string;
  lectureId: string;
  title?: string;
  points: AppReviewPoint[];
  focusId?: string | null;
  focusZh?: string | null;
  /** 为 true 时不打笔记网络接口，只用本地缓存/本地稿，避免与视频抢连接 */
  deferNetwork?: boolean;
  onCollapse?: () => void;
};

export function LectureStudyNotes({
  courseId,
  lectureId,
  title,
  points,
  focusId = null,
  focusZh = null,
  deferNetwork = false,
}: Props) {
  const [notes, setNotes] = useState<LectureNotesDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showBackTop, setShowBackTop] = useState(false);
  const genRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const applyDoc = (doc: LectureNotesDoc) => {
    const cleaned: LectureNotesDoc = {
      ...doc,
      overview: polishOverview(doc.overview || ""),
      themes: [],
      outline:
        doc.outline?.length
          ? doc.outline
          : (doc.sections || []).map((s) => s.title),
      sections: conceptSections(doc.sections || []).map((s) => ({
        ...s,
        blocks: (s.blocks || []).filter((b) => b.type !== "def"),
      })),
    };
    const attached = attachSectionEntities(cleaned, points);
    setNotes(attached);
    const ids = attached.sections.map((s) => s.id);
    // 讲义阅读：默认全部展开
    setOpenIds(new Set(ids));
    setActiveId(ids[0] || null);
  };

  const load = async (force: boolean) => {
    if (!points.length) {
      setNotes(null);
      return;
    }
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    if (force) {
      setNotes(null);
      try {
        await clearLectureNotesCache(courseId, lectureId);
      } catch {
        /* continue */
      }
    }

    try {
      if (!force) {
        // 始终先读服务端落盘稿（GET 很轻）；deferNetwork 只避免顺带触发 LLM 重生成
        const peeked = await peekLectureNotesCache({
          courseId,
          lectureId,
          points,
        });
        if (gen !== genRef.current) return;
        if (peeked) {
          applyDoc(peeked);
          await saveLectureNotesCache(courseId, lectureId, peeked);
          return;
        }
        const cached = await loadLectureNotesCache(courseId, lectureId);
        const cachedNotes = cached?.notes as LectureNotesDoc | undefined;
        // 丢弃「本地整理」回退稿，避免课名 + 等历史失败后永久卡住错误大纲
        if (
          isLectureNotes(cachedNotes) &&
          cachedNotes.source !== "local" &&
          !String(cachedNotes.subtitle || "").includes("本地整理")
        ) {
          if (gen !== genRef.current) return;
          applyDoc(cachedNotes);
          return;
        }
        if (cachedNotes) {
          try {
            await clearLectureNotesCache(courseId, lectureId);
          } catch {
            /* ignore */
          }
        }
        // 视频未就绪时先不拼本地大纲，等 deferNetwork 解除后再试（避免「一、图论等」脏缓存）
        if (deferNetwork) {
          setNotes(null);
          return;
        }
        const local = buildLocalLectureNotes({
          courseId,
          lectureId,
          title,
          points,
        });
        applyDoc(local);
        await saveLectureNotesCache(courseId, lectureId, local);
        return;
      }

      const doc = await fetchLectureNotes({
        courseId,
        lectureId,
        title,
        points,
        force,
      });
      if (gen !== genRef.current) return;
      applyDoc(doc);
      await saveLectureNotesCache(courseId, lectureId, doc);
      if (doc.source === "local") {
        setError(
          doc.subtitle?.includes("生成失败") || doc.subtitle?.includes("未配置")
            ? doc.subtitle
            : doc.subtitle || "已重新生成本地笔记（大模型不可用）",
        );
      } else if (doc.source === "disk") {
        setError("服务端仍返回缓存稿；若内容未变可再点一次重新生成");
      } else {
        setError(`已重新生成（${doc.model || "大模型"}）`);
      }
    } catch (e) {
      if (gen !== genRef.current) return;
      const local = buildLocalLectureNotes({ courseId, lectureId, title, points });
      applyDoc(local);
      setError(String((e as Error)?.message || e));
      await saveLectureNotesCache(courseId, lectureId, local);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
    return () => {
      genRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when lecture/points/network gate change
  }, [courseId, lectureId, points.length, deferNetwork]);

  useEffect(() => {
    if (!notes || (!focusId && !focusZh)) return;
    const sec =
      pickSectionForFocus(notes, focusId, focusZh) ||
      notes.sections.find((s) => sectionMatches(s, focusId, focusZh));
    if (!sec) return;
    setActiveId(sec.id);
    setOpenIds((prev) => {
      const next = new Set(prev);
      next.add(sec.id);
      return next;
    });
    requestAnimationFrame(() => {
      const root = scrollRef.current;
      if (!root) return;
      const el = root.querySelector(`[data-sec="${sec.id}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [focusId, focusZh, notes]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onScroll = () => setShowBackTop(root.scrollTop > 160);
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [notes]);

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToPart = (id: string) => {
    setActiveId(id);
    setOpenIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    requestAnimationFrame(() => {
      const root = scrollRef.current;
      if (!root) return;
      const el = root.querySelector(`[data-sec="${id}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const toggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const partList = notes?.sections || [];
  const outline =
    notes?.outline?.length ? notes.outline : partList.map((s) => s.title);

  return (
    <div className={styles.root}>
      {!points.length ? (
        <p className={styles.empty}>本次课暂无知识点，无法生成笔记</p>
      ) : loading ? (
        <div className={styles.loadingBox}>
          <p>正在整理本次课讲义…</p>
          <p className={styles.hint}>一篇笔记：大纲 → 分部分讲解（覆盖本课两讲）</p>
        </div>
      ) : notes ? (
        <div className={styles.scrollWrap}>
          <div className={styles.scroll} ref={scrollRef}>
            {error ? <p className={styles.warn}>{error}</p> : null}

            <div className={styles.sections}>
              <section className={styles.hero} data-kind="overview">
                {notes.overview ? (
                  <p className={styles.overview}>
                    <LatexText text={polishOverview(notes.overview)} />
                  </p>
                ) : null}
                {outline.length ? (
                  <nav className={styles.outline} aria-label="大纲">
                    <p className={styles.outlineLabel}>大纲</p>
                    <ul>
                      {outline.map((item, i) => {
                        const target = partList[i];
                        return (
                          <li key={`${item}-${i}`}>
                            {target ? (
                              <button
                                type="button"
                                className={styles.outlineLink}
                                onClick={() => scrollToPart(target.id)}
                              >
                                <LatexText text={item} />
                              </button>
                            ) : (
                              <span>
                                <LatexText text={item} />
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </nav>
                ) : null}
              </section>

              {partList.map((sec, idx) => {
                const open = openIds.has(sec.id);
                const focused =
                  sectionMatches(sec, focusId, focusZh) || activeId === sec.id;
                const blocks = sec.blocks || [];
                return (
                  <section
                    key={sec.id}
                    className={styles.section}
                    data-sec={sec.id}
                    data-kind="part"
                    data-focus={focused ? "1" : "0"}
                  >
                    <button
                      type="button"
                      className={styles.secHead}
                      aria-expanded={open}
                      onClick={() => {
                        setActiveId(sec.id);
                        toggle(sec.id);
                      }}
                    >
                      <span className={styles.kind}>第 {idx + 1} 部分</span>
                      <span className={styles.secTitle}>
                        {stripCnOrdinalPrefix(sec.title)}
                      </span>
                      <span className={styles.chev}>{open ? "▾" : "▸"}</span>
                    </button>
                    {!open && sec.summary ? (
                      <p className={styles.oneLiner}>
                        <LatexText text={sec.summary} />
                      </p>
                    ) : null}
                    {open ? (
                      <div className={styles.detail}>
                        {sec.summary ? (
                          <p className={styles.partSummary}>
                            <LatexText text={sec.summary} />
                          </p>
                        ) : null}
                        <PartBody body={sec.body || ""} />
                        <NoteBlocks blocks={blocks} />
                        {!sec.body && !blocks.length && sec.bullets?.length ? (
                          <ul>
                            {sec.bullets.map((b, i) => (
                              <li key={i}>
                                <LatexText text={b} />
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </div>
          {showBackTop ? (
            <button
              type="button"
              className={styles.backTop}
              onClick={scrollToTop}
              title="回到顶部"
              aria-label="回到顶部"
            >
              ↑
            </button>
          ) : null}
        </div>
      ) : (
        <p className={styles.empty}>暂无笔记</p>
      )}
    </div>
  );
}
