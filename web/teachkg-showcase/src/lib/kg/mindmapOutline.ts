/**
 * 路径 A：大纲信号（复习浓缩 + 可选章总结材料 + PPT/片段标题）
 * 用于约束导图排序与主题切块；实体 id 仍以 KG 为准。
 */
import { courseDataUrl } from "@/lib/course";
import type { MindmapSource } from "@/lib/kg/mindmapTypes";

export type OutlineSignal = {
  /** 优先排序键：实体 id / zh */
  order: string[];
  source: MindmapSource;
  /** 是否命中强骨架（章总结稿） */
  strongSkeleton: boolean;
  chapterSkeleton?: { parent: string; child: string }[];
};

function pushUnique(order: string[], seen: Set<string>, ...keys: string[]) {
  for (const raw of keys) {
    const k = String(raw || "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    order.push(k);
  }
}

/** 从 review/lecture_*.json 抽知识点顺序；片段标题作弱补充 */
export async function loadLectureOutlineSignal(
  courseId: string,
  lectureIds: string[],
  chapterHint?: string | null
): Promise<OutlineSignal> {
  const order: string[] = [];
  const seen = new Set<string>();
  let hadReviewPoints = false;

  for (const lid of lectureIds) {
    try {
      const url = courseDataUrl(courseId, `review/lecture_${lid}.json`);
      const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) continue;
      const data = await r.json();
      const points = Array.isArray(data?.points) ? data.points : [];
      if (points.length) hadReviewPoints = true;
      for (const p of points) {
        pushUnique(order, seen, String(p?.id || ""), String(p?.zh || ""));
      }
      // PPT/片段标题：弱信号，仅补未出现的短标题
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      for (const seg of segments) {
        const title = String(seg?.title || "").trim();
        if (title.length < 2 || title.length > 24) continue;
        if (/^片段\s*\d+$/.test(title) || /好，|那么|刚才/.test(title)) continue;
        pushUnique(order, seen, title);
      }
    } catch {
      /* ignore */
    }
  }

  // 若有章总结材料 → 强骨架（试点路径；文件约定 summaries/chapter_*.json）
  const chapterSkeleton = await tryLoadChapterSummarySkeleton(
    courseId,
    lectureIds,
    chapterHint
  );

  if (chapterSkeleton?.edges?.length || chapterSkeleton?.outline?.length) {
    for (const e of chapterSkeleton.edges || []) {
      pushUnique(order, seen, e.parent, e.child);
    }
    for (const o of chapterSkeleton.outline || []) {
      pushUnique(order, seen, o);
    }
    return {
      order,
      source: "summary+kg",
      strongSkeleton: true,
      chapterSkeleton: chapterSkeleton.edges,
    };
  }

  return {
    order,
    source: hadReviewPoints ? "review+kg" : "kg",
    strongSkeleton: false,
  };
}

type ChapterSummaryDoc = {
  chapter?: string;
  /** parent → child 骨架边（概念层级） */
  edges?: { parent: string; child: string }[];
  /** 扁平大纲节点顺序 */
  outline?: string[];
};

async function tryLoadChapterSummarySkeleton(
  courseId: string,
  lectureIds: string[],
  chapterHint?: string | null
): Promise<ChapterSummaryDoc | null> {
  const { chapterFileSlug } = await import("@/lib/kg/mindmapTypes");
  const candidates: string[] = [];
  if (chapterHint) {
    candidates.push(`summaries/chapter_${chapterFileSlug(chapterHint)}.json`);
  }
  candidates.push(
    ...lectureIds.map((lid) => `summaries/chapter_from_lecture_${lid}.json`),
    "summaries/chapter_outline.json"
  );
  for (const rel of candidates) {
    try {
      const r = await fetch(`${courseDataUrl(courseId, rel)}?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!r.ok) continue;
      const data = (await r.json()) as ChapterSummaryDoc & { source?: string; outline_text?: string };
      if (data?.source === "textbook_toc") continue;
      if (data?.outline_text?.trim() || data?.edges?.length || data?.outline?.length) {
        return data;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 强骨架边优先于图谱父子：把 outline 边叠加进已有 parentOf 倾向（前端投影用排序；
 * 静态章融合时也可先排 lecture 枝顺序）。
 */
export function applySkeletonOrderPreference(
  lectureIds: string[],
  skeleton: { parent: string; child: string }[] | undefined
): string[] {
  if (!skeleton?.length) return lectureIds;
  // 章内讲次仍按原序；骨架主要用于实体排序（由 reviewOrder 承载）
  return lectureIds;
}
