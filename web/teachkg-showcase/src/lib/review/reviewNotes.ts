import type { AppReviewPoint } from "@/lib/review/data";
import { withBase } from "@/lib/withBase";

/** 笔记结构版本：v10 课次一篇（大纲 + 多部分讲义） */
export const LECTURE_NOTES_VERSION = 11;

export type NoteSectionKind =
  | "theme"
  | "tips"
  | "extra"
  | "checklist"
  | "overview"
  | "concept"
  | "structure"
  | "part";

export type NoteBlockType =
  | "hook"
  | "def"
  | "fact"
  | "example"
  | "pitfall"
  | "cue";

export type NoteBlock = {
  type: NoteBlockType;
  label?: string;
  text: string;
  answer?: string;
};

/** @deprecated v9 起不再使用主题簇；保留字段以兼容旧缓存解析 */
export type LectureTheme = {
  id: string;
  title: string;
  oneLiner: string;
  keyPoints: string[];
  entityIds?: string[];
};

export type LectureNoteSection = {
  id: string;
  kind: NoteSectionKind;
  title: string;
  summary: string;
  body: string;
  bullets: string[];
  related: string[];
  tips: string[];
  blocks?: NoteBlock[];
  entityIds?: string[];
};

export type LectureNotesDoc = {
  version: number;
  title: string;
  subtitle: string;
  overview: string;
  /** 大纲条目，与各 part 标题对应 */
  outline?: string[];
  /** 固定为空；旧字段保留 */
  themes: LectureTheme[];
  sections: LectureNoteSection[];
  model?: string;
  source: "llm" | "local" | "disk";
  generatedAt: number;
};

const BLOCK_TYPES = new Set<NoteBlockType>([
  "hook",
  "def",
  "fact",
  "example",
  "pitfall",
  "cue",
]);

function zh(name: string) {
  return (name || "").split("/")[0].trim() || name;
}

function packPoint(p: AppReviewPoint) {
  return {
    id: p.id,
    zh: p.zh,
    importance: p.importance,
    origin: p.origin,
    summary: p.summary,
    definition: p.definition,
    neighbors: (p.neighbors || []).slice(0, 6),
    evidence: (p.evidence || []).slice(0, 3).map((e) => ({
      text: e.text || "",
      start_sec: e.start_sec,
    })),
  };
}

function polishOverview(text: string): string {
  return String(text || "")
    .replace(/本次课为单课复习[，,]?\s*/g, "本次课")
    .replace(/本次课\s*聚焦/g, "本次课聚焦")
    .trim();
}

function normalizeBlocks(raw: unknown): NoteBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      const type = String((b as NoteBlock)?.type || "").trim() as NoteBlockType;
      if (!BLOCK_TYPES.has(type)) return null;
      // 定义已写入正文，不再单独出定义卡片
      if (type === "def" || type === "hook" || type === "cue") return null;
      const text = String((b as NoteBlock)?.text || "").trim();
      if (!text) return null;
      let label = String((b as NoteBlock)?.label || "").trim();
      if (type === "fact" && !label) label = "性质";
      if (type === "example" && (!label || label === "课堂" || label === "例")) {
        label = "例";
      }
      if (type === "pitfall" && !label) label = "注";
      return label ? { type, label, text } : { type, text };
    })
    .filter(Boolean)
    .slice(0, 12) as NoteBlock[];
}

/** 只保留课次讲义部分（part）；旧 concept/theme 亦归一为 part */
export function conceptSections(sections: LectureNoteSection[]): LectureNoteSection[] {
  return (sections || [])
    .filter(
      (s) =>
        s.kind === "part" ||
        s.kind === "concept" ||
        s.kind === "structure" ||
        s.kind === "theme" ||
        s.kind === "overview",
    )
    .map((s) => ({
      ...s,
      kind: "part" as const,
      tips: [],
      body: String(s.body || "").trim(),
      blocks: normalizeBlocks(s.blocks),
    }));
}

/** @deprecated 使用 conceptSections */
export function themeOnlySections(sections: LectureNoteSection[]): LectureNoteSection[] {
  return conceptSections(sections);
}

export function isLectureNotes(doc: LectureNotesDoc | null | undefined): doc is LectureNotesDoc {
  return Boolean(
    doc &&
      doc.version === LECTURE_NOTES_VERSION &&
      Array.isArray(doc.sections) &&
      doc.sections.length > 0,
  );
}

/** @deprecated */
export function isThemeNotes(doc: LectureNotesDoc | null | undefined): doc is LectureNotesDoc {
  return isLectureNotes(doc);
}

function nameKeys(raw: string): string[] {
  const t = String(raw || "").trim();
  if (!t) return [];
  const zhPart = t.split("/")[0].trim();
  return [...new Set([t, zhPart].filter(Boolean))];
}

function buildNameIndex(points: AppReviewPoint[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const add = (key: string, id: string) => {
    const k = key.trim();
    if (!k) return;
    const arr = index.get(k) || [];
    if (!arr.includes(id)) arr.push(id);
    index.set(k, arr);
  };
  for (const p of points) {
    add(p.id, p.id);
    for (const k of nameKeys(p.id)) add(k, p.id);
    for (const k of nameKeys(p.zh)) add(k, p.id);
  }
  return index;
}

function resolveNames(names: string[], index: Map<string, string[]>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    for (const key of nameKeys(name)) {
      const hits = index.get(key);
      if (!hits?.length) continue;
      for (const id of hits) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/** 把小节标题 / related 解析成图谱实体 id */
export function attachSectionEntities(
  doc: LectureNotesDoc,
  points: AppReviewPoint[],
): LectureNotesDoc {
  if (!points.length || !doc.sections?.length) return doc;
  const index = buildNameIndex(points);
  const sections = doc.sections.map((s) => {
    const names = [s.title, ...(s.related || [])];
    const resolved = resolveNames(names, index);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const id of [...(s.entityIds || []), ...resolved]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    return merged.length ? { ...s, entityIds: merged } : s;
  });
  return { ...doc, sections, themes: [] };
}

/** @deprecated */
export function attachThemeEntities(
  doc: LectureNotesDoc,
  points: AppReviewPoint[],
): LectureNotesDoc {
  return attachSectionEntities(doc, points);
}

export function sectionMatchesFocus(
  sec: LectureNoteSection,
  focusId?: string | null,
  focusZh?: string | null,
): boolean {
  const id = String(focusId || "").trim();
  const label = String(focusZh || "").trim();
  if (id && (sec.entityIds || []).includes(id)) return true;
  if (id) {
    const idZh = zh(id);
    if ((sec.entityIds || []).some((eid) => eid === id || zh(eid) === idZh)) return true;
    if ((sec.related || []).some((r) => r === id || zh(r) === idZh)) return true;
  }
  if (!label) return false;
  if (sec.title === label || zh(sec.title) === label) return true;
  return (sec.related || []).some((r) => r === label || zh(r) === label);
}

/** @deprecated */
export function themeMatchesFocus(
  theme: LectureTheme,
  focusId?: string | null,
  focusZh?: string | null,
): boolean {
  const fake: LectureNoteSection = {
    id: theme.id,
    kind: "concept",
    title: theme.title,
    summary: theme.oneLiner,
    body: "",
    bullets: [],
    related: theme.keyPoints || [],
    tips: [],
    entityIds: theme.entityIds,
  };
  return sectionMatchesFocus(fake, focusId, focusZh);
}

export function pickSectionForFocus(
  doc: LectureNotesDoc,
  focusId?: string | null,
  focusZh?: string | null,
): LectureNoteSection | null {
  const hits = doc.sections.filter((s) => sectionMatchesFocus(s, focusId, focusZh));
  if (!hits.length) return null;
  hits.sort((a, b) => (a.entityIds?.length || 99) - (b.entityIds?.length || 99));
  return hits[0];
}

/** @deprecated */
export function pickThemeForFocus(
  doc: LectureNotesDoc,
  focusId?: string | null,
  focusZh?: string | null,
): LectureTheme | null {
  const sec = pickSectionForFocus(doc, focusId, focusZh);
  if (!sec) return null;
  return {
    id: sec.id,
    title: sec.title,
    oneLiner: sec.summary,
    keyPoints: sec.related || [],
    entityIds: sec.entityIds,
  };
}

function localBlocksForPoint(p: AppReviewPoint): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  const def = String(p.definition || "").trim();
  const summary = String(p.summary || "").trim();
  if (summary && summary !== def) {
    blocks.push({
      type: "fact",
      label: "性质",
      text: summary.slice(0, 280) + (summary.length > 280 ? "…" : ""),
    });
  }

  const neighbors = (p.neighbors || [])
    .map((n) => zh(n.object) || zh(n.subject))
    .filter((name) => name && name !== p.zh)
    .slice(0, 4);
  if (neighbors.length) {
    blocks.push({
      type: "fact",
      label: "相关",
      text: `与 ${neighbors.join("、")} 等相关；边关系见知识图谱。`,
    });
  }

  const ev = (p.evidence || [])
    .map((e) => String(e.text || "").trim())
    .filter(Boolean);
  if (ev[0]) {
    blocks.push({
      type: "example",
      label: "例",
      text: ev[0].slice(0, 260) + (ev[0].length > 260 ? "…" : ""),
    });
  }

  return blocks.slice(0, 8);
}

function sessionNoteTitle(lectureId: string, title?: string): {
  title: string;
  subtitle: string;
} {
  const id = String(lectureId || "").trim();
  const m = id.match(/^(\d+)_(\d+)$/);
  if (m) {
    const idx = Math.ceil(Number(m[1]) / 2);
    return {
      title: title?.trim() || `第 ${idx} 次课 · 笔记`,
      subtitle: `第 ${m[1]}–${m[2]} 讲`,
    };
  }
  return {
    title: title?.trim() || `第 ${id || "?"} 讲 · 笔记`,
    subtitle: "单讲课次",
  };
}

/** 无 LLM：把知识点粗分成若干部分，拼成一篇本地讲义 */
export function buildLocalLectureNotes(input: {
  courseId: string;
  lectureId: string;
  title?: string;
  points: AppReviewPoint[];
}): LectureNotesDoc {
  const ranked = [...input.points].sort((a, b) => b.importance - a.importance);
  const take = ranked.slice(0, 18);
  const partCount = Math.min(4, Math.max(2, Math.ceil(take.length / 5)));
  const chunkSize = Math.ceil(take.length / partCount) || 1;
  const sections: LectureNoteSection[] = [];
  for (let i = 0; i < partCount; i++) {
    const chunk = take.slice(i * chunkSize, (i + 1) * chunkSize);
    if (!chunk.length) continue;
    const names = chunk.map((p) => p.zh);
    const body = chunk
      .map((p) => {
        const def = String(p.definition || p.summary || "").trim();
        return def
          ? `关于「${p.zh}」：${def.slice(0, 220)}${def.length > 220 ? "…" : ""}`
          : `本部分涉及「${p.zh}」，请结合图谱节点与课堂录像复习。`;
      })
      .join("\n\n");
    sections.push({
      id: `part-${i + 1}`,
      kind: "part",
      title: `${["一", "二", "三", "四"][i] || String(i + 1)}、${names[0]}${names.length > 1 ? "等" : ""}`,
      summary: `覆盖：${names.slice(0, 4).join("、")}${names.length > 4 ? " 等" : ""}`,
      body,
      blocks: chunk.slice(0, 2).flatMap((p) => localBlocksForPoint(p).slice(0, 2)),
      bullets: [],
      related: names.slice(0, 10),
      tips: [],
      entityIds: chunk.map((p) => p.id),
    });
  }

  const head = sessionNoteTitle(input.lectureId, input.title);
  const outline = sections.map((s) => s.title);
  const names = take.map((p) => p.zh).slice(0, 8);
  return attachSectionEntities(
    {
      version: LECTURE_NOTES_VERSION,
      title: head.title,
      subtitle: `${head.subtitle} · 本地整理`,
      overview: polishOverview(
        names.length
          ? `本次课聚焦：${names.join("、")}${take.length > names.length ? " 等" : ""}。下文按部分串讲，便于整堂复习。`
          : "本次课暂无足够材料生成讲义。",
      ),
      outline,
      themes: [],
      sections,
      source: "local",
      generatedAt: Date.now(),
    },
    input.points,
  );
}

function neighborNamesSafe(p: AppReviewPoint): string[] {
  const names = new Set<string>();
  for (const n of p.neighbors || []) {
    names.add(zh(n.subject));
    names.add(zh(n.object));
  }
  names.delete(p.zh);
  return [...names];
}

function docFromApiPayload(
  data: Record<string, unknown>,
  input: { lectureId: string; points: AppReviewPoint[] },
): LectureNotesDoc | null {
  const sections: LectureNoteSection[] = conceptSections(
    Array.isArray(data.sections)
      ? (data.sections as LectureNoteSection[]).map((s, i) => ({
          id: String(s.id || `part-${i + 1}`),
          kind: (s.kind || "part") as NoteSectionKind,
          title: String(s.title || ""),
          summary: String(s.summary || ""),
          body: String(s.body || ""),
          bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : [],
          related: Array.isArray(s.related) ? s.related.map(String) : [],
          tips: [],
          blocks: normalizeBlocks(s.blocks),
          entityIds: Array.isArray(s.entityIds) ? s.entityIds.map(String) : [],
        }))
      : [],
  );
  if (!sections.length) return null;

  const fromDisk = Boolean(data.cachedFromDisk);
  const subtitle = String(data.subtitle || "");

  const outlineRaw = Array.isArray(data.outline)
    ? data.outline.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const outline = outlineRaw.length
    ? outlineRaw.slice(0, 8)
    : sections.map((s) => s.title);

  const head = sessionNoteTitle(input.lectureId);
  return attachSectionEntities(
    {
      version: LECTURE_NOTES_VERSION,
      title: String(data.title || head.title),
      subtitle,
      overview: polishOverview(String(data.overview || "")),
      outline,
      themes: [],
      sections,
      model: data.model ? String(data.model) : undefined,
      source: fromDisk ? "disk" : "llm",
      generatedAt: Number(data.generatedAt) || Date.now(),
    },
    input.points,
  );
}

async function pollLectureNotes(input: {
  courseId: string;
  lectureId: string;
  points: AppReviewPoint[];
  /** total wait budget */
  maxWaitMs?: number;
}): Promise<LectureNotesDoc | null> {
  const maxWaitMs = input.maxWaitMs ?? 180_000;
  const started = Date.now();
  const url =
    withBase("/api/review-notes") +
    `?courseId=${encodeURIComponent(input.courseId)}&lectureId=${encodeURIComponent(input.lectureId)}`;

  while (Date.now() - started < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await fetch(url, { method: "GET" });
      const data = await r.json().catch(() => ({}));
      if (r.status === 200) {
        const doc = docFromApiPayload(data, input);
        if (doc) return doc;
      }
      if (r.status === 202 || data?.status === "generating") {
        continue;
      }
      if (r.status === 502 || data?.status === "failed") {
        return null;
      }
      // 404 NOT_CACHED: job may not have written status yet
      if (r.status === 404) continue;
    } catch {
      /* network blip — keep polling */
    }
  }
  return null;
}

/** 只读已落盘缓存，不触发 LLM 生成（课次连点切换用） */
export async function peekLectureNotesCache(input: {
  courseId: string;
  lectureId: string;
  points: AppReviewPoint[];
}): Promise<LectureNotesDoc | null> {
  const url =
    withBase("/api/review-notes") +
    `?courseId=${encodeURIComponent(input.courseId)}&lectureId=${encodeURIComponent(input.lectureId)}`;
  try {
    const r = await fetch(url, { method: "GET" });
    if (r.status !== 200) return null;
    const data = await r.json().catch(() => ({}));
    return docFromApiPayload(
      { ...data, cachedFromDisk: true },
      { lectureId: input.lectureId, points: input.points },
    );
  } catch {
    return null;
  }
}

export async function fetchLectureNotes(input: {
  courseId: string;
  lectureId: string;
  title?: string;
  points: AppReviewPoint[];
  force?: boolean;
}): Promise<LectureNotesDoc> {
  const payload = {
    courseId: input.courseId,
    lectureId: input.lectureId,
    title: input.title,
    force: Boolean(input.force),
    /** 避开前置网关 60s 超时：服务端后台生成，前端轮询 */
    async: true,
    points: input.points.map(packPoint),
  };
  let r: Response | null = null;
  let lastFetchErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      r = await fetch(withBase("/api/review-notes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      lastFetchErr = null;
      break;
    } catch (e) {
      lastFetchErr = e;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  if (!r) {
    const local = buildLocalLectureNotes(input);
    const why = String((lastFetchErr as Error)?.message || lastFetchErr || "fetch failed");
    return {
      ...local,
      subtitle: `本地整理（生成失败：${why}；请确认图谱服务与 LLM 可用）`,
    };
  }

  const data = await r.json().catch(() => ({}));

  // 异步已启动：轮询直到落盘
  if (r.status === 202 || data?.status === "generating") {
    const polled = await pollLectureNotes({
      courseId: input.courseId,
      lectureId: input.lectureId,
      points: input.points,
      maxWaitMs: 180_000,
    });
    if (polled) return polled;
    const local = buildLocalLectureNotes(input);
    return {
      ...local,
      subtitle: "本地整理（生成超时：可稍后刷新，服务端可能仍在写缓存）",
    };
  }

  if (!r.ok) {
    const local = buildLocalLectureNotes(input);
    return {
      ...local,
      subtitle:
        data?.error === "NO_LLM_KEY"
          ? "本地整理（未配置大模型密钥）"
          : `本地整理（生成失败：${data?.message || data?.error || r.status}）`,
    };
  }

  const doc = docFromApiPayload(data, input);
  if (!doc) return buildLocalLectureNotes(input);
  return doc;
}
