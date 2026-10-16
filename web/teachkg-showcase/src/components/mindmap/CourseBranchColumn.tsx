import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { packCourseBranches, courseUnderlineY, courseConnectorBoxes } from "@/lib/kg/compactCourseLayout.mjs";
import styles from "./MindmapTree.module.css";

/** Measure visible text silhouettes, rather than stacking whole subtree rectangles. */
export function CourseBranchColumn({ children, dir, open, compact, onLayout }: {
  children: ReactNode; dir: "ltr" | "rtl"; open: boolean;
  compact: boolean; onLayout?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const measuredRef = useRef("");
  const notifiedRef = useRef(-1);
  const [revision, setRevision] = useState(0);
  const [layout, setLayout] = useState<ReturnType<typeof packCourseBranches> | null>(null);
  useLayoutEffect(() => {
    const col = ref.current;
    if (!col || !compact || !open) return;
    const rows = Array.from(col.children) as HTMLElement[];
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (!col.offsetWidth || !rows.length) return;
      // Descendants settle first; their completion events then wake this parent.
      if (Array.from(col.querySelectorAll<HTMLElement>('[data-course-compact="1"]'))
        .some(el => el.getClientRects().length && el.dataset.courseReady !== "1")) return;
      const branches = rows.map(row => {
        const bounds = row.getBoundingClientRect();
        const computed = getComputedStyle(row);
        const width = parseFloat(computed.width);
        const height = parseFloat(computed.height);
        const scale = bounds.width / width || 1;
        const local = (value: number) => Math.round(value / scale * 4) / 4;
        const rect = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          return { x: local(dir === "rtl" ? bounds.right - r.right : r.left - bounds.left),
            y: local(r.top - bounds.top), width: local(r.width), height: local(r.height) };
        };
        const bubbles = Array.from(row.querySelectorAll<HTMLElement>('[data-mind-bubble="1"]'))
          .filter(el => el.getClientRects().length > 0)
          .map(rect);
        const anchor = bubbles[0];
        const boxes = [...bubbles];
        row.querySelectorAll<HTMLElement>('[data-mind-branch="1"]').forEach(branch => {
          const parentEl = branch.querySelector<HTMLElement>(':scope > [data-mind-branch-main] > [data-mind-bubble]');
          if (!parentEl?.getClientRects().length) return;
          const parent = rect(parentEl);
          branch.querySelectorAll<HTMLElement>(':scope > [data-mind-child-col][data-open="1"]').forEach(childCol => {
            const spineX = rect(childCol).x + 4;
            childCol.querySelectorAll<HTMLElement>(':scope > [data-mind-child-row]').forEach(childRow => {
              const childEl = childRow.querySelector<HTMLElement>(':scope > [data-mind-branch] > [data-mind-branch-main] > [data-mind-bubble]');
              if (!childEl?.getClientRects().length) return;
              const child = rect(childEl);
              boxes.push(...courseConnectorBoxes({ x: parent.x + parent.width,
                y: courseUnderlineY(parent.y, parent.height, parentEl.dataset.kind || "") },
                { x: child.x, y: courseUnderlineY(child.y, child.height, childEl.dataset.kind || "") }, spineX));
            });
          });
        });
        const anchorEl = row.querySelector<HTMLElement>('[data-mind-bubble="1"]');
        return { width: Math.ceil(width), height: Math.ceil(height * 4) / 4,
          anchorY: anchor ? anchor.y + anchor.height / 2 : row.offsetHeight / 2,
          anchorHeight: anchor?.height ?? 24, boxes,
          incoming: anchor ? { x: anchor.x,
            y: courseUnderlineY(anchor.y, anchor.height, anchorEl?.dataset.kind || "") } : undefined };
      });
      const signature = JSON.stringify(branches);
      if (signature === measuredRef.current) return;
      measuredRef.current = signature;
      const next = packCourseBranches(branches);
      setLayout(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      setRevision(value => value + 1);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    rows.forEach(row => observer.observe(row));
    col.addEventListener("course-layout-settled", schedule);
    measure();
    return () => { observer.disconnect(); col.removeEventListener("course-layout-settled", schedule); if (frame) cancelAnimationFrame(frame); };
  }, [children, compact, dir, open]);
  useLayoutEffect(() => { onLayout?.(); }, [layout, revision, onLayout]);
  const packed = compact && open && layout && layout.positions.length === (ref.current?.children.length ?? 0) ? layout : null;
  // Apply row positions before notifying ancestors to remeasure this subtree.
  useLayoutEffect(() => {
    Array.from(ref.current?.children ?? []).forEach((child, i) => {
      const row = child as HTMLElement;
      const pos = packed?.positions[i];
      row.style.setProperty("--course-x", `${pos?.x ?? 0}px`);
      row.style.setProperty("--course-y", `${pos?.y ?? 0}px`);
    });
    if (packed && notifiedRef.current !== revision) {
      notifiedRef.current = revision;
      ref.current?.dispatchEvent(new Event("course-layout-settled", { bubbles: true }));
    }
  }, [packed, children, revision]);
  return <div ref={ref} className={styles.childCol} data-mind-child-col="1"
    data-dir={dir} data-open={open ? "1" : "0"} hidden={!open} aria-hidden={!open}
    data-course-packed={packed ? "1" : undefined}
    data-course-compact={compact ? "1" : undefined} data-course-ready={packed ? "1" : undefined}
    style={packed ? { width: packed.width, height: packed.height } : undefined}>
    {children}
  </div>;
}
