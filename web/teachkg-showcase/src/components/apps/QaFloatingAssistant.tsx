import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useLocation } from "react-router-dom";
import { LatexText } from "@/components/pipeline/LatexText";
import {
  buildGroundedAnswer,
  detectQaIntent,
  loadReviewIndex,
  loadReviewLecture,
  matchPoint,
  zhName,
  type AppReviewPoint,
  type QaIntent,
} from "@/lib/apps/data";
import { loadFocus, saveFocus } from "@/lib/apps/focus";
import {
  clearQaThread,
  loadQaThread,
  saveQaThread,
  type StoredChatMsg,
} from "@/lib/apps/localDb";
import {
  askQaLlm,
  collectQaContext,
  resolveCitedPoint,
} from "@/lib/apps/qaLlm";
import { decodeCourseId } from "@/lib/course";
import { WatchClassroom } from "@/components/apps/WatchClassroom";
import styles from "./QaFloatingAssistant.module.css";

type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  point?: AppReviewPoint;
  compare?: AppReviewPoint;
  intent?: QaIntent;
  bullets?: string[];
  evidence?: { text: string; start_sec?: number | null; lecture_id?: string }[];
  usedExtra?: boolean;
  pending?: boolean;
};

function toStored(msgs: ChatMsg[]): StoredChatMsg[] {
  return msgs
    .filter((m) => !m.pending)
    .map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      pointId: m.point?.id,
      pointZh: m.point?.zh,
      compareId: m.compare?.id,
      compareZh: m.compare?.zh,
      intent: m.intent,
      bullets: m.bullets,
      evidence: m.evidence,
      usedExtra: m.usedExtra,
    }));
}

function fromStored(msgs: StoredChatMsg[], points: AppReviewPoint[]): ChatMsg[] {
  return msgs.map((m) => {
    const point =
      (m.pointId && matchPoint(points, m.pointId)) ||
      (m.pointZh && matchPoint(points, m.pointZh)) ||
      undefined;
    const compare =
      (m.compareId && matchPoint(points, m.compareId)) ||
      (m.compareZh && matchPoint(points, m.compareZh)) ||
      undefined;
    return {
      id: m.id,
      role: m.role,
      text: m.text,
      point:
        point ||
        (m.pointZh
          ? ({
              id: m.pointId || m.pointZh,
              zh: m.pointZh,
              importance: 0,
              origin: "",
              summary: "",
            } as AppReviewPoint)
          : undefined),
      compare:
        compare ||
        (m.compareZh
          ? ({
              id: m.compareId || m.compareZh,
              zh: m.compareZh,
              importance: 0,
              origin: "",
              summary: "",
            } as AppReviewPoint)
          : undefined),
      intent: (m.intent as QaIntent) || undefined,
      bullets: m.bullets,
      evidence: m.evidence,
      usedExtra: m.usedExtra,
    };
  });
}

function isNoiseMsg(m: StoredChatMsg) {
  if (m.id === "welcome" || m.id === "welcome-focus" || String(m.id).startsWith("welcome-")) {
    return true;
  }
  return m.role === "assistant" && /^可以问|^继续学习「/.test(String(m.text || ""));
}

/** 助手挂在 Routes 外，须从 pathname 解析课程/讲次 */
function courseIdFromPath(pathname: string): string {
  const m = pathname.match(/^\/c\/([^/]+)/);
  return m ? decodeCourseId(m[1]) : "";
}

function lectureFromPath(pathname: string) {
  const review = pathname.match(/\/apps\/review\/(\d+)/);
  if (review) return review[1];
  const kg = pathname.match(/\/kg\/lecture\/(\d+)/);
  if (kg) return kg[1];
  const pipe = pathname.match(/\/pipeline\/(\d+)/);
  if (pipe) return pipe[1];
  const assets = pathname.match(/\/assets\/(\d+)/);
  if (assets) return assets[1];
  return null;
}

type FabPos = { right: number; bottom: number };

const QA_POS_KEY = "teachkg-qa-fab-pos";

function loadFabPos(): FabPos {
  try {
    const raw = localStorage.getItem(QA_POS_KEY);
    if (!raw) return { right: 20, bottom: 20 };
    const p = JSON.parse(raw) as FabPos;
    if (typeof p?.right !== "number" || typeof p?.bottom !== "number") {
      return { right: 20, bottom: 20 };
    }
    return clampFabPos(p);
  } catch {
    return { right: 20, bottom: 20 };
  }
}

function saveFabPos(pos: FabPos) {
  try {
    localStorage.setItem(QA_POS_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

function clampFabPos(pos: FabPos, box?: { w: number; h: number }): FabPos {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  // 始终按 FAB 尺寸夹紧，避免展开面板后改写锚点
  const w = box?.w ?? 48;
  const h = box?.h ?? 48;
  const margin = 8;
  return {
    right: Math.min(Math.max(margin, pos.right), Math.max(margin, vw - w - margin)),
    bottom: Math.min(Math.max(margin, pos.bottom), Math.max(margin, vh - h - margin)),
  };
}

const FAB_SIZE = 48;
const PANEL_GAP = 10;
const PANEL_H_EST = 560;

/** 面板放在 FAB 上方还是下方，避免出屏（不改 FAB 锚点） */
function panelPlacement(pos: FabPos): "above" | "below" {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const spaceAbove = vh - pos.bottom - FAB_SIZE - PANEL_GAP;
  if (spaceAbove >= Math.min(PANEL_H_EST, vh * 0.55)) return "above";
  return "below";
}

/** 各应用内悬浮问答助手 */
export function QaFloatingAssistant() {
  const location = useLocation();
  const courseId = useMemo(
    () => courseIdFromPath(location.pathname),
    [location.pathname]
  );
  const visible = Boolean(courseId);

  const [open, setOpen] = useState(false);
  const [lectures, setLectures] = useState<string[]>([]);
  const [lectureId, setLectureId] = useState("1");
  const [points, setPoints] = useState<AppReviewPoint[]>([]);
  const [query, setQuery] = useState("");
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [asking, setAsking] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<FabPos>(() => loadFabPos());
  const [dragging, setDragging] = useState(false);

  const msgsRef = useRef<ChatMsg[]>([]);
  const threadKeyRef = useRef<string | null>(null);
  const askGenRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originRight: number;
    originBottom: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  msgsRef.current = msgs;

  const clampToViewport = (next: FabPos) =>
    clampFabPos(next, { w: FAB_SIZE, h: FAB_SIZE });

  useEffect(() => {
    const onResize = () => setPos((p) => clampToViewport(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onDragPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // 面板里点到子控件时不拖；FAB 自身可拖
    const t = e.target as HTMLElement;
    const interactive = t.closest("button, select, input, a, textarea");
    if (interactive && interactive !== e.currentTarget) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originRight: pos.right,
      originBottom: pos.bottom,
      moved: false,
    };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onDragPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && dx * dx + dy * dy > 16) d.moved = true;
    if (!d.moved) return;
    e.preventDefault();
    const next = clampToViewport({
      right: d.originRight - dx,
      bottom: d.originBottom - dy,
    });
    setPos(next);
  };

  const onDragPointerUp = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const moved = d.moved;
    dragRef.current = null;
    setDragging(false);
    suppressClickRef.current = moved;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    setPos((p) => {
      const next = clampToViewport(p);
      saveFabPos(next);
      return next;
    });
  };

  const onFabClick = (e: MouseEvent) => {
    // 拖拽结束后的 click 忽略，避免误开合
    if (suppressClickRef.current) {
      e.preventDefault();
      suppressClickRef.current = false;
      return;
    }
    setOpen((v) => !v);
  };

  // 跟随路由/焦点同步默认讲次
  useEffect(() => {
    if (!courseId || !visible) return;
    const fromPath = lectureFromPath(location.pathname);
    const focus = loadFocus(courseId);
    const next = fromPath || focus?.lectureId || "1";
    setLectureId((cur) => (cur === next ? cur : next));
  }, [courseId, visible, location.pathname]);

  useEffect(() => {
    if (!courseId || !visible) return;
    void loadReviewIndex(courseId).then((items) => {
      setLectures(items.map((i) => i.lecture_id));
    });
  }, [courseId, visible]);

  useEffect(() => {
    if (!courseId || !visible) return;
    let cancelled = false;
    const activeCourse = courseId;
    const activeLecture = lectureId;
    const activeKey = `${activeCourse}:${activeLecture}`;

    setHydrated(false);
    threadKeyRef.current = null;
    askGenRef.current += 1;
    setAsking(false);
    setMsgs([]);
    setError(null);

    (async () => {
      const doc = await loadReviewLecture(activeCourse, activeLecture);
      if (cancelled) return;
      const pts = doc?.points || [];
      setPoints(pts);
      const saved = await loadQaThread(activeCourse, activeLecture);
      if (cancelled) return;
      const real = (saved?.msgs || []).filter((m) => !isNoiseMsg(m));
      setMsgs(real.length ? fromStored(real, pts) : []);
      threadKeyRef.current = activeKey;
      setHydrated(true);
    })();

    return () => {
      cancelled = true;
      const snapshot = toStored(msgsRef.current);
      if (snapshot.length) void saveQaThread(activeCourse, activeLecture, snapshot);
      if (threadKeyRef.current === activeKey) threadKeyRef.current = null;
    };
  }, [courseId, lectureId, visible]);

  useEffect(() => {
    if (!hydrated || !courseId) return;
    const key = `${courseId}:${lectureId}`;
    if (threadKeyRef.current !== key) return;
    void saveQaThread(courseId, lectureId, toStored(msgs));
  }, [msgs, hydrated, courseId, lectureId]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, open]);

  const ask = async (raw?: string) => {
    if (!courseId) return;
    const q = (raw ?? query).trim();
    if (!q || asking) return;
    setQuery("");
    setError(null);

    const askGen = ++askGenRef.current;
    const askLecture = lectureId;
    const askCourse = courseId;
    const stillHere = () =>
      askGenRef.current === askGen &&
      threadKeyRef.current === `${askCourse}:${askLecture}`;

    const userMsg: ChatMsg = { id: `u-${Date.now()}`, role: "user", text: q };
    const pendingId = `a-${Date.now()}`;
    const nextIntent = detectQaIntent(q);

    const pair = q.match(
      /^(.+?)\s*(?:和|与|跟|vs\.?|VS|对比|区别于|区别)\s*(.+?)(?:的?区别|有何区别|差异)?$/
    );
    let primary: AppReviewPoint | undefined;
    let secondary: AppReviewPoint | undefined;
    if (pair) {
      primary = matchPoint(points, pair[1].trim());
      secondary = matchPoint(points, pair[2].trim());
    } else {
      const cleaned = q.replace(/^(什么是|是什么|简述|解释)/, "").trim() || q;
      primary = matchPoint(points, cleaned);
    }
    if (primary) {
      saveFocus(courseId, {
        lectureId,
        entityId: primary.id,
        zh: primary.zh,
      });
    }

    const ctxPoints = collectQaContext(points, q, {
      primary: primary || null,
      secondary: secondary || null,
    });
    const history = msgs
      .filter((m) => !m.pending)
      .slice(-6)
      .map((m) => ({ role: m.role, text: m.text }));

    setAsking(true);
    setMsgs((m) => [
      ...m,
      userMsg,
      {
        id: pendingId,
        role: "assistant",
        text: "正在根据本讲课堂材料作答…",
        pending: true,
        intent: nextIntent,
        point: primary,
        compare: secondary,
      },
    ]);

    const localFallback = () => {
      if (primary && secondary) {
        const rels = (primary.neighbors || []).filter(
          (n) =>
            n.subject === secondary!.id ||
            n.object === secondary!.id ||
            zhName(n.subject) === secondary!.zh ||
            zhName(n.object) === secondary!.zh
        );
        return {
          text: `对照「${primary.zh}」与「${secondary.zh}」（本地课堂材料）：`,
          point: primary,
          compare: secondary,
          intent: "relation" as QaIntent,
          bullets: rels.length
            ? rels.map(
                (n) =>
                  n.natural_statement ||
                  `${zhName(n.subject)} —${n.label || n.predicate}→ ${zhName(n.object)}`
              )
            : ["本讲未直接抽出二者之间的边。"],
          evidence: (primary.evidence || []).slice(0, 2).map((e) => ({
            text: e.text || "",
            start_sec: e.start_sec,
            lecture_id: e.lecture_id,
          })),
        };
      }
      if (primary) {
        const ans = buildGroundedAnswer(primary, nextIntent);
        return {
          text: ans.lead,
          point: primary,
          intent: ans.intent,
          bullets: nextIntent === "relation" || nextIntent === "all" ? ans.bullets : [],
          evidence: nextIntent === "lecture" || nextIntent === "all" ? ans.evidence : [],
        };
      }
      return {
        text: `未在第 ${lectureId} 讲命中「${q}」，且大模型不可用。`,
        intent: nextIntent,
      };
    };

    try {
      const llm = await askQaLlm({
        courseId: askCourse,
        lectureId: askLecture,
        question: q,
        intent: nextIntent,
        points: ctxPoints,
        history,
      });
      if (!stillHere()) return;

      if (llm.error || !llm.answer) {
        const fb = localFallback();
        const notice =
          llm.error === "NO_LLM_KEY" || String(llm.error || "").includes("NO_LLM_KEY")
            ? "未配置大模型 Key，已回退课堂材料。"
            : `大模型暂不可用，已回退课堂材料。`;
        setError(notice);
        setMsgs((m) =>
          m.map((msg) =>
            msg.id === pendingId
              ? {
                  id: pendingId,
                  role: "assistant",
                  text: `${fb.text}\n\n（${notice}）`,
                  point: fb.point,
                  compare: fb.compare,
                  intent: fb.intent,
                  bullets: fb.bullets,
                  evidence: fb.evidence,
                }
              : msg
          )
        );
        return;
      }

      const cited = resolveCitedPoint(points, llm.citedConcepts, primary || null);
      if (cited) {
        saveFocus(courseId, {
          lectureId,
          entityId: cited.id,
          zh: cited.zh,
        });
      }
      const evidence =
        (cited || primary)?.evidence
          ?.slice(0, 4)
          .map((e) => ({
            text: e.text || "",
            start_sec: e.start_sec,
            lecture_id: e.lecture_id,
          }))
          .filter((e) => e.text) || [];
      let answerText = llm.answer;
      if (llm.usedExtra && llm.extraNote) {
        answerText = `${answerText}\n\n【课外补充说明】${llm.extraNote}`;
      }
      setMsgs((m) =>
        m.map((msg) =>
          msg.id === pendingId
            ? {
                id: pendingId,
                role: "assistant",
                text: answerText,
                point: cited || primary,
                compare: secondary,
                intent: nextIntent,
                bullets: llm.bullets,
                evidence,
                usedExtra: llm.usedExtra,
              }
            : msg
        )
      );
    } catch (e) {
      if (!stillHere()) return;
      const fb = localFallback();
      const notice = String((e as Error)?.message || e);
      setError(notice);
      setMsgs((m) =>
        m.map((msg) =>
          msg.id === pendingId
            ? {
                id: pendingId,
                role: "assistant",
                text: `${fb.text}\n\n（调用失败：${notice}）`,
                point: fb.point,
                compare: fb.compare,
                intent: fb.intent,
                bullets: fb.bullets,
                evidence: fb.evidence,
              }
            : msg
        )
      );
    } finally {
      if (stillHere()) setAsking(false);
    }
  };

  const clearThread = async () => {
    if (!courseId) return;
    await clearQaThread(courseId, lectureId);
    setMsgs([]);
    setError(null);
  };

  const title = useMemo(() => `第 ${lectureId} 讲问答`, [lectureId]);
  const panelSide = open ? panelPlacement(pos) : "above";

  if (!visible || !courseId) return null;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-open={open ? "1" : "0"}
      data-dragging={dragging ? "1" : "0"}
      data-panel={panelSide}
      style={
        {
          "--qa-right": `${pos.right}px`,
          "--qa-bottom": `${pos.bottom}px`,
        } as CSSProperties
      }
    >
      {open ? (
        <div className={styles.panel} role="dialog" aria-label="图谱问答助手">
          <div
            className={styles.panelHead}
            onPointerDown={onDragPointerDown}
            onPointerMove={onDragPointerMove}
            onPointerUp={onDragPointerUp}
            onPointerCancel={onDragPointerUp}
            title="拖动可移动助手位置"
          >
            <div>
              <strong>问答助手</strong>
              <em>{title}</em>
              <p className={styles.dragHint}>按住此处拖动位置</p>
            </div>
            <div className={styles.panelActions}>
              <select
                className={styles.lecSelect}
                value={lectureId}
                onChange={(e) => setLectureId(e.target.value)}
                aria-label="选择讲次"
              >
                {(lectures.length ? lectures : [lectureId]).map((id) => (
                  <option key={id} value={id}>
                    第 {id} 讲
                  </option>
                ))}
              </select>
              <button type="button" className={styles.iconBtn} onClick={() => void clearThread()}>
                清空
              </button>
              <button type="button" className={styles.iconBtn} onClick={() => setOpen(false)}>
                收起
              </button>
            </div>
          </div>
          <div className={styles.chat}>
            {!msgs.length && !asking ? (
              <p className={styles.empty}>围绕本讲课堂内容提问</p>
            ) : null}
            {msgs.map((msg) =>
              msg.role === "user" ? (
                <div key={msg.id} className={styles.bubbleUser}>
                  {msg.text}
                </div>
              ) : (
                <div key={msg.id} className={styles.bubbleBot}>
                  {msg.pending && <p className={styles.muted}>生成中…</p>}
                  {msg.usedExtra && <p className={styles.extraTag}>含课外补充</p>}
                  {msg.point && !msg.compare ? <h4>{msg.point.zh}</h4> : null}
                  <p>
                    <LatexText text={msg.text} />
                  </p>
                  {msg.evidence && msg.evidence.length > 0 ? (
                    <div className={styles.evidence}>
                      {msg.evidence.slice(0, 2).map((e, i) => (
                        <p key={i}>
                          <LatexText text={e.text || ""} />
                          <WatchClassroom
                            courseId={courseId}
                            lectureId={String(e.lecture_id || lectureId)}
                            startSec={e.start_sec}
                            entityId={msg.point?.id}
                          />
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            )}
            <div ref={bottomRef} />
          </div>
          <div className={styles.composer}>
            <input
              value={query}
              placeholder="输入问题…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void ask()}
            />
            <button type="button" className={styles.sendBtn} disabled={asking} onClick={() => void ask()}>
              {asking ? "…" : "发送"}
            </button>
          </div>
          {error ? <p className={styles.err}>{error}</p> : null}
        </div>
      ) : null}
      <button
        type="button"
        className={styles.fab}
        aria-expanded={open}
        title="拖动调整位置 · 点击打开问答"
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
        onPointerCancel={onDragPointerUp}
        onClick={onFabClick}
      >
        {open ? "×" : "问"}
      </button>
    </div>
  );
}
