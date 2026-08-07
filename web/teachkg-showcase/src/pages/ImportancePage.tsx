import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ResizableShell } from "@/components/pipeline/ResizableShell";
import shell from "@/styles/shell.module.css";
import styles from "./ImportancePage.module.css";

type RankItem = {
  rank: number;
  zh: string;
  name?: string;
  score?: number | null;
  base?: number | null;
  classroom?: number | null;
};

type LectureRow = {
  id: string;
  chapters: { name: string; weight: number }[];
  alpha_used: number;
  jaccard?: number;
  grade: string;
  note: string;
  top: RankItem[];
};

type TocRow = {
  chapter: string;
  keywords: string[];
  hits: { rank: number; zh: string; score?: number }[];
  hit_count: number;
  best_rank: number | null;
};

type Showcase = {
  courseId: string;
  title: string;
  subtitle: string;
  generatedAt: string;
  meta: {
    n_lectures: number;
    entity_count: number;
    alpha: number;
    merge: string;
    method: string;
  };
  grade_counts: Record<string, number>;
  global: { top: RankItem[] };
  lectures: LectureRow[];
  toc: { chapters: TocRow[] };
  notes: string[];
};

type Tab = "global" | "lecture" | "toc";

function fmt(n: number | null | undefined, digits = 3) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function gradeClass(g: string) {
  if (g === "好") return styles.gradeGood;
  if (g === "较好" || g === "中偏上") return styles.gradeOk;
  return styles.gradeMid;
}

function ScoreBars({
  score,
  base,
  classroom,
  maxScore,
}: {
  score?: number | null;
  base?: number | null;
  classroom?: number | null;
  maxScore: number;
}) {
  const s = Math.max(0, Number(score || 0));
  const b = Math.max(0, Number(base || 0));
  const c = Math.max(0, Number(classroom || 0));
  const max = Math.max(maxScore, 1e-6);
  return (
    <div className={styles.bars}>
      <div className={styles.barTrack} title={`综合 ${fmt(s)}`}>
        <div className={styles.barScore} style={{ width: `${(s / max) * 100}%` }} />
      </div>
      <div className={styles.barPair}>
        <div className={styles.barMini} title={`先验 ${fmt(b)}`}>
          <div className={styles.barBase} style={{ width: `${Math.min(100, b * 100)}%` }} />
        </div>
        <div className={styles.barMini} title={`课堂 ${fmt(c)}`}>
          <div className={styles.barClass} style={{ width: `${Math.min(100, c * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}

function RankList({ items, maxScore }: { items: RankItem[]; maxScore: number }) {
  return (
    <ol className={styles.rankList}>
      {items.map((it) => (
        <li key={`${it.rank}-${it.zh}`}>
          <span className={styles.rankNum}>{it.rank}</span>
          <div className={styles.rankBody}>
            <div className={styles.rankHead}>
              <span className={styles.rankZh}>{it.zh}</span>
              <span className={styles.rankScore}>{fmt(it.score)}</span>
            </div>
            <ScoreBars
              score={it.score}
              base={it.base}
              classroom={it.classroom}
              maxScore={maxScore}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ImportancePage() {
  const [data, setData] = useState<Showcase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("global");
  const [lecId, setLecId] = useState<string>("");
  const [liveCtx, setLiveCtx] = useState<{
    version?: number;
    by_context?: Record<
      string,
      { top?: { zh?: string; name?: string; importance?: number; contributions?: Record<string, number> }[] }
    >;
  } | null>(null);

  useEffect(() => {
    fetch("/data/importance_showcase.json")
      .then((r) => {
        if (!r.ok) throw new Error("缺少 importance_showcase.json，请先导出并 sync-data");
        return r.json();
      })
      .then((d: Showcase) => {
        setData(d);
        if (d.lectures?.length) setLecId(d.lectures[0].id);
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  useEffect(() => {
    fetch(`/data/entity_importance_lookup.json?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setLiveCtx(j))
      .catch(() => setLiveCtx(null));
  }, []);

  const lecture = useMemo(
    () => data?.lectures.find((l) => l.id === lecId) || data?.lectures[0],
    [data, lecId]
  );

  const globalMax = data?.global.top[0]?.score || 1;
  const lecMax = lecture?.top[0]?.score || 1;

  const tabTitle =
    tab === "global" ? "课程全局" : tab === "lecture" ? "分讲次" : "对照目录";
  const tabSub =
    tab === "global"
      ? data
        ? `17 讲按时长加权 · ${data.meta.merge}`
        : ""
      : tab === "lecture"
        ? lecture
          ? `α ${fmt(lecture.alpha_used, 2)} · J ${fmt(lecture.jaccard, 2)} · ${lecture.grade}`
          : ""
        : "全局 Top40 对教材目录关键词命中";

  if (error) {
    return (
      <ResizableShell
        storagePrefix="shell-importance"
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
              <h1 className={shell.sideTitle}>重要性</h1>
            </div>
          </aside>
        }
        main={
          <main className={shell.main}>
            <p className="empty-hint">{error}</p>
          </main>
        }
      />
    );
  }

  if (!data) {
    return (
      <ResizableShell
        storagePrefix="shell-importance"
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
              <p className={shell.eyebrow}>Importance</p>
              <h1 className={shell.sideTitle}>实体重要性</h1>
            </div>
          </aside>
        }
        main={
          <main className={shell.main}>
            <p className="empty-hint">加载重要性结果…</p>
          </main>
        }
      />
    );
  }

  return (
    <ResizableShell
      storagePrefix="shell-importance"
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
          <p className={shell.eyebrow}>Importance · Feedback</p>
          <h1 className={shell.sideTitle}>实体重要性</h1>
          <p className={shell.sideLead}>{data.subtitle}</p>
        </div>

        <div className={shell.navBlock}>
          <p className={shell.navLabel}>视图</p>
          {(
            [
              ["global", "课程全局", `${data.global.top.length}`],
              ["lecture", "分讲次", `${data.lectures.length}`],
              ["toc", "对照目录", `${data.toc.chapters.length}`],
            ] as const
          ).map(([id, label, meta]) => (
            <button
              key={id}
              type="button"
              className={tab === id ? shell.navItemActive : shell.navItem}
              onClick={() => setTab(id)}
            >
              <span>{label}</span>
              <em>{meta}</em>
            </button>
          ))}
        </div>

        {tab === "lecture" && (
          <div className={`${shell.navBlock} ${shell.navBlockGrow}`}>
            <p className={shell.navLabel}>讲次</p>
            <div className={shell.navScroll}>
              {data.lectures.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={l.id === lecture?.id ? shell.navItemActive : shell.navItem}
                  onClick={() => setLecId(l.id)}
                >
                  <span>第 {l.id} 讲</span>
                  <em>{l.grade}</em>
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
      }
      main={
      <main className={shell.main}>
        <header className={shell.topbar}>
          <div className={shell.topbarText}>
            <h2>
              {tab === "lecture" && lecture ? `第 ${lecture.id} 讲 · Top` : tabTitle}
            </h2>
            <p>{tabSub}</p>
          </div>

          <div className={shell.stats}>
            <div>
              <strong>{data.meta.n_lectures}</strong>
              <span>讲次</span>
            </div>
            <div>
              <strong>{data.meta.entity_count}</strong>
              <span>实体</span>
            </div>
            <div>
              <strong>{fmt(data.meta.alpha, 2)}</strong>
              <span>α 基准</span>
            </div>
            <div>
              <strong>{Object.values(data.grade_counts).reduce((a, b) => a + b, 0)}</strong>
              <span>已评估</span>
            </div>
          </div>

          <div className={styles.gradeRow}>
            {Object.entries(data.grade_counts).map(([g, n]) => (
              <span key={g} className={`${styles.gradePill} ${gradeClass(g)}`}>
                {g} · {n}
              </span>
            ))}
          </div>
        </header>

        <div className={shell.canvasPlain}>
          <div className={styles.legend}>
            <span>
              <i className={styles.dotScore} /> 综合分
            </span>
            <span>
              <i className={styles.dotBase} /> 教材先验
            </span>
            <span>
              <i className={styles.dotClass} /> 课堂信号
            </span>
            <span className={styles.methodHint}>{data.meta.method}</span>
          </div>

          {tab === "global" && (
            <section className={styles.panel}>
              <RankList items={data.global.top} maxScore={Number(globalMax)} />
              {data.notes?.length > 0 && (
                <ul className={styles.notes}>
                  {data.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "lecture" && lecture && (
            <section className={styles.panel}>
              <div className={styles.chapterChips}>
                {lecture.chapters.map((ch) => (
                  <span key={ch.name} className={styles.chapterChip}>
                    {ch.name}
                    <em>{Math.round(ch.weight * 100)}%</em>
                  </span>
                ))}
              </div>
              <p className={styles.noteLine}>{lecture.note}</p>
              <RankList items={lecture.top} maxScore={Number(lecMax)} />
              {(() => {
                const key = `lecture:${lecture.id}`;
                const tops = liveCtx?.by_context?.[key]?.top || [];
                if (!tops.length) return null;
                return (
                  <div className={styles.liveV2}>
                    <h3>实时 v2 · {key}</h3>
                    <p className={styles.noteLine}>
                      多通道融合（先验 / 时长 / 板书 / 话语 / 结构）· lookup version=
                      {liveCtx?.version ?? "?"}
                    </p>
                    <ol className={styles.rankList}>
                      {tops.slice(0, 12).map((it, i) => {
                        const contrib = it.contributions || {};
                        const parts = Object.entries(contrib)
                          .sort((a, b) => Number(b[1]) - Number(a[1]))
                          .slice(0, 3)
                          .map(([k, v]) => `${k}:${Number(v).toFixed(2)}`)
                          .join(" · ");
                        return (
                          <li key={`${it.name || it.zh}-${i}`}>
                            <span className={styles.rankNum}>{i + 1}</span>
                            <div className={styles.rankBody}>
                              <div className={styles.rankHead}>
                                <span className={styles.rankZh}>
                                  {it.zh || String(it.name || "").split("/")[0]}
                                </span>
                                <span className={styles.rankScore}>
                                  {fmt(it.importance)}
                                </span>
                              </div>
                              {parts ? (
                                <p className={styles.noteLine}>{parts}</p>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                );
              })()}
            </section>
          )}

          {tab === "toc" && (
            <section className={styles.panel}>
              <div className={styles.tocList}>
                {data.toc.chapters.map((row) => (
                  <article key={row.chapter} className={styles.tocCard}>
                    <header>
                      <h3>{row.chapter}</h3>
                      <span
                        className={
                          row.best_rank != null && row.best_rank <= 15
                            ? styles.tocStrong
                            : row.hit_count > 0
                              ? styles.tocOk
                              : styles.tocWeak
                        }
                      >
                        {row.best_rank != null ? `最佳 #${row.best_rank}` : "未命中"}
                      </span>
                    </header>
                    <div className={styles.tocHits}>
                      {row.hits.length === 0 && (
                        <span className={styles.muted}>Top40 中无直接章题命中</span>
                      )}
                      {row.hits.map((h) => (
                        <span key={`${h.rank}-${h.zh}`} className={styles.tocHit}>
                          <b>#{h.rank}</b> {h.zh}
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          <footer className={styles.footer}>
            生成于 {new Date(data.generatedAt).toLocaleString("zh-CN")} · {data.courseId}
          </footer>
        </div>
      </main>
      }
    />
  );
}
