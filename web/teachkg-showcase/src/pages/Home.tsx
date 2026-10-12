import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { coursePath, loadCoursesIndex, type CourseListItem } from "@/lib/course";
import styles from "./Home.module.css";

const CANVAS_TO_MMKG: Record<string, string> = {
  "92311": "离散数学(图论+数理逻辑与集合论)",
};
const DEFAULT_MMKG_COURSE = "离散数学(图论+数理逻辑与集合论)";

function embeddedCourseTarget(params: URLSearchParams): string | null {
  const embed = String(params.get("embed") || "").trim();
  const canvasId = String(params.get("resource_course_id") || params.get("course_id") || "").trim();
  const kgToken = String(params.get("kg_token") || "").trim();
  if (embed !== "ai-teaching" && !canvasId && !kgToken) return null;
  const mapped = CANVAS_TO_MMKG[canvasId];
  const courseId = mapped || (/^\d+$/.test(canvasId) || !canvasId ? DEFAULT_MMKG_COURSE : canvasId);
  const query = params.toString();
  return `${coursePath(courseId, "/kg/course")}${query ? `?${query}` : ""}`;
}

export function Home() {
  const [searchParams] = useSearchParams();
  const embeddedTarget = embeddedCourseTarget(searchParams);
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCoursesIndex()
      .then((idx) => setCourses(idx.courses || []))
      .catch((e) => setError(String(e.message || e)));
  }, []);

  const sorted = useMemo(
    () =>
      [...courses].sort((a, b) =>
        String(a.title || a.id).localeCompare(String(b.title || b.id), "zh")
      ),
    [courses]
  );

  if (embeddedTarget) {
    return <Navigate to={embeddedTarget} replace />;
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>Knowledge Graph</p>
          <h1 className={styles.brand}>
            Edu<span>KG</span>
          </h1>
          <p className={styles.lead}>课程列表</p>
        </header>

        {error && <p className="empty-hint">{error}</p>}
        {!error && !sorted.length && <p className="empty-hint">加载课程列表…</p>}

        <nav className={styles.courseNav} aria-label="课程列表">
          {sorted.map((c) => (
            <Link key={c.id} to={c.href} className={styles.courseCard}>
              <span className={styles.kicker}>Course</span>
              <span className={styles.title}>{c.title || c.id}</span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
