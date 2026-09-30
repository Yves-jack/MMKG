import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { withBase } from "@/lib/withBase";


export function encodeCourseId(courseId: string): string {
  return encodeURIComponent(String(courseId || "").trim()).replace(/%2B/gi, "+");
}

export function decodeCourseId(raw: string | undefined): string {
  if (!raw) return "";
  try {
    let id = decodeURIComponent(raw);
    if (id.includes(" ")) {
      id = id.replace(" ", "+");
    }
    return id;
  } catch {
    return raw;
  }
}

// 课内页面路径：/course/{courseId}/pipeline/1
export function coursePath(courseId: string, subPath = ""): string {
  const base = `/course/${encodeCourseId(courseId)}`;
  if (!subPath) return base;
  return `${base}${subPath.startsWith("/") ? subPath : `/${subPath}`}`;
}

// 课内静态数据：/data/courses/{courseId}/manifest.json
export function courseDataUrl(courseId: string, relPath: string): string {
  const clean = String(relPath || "").replace(/^\/+/, "");
  return withBase(`/data/courses/${encodeCourseId(courseId)}/${clean}`);
}

export type CourseListItem = {
  id: string;
  title: string;
  href: string;
  lectureCount?: number;
  hasPipeline?: boolean;
  hasKg?: boolean;
};

export type CoursesIndex = {
  generatedAt: string;
  defaultCourseId?: string;
  courses: CourseListItem[];
};

export async function loadCoursesIndex(): Promise<CoursesIndex> {
  const res = await fetch(withBase(`/data/courses.json?t=${Date.now()}`), { cache: "no-store" });
  if (!res.ok) {
    throw new Error("缺少 courses.json，请先运行 npm run sync-data");
  }
  return res.json();
}

// 从路由读取当前课程；无参时返回空串
export function useCourseId(): string {
  const { courseId: raw } = useParams<{ courseId?: string }>();
  return useMemo(() => decodeCourseId(raw), [raw]);
}
