import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captionAt, type AsrCaption } from "@/lib/apps/asrCaptions";
import styles from "./VideoChapterPlayer.module.css";

export type VideoSegment = {
  id: string;
  index: number;
  start_sec: number;
  end_sec: number;
  title: string;
  /** 该段内容摘要/浓缩；悬浮与当前段展示优先用它 */
  summary?: string;
};

type Props = {
  src: string;
  segments?: VideoSegment[];
  durationHint?: number | null;
  seekToSec?: number | null;
  seekNonce?: number;
  className?: string;
  /** 播放进度回调（秒），供演化等联动 */
  onTime?: (sec: number) => void;
  /** 在可拉伸容器内铺满剩余高度 */
  fill?: boolean;
  captions?: AsrCaption[];
};

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** 展示用文案：优先摘要，否则标题 */
export function segmentCaption(seg: VideoSegment | null | undefined): string {
  if (!seg) return "";
  const s = String(seg.summary || "").trim();
  if (s) return s;
  return String(seg.title || "").trim();
}

function isFsActive() {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return Boolean(document.fullscreenElement || doc.webkitFullscreenElement);
}

async function enterFs(el: HTMLElement) {
  const anyEl = el as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
    requestFullscreen?: () => Promise<void>;
  };
  if (anyEl.requestFullscreen) await anyEl.requestFullscreen();
  else if (anyEl.webkitRequestFullscreen) await anyEl.webkitRequestFullscreen();
}

async function exitFs() {
  const doc = document as Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
  };
  if (document.exitFullscreen) await document.exitFullscreen();
  else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
}

export function VideoChapterPlayer({
  src,
  segments = [],
  durationHint,
  seekToSec = null,
  seekNonce = 0,
  className,
  onTime,
  fill = false,
  captions = [],
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const durationRef = useRef(Math.max(0, Number(durationHint) || 0));
  const draggingRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);

  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(Math.max(0, Number(durationHint) || 0));
  const [playing, setPlaying] = useState(false);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showCaptions, setShowCaptions] = useState(true);
  const [liveCaption, setLiveCaption] = useState<AsrCaption | null>(null);

  const ordered = useMemo(
    () => [...segments].sort((a, b) => a.start_sec - b.start_sec),
    [segments]
  );

  const total = useMemo(() => {
    if (duration > 0) return duration;
    if (ordered.length) return Math.max(...ordered.map((s) => s.end_sec), 1);
    return 1;
  }, [duration, ordered]);

  const active = useMemo(() => {
    if (!ordered.length) return null;
    let hit = ordered[0];
    for (const seg of ordered) {
      if (current + 0.05 >= seg.start_sec) hit = seg;
      else break;
    }
    return hit;
  }, [ordered, current]);

  const hoverSeg = useMemo(() => {
    if (hoverSec == null || !ordered.length) return null;
    return (
      ordered.find((s) => hoverSec >= s.start_sec && hoverSec < s.end_sec) ||
      ordered[ordered.length - 1]
    );
  }, [hoverSec, ordered]);

  const updateDuration = useCallback((d: number) => {
    if (!Number.isFinite(d) || d <= 0) return;
    durationRef.current = d;
    setDuration(d);
  }, []);

  const seek = useCallback((sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    const dur =
      Number.isFinite(v.duration) && v.duration > 0
        ? v.duration
        : durationRef.current > 0
          ? durationRef.current
          : 0;
    const t = dur > 0 ? Math.min(Math.max(0, sec), Math.max(0, dur - 0.05)) : Math.max(0, sec);

    const apply = () => {
      try {
        v.currentTime = t;
        setCurrent(v.currentTime || t);
      } catch {
        pendingSeekRef.current = t;
      }
    };

    if (v.readyState >= 1) {
      apply();
      pendingSeekRef.current = null;
    } else {
      pendingSeekRef.current = t;
      const onReady = () => {
        if (pendingSeekRef.current == null) return;
        const want = pendingSeekRef.current;
        pendingSeekRef.current = null;
        v.currentTime = want;
        setCurrent(want);
      };
      v.addEventListener("loadedmetadata", onReady, { once: true });
      v.addEventListener("canplay", onReady, { once: true });
    }
  }, []);

  useEffect(() => {
    setCurrent(0);
    setPlaying(false);
    pendingSeekRef.current = null;
    if (Number(durationHint) > 0) updateDuration(Number(durationHint));
  }, [src, durationHint, updateDuration]);

  useEffect(() => {
    if (seekToSec == null || !Number.isFinite(seekToSec)) return;
    seek(Number(seekToSec));
    void videoRef.current?.play()?.catch(() => undefined);
  }, [seekToSec, seekNonce, seek]);

  const currentRef = useRef(0);
  currentRef.current = current;

  useEffect(() => {
    if (!showCaptions || !captions.length) {
      setLiveCaption(null);
      return;
    }
    let raf = 0;
    let lastKey = "";
    const tick = () => {
      const t = videoRef.current?.currentTime ?? currentRef.current;
      const cap = captionAt(captions, t);
      const key = cap ? `${cap.start}|${cap.text}` : "";
      if (key !== lastKey) {
        lastKey = key;
        setLiveCaption(cap);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [captions, showCaptions, src]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (el.isContentEditable) return;
        if (el.closest('[role="separator"]')) return;
      }
      e.preventDefault();
      const step = e.shiftKey ? 15 : 5;
      const delta = e.key === "ArrowRight" ? step : -step;
      seek(currentRef.current + delta);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seek]);

  useEffect(() => {
    const sync = () => setFullscreen(isFsActive());
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync as EventListener);
    };
  }, []);

  const secFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / width));
      const dur =
        durationRef.current > 0
          ? durationRef.current
          : videoRef.current?.duration && Number.isFinite(videoRef.current.duration)
            ? videoRef.current.duration
            : total;
      return ratio * dur;
    },
    [total]
  );

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const t = secFromClientX(e.clientX);
    setHoverSec(t);
    seek(t);
  };

  const onTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = secFromClientX(e.clientX);
    setHoverSec(t);
    if (draggingRef.current) seek(t);
  };

  const onTrackPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) {
      seek(secFromClientX(e.clientX));
    }
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };

  const toggleFullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    void (async () => {
      try {
        if (isFsActive()) await exitFs();
        else await enterFs(el);
      } catch {
        /* 部分环境无全屏权限 */
      }
    })();
  };

  const playedPct = Math.min(100, (current / Math.max(total, 0.001)) * 100);
  const activeCaption = segmentCaption(active);
  const hoverCaption = segmentCaption(hoverSeg);

  return (
    <div
      className={[styles.wrap, fill ? styles.wrapFill : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        ref={shellRef}
        className={styles.playerShell}
        data-fs={fullscreen ? "1" : "0"}
        onDoubleClick={(e) => {
          e.preventDefault();
          toggleFullscreen();
        }}
      >
        <div className={styles.videoStage}>
          <video
            ref={videoRef}
            key={src}
            className={styles.player}
            src={src}
            preload="auto"
            playsInline
            onClick={togglePlay}
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              setCurrent(t);
              onTime?.(t);
            }}
            onSeeked={(e) => {
              const t = e.currentTarget.currentTime;
              setCurrent(t);
              onTime?.(t);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onLoadedMetadata={(e) => updateDuration(e.currentTarget.duration)}
            onDurationChange={(e) => updateDuration(e.currentTarget.duration)}
          />
          {liveCaption ? (
            <div className={styles.caption} aria-live="polite">
              {liveCaption.text}
            </div>
          ) : null}
        </div>

        <div className={styles.chrome}>
          <div className={styles.progressDock}>
            <div
              ref={trackRef}
              className={styles.progress}
              role="slider"
              aria-label="播放进度"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={current}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") seek(current + 5);
                if (e.key === "ArrowLeft") seek(current - 5);
                if (e.key === " ") {
                  e.preventDefault();
                  togglePlay();
                }
              }}
              onPointerDown={onTrackPointerDown}
              onPointerMove={onTrackPointerMove}
              onPointerUp={onTrackPointerUp}
              onPointerCancel={() => {
                draggingRef.current = false;
              }}
              onLostPointerCapture={() => {
                draggingRef.current = false;
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!draggingRef.current) seek(secFromClientX(e.clientX));
              }}
              onMouseLeave={() => {
                if (!draggingRef.current) setHoverSec(null);
              }}
            >
              <div className={styles.progressBg} />
              <div className={styles.progressPlayed} style={{ width: `${playedPct}%` }} />

              {ordered.map((seg) => {
                if (seg.start_sec <= 0.05) return null;
                const left = (seg.start_sec / Math.max(total, 0.001)) * 100;
                return (
                  <span
                    key={`mark-${seg.id}`}
                    className={styles.chapterMark}
                    style={{ left: `${left}%` }}
                    title={`${fmtTime(seg.start_sec)} ${segmentCaption(seg)}`}
                  />
                );
              })}

              <div className={styles.scrubber} style={{ left: `${playedPct}%` }} />

              {hoverSec != null && (
                <div
                  className={styles.hoverTip}
                  style={{
                    left: `${Math.min(96, Math.max(4, (hoverSec / Math.max(total, 0.001)) * 100))}%`,
                  }}
                >
                  <span>{fmtTime(hoverSec)}</span>
                  {hoverCaption ? <em>{hoverCaption}</em> : null}
                </div>
              )}
            </div>
          </div>

          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={togglePlay}
              aria-label={playing ? "暂停" : "播放"}
            >
              {playing ? "暂停" : "播放"}
            </button>
            <span className={styles.time}>
              {fmtTime(current)} / {fmtTime(total)}
            </span>
            <div className={styles.toolbarEnd}>
              {captions.length ? (
                <button
                  type="button"
                  className={styles.toolBtn}
                  onClick={() => setShowCaptions((v) => !v)}
                  aria-pressed={showCaptions}
                >
                  {showCaptions ? "字幕开" : "字幕关"}
                </button>
              ) : null}
              <button type="button" className={styles.toolBtn} onClick={toggleFullscreen}>
                {fullscreen ? "退出" : "全屏"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
