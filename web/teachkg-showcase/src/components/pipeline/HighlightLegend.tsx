import type { PipelineStage } from "@/lib/pipeline/types";
import {
  countFilterMatches,
  countVisibleEdges,
  type HlFilter,
} from "@/lib/pipeline/graphLogic";
import styles from "@/pages/PipelinePage.module.css";

type Props = {
  filters: HlFilter[];
  highlightKey: string | null;
  onHighlightKey: (key: string | null) => void;
  stage: PipelineStage;
  mode: string;
  hideFiltered?: boolean;
  /** 额外 class，便于 Textbook 页复用自己的 legend 容器样式时可覆盖 */
  className?: string;
};

export function HighlightLegend({
  filters,
  highlightKey,
  onHighlightKey,
  stage,
  mode,
  hideFiltered = false,
  className,
}: Props) {
  if (!filters.length) return null;
  const totalEdges = countVisibleEdges(mode, stage, hideFiltered);

  return (
    <div className={className || styles.legend}>
      <span className={styles.hlHint}>点击高亮</span>
      <button
        type="button"
        className={`${styles.hlBtn} ${!highlightKey ? styles.hlOn : ""}`}
        onClick={() => onHighlightKey(null)}
      >
        全部 · {totalEdges}
      </button>
      {filters.map((f) => {
        const n = countFilterMatches(mode, stage, f, hideFiltered);
        return (
          <button
            key={f.key}
            type="button"
            className={`${styles.hlBtn} ${highlightKey === f.key ? styles.hlOn : ""}`}
            style={{ ["--hl-color" as string]: f.color }}
            onClick={() => onHighlightKey(highlightKey === f.key ? null : f.key)}
          >
            <i className={styles.dot} style={{ background: f.color }} />
            {f.label} · {n}
          </button>
        );
      })}
    </div>
  );
}
