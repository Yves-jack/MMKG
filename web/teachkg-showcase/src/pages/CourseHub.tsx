import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { loadManifest, withCourseHref, type Manifest, type ManifestItem } from "@/lib/catalog";
import { useCourseId } from "@/lib/course";
import styles from "./Home.module.css";

const FEATURES = [
  {
    type: "review",
    kicker: "Review",
    title: "单课复习",
    desc: "课堂复习整理",
    fallback: "/apps/review/1",
  },
  {
    type: "classroom_kg",
    kicker: "Knowledge Graph",
    title: "课堂知识图谱",
    desc: "整课与课次图谱",
    fallback: "/kg/course",
  },
  {
    type: "mindmap",
    kicker: "Mindmap",
    title: "知识导图",
    desc: "整课树状浏览",
    fallback: "/mindmap",
  },
  {
    type: "assets",
    kicker: "Assets",
    title: "资产库",
    desc: "课堂资产",
    fallback: "/assets/1",
  },
] as const;

function fallbackItem(
  courseId: string,
  type: string,
  title: string,
  fallback: string,
  scope?: ManifestItem["scope"]
): ManifestItem {
  return {
    id: `${type}_entry`,
    type:
      type === "classroom_kg"
        ? "mmkg"
        : (type as ManifestItem["type"]),
    group: title,
    title,
    href: withCourseHref(courseId, fallback),
    dataUrl: "",
    scope: scope || "course",
  };
}

/** 课内门户：仅四块展示入口 */
export function CourseHub() {
  const courseId = useCourseId();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!courseId) return;
    setManifest(null);
    setError(null);
    loadManifest(courseId)
      .then(setManifest)
      .catch((e) => setError(String(e.message || e)));
  }, [courseId]);

  const byType = useMemo(() => {
    const m = new Map<string, ManifestItem>();
    if (!courseId) return m;

    for (const it of manifest?.items || []) {
      if (it.type.includes("kg")) {
        if (!m.has("classroom_kg")) {
          m.set("classroom_kg", {
            ...it,
            href: withCourseHref(courseId, "/kg/course"),
            title: "课堂知识图谱",
            scope: "course",
          });
        }
        continue;
      }
      if (it.type === "assets") {
        if (!m.has("assets")) {
          m.set("assets", {
            ...it,
            href: withCourseHref(courseId, "/assets/1"),
            title: "资产库",
          });
        }
        continue;
      }
      if (it.type === "review") {
        if (!m.has("review")) {
          m.set("review", {
            ...it,
            href: withCourseHref(
              courseId,
              it.lectureId ? `/apps/review/${it.lectureId}` : "/apps/review/1"
            ),
            title: "单课复习",
          });
        }
        continue;
      }
      if (it.type === "mindmap") {
        if (!m.has("mindmap")) {
          m.set("mindmap", {
            ...it,
            href: withCourseHref(courseId, "/mindmap"),
            title: "知识导图",
          });
        }
        continue;
      }
    }

    for (const entry of FEATURES) {
      if (m.has(entry.type)) continue;
      m.set(
        entry.type,
        fallbackItem(
          courseId,
          entry.type,
          entry.title,
          entry.fallback,
          entry.type === "classroom_kg" ? "course" : undefined
        )
      );
    }
    return m;
  }, [manifest, courseId]);

  if (!courseId) {
    return (
      <div className={styles.page}>
        <div className={styles.inner}>
          <p className="empty-hint">缺少课程参数</p>
          <Link to="/">返回课程列表</Link>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>
            <Link to="/" className={styles.backHome}>
              返回课程列表
            </Link>
          </p>
          <h1 className={styles.brand}>{courseId}</h1>
        </header>

        {error && <p className="empty-hint">{error}</p>}
        {!manifest && !error && <p className="empty-hint">加载目录…</p>}

        <section className={styles.extra} aria-label="展示">
          <h2>展示</h2>
          <nav className={styles.mainNav}>
            {FEATURES.map((f) => {
              const it = byType.get(f.type);
              const href = it?.href ?? withCourseHref(courseId, f.fallback);
              return (
                <Link key={f.type} to={href} className={styles.mainLink}>
                  <span className={styles.kicker}>{f.kicker}</span>
                  <span className={styles.title}>{f.title}</span>
                  <span className={styles.desc}>{f.desc}</span>
                </Link>
              );
            })}
          </nav>
        </section>
      </div>
    </div>
  );
}
