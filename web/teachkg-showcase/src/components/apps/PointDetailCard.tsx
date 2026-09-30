import { LatexText } from "@/components/pipeline/LatexText";
import { WatchClassroom } from "@/components/apps/WatchClassroom";
import { zhName, type AppReviewPoint } from "@/lib/apps/data";
import styles from "@/pages/apps/Apps.module.css";

export function PointDetailCard({
  courseId,
  lectureId,
  point,
  showEvidence = true,
  compact = false,
}: {
  courseId: string;
  lectureId: string;
  point: AppReviewPoint;
  showEvidence?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={styles.answer}>
      <h3>{point.zh}</h3>
      <p>
        <LatexText text={point.summary || point.definition || ""} />
      </p>
      {!compact && point.definition && point.definition !== point.summary && (
        <p>
          <LatexText text={point.definition} />
        </p>
      )}
      {!compact && (point.neighbors || []).length > 0 && (
        <ul>
          {(point.neighbors || []).slice(0, 6).map((n, i) => (
            <li key={i}>
              {n.natural_statement ||
                `${zhName(n.subject)} —${n.label || n.predicate}→ ${zhName(n.object)}`}
            </li>
          ))}
        </ul>
      )}
      {showEvidence && (point.evidence || []).slice(0, 2).map((e, i) => (
        <p key={i} className={styles.muted}>
          <LatexText text={e.text || ""} />
          {e.start_sec != null && (
            <WatchClassroom
              courseId={courseId}
              lectureId={String(e.lecture_id || lectureId)}
              startSec={e.start_sec}
              entityId={point.id}
            />
          )}
        </p>
      ))}
    </div>
  );
}
