import type { CSSProperties } from "react";
import { masteryVisual } from "@/lib/kg/mindmapMasteryBinding.mjs";
import { MasteryEntityDetails } from "./MasteryEntityDetails";
import styles from "./MasteryNodeDetails.module.css";

export function MasteryNodeSummary({
  label,
  node,
  courseId,
  score,
  scope,
  onClose,
}: {
  label: string;
  node: { id: string; zh: string };
  courseId: string;
  score: number | undefined;
  scope: "personal" | "class_average";
  onClose: () => void;
}) {
  const visual = masteryVisual(score);
  return (
    <section
      className={styles.summary}
      style={{ "--score-color": visual.color } as CSSProperties}
    >
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>知识点详情</p>
          <h3 className={styles.title}>{label}</h3>
        </div>
        <button
          className={styles.close}
          type="button"
          aria-label="收起详情"
          title="关闭详情"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className={styles.metric}>
        <div>
          <p className={styles.metricLabel}>
            {scope === "class_average" ? "全班平均掌握度" : "我的掌握度"}
          </p>
          <span className={styles.score}>
            {score == null ? "待评估" : score.toFixed(2)}
          </span>
          {score != null ? <span className={styles.total}> / 5</span> : null}
        </div>
        <span className={styles.status}>{visual.label.split(" · ")[0]}</span>
      </div>
      {score != null ? (
        <div
          className={styles.progress}
          role="meter"
          aria-label="掌握程度"
          aria-valuemin={0}
          aria-valuemax={5}
          aria-valuenow={score}
        >
          <span style={{ width: `${(score / 5) * 100}%` }} />
        </div>
      ) : (
        <p className={styles.emptyScore}>完成练习后查看掌握程度</p>
      )}
      <MasteryEntityDetails courseId={courseId} node={node} />
    </section>
  );
}
