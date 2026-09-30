import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { loadCoursesIndex, type CourseListItem } from "@/lib/course";
import styles from "./Home.module.css";

export function Home() {
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
