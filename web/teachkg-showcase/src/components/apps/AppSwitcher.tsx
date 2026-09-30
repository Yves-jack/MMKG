import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { saveContinue } from "@/lib/apps/progress";
import { coursePath } from "@/lib/course";
import styles from "./AppSwitcher.module.css";

const APPS = [
  { path: "/apps/review/1", match: "/apps/review", label: "复习", tip: "一堂课复习整理" },
  { path: "/apps/practice", match: "/apps/practice", label: "练习", tip: "巩固练习" },
  { path: "/apps/animate", match: "/apps/animate", label: "动画", tip: "动画演示" },
  { path: "/apps/resources", match: "/apps/resources", label: "推荐", tip: "资源推荐" },
] as const;

/** 各应用顶栏内的应用切换条，形成连续学习产品感 */
export function AppSwitcher({
  courseId,
  lectureId,
}: {
  courseId: string;
  lectureId?: string;
}) {
  const { pathname } = useLocation();
  const lec =
    lectureId && (/^\d+_\d+$/.test(lectureId) || /^\d+$/.test(lectureId))
      ? lectureId
      : "1";

  useEffect(() => {
    const hit = APPS.find((a) => pathname.includes(a.match));
    if (!hit) return;
    const href =
      hit.match === "/apps/review"
        ? coursePath(courseId, `/apps/review/${lec}`)
        : coursePath(courseId, hit.path);
    saveContinue(courseId, {
      app: hit.match,
      lectureId: lec,
      label: hit.tip,
      href,
    });
  }, [courseId, lec, pathname]);

  return (
    <nav className={styles.bar} aria-label="应用切换">
      {APPS.map((a) => {
        const active = pathname.includes(a.match);
        const to =
          a.match === "/apps/review"
            ? coursePath(courseId, `/apps/review/${lec}`)
            : coursePath(courseId, a.path);
        return (
          <Link
            key={a.match}
            to={to}
            title={a.tip}
            className={active ? styles.itemActive : styles.item}
            aria-current={active ? "page" : undefined}
          >
            {a.label}
          </Link>
        );
      })}
    </nav>
  );
}
