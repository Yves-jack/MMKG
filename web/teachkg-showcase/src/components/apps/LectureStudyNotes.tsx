import { useEffect, useRef, useState } from "react";
import { LatexText } from "@/components/pipeline/LatexText";
import type { AppReviewPoint } from "@/lib/apps/data";
import {
  clearLectureNotesCache,
  loadLectureNotesCache,
  saveLectureNotesCache,
} from "@/lib/apps/localDb";
import {
  attachThemeEntities,
  buildLocalLectureNotes,
  fetchLectureNotes,
  isThemeNotes,
  pickThemeForFocus,
  type LectureNoteSection,
  type LectureNotesDoc,
  type NoteBlock,
  type NoteBlockType,
} from "@/lib/apps/reviewNotes";
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
    const attached = attachThemeEntities(doc, points);
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

    if (!force) {
      const cached = await loadLectureNotesCache(courseId, lectureId);
      const cachedNotes = cached?.notes as LectureNotesDoc | undefined;
      if (isThemeNotes(cachedNotes)) {
        if (gen !== genRef.current) return;
        applyDoc(cachedNotes);
        setLoading(false);
        return;
      }
    } else {
      await clearLectureNotesCache(courseId, lectureId);
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
  const extraSections = notes?.sections.filter(
    (s) => s.kind === "tips" || s.kind === "checklist" || s.kind === "extra"
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
          {onCollapse ? (
            <button type="button" className={styles.toolBtn} onClick={onCollapse}>
              折叠
            </button>
          ) : null}
        </div>
      </div>

      {!points.length ? (
        <p className={styles.empty}>本堂课暂无知识点，无法生成笔记</p>
      ) : loading && !notes ? (
        <div className={styles.loadingBox}>
          <p>正在按主题重写本堂课笔记…</p>
          <p className={styles.hint}>
            会整理成 5～8 个主题：脉络 → 定义 → 要点 → 例子 → 易错 → 自测
          </p>
        </div>
      ) : notes ? (
        <div className={styles.scrollWrap}>
          <div className={styles.scroll} ref={scrollRef}>
          <header className={styles.hero}>
            <p className={styles.kicker}>Notebook</p>
            <h3>{notes.title}</h3>
            {notes.subtitle ? (
              <p className={styles.subtitle}>
                <LatexText text={notes.subtitle} />
              </p>
            ) : null}
            {notes.overview ? (
              <p className={styles.overview}>
                <LatexText text={notes.overview} />
              </p>
            ) : null}
            {error ? <p className={styles.warn}>{error}</p> : null}
            {notes.themes.length ? (
              <div className={styles.themeMap} aria-label="主题地图">
                {notes.themes.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`${styles.themeChip} ${
                      activeThemeId === t.id ? styles.themeChipOn : ""
                    }`}
                    title={t.oneLiner || t.title}
                    onClick={() => {
                      setActiveThemeId(t.id);
                      setOpenIds((prev) => new Set(prev).add(t.id));
                      requestAnimationFrame(() => {
                        scrollRef.current
                          ?.querySelector(`[data-sec="${t.id}"]`)
                          ?.scrollIntoView({ behavior: "smooth", block: "start" });
                      });
                    }}
                  >
                    <em>{i + 1}</em>
                    <span>{t.title}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </header>

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

            {(extraSections || []).map((sec) => {
              const open = openIds.has(sec.id);
              return (
                <section
                  key={sec.id}
                  className={styles.section}
                  data-sec={sec.id}
                  data-kind={sec.kind}
                >
                  <button
                    type="button"
                    className={styles.secHead}
                    aria-expanded={open}
                    onClick={() => toggle(sec.id)}
                  >
                    <span className={styles.kind}>{KIND_LABEL[sec.kind] || sec.kind}</span>
                    <span className={styles.secTitle}>{sec.title}</span>
                    <span className={styles.chev}>{open ? "▾" : "▸"}</span>
                  </button>
                  {sec.summary ? (
                    <p className={styles.summary}>
                      <LatexText text={sec.summary} />
                    </p>
                  ) : null}
                  {open ? (
                    <div className={styles.detail}>
                      {sec.body
                        ? sec.body.split(/\n{2,}/).map((para, i) => (
                            <p key={i}>
                              <LatexText text={para.replace(/\n/g, " ")} />
                            </p>
                          ))
                        : null}
                      {sec.bullets?.length ? (
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
