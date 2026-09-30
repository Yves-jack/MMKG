import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimStage } from "@/components/apps/AnimStage";
import { AppsChrome } from "@/components/apps/AppsChrome";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import { regenerateSandbox, randomGraph, type GraphModel } from "@/lib/apps/animate/engines";
import { runAnimatePipeline } from "@/lib/apps/animate/pipeline";
import { useAnimPlayer, type PlayMode } from "@/lib/apps/animate/player";
import { TIER_LABEL } from "@/lib/apps/animate/suitability";
import type { AnimSpec, AnimTier, SuitabilityHit } from "@/lib/apps/animate/types";
import { saveFocus } from "@/lib/apps/focus";
import {
  loadAnimProgress,
  markAnimWatched,
  type AnimProgressStore,
} from "@/lib/apps/localDb";
import { coursePath, useCourseId } from "@/lib/course";
import shell from "@/styles/shell.module.css";
import styles from "./Apps.module.css";
import a from "./Animate.module.css";

const ENGINE_LABEL: Record<string, string> = {
  "graph-bfs": "广度优先",
  "graph-dfs": "深度优先",
  huffman: "哈夫曼树",
  "graph-coloring": "图着色",
  "resolution-trace": "归结示意",
  "generic-steps": "要点分步",
};

const TIER_CLASS: Record<AnimTier, string> = {
  crafted: a.tierCrafted,
  sketch: a.tierSketch,
  skip: a.tierSkip,
};

function etaLabel(sec: number) {
  const m = Math.max(1, Math.round(sec / 60));
  return `约 ${m} 分钟看懂`;
}

/** 动画演示：7 点体验（实例绑定 / 三层叙事 / 沙盘 / 分档 / 闭环 / 今日推荐 / 引擎深度） */
export function AnimatePage() {
  const courseId = useCourseId() || "数理逻辑";
  const [loading, setLoading] = useState(true);
  const [specs, setSpecs] = useState<AnimSpec[]>([]);
  const [skipped, setSkipped] = useState<SuitabilityHit[]>([]);
  const [todayId, setTodayId] = useState<string | null>(null);
  const [progress, setProgress] = useState<AnimProgressStore>({
    courseId,
    watched: {},
    updatedAt: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<"all" | AnimTier>("crafted");
  const [showSkipped, setShowSkipped] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<PlayMode>("auto");
  const [shareHint, setShareHint] = useState<string | null>(null);
  const [sandboxStart, setSandboxStart] = useState("A");
  const [sandboxGraph, setSandboxGraph] = useState<GraphModel | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [result, prog] = await Promise.all([
          runAnimatePipeline(courseId),
          loadAnimProgress(courseId),
        ]);
        if (cancelled) return;
        setSpecs(result.specs);
        setSkipped(result.skipped);
        setTodayId(result.todayId);
        setProgress(prog);
        setActiveId(result.todayId || result.specs[0]?.id || null);
        if (!result.specs.some((s) => s.tier === "crafted")) {
          setTierFilter("all");
        }
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return specs.filter((s) => {
      if (tierFilter !== "all" && s.tier !== tierFilter) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.engine.includes(q) ||
        (s.kpKind || "").includes(q) ||
        s.reason.toLowerCase().includes(q)
      );
    });
  }, [specs, query, tierFilter]);

  const active = useMemo(
    () => specs.find((s) => s.id === activeId) || visible[0] || null,
    [specs, activeId, visible]
  );

  useEffect(() => {
    if (active?.startOptions?.length) {
      setSandboxStart((prev) =>
        active.startOptions!.includes(prev) ? prev : active.startOptions![0]
      );
    }
    // 切换知识点时清空沙盘图，回到引擎默认
    setSandboxGraph(null);
  }, [active?.id]);

  const player = useAnimPlayer(active, mode);

  // 播到最后一帧 → 记进度
  useEffect(() => {
    if (!active || player.total < 1) return;
    if (player.index < player.total - 1) return;
    if (progress.watched[active.id]) return;
    void markAnimWatched(courseId, active.id).then(setProgress);
  }, [active, player.index, player.total, courseId, progress.watched]);

  const watchedCount = useMemo(
    () => specs.filter((s) => progress.watched[s.id]).length,
    [specs, progress]
  );

  const isGraphSandbox = Boolean(
    active &&
      (active.engine === "graph-bfs" ||
        active.engine === "graph-dfs" ||
        active.engine === "graph-coloring")
  );

  const applySpec = (next: AnimSpec) => {
    setSpecs((list) => list.map((s) => (s.id === next.id ? next : s)));
    setActiveId(next.id);
  };

  const onPickStart = (id: string) => {
    if (!active || !isGraphSandbox) return;
    if (mode !== "manual") setMode("manual");
    setSandboxStart(id);
    const next = regenerateSandbox(active, {
      startId: id,
      graph: sandboxGraph || undefined,
    });
    applySpec({ ...next, id: active.id });
  };

  const onShare = async () => {
    if (!active || !player.frame) return;
    const text = [
      `【TeachKG 动画】${active.title}`,
      `第 ${player.index + 1}/${player.total} 步：${player.frame.caption}`,
      player.frame.detail || "",
      `分档：${TIER_LABEL[active.tier]} · ${etaLabel(active.etaSec)}`,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setShareHint("已复制分享文案");
    } catch {
      setShareHint(text.slice(0, 80));
    }
    window.setTimeout(() => setShareHint(null), 2500);
  };

  const goPractice = () => {
    if (!active?.entityId || !active.lectureId) return;
    saveFocus(courseId, {
      lectureId: active.lectureId,
      entityId: active.entityId,
      zh: active.title,
    });
  };

  return (
    <ResizableShell
      storagePrefix="shell-app-animate"
      nav={
        <aside className={shell.sidebar}>
          <div className={shell.sideHead}>
            <Link className={shell.back} to={coursePath(courseId)}>
              <span className={shell.backIcon}>←</span>
              <span className={shell.backBrand}>
                Teach<em>KG</em>
              </span>
            </Link>
            <p className={shell.eyebrow}>动画</p>
            <p className={shell.sideLead}>
              已看 {watchedCount}/{specs.length}
              {skipped.length ? ` · 暂不推荐 ${skipped.length}` : ""}
            </p>
          </div>
          {todayId ? (
            <button
              type="button"
              className={a.todayCard}
              onClick={() => setActiveId(todayId)}
            >
              <span className={a.todayLabel}>今日最值得看</span>
              <span className={a.todayTitle}>
                {specs.find((s) => s.id === todayId)?.title || "—"}
              </span>
            </button>
          ) : null}
          <div className={a.navTools}>
            <div className={a.tierRow}>
              {(["all", "crafted", "sketch"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={tierFilter === t ? styles.chipActive : styles.chip}
                  onClick={() => setTierFilter(t)}
                >
                  {t === "all"
                    ? "全部"
                    : t === "crafted"
                      ? "精制"
                      : "示意"}
                </button>
              ))}
            </div>
            <input
              className={a.search}
              value={query}
              placeholder="筛选知识点…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {loading && <p className={a.empty}>正在判定并生成动画…</p>}
          {!loading && visible.length === 0 && (
            <p className={a.empty}>当前筛选下无动画</p>
          )}
          <ul className={a.list}>
            {visible.map((s) => {
              const on = active?.id === s.id;
              const watched = !!progress.watched[s.id];
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={on ? a.itemOn : a.item}
                    onClick={() => setActiveId(s.id)}
                  >
                    <span className={a.itemTitle}>
                      <span className={TIER_CLASS[s.tier]}>
                        {TIER_LABEL[s.tier]}
                      </span>
                      {s.title}
                    </span>
                    <span className={a.itemMeta}>
                      {ENGINE_LABEL[s.engine] || s.engine}
                      {" · "}
                      {etaLabel(s.etaSec)}
                      {watched ? " · 已看" : ""}
                      {s.usedCourseExample ? " · 课内例" : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {skipped.length > 0 ? (
            <div className={a.skippedBox}>
              <button
                type="button"
                className={styles.jump}
                onClick={() => setShowSkipped((v) => !v)}
              >
                {showSkipped ? "收起" : "查看"}暂不推荐（{skipped.length}）
              </button>
              {showSkipped ? (
                <ul className={a.skippedList}>
                  {skipped.slice(0, 12).map((s) => (
                    <li key={s.entityId}>
                      <strong>{s.knowledgePoint}</strong>
                      <span>{s.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </aside>
      }
      main={
        <main className={styles.page}>
          <AppsChrome
            courseId={courseId}
            lectureId={active?.lectureId}
            title="动画演示"
            extra={
              <div className={a.modeSwitch}>
                <button
                  type="button"
                  className={mode === "auto" ? styles.ghostBtn : styles.jump}
                  onClick={() => setMode("auto")}
                >
                  自动演示
                </button>
                <button
                  type="button"
                  className={mode === "manual" ? styles.ghostBtn : styles.jump}
                  onClick={() => setMode("manual")}
                >
                  手动沙盘
                </button>
              </div>
            }
          />
          <div className={styles.body}>
            <div className={styles.panel}>
              {error && <p className={styles.warn}>{error}</p>}
              {active ? (
                <>
                  <header className={a.kpIntro}>
                    <div className={a.kpIntroTop}>
                      <h3 className={a.heroTitle}>
                        {active.title}
                        <span className={TIER_CLASS[active.tier]}>
                          {TIER_LABEL[active.tier]}
                        </span>
                      </h3>
                      <div className={a.kpMeta}>
                        <span className={a.pillMuted}>
                          {ENGINE_LABEL[active.engine] || active.engine}
                        </span>
                        <span className={a.pillMuted}>
                          {active.frames.length} 步 · {etaLabel(active.etaSec)}
                        </span>
                        {active.usedCourseExample ? (
                          <span className={a.pill}>课内例子</span>
                        ) : active.exampleNote ? (
                          <span className={a.pillMuted}>{active.exampleNote}</span>
                        ) : null}
                      </div>
                    </div>
                    {active.courseQuote ? (
                      <p className={a.kpQuote}>「{active.courseQuote}」</p>
                    ) : active.frames[0]?.definition ? (
                      <p className={a.kpDef}>{active.frames[0].definition}</p>
                    ) : (
                      <p className={a.kpDef}>{active.reason}</p>
                    )}
                  </header>

                  <AnimStage
                    frame={player.frame}
                    specId={active.id}
                    frameKey={`${active.id}-${player.index}`}
                    onNodeClick={
                      isGraphSandbox && mode === "manual"
                        ? (id) => onPickStart(id)
                        : undefined
                    }
                  />

                  <div className={a.scrub}>
                    <div className={a.scrubTrack}>
                      {active.frames.map((f, i) => (
                        <button
                          key={i}
                          type="button"
                          className={
                            i === player.index
                              ? a.scrubOn
                              : i < player.index
                                ? a.scrubDone
                                : a.scrubSeg
                          }
                          title={`${i + 1}. ${f.caption}`}
                          aria-label={`第 ${i + 1} 步：${f.caption}`}
                          onClick={() => {
                            player.pause();
                            player.setIndex(i);
                          }}
                        />
                      ))}
                    </div>
                    <span className={a.stepMark}>
                      {player.index + 1}/{player.total}
                    </span>
                  </div>

                  <div className={a.controls}>
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      onClick={() =>
                        player.playing ? player.pause() : player.play()
                      }
                    >
                      {player.playing ? "暂停" : "播放"}
                    </button>
                    <button type="button" className={styles.jump} onClick={player.prev}>
                      上一步
                    </button>
                    <button type="button" className={styles.jump} onClick={player.next}>
                      下一步
                    </button>
                    <button type="button" className={styles.jump} onClick={player.reset}>
                      重来
                    </button>
                    <label className={a.speed}>
                      速度
                      <input
                        type="range"
                        min={500}
                        max={2200}
                        step={100}
                        value={2700 - player.speedMs}
                        onChange={(e) =>
                          player.setSpeedMs(2700 - Number(e.target.value))
                        }
                      />
                    </label>
                  </div>

                  {mode === "manual" && isGraphSandbox ? (
                    <div className={a.sandbox}>
                      <span className={a.sandboxLabel}>沙盘 · 也可点图中节点设起点</span>
                      {active.startOptions?.length ? (
                        <label className={a.sandboxField}>
                          起点
                          <select
                            value={sandboxStart}
                            onChange={(e) => onPickStart(e.target.value)}
                          >
                            {active.startOptions.map((id) => (
                              <option key={id} value={id}>
                                {id}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      <button
                        type="button"
                        className={styles.jump}
                        onClick={() => {
                          const seed = Date.now();
                          const g = randomGraph(seed);
                          setSandboxGraph(g);
                          const startId = g.nodes.some((n) => n.id === sandboxStart)
                            ? sandboxStart
                            : g.nodes[0]?.id || "A";
                          setSandboxStart(startId);
                          const next = regenerateSandbox(active, {
                            graph: g,
                            startId,
                            seed,
                          });
                          applySpec({ ...next, id: active.id });
                        }}
                      >
                        随机换图
                      </button>
                      <button
                        type="button"
                        className={styles.jump}
                        onClick={() => {
                          setSandboxStart("A");
                          setSandboxGraph(null);
                          const next = regenerateSandbox(active, {
                            randomize: false,
                            startId: "A",
                          });
                          applySpec({ ...next, id: active.id });
                        }}
                      >
                        默认图
                      </button>
                    </div>
                  ) : null}

                  {player.index >= player.total - 1 && player.total > 0 ? (
                    <div className={a.loopBox}>
                      <p className={a.loopTitle}>看懂了？接着练一下</p>
                      <div className={a.loopActions}>
                        <Link
                          className={styles.ghostBtn}
                          to={coursePath(courseId, "/apps/practice")}
                          onClick={goPractice}
                        >
                          去练习
                        </Link>
                        {active.lectureId && active.entityId ? (
                          <Link
                            className={styles.jump}
                            to={coursePath(
                              courseId,
                              `/apps/review/${active.lectureId}?kp=${encodeURIComponent(active.entityId)}`
                            )}
                            onClick={goPractice}
                          >
                            回复习
                          </Link>
                        ) : null}
                        <button
                          type="button"
                          className={styles.jump}
                          onClick={() => void onShare()}
                        >
                          分享这一步
                        </button>
                      </div>
                      {shareHint ? (
                        <p className={a.shareHint}>{shareHint}</p>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <p className={styles.empty}>
                  {loading
                    ? "正在准备今日动画…"
                    : tierFilter === "crafted"
                      ? "暂无精制动画，可切换到「示意」或「全部」"
                      : "左侧选择一个动画"}
                </p>
              )}
            </div>
          </div>
        </main>
      }
    />
  );
}
