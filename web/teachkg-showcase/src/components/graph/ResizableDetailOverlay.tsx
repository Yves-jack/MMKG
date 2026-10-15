import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
} from "react";
import shell from "@/styles/shell.module.css";
export function ResizableDetailOverlay({
  children,
  storageKey,
  initialWidth = 340,
  minWidth = 220,
}: {
  children: ReactNode;
  storageKey: string;
  initialWidth?: number;
  minWidth?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(storageKey)) || initialWidth;
    } catch {
      return initialWidth;
    }
  });
  const [maxWidth, setMaxWidth] = useState(640);
  const [top, setTop] = useState(52);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const clamp = (value: number) =>
    Math.max(Math.min(minWidth, maxWidth), Math.min(maxWidth, value));
  useEffect(() => {
    const parent = container.current?.parentElement;
    if (!parent) return;
    const toolbar = parent.querySelector<HTMLElement>("[data-mastery-toolbar]");
    const observer = new ResizeObserver(() => {
      setMaxWidth(Math.max(100, Math.min(640, parent.clientWidth - 24)));
      if (toolbar)
        setTop(
          Math.max(
            52,
            toolbar.getBoundingClientRect().bottom -
              parent.getBoundingClientRect().top +
              8,
          ),
        );
    });
    observer.observe(parent);
    if (toolbar) observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);
  const changeWidth = (value: number) => {
    const next = clamp(value);
    setWidth(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* Optional preference storage. */
    }
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      ref={container}
      className={shell.detailOverlay}
      style={{
        width: clamp(width),
        top,
        maxHeight: `calc(100% - ${top + 80}px)`,
      }}
    >
      <div
        className={shell.detailResizeHandle}
        role="separator"
        aria-label="调整详情栏宽度"
        aria-orientation="vertical"
        tabIndex={0}
        aria-valuemin={Math.min(minWidth, maxWidth)}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.round(clamp(width))}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            width: clamp(width),
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current?.id === event.pointerId)
            changeWidth(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            changeWidth(
              event.key === "Home"
                ? minWidth
                : event.key === "End"
                  ? maxWidth
                  : width + (event.key === "ArrowLeft" ? 24 : -24),
            );
          }
        }}
      />
      <div className={shell.detailOverlayContent}>{children}</div>
    </div>
  );
}
