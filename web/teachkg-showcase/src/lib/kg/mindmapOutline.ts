/**
 * 路径 A：大纲信号（复习浓缩 + 笔记正文 + 可选章总结材料 + PPT/片段标题）
 * 用于约束导图排序与主题切块 / 课次子树匹配。
 */
import { courseDataUrl } from "@/lib/course";
import type { MindmapSource } from "@/lib/kg/mindmapTypes";
import { withBase } from "@/lib/withBase";

export type OutlineSignal = {
  /** 优先排序键：实体 id / zh / 笔记抽词 */
  order: string[];
  source: MindmapSource;
  /** 是否命中强骨架（章总结稿） */
  strongSkeleton: boolean;
  chapterSkeleton?: { parent: string; child: string }[];
  /**
   * 笔记语料（复习点 definition/summary + 已缓存课次笔记正文），
   * 供章节点「是否在笔记中出现」匹配。
   */
  noteCorpus?: string;
};

function pushUnique(order: string[], seen: Set<string>, ...keys: string[]) {
  for (const raw of keys) {
    const k = String(raw || "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    order.push(k);
  }
}

/** 从笔记/定义长文抽短概念短语 */
export function extractPhrasesFromNoteText(text: string): string[] {
  const t = String(text || "").trim();
  if (!t) return [];
  const out: string[] = [];
  const push = (s: string) => {
    const x = String(s || "").trim();
    if (x.length < 2 || x.length > 16) return;
    if (/^[0-9.]+$/.test(x)) return;
    out.push(x);
  };
  for (const m of t.matchAll(/[「『“"]([^」』”"]{2,16})[」』”"]/g)) {
    push(m[1]);
  }
  for (const m of t.matchAll(
    /(?:称为|叫做|又称|即|记作|写作)\s*([A-Za-z\u4e00-\u9fff¬∧∨→↔∀∃]{1,16})/g
  )) {
    push(m[1]);
  }
  // 列举：否定（¬）、合取（∧）…
  for (const m of t.matchAll(
    /([\u4e00-\u9fff]{2,12})\s*[（(][^）)]{0,12}[）)]/g
  )) {
    push(m[1]);
  }
  return out;
}

function appendNoteCorpus(parts: string[], ...chunks: unknown[]) {
  for (const c of chunks) {
    const s = String(c || "").trim();
    if (s.length >= 2) parts.push(s);
  }
}

/** 只读已落盘课次笔记（不触发生成） */
async function peekNotesText(
  courseId: string,
  lectureId: string
): Promise<{ phrases: string[]; corpus: string } | null> {
  try {
    const url =
      withBase("/api/review-notes") +
      `?courseId=${encodeURIComponent(courseId)}&lectureId=${encodeURIComponent(lectureId)}`;
    const r = await fetch(url, { method: "GET" });
    if (r.status !== 200) return null;
    const data = (await r.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!data) return null;
    const phrases: string[] = [];
    const corpusParts: string[] = [];
    appendNoteCorpus(corpusParts, data.overview, data.subtitle, data.title);
    if (Array.isArray(data.outline)) {
      for (const o of data.outline) {
        phrases.push(String(o || ""));
        appendNoteCorpus(corpusParts, o);
      }
    }
    const sections = Array.isArray(data.sections) ? data.sections : [];
    for (const raw of sections) {
      const s = raw as Record<string, unknown>;
      phrases.push(String(s.title || ""));
      appendNoteCorpus(
        corpusParts,
        s.title,
        s.summary,
        s.body,
        ...(Array.isArray(s.bullets) ? s.bullets : []),
        ...(Array.isArray(s.tips) ? s.tips : [])
      );
      for (const b of Array.isArray(s.blocks) ? s.blocks : []) {
        const blk = b as { text?: string; label?: string };
        appendNoteCorpus(corpusParts, blk.label, blk.text);
        phrases.push(...extractPhrasesFromNoteText(String(blk.text || "")));
      }
      phrases.push(
        ...extractPhrasesFromNoteText(
          [s.summary, s.body].filter(Boolean).join("\n")
        )
      );
    }
    const corpus = corpusParts.join("\n");
    if (!corpus.trim() && !phrases.length) return null;
    return { phrases, corpus };
  } catch {
    return null;
  }
}

/** 从 review/lecture_*.json 抽知识点 + 笔记正文；片段标题作弱补充 */
export async function loadLectureOutlineSignal(
  courseId: string,
  lectureIds: string[],
  chapterHint?: string | null,
  sessionId?: string | null
): Promise<OutlineSignal> {
  const order: string[] = [];
  const seen = new Set<string>();
  const noteParts: string[] = [];
  let hadReviewPoints = false;
  let hadNoteBody = false;

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
        const def = String(p?.definition || "");
        const sum = String(p?.summary || "");
        if (def || sum) {
          hadNoteBody = true;
          appendNoteCorpus(noteParts, def, sum);
          for (const ph of extractPhrasesFromNoteText(`${sum}\n${def}`)) {
            pushUnique(order, seen, ph);
          }
        }
      }
      // PPT/片段标题：弱信号，仅补未出现的短标题
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      for (const seg of segments) {
        const title = String(seg?.title || "").trim();
        if (title.length < 2 || title.length > 24) continue;
        if (/^片段\s*\d+$/.test(title) || /好，|那么|刚才/.test(title)) continue;
        pushUnique(order, seen, title);
        appendNoteCorpus(noteParts, title);
      }
    } catch {
      /* ignore */
    }
  }

  // 已缓存的课次笔记（单讲 + 堂次 13_14 / sessionId）
  const noteIds = [
    ...lectureIds.map(String),
    sessionId ? String(sessionId) : "",
    lectureIds.length >= 2 ? `${lectureIds[0]}_${lectureIds[1]}` : "",
  ].filter(Boolean);
  for (const nid of [...new Set(noteIds)]) {
    const peeked = await peekNotesText(courseId, nid);
    if (!peeked) continue;
    hadNoteBody = true;
    appendNoteCorpus(noteParts, peeked.corpus);
    for (const ph of peeked.phrases) pushUnique(order, seen, ph);
    for (const ph of extractPhrasesFromNoteText(peeked.corpus)) {
      pushUnique(order, seen, ph);
    }
  }

  const noteCorpus = noteParts.join("\n").trim() || undefined;

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
      noteCorpus,
    };
  }

  return {
    order,
    source: hadNoteBody || hadReviewPoints ? "review+kg" : "kg",
    strongSkeleton: false,
    noteCorpus,
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
      const data = (await r.json()) as ChapterSummaryDoc & {
        source?: string;
        outline_text?: string;
      };
      if (data?.source === "textbook_toc") continue;
      if (
        data?.outline_text?.trim() ||
        data?.edges?.length ||
        data?.outline?.length
      ) {
        return data;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}
