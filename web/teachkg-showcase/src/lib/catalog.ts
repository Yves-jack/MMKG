import { courseDataUrl, coursePath } from "@/lib/course";
import { withBase } from "@/lib/withBase";

export type ManifestItem = {
  id: string;
  type: string;
  group: string;
  title: string;
  href: string;
  dataUrl: string;
  stem?: string;
  lectureId?: string;
  source?: "kg" | "mmkg";
  scope?: "lecture" | "course" | "session";
  sessionId?: string;
  lectureIds?: string[];
};

export type Manifest = {
  courseId: string;
  generatedAt: string;
  items: ManifestItem[];
};

export async function loadManifest(courseId?: string): Promise<Manifest> {
  const url = courseId
    ? courseDataUrl(courseId, "manifest.json")
    : withBase("/data/manifest.json");
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      courseId
        ? `缺少课程「${courseId}」的 manifest，请先运行 npm run sync-data`
        : "缺少 manifest.json，请先运行 npm run sync-data"
    );
  }
  return res.json();
}

export function groupItems(items: ManifestItem[]): Record<string, ManifestItem[]> {
  const out: Record<string, ManifestItem[]> = {};
  for (const it of items) {
    (out[it.group] ||= []).push(it);
  }
  return out;
}

/** 把旧绝对路径 href 规范到课内前缀（兼容已同步的扁平 href） */
export function withCourseHref(courseId: string, href: string): string {
  const h = String(href || "");
  if (!h) return coursePath(courseId);
  if (h.startsWith("/course/")) return h;
  if (h.startsWith("/")) return coursePath(courseId, h);
  return coursePath(courseId, `/${h}`);
}
