import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./ZoomableImage.module.css";

type Props = {
  src: string;
  alt?: string;
  className?: string;
};

/** 缩略图可点击，全屏遮罩放大查看（Esc / 点背景关闭）。 */
export function ZoomableImage({ src, alt = "image", className }: Props) {
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!src) return null;

  return (
    <>
      <button
        type="button"
        className={`${styles.thumbBtn} ${className || ""}`.trim()}
        onClick={() => setOpen(true)}
        title="点击放大"
        aria-label={`放大查看：${alt}`}
      >
        <img src={src} alt={alt} className={styles.thumb} />
        <span className={styles.hint} aria-hidden>
          点击放大
        </span>
      </button>

      {open &&
        createPortal(
          <div
            className={styles.overlay}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={() => setOpen(false)}
          >
            <div className={styles.toolbar}>
              <span id={titleId}>{alt}</span>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={() => setOpen(false)}
                aria-label="关闭"
              >
                关闭 Esc
              </button>
            </div>
            <img
              src={src}
              alt={alt}
              className={styles.full}
              onClick={(e) => e.stopPropagation()}
            />
          </div>,
          document.body
        )}
    </>
  );
}
