/**
 * 运行时：从章导图拼接课总图、裁剪堂次/讲次导图。
 */
import type { MindmapDoc } from "@/components/mindmap/MindmapTree";
import { courseDataUrl } from "@/lib/course";
import {
  buildCourseMindmapFromChapters,
  findChapterItemsForLectures,
  sliceChaptersForLectures,
  type CoursePartInfo,
} from "@/lib/kg/mindmapChapterMerge";
import { chapterFileSlug, type MindmapIndexItem } from "@/lib/kg/mindmapTypes";
import type { AssetsChapterCatalog } from "@/lib/kg/assetsLibrary";
import { groupChaptersByPart } from "@/lib/kg/assetsLibrary";

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
    courseDataUrl(courseId, "mindmaps/index.json")
  );
  return d?.items || [];
}

export async function loadChapterCatalog(
  courseId: string
): Promise<AssetsChapterCatalog | null> {
  return fetchJson<AssetsChapterCatalog>(
    courseDataUrl(courseId, "chapter_catalog.json")
  );
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

function catalogPartsForCourse(
  catalog: AssetsChapterCatalog | null | undefined,
  chapterNames: string[]
): CoursePartInfo[] {
  if (!catalog?.parts?.length) return [];
  return groupChaptersByPart(chapterNames, catalog).map((g) => ({
    id: g.id,
    title: g.title,
    chapters: g.chapters,
  }));
}

/** 课总图：优先用已含分册层的静态 course.json；否则按章+目录重拼 */
export async function loadCourseMindmapStitched(
  courseId: string,
  items: MindmapIndexItem[],
  opts: {
    courseTitle?: string;
    catalog?: AssetsChapterCatalog | null;
    /** 骨架展示：章为最外层，仅大纲层级 */
    skeletonOnly?: boolean;
  } = {}
): Promise<MindmapDoc> {
  const catalog = opts.catalog ?? (await loadChapterCatalog(courseId));
  const skeletonOnly = Boolean(opts.skeletonOnly);

  if (skeletonOnly) {
    const saved = await fetchJson<MindmapDoc>(
      courseDataUrl(courseId, "mindmaps/course_skeleton.json")
    );
    if (saved?.root || saved?.roots?.length) {
      return {
        ...saved,
        lecture_id: "course:skeleton",
        meta: {
          ...saved.meta,
          scope: "course",
          skeleton_view: true,
          composed_from: saved.meta?.composed_from || "chapters",
        },
      };
    }
  }

  const legacy = await fetchJson<MindmapDoc>(
    courseDataUrl(courseId, "mindmaps/course.json")
  );

  const legacyRoot = legacy?.roots?.[0] || legacy?.root;
  const legacyHasParts = (legacyRoot?.children || []).some((c) =>
    String(c.id || "").startsWith("__part__/")
  );
  // 静态课总图已带分册且有多章时直接用，避免运行时缺目录/缺章文件拼成「只有两章」
  // 骨架视图不走完整静态课图（含实体细节），改从章文件抽层级
  if (!skeletonOnly && legacy && legacyHasParts) {
    const nPartKids = (legacyRoot?.children || []).reduce(
      (s, p) => s + (p.children?.length || 0),
      0
    );
    if (nPartKids >= 2) {
      return {
        ...legacy,
        meta: {
          ...legacy.meta,
          scope: "course",
          source: legacy.meta?.source || "kg",
          n_parts: (legacyRoot?.children || []).filter((c) =>
            String(c.id || "").startsWith("__part__/")
          ).length,
          n_chapters: nPartKids,
          composed_from: legacy.meta?.composed_from || "chapters",
        },
      };
    }
  }

  const chapters = items
    .filter(
      (i) => i.scope === "chapter" || String(i.lecture_id).startsWith("chapter:")
    )
    .sort((a, b) => {
      const order = catalog?.chapter_order || [];
      const idx = new Map(order.map((n, i) => [n, i]));
      const ca = String(a.chapter || "");
      const cb = String(b.chapter || "");
      const ia = idx.has(ca) ? idx.get(ca)! : 10_000;
      const ib = idx.has(cb) ? idx.get(cb)! : 10_000;
      if (ia !== ib) return ia - ib;
      const na = Number(ca.match(/第\s*(\d+)\s*章/)?.[1] || 999);
      const nb = Number(cb.match(/第\s*(\d+)\s*章/)?.[1] || 999);
      return na - nb || ca.localeCompare(cb, "zh");
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
    const catalogNames =
      catalog?.chapter_order?.length
        ? catalog.chapter_order
        : (catalog?.parts || []).flatMap((p) =>
            (p.chapters || []).map((c) => String(c.name || "").trim())
          );
    // 整课只拼本学期已有章导图，不为未讲章补空骨架
    if (catalogNames.length) {
      const order = new Map(catalogNames.map((n, i) => [String(n), i]));
      loaded.sort(
        (a, b) =>
          (order.get(a.chapter) ?? 10_000) - (order.get(b.chapter) ?? 10_000) ||
          a.chapter.localeCompare(b.chapter, "zh")
      );
    }
    const parts = catalogPartsForCourse(
      catalog,
      loaded.map((c) => c.chapter)
    );
    return buildCourseMindmapFromChapters(title, loaded, {
      source: hasSummary ? "summary+kg" : "kg",
      parts,
      hierarchyOnly: skeletonOnly,
      shallow: skeletonOnly ? false : undefined,
      lectureId: skeletonOnly ? "course:skeleton" : "course",
      maxTopicsPerChapter: skeletonOnly ? 24 : undefined,
    });
  }

  if (skeletonOnly) {
    // 无章文件时用目录空章占位
    const title =
      opts.courseTitle ||
      items.find((i) => i.lecture_id === "course")?.root_zh ||
      items.find((i) => i.lecture_id === "course")?.chapter ||
      courseId;
    const names =
      catalog?.chapter_order?.length
        ? catalog.chapter_order
        : (catalog?.parts || []).flatMap((p) =>
            (p.chapters || []).map((c) => String(c.name || "").trim())
          );
    const emptyChapters = (names || [])
      .filter(Boolean)
      .map((chapter) => ({
        chapter,
        doc: {
          lecture_id: `chapter:${chapter}`,
          root: {
            id: `__chapter__/${chapter}`,
            zh: chapter,
            importance: 0.65,
            relation: "toc_chapter",
            related: [],
            children: [],
          },
          roots: [
            {
              id: `__chapter__/${chapter}`,
              zh: chapter,
              importance: 0.65,
              relation: "toc_chapter",
              related: [],
              children: [],
            },
          ],
          n_nodes: 1,
          max_depth: 0,
          orphan_count: 0,
          meta: { chapter, scope: "chapter" as const },
        } satisfies MindmapDoc,
      }));
    if (emptyChapters.length) {
      const parts = catalogPartsForCourse(
        catalog,
        emptyChapters.map((c) => c.chapter)
      );
      return buildCourseMindmapFromChapters(title, emptyChapters, {
        source: "summary+kg",
        parts,
        hierarchyOnly: true,
        lectureId: "course:skeleton",
      });
    }
  }

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
