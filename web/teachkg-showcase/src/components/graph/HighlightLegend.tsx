import { useEffect, useMemo, useRef, useState } from "react";
import type { PipelineStage } from "@/lib/graph/types";
import {
  countFilterMatches,
  countVisibleEdges,
  legendSwatchColor,
  type HlFilter,
} from "@/lib/graph/graphLogic";
import styles from "./HighlightLegend.module.css";

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

function filterCount(
  f: HlFilter,
  mode: string,
  stage: PipelineStage,
  countHide: boolean,
  vis?: EdgeVisibilityToggle,
) {
  if (vis) return vis.count;
  const useHide = f.group === "处理类" ? false : countHide;
  return countFilterMatches(mode, stage, f, useHide);
}

function isShown(f: HlFilter, n: number) {
  if (n <= 0 && f.group === "处理类") return false;
  if (n <= 0 && f.group === "增量类" && f.key === "e_cross") return false;
  return n > 0;
}

function ItemRow({
  f,
  n,
  vis,
  highlightKey,
  onHighlightKey,
  close,
}: {
  f: HlFilter;
  n: number;
  vis?: EdgeVisibilityToggle;
  highlightKey: string | null;
  onHighlightKey: (key: string | null) => void;
  close: () => void;
}) {
  const swatch = legendSwatchColor(f);
  if (vis) {
    return (
      <button
        type="button"
        className={`${styles.item} ${!vis.hidden ? styles.itemOn : styles.itemMuted}`}
        style={{ ["--hl-color" as string]: swatch }}
        onClick={vis.onToggle}
        title={
          vis.hidden
            ? `已隐藏 ${vis.count} 条 ${f.label}（点击显示）`
            : `当前显示 ${vis.count} 条 ${f.label}（点击隐藏）`
        }
      >
        <i className={styles.dot} style={{ background: swatch }} />
        <span className={styles.label}>{f.label}</span>
        <span className={styles.count}>{vis.count}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`${styles.item} ${highlightKey === f.key ? styles.itemOn : ""}`}
      style={{ ["--hl-color" as string]: swatch }}
      onClick={() => {
        onHighlightKey(highlightKey === f.key ? null : f.key);
        close();
      }}
    >
      <i className={styles.dot} style={{ background: swatch }} />
      <span className={styles.label}>{f.label}</span>
      <span className={styles.count}>{n}</span>
    </button>
  );
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
}: Props) {
  const countHide = countHideFiltered ?? hideFiltered;
  const totalEdges = countVisibleEdges(mode, stage, hideFiltered);
  const visByKey = useMemo(
    () => new Map((edgeVisibility || []).map((v) => [v.filterKey, v])),
    [edgeVisibility],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const grouped = Boolean(groups?.length);

  const visibleGroups = useMemo(() => {
    if (!groups?.length) return [];
    return groups
      .map((g) => ({
        ...g,
        filters: g.filters.filter((f) => {
          const n = filterCount(f, mode, stage, countHide, visByKey.get(f.key));
          return isShown(f, n);
        }),
      }))
      .filter((g) => g.filters.length > 0);
  }, [groups, mode, stage, countHide, visByKey]);

  const flatItems = useMemo(
    () =>
      filters.filter((f) => {
        const n = filterCount(f, mode, stage, countHide, visByKey.get(f.key));
        return isShown(f, n);
      }),
    [filters, mode, stage, countHide, visByKey],
  );

  const activeLabel = useMemo(() => {
    if (!highlightKey) return null;
    const pool = grouped ? visibleGroups.flatMap((g) => g.filters) : flatItems;
    return pool.find((f) => f.key === highlightKey)?.label || null;
  }, [highlightKey, grouped, visibleGroups, flatItems]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setOpenGroup(null);
      return;
    }
    if (!grouped) return;
    if (highlightKey) {
      const g = visibleGroups.find((x) => x.filters.some((f) => f.key === highlightKey));
      if (g) setOpenGroup(g.id);
      return;
    }
    if (visibleGroups[0]) setOpenGroup(visibleGroups[0].id);
  }, [open, highlightKey, grouped, visibleGroups]);

  if (grouped ? !visibleGroups.length : !flatItems.length) return null;

  const submenu = grouped
    ? visibleGroups.find((g) => g.id === openGroup)?.filters || []
    : [];
  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={styles.trigger}
        data-open={open ? "true" : "false"}
        onClick={() => {
          setOpen((v) => {
            const next = !v;
            if (next && grouped && visibleGroups[0]) setOpenGroup(visibleGroups[0].id);
            return next;
          });
        }}
        title={totalEdges ? `图例 · ${totalEdges} 条可见边` : "图例"}
      >
        图例
        {activeLabel ? <span className={styles.badge}>{activeLabel}</span> : null}
        <i className={styles.chevron} aria-hidden />
      </button>

      {open && grouped ? (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            className={`${styles.item} ${!highlightKey ? styles.itemOn : ""}`}
            onClick={() => {
              onHighlightKey(null);
              close();
            }}
          >
            <i className={styles.dot} style={{ background: legendSwatchColor({ key: "all", label: "全部", color: "#34d399", nodeKinds: ["textbook"] }) }} />
            <span className={styles.label}>全部</span>
            {totalEdges > 0 ? <span className={styles.count}>{totalEdges}</span> : null}
          </button>
          {visibleGroups.map((g) => {
            const on = g.filters.some((f) => f.key === highlightKey);
            const groupColor = g.filters[0] ? legendSwatchColor(g.filters[0]) : "#047857";
            return (
              <button
                key={g.id}
                type="button"
                className={`${styles.item} ${on ? styles.itemOn : ""}`}
                data-open={openGroup === g.id ? "true" : "false"}
                style={{ ["--hl-color" as string]: groupColor }}
                onMouseEnter={() => setOpenGroup(g.id)}
                onFocus={() => setOpenGroup(g.id)}
                onClick={() => setOpenGroup(g.id)}
              >
                <i
                  className={styles.dot}
                  style={{ background: groupColor }}
                />
                <span className={styles.label}>{g.label}</span>
                <i className={styles.fly} aria-hidden />
              </button>
            );
          })}
        </div>
      ) : null}

      {open && grouped && submenu.length ? (
        <div className={styles.menu} role="menu">
          {submenu.map((f) => (
            <ItemRow
              key={f.key}
              f={f}
              n={filterCount(f, mode, stage, countHide, visByKey.get(f.key))}
              vis={visByKey.get(f.key)}
              highlightKey={highlightKey}
              onHighlightKey={onHighlightKey}
              close={close}
            />
          ))}
        </div>
      ) : null}

      {open && !grouped ? (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            className={`${styles.item} ${!highlightKey ? styles.itemOn : ""}`}
            onClick={() => {
              onHighlightKey(null);
              close();
            }}
          >
            <i className={styles.dot} style={{ background: legendSwatchColor({ key: "all", label: "全部", color: "#34d399", nodeKinds: ["textbook"] }) }} />
            <span className={styles.label}>全部</span>
            {totalEdges > 0 ? <span className={styles.count}>{totalEdges}</span> : null}
          </button>
          {flatItems.map((f) => (
            <ItemRow
              key={f.key}
              f={f}
              n={filterCount(f, mode, stage, countHide, visByKey.get(f.key))}
              vis={visByKey.get(f.key)}
              highlightKey={highlightKey}
              onHighlightKey={onHighlightKey}
              close={close}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
