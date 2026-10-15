/**
 * 运行时：从章导图拼接课总图、裁剪堂次/讲次导图。
 */
import type { MindmapDoc } from "@/components/mindmap/MindmapTree";
import { courseDataUrl } from "@/lib/course";
import {
  buildCourseMindmapFromChapters,
  findChapterItemsForLectures,
  preferCatalogChapters,
  scoreChapterAgainstTerms,
  sliceChaptersForLectures,
  type CoursePartInfo,
} from "@/lib/kg/mindmapChapterMerge";
import { loadLectureOutlineSignal } from "@/lib/kg/mindmapOutline";
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

function catalogChapterNames(
  catalog: AssetsChapterCatalog | null | undefined
): string[] {
  if (catalog?.chapter_order?.length) return catalog.chapter_order;
  return (catalog?.parts || []).flatMap((p) =>
    (p.chapters || []).map((c) => String(c.name || "").trim())
  );
}

/** 课总图：按已有章文件拼接；默认保留分册；骨架为 分册→章（章为最外层叶） */
export async function loadCourseMindmapStitched(
  courseId: string,
  items: MindmapIndexItem[],
  opts: {
    courseTitle?: string;
    catalog?: AssetsChapterCatalog | null;
    /** 骨架：分册 → 章（章下无节） */
    skeletonOnly?: boolean;
    /** false 时去掉分册层（默认保留） */
    keepParts?: boolean;
  } = {}
): Promise<MindmapDoc> {
  const catalog = opts.catalog ?? (await loadChapterCatalog(courseId));
  const skeletonOnly = Boolean(opts.skeletonOnly);
  const keepParts = opts.keepParts !== false;

  // 骨架始终按章文件重拼（带分册、章为叶），避免旧 course_skeleton.json 缺分册/多节
  const legacy = await fetchJson<MindmapDoc>(
    courseDataUrl(courseId, "mindmaps/course.json")
  );

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

  const loadedRaw: { chapter: string; doc: MindmapDoc }[] = [];
  const seenPath = new Set<string>();
  for (const it of chapters) {
    const path =
      it.path ||
      `mindmaps/chapter_${chapterFileSlug(it.chapter || it.root_zh || "")}.json`;
    if (seenPath.has(path)) continue;
    const doc = await loadChapterMindmapFile(courseId, it);
    if (!doc) continue;
    seenPath.add(path);
    loadedRaw.push({ chapter: String(it.chapter || it.root_zh || ""), doc });
  }

  const catalogNames = catalogChapterNames(catalog);
  // 只保留目录内章，去掉分册重映射重复（如集合论「第1章」与「第9章」并存）
  const loaded = preferCatalogChapters(loadedRaw, catalogNames);

  if (loaded.length) {
    const title =
      opts.courseTitle ||
      items.find((i) => i.lecture_id === "course")?.root_zh ||
      items.find((i) => i.lecture_id === "course")?.chapter ||
      courseId;
    const hasOutline = loaded.some((c) => {
      const s = c.doc.meta?.source;
      return s === "outline_text" || s === "outline+kg";
    });
    const hasSummary = loaded.some((c) => c.doc.meta?.source === "summary+kg");
    const courseSource = hasOutline
      ? loaded.some((c) => c.doc.meta?.source === "outline+kg")
        ? "outline+kg"
        : "outline_text"
      : hasSummary
        ? "summary+kg"
        : "kg";
    const parts = keepParts
      ? catalogPartsForCourse(
          catalog,
          loaded.map((c) => c.chapter)
        )
      : [];
    return buildCourseMindmapFromChapters(title, loaded, {
      source: courseSource,
      parts,
      flattenParts: !keepParts,
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
    const names = catalogNames;
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
      const parts = keepParts
        ? catalogPartsForCourse(
            catalog,
            emptyChapters.map((c) => c.chapter)
          )
        : [];
      return buildCourseMindmapFromChapters(title, emptyChapters, {
        source: "summary+kg",
        parts,
        flattenParts: !keepParts,
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

/** 已落盘的笔记匹配结果（LLM 精炼 final 优先） */
export async function tryLoadNoteMatchSaved(
  courseId: string,
  lectureIds: string[],
  sessionId?: string | null
): Promise<MindmapDoc | null> {
  const lids = lectureIds.map(String);
  const sid =
    String(sessionId || "").trim() ||
    (lids.length === 2 ? `${lids[0]}_${lids[1]}` : lids[0] || "");
  if (!sid) return null;
  const candidates = [
    `mindmaps/note_match/session_${sid}.final.json`,
    `mindmaps/note_match/session_${sid}.prelim.json`,
  ];
  if (lids.length === 1) {
    candidates.push(
      `mindmaps/note_match/lecture_${lids[0]}.final.json`,
      `mindmaps/note_match/lecture_${lids[0]}.prelim.json`
    );
  }
  for (const rel of candidates) {
    const doc = await fetchJson<MindmapDoc>(courseDataUrl(courseId, rel));
    if (doc?.root || doc?.roots?.length) return doc;
  }
  return null;
}

/**
 * 讲次/堂次：章内容 × 课次复习信号 → 相关/残缺子树拼接；太稀时返回 null。
 * 若已有 note_match final/prelim 落盘，优先直接加载。
 */
export async function tryLoadMindmapSlicedFromChapters(
  courseId: string,
  lectureIds: string[],
  opts: {
    items?: MindmapIndexItem[];
    entityIds?: Iterable<string>;
    sessionId?: string;
    /** 跳过落盘结果，强制运行时重切 */
    forceRuntimeSlice?: boolean;
  } = {}
): Promise<MindmapDoc | null> {
  const lids = lectureIds.map(String);
  if (!opts.forceRuntimeSlice) {
    const saved = await tryLoadNoteMatchSaved(courseId, lids, opts.sessionId);
    if (saved) return saved;
  }
  const items = opts.items || (await loadMindmapIndex(courseId));
  const signal = await loadLectureOutlineSignal(
    courseId,
    lids,
    null,
    opts.sessionId
  );
  const matchTerms = signal.order || [];
  const noteCorpus = signal.noteCorpus || "";

  const resolveSource = (docs: MindmapDoc[]) => {
    const hasOutline = docs.some((d) => {
      const s = d.meta?.source;
      return s === "outline_text" || s === "outline+kg";
    });
    if (hasOutline) {
      return docs.some((d) => d.meta?.source === "outline+kg")
        ? ("outline+kg" as const)
        : ("outline_text" as const);
    }
    if (docs.some((d) => d.meta?.source === "summary+kg")) return "summary+kg" as const;
    if (docs.some((d) => d.meta?.source === "review+kg")) return "review+kg" as const;
    return signal.source || ("kg" as const);
  };

  const allChapterItems = items.filter(
    (i) => i.scope === "chapter" || String(i.lecture_id).startsWith("chapter:")
  );

  /** 与 noteMatchRefine.buildPrelim 一致：全章打分，供错挂过滤 / 回退挑选 */
  const scoreAllChapters = async () => {
    const scored: { chapter: string; doc: MindmapDoc; score: number }[] = [];
    if (!matchTerms.length && !noteCorpus) return scored;
    const catalog = await loadChapterCatalog(courseId);
    const catalogNames = catalogChapterNames(catalog);
    const candidates = preferCatalogChapters(
      allChapterItems.map((it) => ({
        chapter: String(it.chapter || it.root_zh || ""),
        item: it,
      })),
      catalogNames
    );
    for (const { chapter, item } of candidates) {
      const doc = await loadChapterMindmapFile(courseId, item);
      if (!doc) continue;
      const score = scoreChapterAgainstTerms(doc, matchTerms, { noteCorpus });
      if (score > 0) scored.push({ chapter, doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  };

  // 1) 索引 lecture_ids 命中的章 — 仍用笔记打分过滤，避免错挂串章
  const chapterItems = findChapterItemsForLectures(items, lids);
  if (chapterItems.length) {
    let loaded: { chapter: string; doc: MindmapDoc }[] = [];
    for (const it of chapterItems) {
      const doc = await loadChapterMindmapFile(courseId, it);
      if (!doc) continue;
      loaded.push({ chapter: String(it.chapter || ""), doc });
    }
    if (loaded.length && (matchTerms.length || noteCorpus)) {
      const global = await scoreAllChapters();
      const top = global[0]?.score || 0;
      const kept: { chapter: string; doc: MindmapDoc; score: number }[] = [];
      for (const row of loaded) {
        const score = scoreChapterAgainstTerms(row.doc, matchTerms, {
          noteCorpus,
        });
        if (score >= Math.max(12, top * 0.22)) {
          kept.push({ ...row, score });
        }
      }
      if (kept.length) {
        kept.sort((a, b) => b.score - a.score);
        loaded = kept.slice(0, 4).map(({ chapter, doc }) => ({ chapter, doc }));
      } else if (top > 0) {
        loaded = global
          .filter((x) => x.score >= Math.max(20, top * 0.35))
          .slice(0, 4)
          .map(({ chapter, doc }) => ({ chapter, doc }));
      }
    }
    if (loaded.length) {
      const sliced = sliceChaptersForLectures(loaded, lids, {
        entityIds: opts.entityIds,
        matchTerms,
        noteCorpus,
        sessionId: opts.sessionId,
        source: resolveSource(loaded.map((l) => l.doc)),
        minNodes: 3,
      });
      if (sliced) return sliced;
    }
  }

  // 2) lids 缺失/过时或切片过稀：按课次关键词 / 笔记正文对目录章打分
  if (!matchTerms.length && !noteCorpus) return null;
  const scored = await scoreAllChapters();
  const top = scored[0]?.score || 0;
  const picked = scored
    .filter((s) => s.score >= Math.max(20, top * 0.35))
    .slice(0, 4);
  if (!picked.length) return null;

  return sliceChaptersForLectures(
    picked.map((p) => ({ chapter: p.chapter, doc: p.doc })),
    lids,
    {
      entityIds: opts.entityIds,
      matchTerms,
      noteCorpus,
      sessionId: opts.sessionId,
      source: resolveSource(picked.map((p) => p.doc)),
      minNodes: 3,
    }
  );
}
