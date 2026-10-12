import { useEffect, useRef, useState } from "react";
import { LatexText } from "@/components/graph/LatexText";
import type { AppReviewPoint } from "@/lib/review/data";
import {
  clearLectureNotesCache,
  loadLectureNotesCache,
  saveLectureNotesCache,
} from "@/lib/review/localDb";
import {
  attachThemeEntities,
  buildLocalLectureNotes,
  fetchLectureNotes,
  isThemeNotes,
  pickThemeForFocus,
  themeOnlySections,
  type LectureNoteSection,
  type LectureNotesDoc,
  type NoteBlock,
  type NoteBlockType,
} from "@/lib/review/reviewNotes";
import styles from "./LectureStudyNotes.module.css";

const KIND_LABEL: Record<string, string> = {
  theme: "主题",
  concept: "主题",
  structure: "主题",
  tips: "技巧",
  checklist: "自测",
  extra: "拓展",
};

const BLOCK_FALLBACK_LABEL: Record<NoteBlockType, string> = {
  hook: "脉络",
  def: "定义",
  fact: "要点",
  example: "例",
  pitfall: "易错",
  cue: "自测",
};

function sectionMatches(
  sec: LectureNoteSection,
  focusId: string | null,
  focusZh: string | null
) {
  const id = (focusId || "").trim();
  const f = (focusZh || "").trim();
  if (id && (sec.related || []).includes(id)) return true;
  if (!f) return false;
  if (sec.title === f) return true;
  return (sec.related || []).some((r) => r === f);
}

function NoteBlocks({ blocks }: { blocks: NoteBlock[] }) {
  const [openAnswers, setOpenAnswers] = useState<Set<number>>(() => new Set());
  if (!blocks.length) return null;
  return (
    <div className={styles.blocks}>
      {blocks.map((b, i) => (
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
            {b.type === "cue" && b.answer ? (
              <div className={styles.cueAnswer}>
                <button
                  type="button"
                  className={styles.cueAnswerBtn}
                  onClick={() =>
                    setOpenAnswers((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                >
                  {openAnswers.has(i) ? "收起参考答" : "查看参考答"}
                </button>
                {openAnswers.has(i) ? (
                  <p className={styles.cueAnswerBody}>
                    <LatexText text={b.answer} />
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
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
  onCollapse?: () => void;
};

export function LectureStudyNotes({
  courseId,
  lectureId,
  title,
  points,
  focusId = null,
  focusZh = null,
  onCollapse,
}: Props) {
  const [notes, setNotes] = useState<LectureNotesDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [activeThemeId, setActiveThemeId] = useState<string | null>(null);
  const [showBackTop, setShowBackTop] = useState(false);
  const genRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const applyDoc = (doc: LectureNotesDoc) => {
    const cleaned: LectureNotesDoc = {
      ...doc,
      sections: themeOnlySections(doc.sections || []),
    };
    const attached = attachThemeEntities(cleaned, points);
    setNotes(attached);
    const themeIds = attached.themes.map((t) => t.id);
    // 默认展开第一个主题，更像打开笔记本
    setOpenIds(new Set(themeIds.slice(0, 1)));
    setActiveThemeId(themeIds[0] || null);
  };

  const load = async (force: boolean) => {
    if (!points.length) {
      setNotes(null);
      return;
    }
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    // 重新生成时先清空正文，避免「点了没反应」的错觉
    if (force) {
      setNotes(null);
      try {
        await clearLectureNotesCache(courseId, lectureId);
      } catch {
        /* 清缓存失败仍继续请求服务端 force */
      }
    } else {
      const cached = await loadLectureNotesCache(courseId, lectureId);
      const cachedNotes = cached?.notes as LectureNotesDoc | undefined;
      if (isThemeNotes(cachedNotes)) {
        if (gen !== genRef.current) return;
        applyDoc(cachedNotes);
        setLoading(false);
        return;
      }
    }

    try {
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
      if (force) {
        if (doc.source === "local") {
          setError(
            doc.subtitle?.includes("生成失败")
              ? doc.subtitle
              : doc.subtitle ||
                  "已重新生成本地笔记（未配置或调用大模型失败）",
          );
        } else if (doc.source === "disk") {
          setError("服务端仍返回缓存稿；若内容未变可再点一次重新生成");
        } else {
          setError(`已重新生成（${doc.model || "大模型"}）`);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when lecture/points change
  }, [courseId, lectureId, points.length]);

  useEffect(() => {
    if (!notes || (!focusId && !focusZh)) return;
    const theme = pickThemeForFocus(notes, focusId, focusZh);
    const sec =
      (theme && notes.sections.find((s) => s.id === theme.id)) ||
      (theme && notes.sections.find((s) => s.title === theme.title)) ||
      notes.sections.find((s) => sectionMatches(s, focusId, focusZh));
    const cardId = theme?.id || sec?.id;
    if (!cardId) return;
    const expandId = sec?.id || theme?.id;
    setActiveThemeId(cardId);
    setOpenIds((prev) => {
      const next = new Set(prev);
      next.add(cardId);
      if (expandId) next.add(expandId);
      return next;
    });
    requestAnimationFrame(() => {
      const root = scrollRef.current;
      if (!root) return;
      const el =
        root.querySelector(`[data-sec="${expandId}"]`) ||
        root.querySelector(`[data-sec="${cardId}"]`);
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

  const toggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const themeSections = notes?.sections.filter(
    (s) => s.kind === "theme" || s.kind === "concept" || s.kind === "structure"
  );

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span>本堂课堂笔记</span>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.toolBtn}
            disabled={loading || !points.length}
            onClick={() => void load(true)}
          >
            {loading ? "生成中…" : "重新生成"}
          </button>
        </div>
      </div>

      {!points.length ? (
        <p className={styles.empty}>本堂课暂无知识点，无法生成笔记</p>
      ) : loading ? (
        <div className={styles.loadingBox}>
          <p>正在按主题重写本堂课笔记…</p>
          <p className={styles.hint}>
            会整理成 5～8 个主题：脉络 → 定义 → 要点 → 例子 → 易错 → 自测
          </p>
        </div>
      ) : notes ? (
        <div className={styles.scrollWrap}>
          <div className={styles.scroll} ref={scrollRef}>
          {error ? <p className={styles.warn}>{error}</p> : null}

          <div className={styles.sections}>
            {(themeSections || []).map((sec) => {
              const open = openIds.has(sec.id);
              const focused =
                sectionMatches(sec, focusId, focusZh) || activeThemeId === sec.id;
              const theme = notes.themes.find(
                (t) => t.id === sec.id || t.title === sec.title
              );
              const blocks = sec.blocks || [];
              return (
                <section
                  key={sec.id}
                  className={styles.section}
                  data-sec={sec.id}
                  data-kind="theme"
                  data-focus={focused ? "1" : "0"}
                >
                  <button
                    type="button"
                    className={styles.secHead}
                    aria-expanded={open}
                    onClick={() => {
                      setActiveThemeId(sec.id);
                      toggle(sec.id);
                    }}
                  >
                    <span className={styles.kind}>{KIND_LABEL[sec.kind] || "主题"}</span>
                    <span className={styles.secTitle}>{sec.title}</span>
                    <span className={styles.chev}>{open ? "▾" : "▸"}</span>
                  </button>
                  {/* 折叠时只留一句预览；展开后用 hook 开场，避免 oneLiner/summary/hook 三段重复 */}
                  {!open ? (
                    theme?.oneLiner || sec.summary ? (
                      <p className={styles.oneLiner}>
                        <LatexText text={theme?.oneLiner || sec.summary} />
                      </p>
                    ) : null
                  ) : null}
                  {open ? (
                    <div className={styles.detail}>
                      <NoteBlocks blocks={blocks} />
                      {!blocks.length && sec.bullets?.length ? (
                        <ul>
                          {sec.bullets.map((b, i) => (
                            <li key={i}>
                              <LatexText text={b} />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {sec.tips?.length ? (
                        <div className={styles.tips}>
                          {sec.tips.map((t, i) => (
                            <p key={i}>
                              <LatexText text={t} />
                            </p>
                          ))}
                        </div>
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
