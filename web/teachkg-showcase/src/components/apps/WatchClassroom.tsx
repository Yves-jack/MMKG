import { Link, useLocation } from "react-router-dom";
import {
  isOnReviewPage,
  requestWatchClassroom,
  reviewWatchPath,
  videoLectureId,
  watchClassroomLabel,
} from "@/lib/apps/reviewSeek";
import styles from "./WatchClassroom.module.css";

/** 有秒数才渲染：本讲复习页内 seek，其它页跳到复习页完整课。 */
export function WatchClassroom({
  courseId,
  lectureId,
  startSec,
  entityId,
  className,
  children,
}: {
  courseId: string;
  lectureId: string;
  startSec?: number | null;
  entityId?: string | null;
  className?: string;
  children?: string;
}) {
  const loc = useLocation();
  const sec = Number(startSec);
  const lid = videoLectureId(lectureId);
  if (!courseId || !lid || !Number.isFinite(sec)) return null;

  const label = children || watchClassroomLabel(lid, sec);
  const kp = String(entityId || "").trim() || undefined;
  const cls = className || styles.btn;

  if (isOnReviewPage(loc.pathname)) {
    return (
      <button
        type="button"
        className={cls}
        onClick={() =>
          requestWatchClassroom({ lectureId: lid, startSec: sec, entityId: kp })
        }
      >
        {label}
      </button>
    );
  }

  return (
    <Link
      className={cls}
      to={reviewWatchPath(courseId, lid, { kp, t: sec, lec: lid })}
    >
      {label}
    </Link>
  );
}
