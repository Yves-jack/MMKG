import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { packCourseBranches } from "@/lib/kg/compactCourseLayout.mjs";
import styles from "./MindmapTree.module.css";

/** Measure visible text silhouettes, rather than stacking whole subtree rectangles. */
export function CourseBranchColumn({ children, dir, open, compact, onLayout }: {
  children: ReactNode; dir: "ltr" | "rtl"; open: boolean;
  compact: boolean; onLayout?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<ReturnType<typeof packCourseBranches> | null>(null);
  useLayoutEffect(() => {
    const col = ref.current;
    if (!col || !compact || !open) return;
    const rows = Array.from(col.children) as HTMLElement[];
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (!col.offsetWidth || !rows.length) return;
      const branches = rows.map(row => {
        const bounds = row.getBoundingClientRect();
        const scale = bounds.width / row.offsetWidth || 1;
        const local = (value: number) => Math.round(value / scale * 4) / 4;
        const boxes = Array.from(row.querySelectorAll<HTMLElement>('[data-mind-bubble="1"]'))
          .filter(el => el.getClientRects().length > 0)
          .map(el => {
            const r = el.getBoundingClientRect();
            return { x: local(dir === "rtl" ? bounds.right - r.right : r.left - bounds.left),
              y: local(r.top - bounds.top), width: local(r.width), height: local(r.height) };
          });
        const anchor = boxes[0];
        return { width: row.offsetWidth, height: row.offsetHeight,
          anchorY: anchor ? anchor.y + anchor.height / 2 : row.offsetHeight / 2,
          anchorHeight: anchor?.height ?? 24, boxes };
      });
      const next = packCourseBranches(branches);
      setLayout(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    rows.forEach(row => observer.observe(row));
    measure();
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [children, compact, dir, open]);
  useLayoutEffect(() => { onLayout?.(); }, [layout, onLayout]);
  const packed = compact && open && layout && layout.positions.length === (ref.current?.children.length ?? 0) ? layout : null;
  // Row placement uses CSS variables so React still owns every style mutation.
  useLayoutEffect(() => {
    Array.from(ref.current?.children ?? []).forEach((child, i) => {
      const row = child as HTMLElement;
      const pos = packed?.positions[i];
      row.style.setProperty("--course-x", `${pos?.x ?? 0}px`);
      row.style.setProperty("--course-y", `${pos?.y ?? 0}px`);
    });
  }, [packed, children]);
  return <div ref={ref} className={styles.childCol} data-mind-child-col="1"
    data-dir={dir} data-open={open ? "1" : "0"} hidden={!open} aria-hidden={!open}
    data-course-packed={packed ? "1" : undefined}
    style={packed ? { width: packed.width, height: packed.height } : undefined}>
    {children}
  </div>;
}
