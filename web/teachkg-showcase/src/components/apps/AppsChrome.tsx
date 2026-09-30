import type { ReactNode } from "react";
import { AppSwitcher } from "@/components/apps/AppSwitcher";
import styles from "@/pages/apps/Apps.module.css";

/** 单行顶栏：左标题 · 中跳转 · 右操作 */
export function AppsChrome({
  courseId,
  lectureId,
  title,
  extra,
}: {
  courseId: string;
  lectureId?: string;
  title: string;
  subtitle?: string;
  extra?: ReactNode;
}) {
  return (
    <header className={styles.topbar}>
      <div className={styles.topbarLeft}>
        <h2>{title}</h2>
      </div>
      <div className={styles.topbarCenter}>
        <AppSwitcher courseId={courseId} lectureId={lectureId} />
      </div>
      <div className={styles.topbarRight}>{extra}</div>
    </header>
  );
}
