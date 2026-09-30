/**
 * 运行时：从章导图拼接课总图、裁剪堂次/讲次导图。
 */
import type { MindmapDoc } from "@/components/mindmap/MindmapTree";
import { courseDataUrl } from "@/lib/course";
import {
  buildCourseMindmapFromChapters,
  findChapterItemsForLectures,
  sliceChaptersForLectures,
} from "@/lib/kg/mindmapChapterMerge";
import { chapterFileSlug, type MindmapIndexItem } from "@/lib/kg/mindmapTypes";

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function loadMindmapIndex(
  courseId: string
): Promise<MindmapIndexItem[]> {
  const d = await fetchJson<{ items?: MindmapIndexItem[] }>(
    courseDataUrl(courseId, "mindmap_showcase.json")
  );
  return d?.items || [];
}

export async function loadChapterMindmapFile(
  courseId: string,
  item: MindmapIndexItem
): Promise<MindmapDoc | null> {
  const path =
    item.path ||
    `mindmaps/chapter_${chapterFileSlug(item.chapter || item.root_zh || "")}.json`;
  const d = await fetchJson<MindmapDoc>(courseDataUrl(courseId, path));
  if (!d?.root && !d?.roots?.length) return null;
  return d;
}

/** 课总图：优先按章拼接（保留节→主题）；失败再退回静态 course.json */
export async function loadCourseMindmapStitched(
  courseId: string,
  items: MindmapIndexItem[],
  opts: { courseTitle?: string } = {}
): Promise<MindmapDoc> {
  const chapters = items
    .filter(
      (i) => i.scope === "chapter" || String(i.lecture_id).startsWith("chapter:")
    )
    .sort((a, b) => {
      const na = Number(String(a.chapter).match(/第\s*(\d+)\s*章/)?.[1] || 999);
      const nb = Number(String(b.chapter).match(/第\s*(\d+)\s*章/)?.[1] || 999);
      return na - nb || String(a.chapter).localeCompare(String(b.chapter), "zh");
    });

  const loaded: { chapter: string; doc: MindmapDoc }[] = [];
  for (const it of chapters) {
    const doc = await loadChapterMindmapFile(courseId, it);
    if (!doc) continue;
    loaded.push({ chapter: String(it.chapter || it.root_zh || ""), doc });
  }

  if (loaded.length) {
    const title =
      opts.courseTitle ||
      items.find((i) => i.lecture_id === "course")?.root_zh ||
      items.find((i) => i.lecture_id === "course")?.chapter ||
      courseId;
    const hasSummary = loaded.some(
      (c) => c.doc.meta?.source === "summary+kg"
    );
    return buildCourseMindmapFromChapters(title, loaded, {
      source: hasSummary ? "summary+kg" : "kg",
    });
  }

  const legacy = await fetchJson<MindmapDoc>(
    courseDataUrl(courseId, "mindmaps/course.json")
  );
  if (!legacy) throw new Error("加载课程思维导图失败（无章文件且无 course.json）");
  return {
    ...legacy,
    meta: {
      ...legacy.meta,
      scope: "course",
      source: legacy.meta?.source || "kg",
    },
  };
}

/**
 * 讲次/堂次：从覆盖这些讲的章导图裁剪；太稀或缺文件时返回 null（调用方回退投影）。
 */
export async function tryLoadMindmapSlicedFromChapters(
  courseId: string,
  lectureIds: string[],
  opts: {
    items?: MindmapIndexItem[];
    entityIds?: Iterable<string>;
    sessionId?: string;
  } = {}
): Promise<MindmapDoc | null> {
  const items = opts.items || (await loadMindmapIndex(courseId));
  const chapterItems = findChapterItemsForLectures(items, lectureIds);
  if (!chapterItems.length) return null;

  const loaded: { chapter: string; doc: MindmapDoc }[] = [];
  for (const it of chapterItems) {
    const doc = await loadChapterMindmapFile(courseId, it);
    if (!doc) continue;
    loaded.push({ chapter: String(it.chapter || ""), doc });
  }
  if (!loaded.length) return null;

  const hasSummary = loaded.some((c) => c.doc.meta?.source === "summary+kg");
  const hasReview = loaded.some((c) => c.doc.meta?.source === "review+kg");
  return sliceChaptersForLectures(loaded, lectureIds, {
    entityIds: opts.entityIds,
    sessionId: opts.sessionId,
    source: hasSummary ? "summary+kg" : hasReview ? "review+kg" : "kg",
    minNodes: 4,
  });
}
