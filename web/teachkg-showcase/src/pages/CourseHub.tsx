import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { loadManifest, withCourseHref, type Manifest, type ManifestItem } from "@/lib/catalog";
import { loadContinue, type ContinueState } from "@/lib/apps/progress";
import { useCourseId } from "@/lib/course";
import styles from "./Home.module.css";

// 知识图谱区
const GRAPHS = [
  {
    type: "classroom_kg",
    kicker: "Classroom",
    title: "课堂级图谱",
    desc: "默认第1–2讲",
    fallback: "/kg/session/1_2",
  },
  {
    type: "textbook",
    kicker: "Textbook",
    title: "教材级图谱",
    desc: "教材",
    fallback: "/textbook",
  },
] as const;

// 工具区
const TOOLS = [
  {
    type: "pipeline",
    kicker: "Pipeline",
    title: "构建流水线",
    desc: "图谱构建分步演化",
    fallback: "/pipeline/1",
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
    title: "资源库",
    desc: "课堂资产",
    fallback: "/assets/1",
  },
] as const;

// 应用区
const APPS = [
  {
    type: "review",
    kicker: "Review",
    title: "单课课复习整理",
    desc: "单课复习整理",
    fallback: "/apps/review",
  },
  {
    type: "practice",
    kicker: "Practice",
    title: "巩固练习",
    desc: "巩固练习",
    fallback: "/apps/practice",
  },
  {
    type: "animate",
    kicker: "Animate",
    title: "动画演示",
    desc: "动画演示",
    fallback: "/apps/animate",
  },
  {
    type: "resources",
    kicker: "Resources",
    title: "资源推荐",
    desc: "资源推荐",
    fallback: "/apps/resources",
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

/** 课内门户：图谱两级入口 + 应用 + 构建工具 */
export function CourseHub() {
  const courseId = useCourseId();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cont, setCont] = useState<ContinueState | null>(null);

  useEffect(() => {
    if (!courseId) return;
    setManifest(null);
    setError(null);
    setCont(loadContinue(courseId));
    loadManifest(courseId)
      .then(setManifest)
      .catch((e) => setError(String(e.message || e)));
  }, [courseId]);

  const byType = useMemo(() => {
    const m = new Map<string, ManifestItem>();
    if (!courseId) return m;

    for (const it of manifest?.items || []) {
      // 讲次 / 一堂课 / 整课 mmkg → 统一挂到课堂级入口
      if (it.type.includes("kg")) {
        if (!m.has("classroom_kg")) {
          m.set("classroom_kg", {
            ...it,
            href: withCourseHref(courseId, "/kg/session/1_2"),
            title: "课堂级图谱",
            scope: "session",
            sessionId: "1_2",
            lectureIds: ["1", "2"],
          });
        }
        continue;
      }
      if (it.type === "session") {
        // 会话流水线数据 → 构建流水线入口，不再单独占「一堂课图谱」卡片
        if (!m.has("pipeline")) {
          m.set("pipeline", {
            ...it,
            href: withCourseHref(
              courseId,
              it.stem?.startsWith("session_")
                ? `/pipeline/${it.stem}`
                : "/pipeline"
            ),
            title: "构建流水线",
          });
        }
        continue;
      }
      if (it.type === "pipeline") {
        if (!m.has("pipeline")) {
          m.set("pipeline", {
            ...it,
            href: withCourseHref(courseId, "/pipeline/1"),
            title: "构建流水线",
          });
        }
        continue;
      }
      if (it.type === "assets") {
        if (!m.has("assets")) {
          m.set("assets", {
            ...it,
            href: withCourseHref(courseId, "/assets/1"),
            title: "资源库",
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
            title: "一堂课复习整理",
          });
        }
        continue;
      }
      if (it.type === "textbook") {
        if (!m.has("textbook")) {
          m.set("textbook", {
            ...it,
            href: withCourseHref(courseId, "/textbook"),
            title: "教材级图谱",
          });
        }
        continue;
      }
      if (it.type === "importance") continue;
      if (!m.has(it.type)) {
        m.set(it.type, { ...it, href: withCourseHref(courseId, it.href) });
      }
    }

    for (const entry of GRAPHS) {
      if (m.has(entry.type)) continue;
      m.set(
        entry.type,
        fallbackItem(
          courseId,
          entry.type,
          entry.title,
          entry.fallback,
          entry.type === "classroom_kg" ? "session" : undefined
        )
      );
    }
    for (const entry of TOOLS) {
      if (m.has(entry.type)) continue;
      m.set(
        entry.type,
        fallbackItem(courseId, entry.type, entry.title, entry.fallback)
      );
    }
    for (const entry of APPS) {
      if (m.has(entry.type)) continue;
      m.set(
        entry.type,
        fallbackItem(courseId, entry.type, entry.title, entry.fallback)
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

        <section className={styles.extra} aria-label="应用">
          <h2>应用</h2>
          <nav className={styles.mainNav}>
            {APPS.map((m) => {
              const it = byType.get(m.type);
              const href = it?.href ?? withCourseHref(courseId, m.fallback);
              return (
                <Link key={m.type} to={href} className={styles.mainLink}>
                  <span className={styles.kicker}>{m.kicker}</span>
                  <span className={styles.title}>{m.title}</span>
                  <span className={styles.desc}>{m.desc}</span>
                </Link>
              );
            })}
          </nav>
        </section>

        <section className={styles.extra} aria-label="知识图谱">
          <h2>知识图谱</h2>
          <nav className={styles.mainNav}>
            {GRAPHS.map((m) => {
              const it = byType.get(m.type);
              const href = it?.href ?? withCourseHref(courseId, m.fallback);
              return (
                <Link key={m.type} to={href} className={styles.mainLink}>
                  <span className={styles.kicker}>{m.kicker}</span>
                  <span className={styles.title}>{m.title}</span>
                  <span className={styles.desc}>{m.desc}</span>
                </Link>
              );
            })}
          </nav>
        </section>

        <section className={styles.extra} aria-label="构建与工具">
          <h2>构建与工具</h2>
          <nav className={styles.mainNav}>
            {TOOLS.map((m) => {
              const it = byType.get(m.type);
              if (!it) return null;
              return (
                <Link key={m.type} to={it.href} className={styles.mainLink}>
                  <span className={styles.kicker}>{m.kicker}</span>
                  <span className={styles.title}>{m.title}</span>
                  <span className={styles.desc}>{m.desc}</span>
                </Link>
              );
            })}
          </nav>
        </section>
      </div>
    </div>
  );
}
