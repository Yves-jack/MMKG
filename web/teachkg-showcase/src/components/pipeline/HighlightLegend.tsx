import { type ReactNode } from "react";
import type { PipelineStage } from "@/lib/pipeline/types";
import {
  countFilterMatches,
  countVisibleEdges,
  type HlFilter,
} from "@/lib/pipeline/graphLogic";
import styles from "@/pages/PipelinePage.module.css";

type GroupedFilters = { id: string; label: string; filters: HlFilter[] };

/** 图例中边可见性开关（如 related_with 默认隐藏） */
export type EdgeVisibilityToggle = {
  filterKey: string;
  hidden: boolean;
  count: number;
  onToggle: () => void;
};

type Props = {
  filters: HlFilter[];
  /** 若提供则按分组渲染（课堂 KG） */
  groups?: GroupedFilters[];
  highlightKey: string | null;
  onHighlightKey: (key: string | null) => void;
  stage: PipelineStage;
  mode: string;
  hideFiltered?: boolean;
  /** 处理类计数始终看全量边（含 process_*） */
  countHideFiltered?: boolean;
  /** 覆盖部分图例按钮为显隐开关（计数与点击行为） */
  edgeVisibility?: EdgeVisibilityToggle[];
  className?: string;
};

/** 增量类：实体一行，边类换行 */
const DELTA_SECOND_ROW = new Set(["e_tb", "e_delta", "e_kgc", "e_cross"]);

function FilterButtons({
  filters,
  highlightKey,
  onHighlightKey,
  stage,
  mode,
  hideFiltered,
  countHideFiltered,
  edgeVisibility,
}: {
  filters: HlFilter[];
  highlightKey: string | null;
  onHighlightKey: (key: string | null) => void;
  stage: PipelineStage;
  mode: string;
  hideFiltered: boolean;
  countHideFiltered: boolean;
  edgeVisibility?: EdgeVisibilityToggle[];
}) {
  const visByKey = new Map((edgeVisibility || []).map((v) => [v.filterKey, v]));

  const rendered: ReactNode[] = [];
  let brokeForSecondRow = false;

  for (const f of filters) {
    const vis = visByKey.get(f.key);
    let n = 0;
    if (vis) {
      if (vis.count <= 0) continue;
      n = vis.count;
    } else {
      const useHide = f.group === "处理类" ? false : countHideFiltered;
      n = countFilterMatches(mode, stage, f, useHide);
      if (n <= 0 && f.group === "处理类") continue;
      if (n <= 0 && f.group === "增量类" && f.key === "e_cross") continue;
      if (n <= 0) continue;
    }

    if (
      f.group === "增量类" &&
      DELTA_SECOND_ROW.has(f.key) &&
      !brokeForSecondRow
    ) {
      rendered.push(
        <span key="delta-row-break" className={styles.hlBreak} aria-hidden />
      );
      brokeForSecondRow = true;
    }

    if (vis) {
      rendered.push(
        <button
          key={f.key}
          type="button"
          className={`${styles.hlBtn} ${!vis.hidden ? styles.hlOn : ""}`}
          style={{ ["--hl-color" as string]: f.color }}
          onClick={vis.onToggle}
          title={
            vis.hidden
              ? `已隐藏 ${vis.count} 条 ${f.label}（点击显示）`
              : `当前显示 ${vis.count} 条 ${f.label}（点击隐藏）`
          }
        >
          <i className={styles.dot} style={{ background: f.color }} />
          {f.label}({vis.count})
        </button>
      );
    } else {
      rendered.push(
        <button
          key={f.key}
          type="button"
          className={`${styles.hlBtn} ${highlightKey === f.key ? styles.hlOn : ""}`}
          style={{ ["--hl-color" as string]: f.color }}
          onClick={() => onHighlightKey(highlightKey === f.key ? null : f.key)}
        >
          <i className={styles.dot} style={{ background: f.color }} />
          {f.label}({n})
        </button>
      );
    }
  }

  return <>{rendered}</>;
}

export function HighlightLegend({
  filters,
  groups,
  highlightKey,
  onHighlightKey,
  stage,
  mode,
  hideFiltered = false,
  countHideFiltered,
  edgeVisibility,
  className,
}: Props) {
  const countHide = countHideFiltered ?? hideFiltered;
  const totalEdges = countVisibleEdges(mode, stage, hideFiltered);
  const hasGroups = Boolean(groups?.length);
  const visByKey = new Map((edgeVisibility || []).map((v) => [v.filterKey, v]));

  if (!hasGroups && !filters.length) return null;

  return (
    <div className={className || styles.legend}>
      <button
        type="button"
        className={`${styles.hlBtn} ${!highlightKey ? styles.hlOn : ""}`}
        onClick={() => onHighlightKey(null)}
      >
        全部
      </button>
      {hasGroups
        ? groups!.map((g) => {
            const visible = g.filters.filter((f) => {
              const vis = visByKey.get(f.key);
              if (vis) return vis.count > 0;
              const useHide = f.group === "处理类" ? false : countHide;
              return countFilterMatches(mode, stage, f, useHide) > 0;
            });
            if (!visible.length) return null;
            return (
              <div key={g.id} className={styles.hlGroup}>
                <span className={styles.hlGroupLabel}>{g.label}</span>
                <FilterButtons
                  filters={visible}
                  highlightKey={highlightKey}
                  onHighlightKey={onHighlightKey}
                  stage={stage}
                  mode={mode}
                  hideFiltered={hideFiltered}
                  countHideFiltered={countHide}
                  edgeVisibility={edgeVisibility}
                />
              </div>
            );
          })
        : (
          <FilterButtons
            filters={filters}
            highlightKey={highlightKey}
            onHighlightKey={onHighlightKey}
            stage={stage}
            mode={mode}
            hideFiltered={hideFiltered}
            countHideFiltered={countHide}
            edgeVisibility={edgeVisibility}
          />
        )}
    </div>
  );
}
