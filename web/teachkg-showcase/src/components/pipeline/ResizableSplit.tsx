import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import styles from "./ResizableSplit.module.css";

type Props = {
  left: ReactNode;
  right: ReactNode;
  /** 左侧初始占比 0–1（sizedPane=left） */
  initialLeftRatio?: number;
  /** 左侧初始像素宽度（sizedPane=left；优先于 ratio，仅首次无缓存时） */
  initialLeftPx?: number;
  /** 右侧初始像素宽度（sizedPane=right） */
  initialRightPx?: number;
  /** 右侧初始占比（sizedPane=right） */
  initialRightRatio?: number;
  minLeftPx?: number;
  minRightPx?: number;
  /** 哪一侧用固定像素宽控制；另一侧 flex:1 */
  sizedPane?: "left" | "right";
  /** 持久化到 localStorage（存 0–1 比例） */
  storageKey?: string;
  className?: string;
  leftClassName?: string;
  rightClassName?: string;
  /** false 时只显示右侧（无分隔条） */
  enabled?: boolean;
  /** 窄屏改为上下堆叠；≤0 表示永不堆叠，始终左右布局 */
  stackBelowPx?: number;
  /**
   * 堆叠时哪一侧占满剩余高度。
   * second（默认）：上栏受限、下栏伸展
   * first：上栏伸展、下栏受限
   */
  stackGrow?: "first" | "second";
};

function readStoredRatio(key: string | undefined): number | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const v = Number(raw);
    // 兼容旧版存的像素宽（>1）；忽略，下次按默认比例重建
    if (!Number.isFinite(v) || v <= 0) return null;
    if (v > 1) return null;
    return Math.min(0.92, Math.max(0.08, v));
  } catch {
    return null;
  }
}

function writeStoredRatio(key: string | undefined, ratio: number) {
  if (!key) return;
  try {
    localStorage.setItem(key, String(Math.round(ratio * 1000) / 1000));
  } catch {
    /* ignore */
  }
}

/**
 * 左右可拖拽分栏。一侧以像素宽控制，另一侧 flex:1。
 * 比例写入 localStorage；容器尺寸变化时自动重算，避免放缩后撑破布局。
 */
export function ResizableSplit({
  left,
  right,
  initialLeftRatio = 0.5,
  initialLeftPx,
  initialRightPx,
  initialRightRatio = 0.32,
  minLeftPx = 200,
  minRightPx = 240,
  sizedPane = "left",
  storageKey,
  className,
  leftClassName,
  rightClassName,
  enabled = true,
  stackBelowPx = 0,
  stackGrow = "second",
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const ratioRef = useRef(0);
  const [stacked, setStacked] = useState(false);
  const [boxW, setBoxW] = useState(0);
  const [ratio, setRatio] = useState(() => {
    const stored = readStoredRatio(storageKey);
    if (stored != null) return stored;
    if (sizedPane === "right") return initialRightRatio;
    return initialLeftRatio;
  });

  useEffect(() => {
    ratioRef.current = ratio;
  }, [ratio]);

  useEffect(() => {
    if (stackBelowPx <= 0) {
      setStacked(false);
      return;
    }
    const mq = window.matchMedia(`(max-width: ${stackBelowPx}px)`);
    const apply = () => setStacked(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [stackBelowPx]);

  // 跟踪容器宽度；像素初值只在第一次量到宽度时折算成比例
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = (w: number) => {
      if (w < 40) return;
      setBoxW((prev) => (Math.abs(prev - w) < 1 ? prev : w));
    };
    apply(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      apply(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled, stacked]);

  // 无缓存且给了 initial*Px 时，用当前宽度折成比例（仅一次）
  const pxBootstrapped = useRef(false);
  useEffect(() => {
    if (pxBootstrapped.current || boxW < 40) return;
    if (readStoredRatio(storageKey) != null) {
      pxBootstrapped.current = true;
      return;
    }
    if (sizedPane === "right" && initialRightPx != null) {
      setRatio(Math.min(0.92, Math.max(0.08, initialRightPx / boxW)));
      pxBootstrapped.current = true;
    } else if (sizedPane === "left" && initialLeftPx != null) {
      setRatio(Math.min(0.92, Math.max(0.08, initialLeftPx / boxW)));
      pxBootstrapped.current = true;
    } else {
      pxBootstrapped.current = true;
    }
  }, [boxW, storageKey, sizedPane, initialLeftPx, initialRightPx]);

  const softMin = useCallback(
    (total: number) => {
      // 容器变窄时放宽最小值，避免 clamp 无解把一侧压成 0
      const leftMin = Math.min(minLeftPx, Math.max(80, Math.floor(total * 0.18)));
      const rightMin = Math.min(minRightPx, Math.max(80, Math.floor(total * 0.18)));
      return { leftMin, rightMin };
    },
    [minLeftPx, minRightPx]
  );

  const clampPx = useCallback(
    (px: number, total: number) => {
      const { leftMin, rightMin } = softMin(total);
      if (sizedPane === "right") {
        const max = Math.max(rightMin, total - leftMin);
        return Math.max(rightMin, Math.min(max, px));
      }
      const max = Math.max(leftMin, total - rightMin);
      return Math.max(leftMin, Math.min(max, px));
    },
    [sizedPane, softMin]
  );

  const sizedPx =
    boxW > 40 ? clampPx(Math.round(boxW * ratio), boxW) : 0;

  const commitRatio = useCallback(
    (nextPx: number, total: number) => {
      const clamped = clampPx(nextPx, total);
      const nextRatio = total > 0 ? clamped / total : ratioRef.current;
      ratioRef.current = nextRatio;
      setRatio(nextRatio);
      writeStoredRatio(storageKey, nextRatio);
    },
    [clampPx, storageKey]
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current || !boxRef.current) return;
      const rect = boxRef.current.getBoundingClientRect();
      const raw =
        sizedPane === "right" ? rect.right - e.clientX : e.clientX - rect.left;
      commitRatio(raw, rect.width);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [commitRatio, sizedPane]);

  const resetSized = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    const target =
      sizedPane === "right"
        ? initialRightPx != null
          ? initialRightPx
          : Math.round(w * initialRightRatio)
        : initialLeftPx != null
          ? initialLeftPx
          : Math.round(w * initialLeftRatio);
    commitRatio(target, w);
  }, [
    commitRatio,
    sizedPane,
    initialLeftPx,
    initialLeftRatio,
    initialRightPx,
    initialRightRatio,
  ]);

  const onKeyResize = (e: KeyboardEvent) => {
    const el = boxRef.current;
    if (!el) return;
    const step = e.shiftKey ? 40 : 16;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const w = el.getBoundingClientRect().width;
    const delta =
      sizedPane === "right"
        ? e.key === "ArrowLeft"
          ? step
          : -step
        : e.key === "ArrowLeft"
          ? -step
          : step;
    commitRatio(sizedPx + delta, w);
  };

  // 始终保持 [左栏, 分隔条, 右栏] 同一 DOM 顺序，避免 enabled/堆叠切换时卸载右侧（图谱会丢视口）
  const splitActive = enabled && !stacked;
  const stackActive = enabled && stacked;
  const growClass = stackActive
    ? stackGrow === "first"
      ? styles.stackedGrowFirst
      : styles.stackedGrowSecond
    : "";
  const sizedStyle =
    sizedPx > 0
      ? { width: sizedPx, flex: "0 0 auto" as const }
      : { flex: "1 1 50%" as const };
  const hideStyle = {
    display: "none",
    width: 0,
    flex: "0 0 0",
    minWidth: 0,
    overflow: "hidden",
    border: "none",
    padding: 0,
    margin: 0,
  } as const;

  return (
    <div
      ref={boxRef}
      className={`${styles.split} ${!enabled ? styles.single : ""} ${
        stackActive ? `${styles.stacked} ${growClass}` : ""
      } ${className || ""}`.trim()}
    >
      <div
        className={`${styles.pane} ${
          splitActive && sizedPane !== "left" ? styles.paneGrow : ""
        } ${leftClassName || ""}`.trim()}
        style={
          !enabled
            ? hideStyle
            : splitActive && sizedPane === "left"
              ? sizedStyle
              : undefined
        }
        aria-hidden={!enabled}
      >
        {left}
      </div>
      <div
        className={styles.handle}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={sizedPx}
        aria-label="拖动调整栏宽"
        title="拖动调整宽度（双击复位）"
        tabIndex={splitActive ? 0 : -1}
        hidden={!splitActive}
        style={splitActive ? undefined : hideStyle}
        onPointerDown={(e) => {
          if (!splitActive) return;
          dragging.current = true;
          e.preventDefault();
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        onDoubleClick={resetSized}
        onKeyDown={onKeyResize}
      />
      <div
        className={`${styles.pane} ${styles.paneGrow} ${rightClassName || ""}`.trim()}
        style={
          splitActive && sizedPane === "right" ? sizedStyle : undefined
        }
      >
        {right}
      </div>
    </div>
  );
}
