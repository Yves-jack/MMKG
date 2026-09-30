import { useCallback, useEffect, useRef, useState } from "react";
import type { AnimSpec } from "./types";

export type PlayMode = "auto" | "manual";

/** 自动进入即播；每帧完整停顿后再切，避免切在过渡半途 */
export function useAnimPlayer(spec: AnimSpec | null, mode: PlayMode) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speedMs, setSpeedMs] = useState(1600);
  const timer = useRef<number | null>(null);

  const total = spec?.frames.length || 0;
  const frame = spec && total ? spec.frames[Math.min(index, total - 1)] : null;

  const clearTimer = () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const reset = useCallback(() => {
    setIndex(0);
    setPlaying(mode === "auto");
  }, [mode]);

  useEffect(() => {
    setIndex(0);
    setPlaying(mode === "auto");
  }, [spec?.id, mode]);

  useEffect(() => {
    clearTimer();
    if (!playing || !spec || total <= 1) return;
    if (index >= total - 1) {
      setPlaying(false);
      return;
    }
    const dwell = Math.max(1100, speedMs);
    timer.current = window.setTimeout(() => {
      setIndex((i) => Math.min(total - 1, i + 1));
    }, dwell);
    return clearTimer;
  }, [playing, spec?.id, total, speedMs, index]);

  const play = () => {
    if (index >= total - 1) setIndex(0);
    setPlaying(true);
  };
  const pause = () => setPlaying(false);
  const next = () => {
    setPlaying(false);
    setIndex((i) => Math.min(total - 1, i + 1));
  };
  const prev = () => {
    setPlaying(false);
    setIndex((i) => Math.max(0, i - 1));
  };

  return {
    index,
    total,
    frame,
    playing,
    speedMs,
    setSpeedMs,
    play,
    pause,
    next,
    prev,
    reset,
    setIndex,
  };
}
