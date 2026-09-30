import { coursePath } from "@/lib/course";

export const WATCH_CLASSROOM_EVENT = "teachkg-watch-classroom";

export type WatchClassroomDetail = {
  lectureId: string;
  startSec: number;
  entityId?: string;
};

export function fmtWatchTime(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function videoLectureId(raw?: string | null): string {
  const s = String(raw || "").trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/(\d+)/);
  return m ? m[1] : s;
}

export function watchClassroomLabel(lectureId: string, sec: number): string {
  const n = videoLectureId(lectureId);
  return /^\d+$/.test(n)
    ? `第 ${n} 讲 · ${fmtWatchTime(sec)}`
    : `看课堂 ${fmtWatchTime(sec)}`;
}

export function reviewWatchPath(
  courseId: string,
  lectureId: string,
  opts: { kp?: string | null; t?: number | null; lec?: string | null } = {}
): string {
  const q = new URLSearchParams();
  const kp = String(opts.kp || "").trim();
  if (kp) q.set("kp", kp);
  const t = Number(opts.t);
  if (Number.isFinite(t)) q.set("t", String(Math.floor(t)));
  const lec = videoLectureId(opts.lec || lectureId);
  if (/^\d+$/.test(lec)) q.set("lec", lec);
  const qs = q.toString();
  return coursePath(
    courseId,
    `/apps/review/${lectureId}${qs ? `?${qs}` : ""}`
  );
}

export function requestWatchClassroom(detail: WatchClassroomDetail) {
  window.dispatchEvent(new CustomEvent(WATCH_CLASSROOM_EVENT, { detail }));
}

export function isOnReviewPage(pathname: string): boolean {
  return /\/apps\/review(?:\/|$)/.test(pathname);
}

export function isReviewLecturePath(pathname: string, lectureId: string): boolean {
  if (isOnReviewPage(pathname)) return true;
  return pathname.includes(`/apps/review/${lectureId}`);
}
