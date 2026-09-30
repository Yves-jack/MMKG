import { useMemo, useState } from "react";
import {
  formatSessionCount,
  summarizePracticeRange,
  type PracticeRange,
  type PracticeStats,
} from "@/lib/apps/progress";
import styles from "./PracticeHistoryPanel.module.css";

const RANGES: { id: PracticeRange; label: string }[] = [
  { id: "day", label: "日" },
  { id: "week", label: "周" },
  { id: "month", label: "月" },
  { id: "year", label: "年" },
];

export function PracticeHistoryPanel({ stats }: { stats: PracticeStats }) {
  const [range, setRange] = useState<PracticeRange>("day");
  const summary = useMemo(
    () => summarizePracticeRange(stats, range),
    [stats, range]
  );
  const maxSessions = Math.max(1, ...summary.buckets.map((b) => b.sessions));
  const hasDiff = summary.byDifficulty.some((d) => d.answered > 0);

  return (
    <div className={styles.root}>
      <div className={styles.tabs}>
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            className={range === r.id ? styles.tabOn : styles.tab}
            onClick={() => setRange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <p className={styles.title}>{summary.title}</p>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <strong>{formatSessionCount(summary.sessions)}</strong>
          <span>练习组数</span>
        </div>
        <div className={styles.stat}>
          <strong>{summary.answered}</strong>
          <span>作答题数</span>
        </div>
        <div className={styles.stat}>
          <strong>{summary.answered ? `${summary.accuracy}%` : "—"}</strong>
          <span>正确率</span>
        </div>
        {range !== "day" ? (
          <div className={styles.stat}>
            <strong>{summary.activeDays}</strong>
            <span>活跃天数</span>
          </div>
        ) : null}
      </div>

      <p className={styles.subTitle}>难度情况</p>
      {hasDiff ? (
        <div className={styles.diffCounts}>
          {summary.byDifficulty.map((d) => (
            <div key={d.key} className={styles.diffCount}>
              <span className={`${styles.diffTag} ${styles[`diff_${d.key}`]}`}>
                {d.label}
              </span>
              <strong>{d.answered}</strong>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.diffEmpty}>开始答题后，难度统计会实时更新</p>
      )}

      <div className={styles.chart} aria-label="练习数量趋势">
        {summary.buckets.map((b) => (
          <div
            key={b.key}
            className={styles.barCol}
            title={`${b.label} · ${formatSessionCount(b.sessions)} 组`}
          >
            <div className={styles.barTrack}>
              <div
                className={styles.barFill}
                style={{
                  height: `${Math.max(
                    b.sessions ? 12 : 0,
                    (b.sessions / maxSessions) * 100
                  )}%`,
                }}
              />
            </div>
            <span className={styles.barLabel}>{b.label}</span>
            <span className={styles.barVal}>
              {b.sessions ? formatSessionCount(b.sessions) : ""}
            </span>
          </div>
        ))}
      </div>

      <ul className={styles.list}>
        {[...summary.buckets]
          .reverse()
          .filter((b) => b.sessions > 0)
          .slice(0, 8)
          .map((b) => (
            <li key={b.key} className={styles.row}>
              <span className={styles.rowLabel}>{b.label}</span>
              <span className={styles.rowMeta}>
                {formatSessionCount(b.sessions)} 组 · {b.answered} 题 ·{" "}
                {b.accuracy}%
              </span>
            </li>
          ))}
        {!summary.buckets.some((b) => b.sessions > 0) ? (
          <li className={styles.empty}>这段时间还没有练习记录</li>
        ) : null}
      </ul>
    </div>
  );
}
