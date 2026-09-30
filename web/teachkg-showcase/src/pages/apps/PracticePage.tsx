import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppsChrome } from "@/components/apps/AppsChrome";
import { LessonVideoStrip } from "@/components/apps/LessonVideoStrip";
import { PracticeHistoryPanel } from "@/components/apps/PracticeHistoryPanel";
import { WrongbookNoteEditor } from "@/components/apps/WrongbookNoteEditor";
import { LatexText } from "@/components/pipeline/LatexText";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import {
  buildQuizFromReviews,
  loadReviewIndex,
  loadReviewLecture,
  type QuizItem,
} from "@/lib/apps/data";
import { reviewWatchPath } from "@/lib/apps/reviewSeek";
import {
  clearPracticeSession,
  loadPracticeSession,
  loadQuizQuality,
  loadWrongbook,
  removeWrongbookEntry,
  savePracticeSession,
  toggleWrongbookStar,
  upsertQuizQuality,
  upsertWrongbookNote,
  type QuizQualityEntry,
  type QuizQualityStore,
  type QuizQualityVote,
  type WrongbookEntry,
  type WrongbookStore,
} from "@/lib/apps/localDb";
import {
  attachQuizContexts,
  buildQuizFromNotes,
  difficultyLabel,
  ensureLectureNotes,
  ensureQuizItemAnswer,
  isCorrectPick,
  polishPracticeQuiz,
  resolvedCorrectIndex,
} from "@/lib/apps/practiceQuiz";
import {
  loadPracticeStats,
  upsertPracticeProgress,
  type PracticeStats,
} from "@/lib/apps/progress";
import { coursePath, useCourseId } from "@/lib/course";
import shell from "@/styles/shell.module.css";
import styles from "./Apps.module.css";
import p from "./Practice.module.css";

type Verdict = "ok" | "wrong" | null;

const QUALITY_REASONS = [
  { id: "prompt", label: "题干不清" },
  { id: "options", label: "选项不当" },
  { id: "answer", label: "答案存疑" },
  { id: "explain", label: "解析不准" },
  { id: "difficulty", label: "难度不符" },
] as const;

function qualityEntryFor(
  store: QuizQualityStore,
  quizId: string
): QuizQualityEntry | null {
  return store.entries.find((e) => e.quizId === quizId) || null;
}

function diffClass(d?: QuizItem["difficulty"]) {
  if (d === "easy") return styles.diffEasy;
  if (d === "hard") return styles.diffHard;
  return styles.diffMedium;
}

function optionClass(picked: number | null, i: number, correctIdx: number) {
  if (picked == null) return p.option;
  if (i === correctIdx) return p.optionCorrect;
  if (i === picked) return p.optionWrong;
  return p.option;
}

/** 巩固练习：进度可视化 · 键盘作答 · 错题回顾 · 本地成绩 */
export function PracticePage() {
  const courseId = useCourseId() || "数理逻辑";
  const [lectureFilter, setLectureFilter] = useState<string>("all");
  const [lectures, setLectures] = useState<string[]>([]);
  const [quiz, setQuiz] = useState<QuizItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [picks, setPicks] = useState<Array<number | null>>([]);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [mode, setMode] = useState<"quiz" | "wrongbook">("quiz");
  const [loading, setLoading] = useState(true);
  const [polishHint, setPolishHint] = useState<string | null>(null);
  const [stats, setStats] = useState<PracticeStats>(() => loadPracticeStats(courseId));
  const [savedSession, setSavedSession] = useState(false);
  const [seekNonce, setSeekNonce] = useState(0);
  const [finished, setFinished] = useState(false);
  const [ready, setReady] = useState(false);
  const [detailOpen, setDetailOpen] = useState(true);
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      const v = localStorage.getItem(`teachkg-practice-side:${courseId}`);
      return v == null ? true : v === "1";
    } catch {
      return true;
    }
  });
  const [wrongbook, setWrongbook] = useState<WrongbookStore>({
    courseId,
    entries: [],
    updatedAt: 0,
  });
  const [quizQuality, setQuizQuality] = useState<QuizQualityStore>({
    courseId,
    entries: [],
    updatedAt: 0,
  });
  const [noteDraft, setNoteDraft] = useState("");
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genRef = useRef(0);
  const quizResumeRef = useRef<{ idx: number; finished: boolean } | null>(null);
  const practiceSessionIdRef = useRef(
    `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );

  const newPracticeSessionId = () => {
    const id = `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    practiceSessionIdRef.current = id;
    return id;
  };

  const reload = async (lec: string) => {
    const gen = ++genRef.current;
    setLoading(true);
    setMode("quiz");
    setSavedSession(false);
    setFinished(false);
    setQuiz([]);
    setIdx(0);
    setPicked(null);
    setPicks([]);
    setVerdicts([]);
    setPolishHint(null);
    setDetailOpen(true);
    setStats(loadPracticeStats(courseId));
    newPracticeSessionId();
    await clearPracticeSession(courseId);
    const index = await loadReviewIndex(courseId);
    if (gen !== genRef.current) return;
    const lids = index.map((i) => i.lecture_id);
    setLectures(lids);
    const want = lec === "all" ? lids : [lec];
    const docs = [];
    for (const id of want) {
      const doc = await loadReviewLecture(courseId, id);
      if (gen !== genRef.current) return;
      if (doc) docs.push({ lectureId: id, doc });
    }

    setPolishHint("正在读取复习笔记并出题…");
    const notesByLecture = new Map();
    const notePacks = [];
    for (const { lectureId, doc } of docs) {
      const notes = await ensureLectureNotes({
        courseId,
        lectureId,
        title: doc.title,
        points: doc.points || [],
      });
      if (gen !== genRef.current) return;
      notesByLecture.set(lectureId, notes);
      notePacks.push({
        lectureId,
        notes,
        points: doc.points || [],
      });
    }

    const fromNotes = buildQuizFromNotes(notePacks, 10, {
      focusEntityId: null,
      focusZh: null,
    });
    const fromGraph = buildQuizFromReviews(docs, 10, {
      focusEntityId: null,
    });
    // 笔记题优先，图谱题补足到 10 道（按讲次/概念去重）
    const seen = new Set<string>();
    const seeded = [];
    for (const q of [...fromNotes, ...fromGraph]) {
      const key = `${q.lectureId}:${q.entityZh}:${q.type}`;
      if (seen.has(q.id) || seen.has(key)) continue;
      seen.add(q.id);
      seen.add(key);
      seeded.push(q);
      if (seeded.length >= 10) break;
    }

    if (gen !== genRef.current) return;
    setPolishHint("正在按学习笔记精修题目与解析（分批生成，约需半分钟）…");
    const withCtx = attachQuizContexts(seeded, docs, notesByLecture);
    const polished = await polishPracticeQuiz({ courseId, items: withCtx });
    if (gen !== genRef.current) return;
    const items = polished.items?.length ? polished.items : seeded;
    const ok = items.some((q) => q.polished);
    setPolishHint(
      ok
        ? null
        : polished.error
          ? `题目润色失败，已用本地题：${polished.error}`
          : null
    );
    setQuiz(items);
    setIdx(0);
    setPicked(null);
    setPicks(items.map(() => null));
    setVerdicts(items.map(() => null));
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setLoading(true);
    (async () => {
      const index = await loadReviewIndex(courseId);
      if (cancelled) return;
      setLectures(index.map((i) => i.lecture_id));
      setStats(loadPracticeStats(courseId));

      const saved = await loadPracticeSession(courseId);
      if (cancelled) return;
      const book = await loadWrongbook(courseId);
      if (cancelled) return;
      setWrongbook(book);
      const quality = await loadQuizQuality(courseId);
      if (cancelled) return;
      setQuizQuality(quality);

      if (saved?.quiz && Array.isArray(saved.quiz) && saved.quiz.length > 0) {
        setLectureFilter(saved.lectureFilter || "all");
        const quizFixed = (saved.quiz as QuizItem[]).map((q) =>
          ensureQuizItemAnswer(q)
        );
        setQuiz(quizFixed);
        const picksFixed =
          Array.isArray(saved.picks) && saved.picks.length === quizFixed.length
            ? saved.picks
            : quizFixed.map(() => null);
        setPicks(picksFixed);
        setVerdicts(
          quizFixed.map((q, i) => {
            const pv = picksFixed[i];
            if (pv == null) return null;
            return isCorrectPick(q, pv) ? "ok" : "wrong";
          })
        );
        setFinished(Boolean(saved.finished));
        setSavedSession(Boolean(saved.finished));

        if (saved.mode === "wrongbook" && book.entries.length > 0) {
          setMode("wrongbook");
          const bi = Math.min(saved.idx || 0, book.entries.length - 1);
          setIdx(bi);
          setPicked(resolvedCorrectIndex(book.entries[bi].quiz as QuizItem));
        } else {
          setMode("quiz");
          setIdx(Math.min(saved.idx || 0, quizFixed.length - 1));
          setPicked(saved.picked ?? null);
        }
        if (saved.practiceSessionId) {
          practiceSessionIdRef.current = saved.practiceSessionId;
        } else {
          newPracticeSessionId();
        }
        setLoading(false);
        setReady(true);
        return;
      }

      setLectureFilter("all");
      await reload("all");
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      genRef.current += 1;
    };
  }, [courseId]);

  useEffect(() => {
    if (!ready || loading) return;
    if (!quiz.length && mode !== "wrongbook") return;
    void savePracticeSession({
      courseId,
      lectureFilter,
      focusMode: false,
      quiz,
      idx,
      picked,
      picks,
      verdicts,
      mode,
      finished,
      practiceSessionId: practiceSessionIdRef.current,
      updatedAt: Date.now(),
    });
  }, [
    ready,
    loading,
    courseId,
    lectureFilter,
    quiz,
    idx,
    picked,
    picks,
    verdicts,
    mode,
    finished,
  ]);

  const changeLecture = (lec: string) => {
    setLectureFilter(lec);
    void reload(lec);
  };

  const wrongItems = useMemo(
    () => quiz.filter((_, i) => verdicts[i] === "wrong"),
    [quiz, verdicts]
  );

  const bookEntries = wrongbook.entries;
  const bookQuiz = useMemo(
    () => bookEntries.map((e) => e.quiz as QuizItem),
    [bookEntries]
  );

  const pool = mode === "wrongbook" ? bookQuiz : quiz;
  const current = pool[idx] || null;
  const currentEntry: WrongbookEntry | null =
    mode === "wrongbook"
      ? bookEntries[idx] || null
      : current
        ? bookEntries.find((e) => e.id === current.id) || null
        : null;
  const inBook = Boolean(currentEntry);
  // 在收藏本中或正在写笔记 → 星标点亮
  const starred = inBook || Boolean(noteDraft.trim());
  const answered = verdicts.filter((v) => v != null).length;
  const correctCount = verdicts.filter((v) => v === "ok").length;
  const done = mode === "quiz" && finished;

  useEffect(() => {
    let cancelled = false;
    void loadWrongbook(courseId).then((store) => {
      if (!cancelled) setWrongbook(store);
    });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  useEffect(() => {
    if (!current) {
      setNoteDraft("");
      return;
    }
    const entry = wrongbook.entries.find((e) => e.id === current.id);
    setNoteDraft(entry?.note || "");
    // 仅切换题目时同步，避免自动保存回写打断输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, mode]);

  const persistNote = (quiz: QuizItem, text: string) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    const delay = text.trim() ? 400 : 0; // 清空时立即同步取消收藏
    noteTimer.current = setTimeout(() => {
      void upsertWrongbookNote(courseId, quiz, text).then(setWrongbook);
    }, delay);
  };

  /** 退出收藏本时恢复进入前的练习进度（含已答解析） */
  const restoreQuizView = () => {
    const resume = quizResumeRef.current;
    quizResumeRef.current = null;
    setMode("quiz");
    if (resume?.finished) {
      setFinished(true);
      setIdx(0);
      setPicked(null);
      return;
    }
    setFinished(false);
    const safeIdx = Math.min(
      Math.max(0, resume?.idx ?? 0),
      Math.max(0, quiz.length - 1)
    );
    setIdx(safeIdx);
    const prevPick = picks[safeIdx];
    setPicked(prevPick != null ? prevPick : null);
    setDetailOpen(true);
  };

  const openWrongbook = () => {
    if (!wrongbook.entries.length) return;
    quizResumeRef.current = { idx, finished };
    setMode("wrongbook");
    setFinished(false);
    setIdx(0);
    const first = wrongbook.entries[0]?.quiz;
    setPicked(first ? resolvedCorrectIndex(first as QuizItem) : null);
    setDetailOpen(true);
  };

  const exitWrongbook = () => {
    restoreQuizView();
  };

  const onToggleStar = async () => {
    if (!current) return;
    if (noteTimer.current) {
      clearTimeout(noteTimer.current);
      noteTimer.current = null;
    }
    if (inBook || noteDraft.trim()) {
      // 再点星标 = 移出收藏本
      const next = await removeWrongbookEntry(courseId, current.id);
      setWrongbook(next);
      setNoteDraft("");
      if (mode === "wrongbook") {
        if (!next.entries.length) {
          restoreQuizView();
          return;
        }
        const nextIdx = Math.min(idx, next.entries.length - 1);
        setIdx(nextIdx);
        setPicked(resolvedCorrectIndex(next.entries[nextIdx].quiz as QuizItem));
      }
      return;
    }
    const next = await toggleWrongbookStar(courseId, current);
    setWrongbook(next);
  };

  const qualityEntry = current ? qualityEntryFor(quizQuality, current.id) : null;

  const saveQuality = async (
    vote: QuizQualityVote,
    reasons: string[] = []
  ) => {
    if (!current) return;
    const store = await upsertQuizQuality(courseId, {
      quizId: current.id,
      lectureId: current.lectureId,
      entityId: current.entityId,
      entityZh: current.entityZh,
      prompt: current.prompt,
      difficulty: current.difficulty,
      polished: current.polished,
      vote,
      reasons: vote === 1 ? [] : reasons,
    });
    setQuizQuality(store);
  };

  const onQualityVote = (vote: QuizQualityVote) => {
    void saveQuality(vote, vote === -1 ? qualityEntry?.reasons || [] : []);
  };

  const onToggleQualityReason = (reasonId: string) => {
    if (!current) return;
    const prev = qualityEntry?.reasons || [];
    const next = prev.includes(reasonId)
      ? prev.filter((r) => r !== reasonId)
      : [...prev, reasonId];
    void saveQuality(-1, next);
  };

  const jumpBook = (i: number) => {
    if (i < 0 || i >= bookQuiz.length) return;
    setIdx(i);
    setPicked(resolvedCorrectIndex(bookQuiz[i]));
    setDetailOpen(true);
  };

  const onPick = (optionIndex: number) => {
    if (!current || picked != null) return;
    setPicked(optionIndex);
    if (mode === "wrongbook") return;
    const ok = isCorrectPick(current, optionIndex);
    const qi = quiz.findIndex((q) => q.id === current.id);
    if (qi >= 0) {
      setVerdicts((vs) => {
        const next = [...vs];
        next[qi] = ok ? "ok" : "wrong";
        return next;
      });
      setPicks((ps) => {
        const next = [...ps];
        next[qi] = optionIndex;
        return next;
      });
    }
    const correctIdx = resolvedCorrectIndex(current);
    if (current.evidenceStartSec != null) setSeekNonce((n) => n + 1);
    setDetailOpen(true);
  };

  const jumpToQuizIndex = (qi: number) => {
    if (mode !== "quiz" || done || qi < 0 || qi >= quiz.length) return;
    // 仅已作答题目可跳转
    if (verdicts[qi] == null) return;
    setIdx(qi);
    const prev = picks[qi];
    setPicked(prev != null ? prev : quiz[qi].answerIndex);
    setDetailOpen(true);
  };

  const next = () => {
    if (idx + 1 < pool.length) {
      const nextIdx = idx + 1;
      setIdx(nextIdx);
      if (mode === "quiz") {
        const q = pool[nextIdx];
        const qi = quiz.findIndex((x) => x.id === q.id);
        const prev = qi >= 0 ? picks[qi] : null;
        setPicked(prev != null ? prev : null);
      } else {
        setPicked(resolvedCorrectIndex(pool[nextIdx]));
      }
      return;
    }
    if (mode === "wrongbook") {
      exitWrongbook();
      return;
    }
    setFinished(true);
    setPicked(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!current || done) return;
      if (picked == null && e.key >= "1" && e.key <= "4") {
        const i = Number(e.key) - 1;
        if (i < current.options.length) onPick(i);
      }
      if (picked != null && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const accuracy = answered ? Math.round((correctCount / answered) * 100) : 0;
  const progress = quiz.length ? (answered / quiz.length) * 100 : 0;

  useEffect(() => {
    if (!ready || loading || mode !== "quiz" || !quiz.length) return;
    const answeredN = verdicts.filter((v) => v != null).length;
    if (answeredN <= 0) return;
    const correctN = verdicts.filter((v) => v === "ok").length;
    const acc = Math.round((correctN / answeredN) * 100);
    const byDifficulty = {
      easy: { answered: 0, correct: 0 },
      medium: { answered: 0, correct: 0 },
      hard: { answered: 0, correct: 0 },
    };
    quiz.forEach((q, i) => {
      const v = verdicts[i];
      if (v == null) return;
      const d =
        q.difficulty === "easy" || q.difficulty === "hard" ? q.difficulty : "medium";
      byDifficulty[d].answered += 1;
      if (v === "ok") byDifficulty[d].correct += 1;
    });
    const wrongIds = quiz
      .filter((_, i) => verdicts[i] === "wrong")
      .map((q) => q.id);
    const next = upsertPracticeProgress(courseId, {
      sessionId: practiceSessionIdRef.current,
      answered: answeredN,
      correct: correctN,
      accuracy: acc,
      total: quiz.length,
      wrongIds,
      byDifficulty,
      finished: Boolean(finished),
    });
    setStats(next);
  }, [ready, loading, mode, quiz, verdicts, finished, courseId]);

  useEffect(() => {
    try {
      localStorage.setItem(`teachkg-practice-side:${courseId}`, sideOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [courseId, sideOpen]);

  return (
    <ResizableShell
      storagePrefix="shell-app-practice"
      detailInitialRightPx={268}
      nav={
        <aside className={shell.sidebar}>
          <div className={shell.sideHead}>
            <Link className={shell.back} to={coursePath(courseId)}>
              <span className={shell.backIcon}>←</span>
              <span className={shell.backBrand}>
                Teach<em>KG</em>
              </span>
            </Link>
            <p className={shell.eyebrow}>练习</p>
            <p className={shell.sideLead}>
              {mode === "wrongbook"
                ? `收藏本 · ${bookEntries.length} 题`
                : "键盘 1–4 作答"}
            </p>
          </div>
          {mode === "wrongbook" ? (
            <div className={p.navBook}>
              <div className={p.navBookHead}>
                <span className={p.navBookLabel}>题目列表</span>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={exitWrongbook}
                >
                  退出
                </button>
              </div>
              {bookEntries.length ? (
                <div className={p.navBookList}>
                  {bookEntries.map((e, i) => (
                    <button
                      key={e.id}
                      type="button"
                      className={i === idx ? p.bookItemOn : p.bookItem}
                      onClick={() => jumpBook(i)}
                    >
                      <span className={p.bookItemTitle}>
                        {e.starred ? "★ " : ""}
                        {e.quiz.entityZh || "未命名"}
                      </span>
                      <span className={p.bookItemMeta}>
                        第 {e.quiz.lectureId} 讲
                        {(e.note || "").trim() ? " · 有笔记" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className={p.navBookEmpty}>收藏本是空的</p>
              )}
            </div>
          ) : (
            <ul className={styles.listNav}>
              <li>
                <button
                  type="button"
                  className={lectureFilter === "all" ? styles.lecBtnActive : styles.lecBtn}
                  onClick={() => changeLecture("all")}
                >
                  <span className={styles.badge}>全部</span>
                  <span className={styles.muted}>跨讲混合</span>
                </button>
              </li>
              {lectures.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className={lectureFilter === id ? styles.lecBtnActive : styles.lecBtn}
                    onClick={() => changeLecture(id)}
                  >
                    <span className={styles.badge}>第 {id} 讲</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      }
      main={
        <main className={styles.page}>
          <AppsChrome
            courseId={courseId}
            lectureId={lectureFilter === "all" ? "1" : lectureFilter}
            title="巩固练习"
            extra={
              <>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  disabled={!bookEntries.length && mode !== "wrongbook"}
                  onClick={() => {
                    if (mode === "wrongbook") exitWrongbook();
                    else openWrongbook();
                  }}
                  title={
                    bookEntries.length
                      ? `收藏本 · ${bookEntries.length} 题`
                      : "暂无收藏"
                  }
                >
                  {mode === "wrongbook"
                    ? "退出收藏本"
                    : `收藏本${bookEntries.length ? ` · ${bookEntries.length}` : ""}`}
                </button>
                {!sideOpen ? (
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => setSideOpen(true)}
                    title="展开右侧栏"
                  >
                    展开侧栏
                  </button>
                ) : null}
              </>
            }
          />
          <div className={p.mainBody}>
            {!sideOpen ? (
              <div className={p.historyInline}>
                <PracticeHistoryPanel stats={stats} />
              </div>
            ) : null}
            <div className={p.stage}>
              <div className={p.toolbar}>
                <div className={p.scoreBlock}>
                  {mode === "wrongbook" ? (
                    <>
                      <span className={p.scoreValue}>
                        {bookQuiz.length ? `${idx + 1}` : "—"}
                      </span>
                      <span className={p.scoreMeta}>
                        / {bookQuiz.length || 0} · 收藏本整理
                      </span>
                    </>
                  ) : answered === 0 ? (
                    <>
                      <span className={p.scoreValue}>
                        {quiz.length ? `${Math.min(idx + 1, quiz.length)}` : "—"}
                      </span>
                      <span className={p.scoreMeta}>
                        {quiz.length ? `/ ${quiz.length} · 未作答` : "准备出题"}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={p.scoreValue}>{accuracy}%</span>
                      <span className={p.scoreMeta}>
                        正确 {correctCount}/{answered}
                        {quiz.length ? ` · 共 ${quiz.length} 题` : ""}
                      </span>
                    </>
                  )}
                </div>
                <div className={p.toolbarActions}>
                  {mode === "wrongbook" ? (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      onClick={exitWrongbook}
                    >
                      返回练习
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      onClick={() => void reload(lectureFilter)}
                    >
                      换一组
                    </button>
                  )}
                </div>
              </div>

              <div className={p.progressBlock}>
                <div className={p.progressTrack}>
                  <div
                    className={p.progressFill}
                    style={{
                      width: `${
                        mode === "wrongbook"
                          ? bookQuiz.length
                            ? ((idx + 1) / bookQuiz.length) * 100
                            : 0
                          : progress
                      }%`,
                    }}
                  />
                </div>
                <div className={p.dotRow}>
                  {(mode === "wrongbook" ? bookQuiz : quiz).map((q, i) => {
                    if (mode === "wrongbook") {
                      const entry = bookEntries[i];
                      let cls = styles.dot;
                      if (i === idx) cls = styles.dotOn;
                      else if (entry?.starred || (entry?.note || "").trim())
                        cls = styles.dotOk;
                      return (
                        <button
                          key={q.id}
                          type="button"
                          className={cls}
                          title={entry?.quiz.entityZh || `第 ${i + 1} 题`}
                          onClick={() => jumpBook(i)}
                          aria-label={`收藏本第 ${i + 1} 题`}
                        />
                      );
                    }
                    const answeredDot = verdicts[i] != null;
                    let cls = styles.dot;
                    if (i === idx && !done) cls = styles.dotOn;
                    if (verdicts[i] === "ok") cls = styles.dotOk;
                    if (verdicts[i] === "wrong") cls = styles.dotWrong;
                    const canJump = !done && answeredDot;
                    return (
                      <button
                        key={q.id}
                        type="button"
                        className={cls}
                        title={
                          answeredDot
                            ? `跳转到第 ${i + 1} 题`
                            : `第 ${i + 1} 题（作答后可跳转）`
                        }
                        disabled={!canJump}
                        onClick={() => jumpToQuizIndex(i)}
                        aria-label={`第 ${i + 1} 题`}
                      />
                    );
                  })}
                </div>
              </div>

              {polishHint && !loading ? <p className={p.hint}>{polishHint}</p> : null}

              {loading && (
                <p className={p.empty}>{polishHint || "正在出题，稍候…"}</p>
              )}
              {!loading && !quiz.length && (
                <p className={p.empty}>暂无题目，请先导出单课复习数据。</p>
              )}
              {!loading && current && !done && (
                <div className={p.question} key={`${mode}-${current.id}-${idx}`}>
                  <div className={p.metaRow}>
                    <div className={p.metaChips}>
                      <span className={p.chip}>
                        {mode === "wrongbook"
                          ? `收藏本 ${idx + 1}/${bookQuiz.length}`
                          : `第 ${idx + 1} 题`}
                      </span>
                      <span className={p.chip}>第 {current.lectureId} 讲</span>
                      <span className={p.chip}>
                        {current.type === "relation" ? "关系" : "释义"}
                      </span>
                    </div>
                    <span
                      className={`${styles.diffBadge} ${diffClass(current.difficulty)}`}
                      title="题目难度"
                    >
                      {difficultyLabel(current.difficulty)}
                    </span>
                  </div>

                  <div className={p.promptRow}>
                    <p className={p.prompt}>
                      <LatexText text={current.prompt} />
                    </p>
                    <button
                      type="button"
                      className={starred ? p.starBtnOn : p.starBtn}
                      onClick={() => void onToggleStar()}
                      title={starred ? "取消收藏并移出" : "加入收藏本"}
                      aria-label={starred ? "取消收藏并移出" : "加入收藏本"}
                    >
                      {starred ? "★" : "☆"}
                    </button>
                  </div>

                  <div className={p.options} data-answered={picked != null ? "1" : "0"}>
                    {current.options.map((opt, i) => {
                      const correctIdx = resolvedCorrectIndex(current);
                      return (
                        <button
                          key={`${current.id}-${i}`}
                          type="button"
                          className={optionClass(picked, i, correctIdx)}
                          onClick={() => onPick(i)}
                          disabled={picked != null}
                        >
                          <span className={p.optKey}>
                            {String.fromCharCode(65 + i)}
                          </span>
                          <span className={p.optText}>
                            <LatexText text={opt} />
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {picked != null && (
                    <div className={p.explain}>
                      <div className={p.explainHead}>
                        <p className={p.explainLabel}>解析</p>
                        <div className={p.bookActions}>
                          <button
                            type="button"
                            className={styles.ghostBtn}
                            onClick={() => setDetailOpen((v) => !v)}
                          >
                            {detailOpen ? "收起详情" : "展开详情"}
                          </button>
                        </div>
                      </div>
                      <p className={p.explainBody}>
                        <LatexText text={current.explain || ""} />
                      </p>
                      {detailOpen && (current.explainDetail || current.explain) ? (
                        <div className={p.explainDetail}>
                          <p className={p.explainLabel}>详细解析</p>
                          <p>
                            <LatexText
                              text={current.explainDetail || current.explain || ""}
                            />
                          </p>
                        </div>
                      ) : null}

                      <div className={p.qualityBlock}>
                        <div className={p.explainHead}>
                          <p className={p.explainLabel}>题目质量</p>
                          <span className={p.noteHint}>
                            {qualityEntry
                              ? qualityEntry.vote === 1
                                ? "已标记：不错"
                                : "已标记：有问题"
                              : "反馈仅保存在本机，用于改进出题"}
                          </span>
                        </div>
                        <div className={p.qualityVotes}>
                          <button
                            type="button"
                            className={
                              qualityEntry?.vote === 1
                                ? styles.voteBtnActive
                                : styles.voteBtn
                            }
                            onClick={() => onQualityVote(1)}
                          >
                            不错
                          </button>
                          <button
                            type="button"
                            className={
                              qualityEntry?.vote === -1
                                ? styles.voteBtnDown
                                : styles.voteBtn
                            }
                            onClick={() => onQualityVote(-1)}
                          >
                            有问题
                          </button>
                        </div>
                        {qualityEntry?.vote === -1 ? (
                          <div className={p.qualityReasons}>
                            {QUALITY_REASONS.map((r) => {
                              const on = (qualityEntry.reasons || []).includes(
                                r.id
                              );
                              return (
                                <button
                                  key={r.id}
                                  type="button"
                                  className={
                                    on ? p.qualityChipOn : p.qualityChip
                                  }
                                  onClick={() => onToggleQualityReason(r.id)}
                                >
                                  {r.label}
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>

                      <div className={p.noteBlock}>
                        <div className={p.explainHead}>
                          <p className={p.explainLabel}>我的笔记</p>
                          <span className={p.noteHint}>
                            {noteDraft.trim()
                              ? "已自动收藏并保存 · 再点 ★ 可移出"
                              : "写下内容会自动收藏；点 ★ 也可收藏/移出"}
                          </span>
                        </div>
                        <WrongbookNoteEditor
                          value={noteDraft}
                          hint="支持 $LaTeX$、加粗/列表，以及粘贴或插入图片"
                          onChange={(text) => {
                            setNoteDraft(text);
                            if (!current) return;
                            persistNote(current, text);
                          }}
                        />
                      </div>

                      {current.evidenceStartSec != null && (
                        <LessonVideoStrip
                          courseId={courseId}
                          lectureId={current.lectureId}
                          seekToSec={current.evidenceStartSec}
                          seekNonce={seekNonce}
                          autoOpenOnSeek={false}
                        />
                      )}
                      <div className={p.actions}>
                        <button type="button" className={styles.primaryBtn} onClick={next}>
                          {idx + 1 < pool.length
                            ? "下一题"
                            : mode === "quiz"
                              ? "查看结果"
                              : "完成整理"}
                        </button>
                        {mode === "quiz" && idx > 0 && verdicts[idx - 1] != null ? (
                          <button
                            type="button"
                            className={styles.jump}
                            onClick={() => jumpToQuizIndex(idx - 1)}
                          >
                            上一题
                          </button>
                        ) : null}
                        {mode === "wrongbook" && idx > 0 ? (
                          <button
                            type="button"
                            className={styles.jump}
                            onClick={() => jumpBook(idx - 1)}
                          >
                            上一题
                          </button>
                        ) : null}
                        <Link
                          className={styles.jump}
                          to={reviewWatchPath(courseId, current.lectureId, {
                            kp: current.entityId,
                            t: current.evidenceStartSec,
                          })}
                        >
                          复习巩固
                        </Link>
                        <Link
                          className={styles.jump}
                          to={coursePath(
                            courseId,
                            `/kg/lecture/${current.lectureId}?focus=${encodeURIComponent(current.entityId)}`
                          )}
                        >
                          打开图谱
                        </Link>
                      </div>
                      <p className={p.kbdHint}>
                        {mode === "wrongbook"
                          ? "收藏本：整理笔记 · 圆点跳题 · 可取消收藏或移出"
                          : "快捷键：1–4 选择 · Enter 下一题"}
                      </p>
                    </div>
                  )}
                </div>
              )}
              {!loading && mode === "quiz" && done && (
                <div className={`${styles.answer} ${p.result}`}>
                  <div className={`${styles.ringWrap} ${p.ringCenter}`}>
                    <svg className={styles.ring} viewBox="0 0 36 36" aria-hidden>
                      <path
                        d="M18 2.5a15.5 15.5 0 1 1 0 31 15.5 15.5 0 1 1 0-31"
                        fill="none"
                        stroke="rgba(255,255,255,0.08)"
                        strokeWidth="3"
                      />
                      <path
                        d="M18 2.5a15.5 15.5 0 1 1 0 31 15.5 15.5 0 1 1 0-31"
                        fill="none"
                        stroke={accuracy >= 80 ? "#3ecf8e" : accuracy >= 60 ? "#5b8def" : "#ff6699"}
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeDasharray={`${accuracy}, 100`}
                        transform="rotate(-90 18 18)"
                      />
                    </svg>
                    <div className={styles.ringText}>
                      <strong>{accuracy}%</strong>
                      正确 {correctCount}/{answered}
                      {stats.bestAccuracy > 0 ? ` · 历史最佳 ${stats.bestAccuracy}%` : ""}
                    </div>
                  </div>
                  {wrongItems.length > 0 ? (
                    <>
                      <p className={styles.headLabel}>错题归因</p>
                      <ul className={p.wrongList}>
                        {wrongItems.map((w) => (
                          <li key={w.id} className={p.wrongItem}>
                            <div className={p.wrongTop}>
                              <span className={styles.causeTag}>
                                {w.type === "relation" ? "易混关系" : "概念辨识"}
                              </span>
                              <Link
                                to={coursePath(
                                  courseId,
                                  `/apps/review/${w.lectureId}?kp=${encodeURIComponent(w.entityId)}`
                                )}
                              >
                                去复习
                              </Link>
                            </div>
                            <span>
                              {w.prompt.slice(0, 72)}
                              {w.prompt.length > 72 ? "…" : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className={p.resultLead}>
                      全对，可以换一组继续挑战，或回到复习巩固笔记。
                    </p>
                  )}
                  <div className={p.actions}>
                    {bookEntries.length > 0 && (
                      <button
                        type="button"
                        className={styles.primaryBtn}
                        onClick={openWrongbook}
                      >
                        整理收藏本 · {bookEntries.length}
                      </button>
                    )}
                    {wrongItems.length > 0 && (
                      <button
                        type="button"
                        className={styles.primaryBtn}
                        onClick={() => {
                          newPracticeSessionId();
                          setQuiz(wrongItems);
                          setVerdicts(wrongItems.map(() => null));
                          setPicks(wrongItems.map(() => null));
                          setMode("quiz");
                          setFinished(false);
                          setIdx(0);
                          setPicked(null);
                        }}
                      >
                        本组错题再练
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      onClick={() => void reload(lectureFilter)}
                    >
                      再练一组
                    </button>
                    <Link className={styles.jump} to={coursePath(courseId, "/apps/review/1")}>
                      去复习
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      }
      detail={
        sideOpen ? (
        <aside className={p.side} aria-label="练习辅助">
          <div className={p.sideHeadRow}>
            <p className={p.sideLabel} style={{ margin: 0 }}>
              练习统计
            </p>
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => setSideOpen(false)}
              title="收起右侧栏"
            >
              收起
            </button>
          </div>
          <div className={p.sideCard}>
            <PracticeHistoryPanel stats={stats} />
          </div>

          <p className={p.sideLabel}>本场</p>
          <div className={p.sideCard}>
            <div className={p.sideStat}>
              <span>进度</span>
              <strong>
                {answered}/{quiz.length || "—"}
              </strong>
            </div>
            <div className={p.sideStat}>
              <span>正确率</span>
              <strong>{answered ? `${accuracy}%` : "—"}</strong>
            </div>
            <div className={p.sideStat}>
              <span>历史最佳</span>
              <strong>
                {stats.bestAccuracy > 0 ? `${stats.bestAccuracy}%` : "—"}
              </strong>
            </div>
          </div>
        </aside>
        ) : undefined
      }
    />
  );
}

