import { useEffect, useMemo, useState } from "react";
import {
  VideoChapterPlayer,
  type VideoSegment,
} from "@/components/review/VideoChapterPlayer";
import { loadReviewLecture } from "@/lib/apps/data";
import { enrichVideoSegments } from "@/lib/apps/enrichVideoSegments";
import { toMediaUrl } from "@/lib/kg/adaptToPipeline";
import styles from "./LessonVideoStrip.module.css";

/** 应用内嵌的课中视频条：证据 / 演化节拍可直接 scrub */
export function LessonVideoStrip({
  courseId,
  lectureId,
  seekToSec,
  seekNonce = 0,
  compact = true,
  onTime,
  defaultOpen = false,
  autoOpenOnSeek = true,
}: {
  courseId: string;
  lectureId: string;
  seekToSec?: number | null;
  seekNonce?: number;
  compact?: boolean;
  onTime?: (sec: number) => void;
  defaultOpen?: boolean;
  autoOpenOnSeek?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [rawSegments, setRawSegments] = useState<VideoSegment[]>([]);
  const [points, setPoints] = useState<
    {
      zh: string;
      importance?: number;
      summary?: string;
      definition?: string;
      evidence?: { start_sec?: number | null }[];
    }[]
  >([]);
  const [duration, setDuration] = useState<number | null>(null);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!autoOpenOnSeek) return;
    if (seekNonce && seekToSec != null && Number.isFinite(seekToSec)) setOpen(true);
  }, [seekNonce, seekToSec, autoOpenOnSeek]);

  useEffect(() => {
    let cancelled = false;
    loadReviewLecture(courseId, lectureId).then((doc) => {
      if (cancelled || !doc) {
        setSrc(null);
        return;
      }
      setSrc(toMediaUrl(doc.class_video || null));
      setRawSegments(doc.segments || []);
      setPoints(doc.points || []);
      setDuration(doc.duration_sec ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [courseId, lectureId]);

  const segments = useMemo(
    () => enrichVideoSegments(rawSegments, points),
    [rawSegments, points]
  );

  const label = useMemo(() => {
    if (seekToSec == null || !Number.isFinite(seekToSec)) return "课中视频";
    const s = Math.floor(seekToSec);
    return `课中视频 · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, [seekToSec]);

  if (!src) return null;

  return (
    <div className={compact ? styles.wrapCompact : styles.wrap}>
      <div className={styles.head}>
        <span>{label}</span>
        <button type="button" className={styles.toggle} onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "展开"}
        </button>
      </div>
      {open && (
        <VideoChapterPlayer
          src={src}
          segments={segments}
          durationHint={duration}
          seekToSec={seekToSec ?? null}
          seekNonce={seekNonce}
          className={styles.player}
          onTime={onTime}
        />
      )}
    </div>
  );
}
