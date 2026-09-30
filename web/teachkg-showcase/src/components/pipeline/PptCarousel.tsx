import { useEffect, useId, useState } from "react";
import { ZoomableImage } from "@/components/pipeline/ZoomableImage";
import styles from "./PptCarousel.module.css";

type Props = {
  images: string[];
  alt?: string;
  /** 页码旁文案，如「本堂全部 PPT」 */
  label?: string;
  canDelete?: boolean;
  deleteBusy?: boolean;
  onDelete?: (url: string) => void | Promise<void>;
};

/** 左右翻看多张 PPT / 板书截图；单张时退化为 ZoomableImage。 */
export function PptCarousel({
  images,
  alt = "板书 / PPT",
  label,
  canDelete = false,
  deleteBusy = false,
  onDelete,
}: Props) {
  const urls = images.filter(Boolean);
  const [index, setIndex] = useState(0);
  const labelId = useId();
  const urlsKey = urls.join("|");

  useEffect(() => {
    setIndex((i) => {
      if (!urls.length) return 0;
      return Math.min(i, urls.length - 1);
    });
  }, [urlsKey, urls.length]);

  useEffect(() => {
    if (urls.length <= 1) return;
    const onKey = (e: KeyboardEvent) => {
      // 放大预览由 ZoomableImage 在 capture 阶段处理，避免叠加重跳
      if (e.defaultPrevented) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIndex((i) => (i - 1 + urls.length) % urls.length);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setIndex((i) => (i + 1) % urls.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [urls.length]);

  if (!urls.length) return null;

  const safeIndex = Math.min(index, urls.length - 1);
  const pageLabel = `${safeIndex + 1} / ${urls.length}`;
  const currentUrl = urls[safeIndex];
  const showToolbar = urls.length > 1 || canDelete;

  const go = (delta: number) => {
    setIndex((i) => (i + delta + urls.length) % urls.length);
  };

  const handleDelete = () => {
    if (!onDelete || !currentUrl || deleteBusy) return;
    if (!window.confirm("删除这张 PPT / 板书截图？（可在「已删除」中恢复）")) return;
    void onDelete(currentUrl);
  };

  const image = (
    <ZoomableImage
      src={currentUrl}
      alt={alt}
      gallery={urls.length > 1 ? urls : undefined}
      galleryIndex={urls.length > 1 ? safeIndex : undefined}
      onGalleryIndexChange={urls.length > 1 ? setIndex : undefined}
    />
  );

  if (!showToolbar) {
    return image;
  }

  return (
    <div className={styles.wrap} role="group" aria-labelledby={labelId}>
      <div className={styles.toolbar}>
        <span id={labelId} className={styles.meta}>
          {label ? `${label} · ` : ""}
          {pageLabel}
        </span>
        <div className={styles.nav}>
          {urls.length > 1 ? (
            <>
              <button
                type="button"
                className={styles.navBtn}
                onClick={() => go(-1)}
                aria-label="上一张"
                title="上一张 ←"
              >
                ‹
              </button>
              <button
                type="button"
                className={styles.navBtn}
                onClick={() => go(1)}
                aria-label="下一张"
                title="下一张 →"
              >
                ›
              </button>
            </>
          ) : null}
          {canDelete && onDelete ? (
            <button
              type="button"
              className={styles.delBtn}
              onClick={handleDelete}
              disabled={deleteBusy}
              aria-label="删除当前截图"
              title="删除当前截图"
            >
              删除
            </button>
          ) : null}
        </div>
      </div>
      {image}
    </div>
  );
}
