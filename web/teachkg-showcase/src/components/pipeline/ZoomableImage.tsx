import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./ZoomableImage.module.css";

type Props = {
  src: string;
  alt?: string;
  className?: string;
  /** 多图列表；提供后放大态可左右切换 */
  gallery?: string[];
  /** 受控当前下标（与缩略图轮播同步） */
  galleryIndex?: number;
  onGalleryIndexChange?: (index: number) => void;
};

const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ZOOM_FACTOR = 1.12;

function clampZoom(v: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
}

/** 缩略图可点击，全屏遮罩放大查看（Esc / 点背景关闭；多图 ←→；滚轮缩放）。 */
export function ZoomableImage({
  src,
  alt = "image",
  className,
  gallery,
  galleryIndex,
  onGalleryIndexChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const titleId = useId();

  const urls = useMemo(
    () => (gallery?.length ? gallery : src ? [src] : []).filter(Boolean),
    // gallery 引用常变；用内容签名做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [src, gallery?.join("|")]
  );

  const controlled =
    typeof galleryIndex === "number" && typeof onGalleryIndexChange === "function";
  const [localIndex, setLocalIndex] = useState(0);

  const activeIndex = useMemo(() => {
    if (!urls.length) return 0;
    if (controlled) {
      return Math.min(Math.max(0, galleryIndex!), urls.length - 1);
    }
    const fromSrc = urls.indexOf(src);
    const base = fromSrc >= 0 ? fromSrc : localIndex;
    return Math.min(Math.max(0, base), urls.length - 1);
  }, [urls, controlled, galleryIndex, src, localIndex]);

  const displaySrc = urls[activeIndex] || src;
  const canNavigate = urls.length > 1;
  const pageLabel = canNavigate ? `${activeIndex + 1} / ${urls.length}` : "";
  const titleText = pageLabel ? `${alt}（${pageLabel}）` : alt;
  const zoomed = scale > 1.001;

  const resetView = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
  };

  const close = () => {
    setOpen(false);
    resetView();
  };

  const setIndex = (next: number) => {
    if (!urls.length) return;
    const wrapped = ((next % urls.length) + urls.length) % urls.length;
    if (controlled) onGalleryIndexChange!(wrapped);
    else setLocalIndex(wrapped);
    resetView();
  };

  const go = (delta: number) => setIndex(activeIndex + delta);

  useEffect(() => {
    if (!open) return;
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      const prev = scaleRef.current;
      const next = clampZoom(prev * factor);
      const rounded = next <= ZOOM_MIN ? ZOOM_MIN : Math.round(next * 100) / 100;
      scaleRef.current = rounded;
      setScale(rounded);
      if (rounded <= ZOOM_MIN) setOffset({ x: 0, y: 0 });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        resetView();
        return;
      }
      if (!canNavigate || zoomed) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        setIndex(activeIndex - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        setIndex(activeIndex + 1);
      }
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, canNavigate, activeIndex, urls.length, controlled, onGalleryIndexChange, zoomed]);

  useEffect(() => {
    resetView();
  }, [activeIndex, displaySrc]);

  if (!src && !urls.length) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!zoomed || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: offset.x,
      origY: offset.y,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setOffset({
      x: drag.origX + (e.clientX - drag.startX),
      y: drag.origY + (e.clientY - drag.startY),
    });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
    }
  };

  return (
    <>
      <button
        type="button"
        className={`${styles.thumbBtn} ${className || ""}`.trim()}
        onClick={() => setOpen(true)}
        title="点击放大"
        aria-label={`放大查看：${titleText}`}
      >
        <img src={displaySrc || src} alt={alt} className={styles.thumb} />
        <span className={styles.hint} aria-hidden>
          点击放大
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={overlayRef}
            className={styles.overlay}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={close}
          >
            <div className={styles.toolbar} onClick={(e) => e.stopPropagation()}>
              <span id={titleId}>
                {titleText}
              </span>
              <div className={styles.toolbarActions}>
                {zoomed ? (
                  <button
                    type="button"
                    className={styles.closeBtn}
                    onClick={resetView}
                    aria-label="重置缩放"
                    title="重置缩放"
                  >
                    重置
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.closeBtn}
                  onClick={close}
                  aria-label="关闭"
                >
                  关闭 Esc
                </button>
              </div>
            </div>

            <div
              className={styles.stage}
              onClick={(e) => e.stopPropagation()}
            >
              {canNavigate && !zoomed ? (
                <button
                  type="button"
                  className={`${styles.navBtn} ${styles.navPrev}`}
                  onClick={() => go(-1)}
                  aria-label="上一张"
                  title="上一张 ←"
                >
                  ‹
                </button>
              ) : null}
              <img
                src={displaySrc}
                alt={titleText}
                className={`${styles.full} ${zoomed ? styles.fullZoomed : ""}`}
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                }}
                draggable={false}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (zoomed) resetView();
                  else setScale(2);
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
              {canNavigate && !zoomed ? (
                <button
                  type="button"
                  className={`${styles.navBtn} ${styles.navNext}`}
                  onClick={() => go(1)}
                  aria-label="下一张"
                  title="下一张 →"
                >
                  ›
                </button>
              ) : null}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
