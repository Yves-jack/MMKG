import type { AppReviewPoint } from "@/lib/apps/data";
import { withBase } from "@/lib/withBase";

/** 笔记结构版本：v4 起为主题内 blocks（脉络/定义/性质/例子/易错/自测） */
export const LECTURE_NOTES_VERSION = 5;

export type NoteSectionKind =
  | "theme"
  | "tips"
  | "extra"
  | "checklist"
  | "overview"
  | "concept"
  | "structure";

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
  /** cue 专用：简短参考答（可折叠展示） */
  answer?: string;
};

export type LectureTheme = {
  id: string;
  title: string;
  /** 一眼看懂的一句话 */
  oneLiner: string;
  /** 该主题下的关键词/概念 */
  keyPoints: string[];
  /** 聚合时挂上的图谱实体 id（精确匹配，不bump版本） */
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
  /** v4：像课堂笔记的分块 */
  blocks?: NoteBlock[];
};

export type LectureNotesDoc = {
  version: number;
  title: string;
  subtitle: string;
  overview: string;
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

function neighborNames(p: AppReviewPoint): string[] {
  const names = new Set<string>();
  for (const n of p.neighbors || []) {
    names.add(zh(n.subject));
    names.add(zh(n.object));
  }
  names.delete(p.zh);
  return [...names];
}

/** 按重要性种子 + 邻接 overlap，把知识点分成若干主题簇 */
function clusterThemes(points: AppReviewPoint[], maxThemes = 8) {
  const ranked = [...points].sort((a, b) => b.importance - a.importance);
  if (!ranked.length) return [] as { seed: AppReviewPoint; members: AppReviewPoint[] }[];

  const nThemes = Math.min(maxThemes, Math.max(2, Math.ceil(ranked.length / 5)));
  const seeds = ranked.slice(0, nThemes);
  const used = new Set(seeds.map((s) => s.id));
  const clusters = seeds.map((seed) => ({ seed, members: [seed] as AppReviewPoint[] }));

  for (const p of ranked) {
    if (used.has(p.id)) continue;
    const pNames = new Set([p.zh, ...neighborNames(p)]);
    let best = 0;
    let bestScore = -1;
    clusters.forEach((c, i) => {
      const cNames = new Set([
        c.seed.zh,
        ...c.members.flatMap((m) => [m.zh, ...neighborNames(m)]),
      ]);
      let overlap = 0;
      for (const n of pNames) if (cNames.has(n)) overlap += 1;
      const score = overlap * 10 + (p.importance || 0);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    clusters[best].members.push(p);
    used.add(p.id);
  }
  return clusters;
}

export function isThemeNotes(doc: LectureNotesDoc | null | undefined): doc is LectureNotesDoc {
  return Boolean(
    doc &&
      doc.version === LECTURE_NOTES_VERSION &&
      Array.isArray(doc.themes) &&
      doc.themes.length > 0 &&
      Array.isArray(doc.sections) &&
      doc.sections.length > 0
  );
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

/** 把主题标题/关键词解析成图谱实体 id；已有 entityIds 则并入 */
export function attachThemeEntities(
  doc: LectureNotesDoc,
  points: AppReviewPoint[]
): LectureNotesDoc {
  if (!points.length || !doc.themes?.length) return doc;
  const index = buildNameIndex(points);
  const themes = doc.themes.map((t) => {
    const sec = doc.sections.find((s) => s.id === t.id);
    const names = [
      t.title,
      ...(t.keyPoints || []),
      ...(sec?.related || []),
      sec?.title || "",
    ];
    const resolved = resolveNames(names, index);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const id of [...(t.entityIds || []), ...resolved]) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    return merged.length ? { ...t, entityIds: merged } : t;
  });
  return { ...doc, themes };
}

export function themeMatchesFocus(
  theme: LectureTheme,
  focusId?: string | null,
  focusZh?: string | null
): boolean {
  const id = String(focusId || "").trim();
  const label = String(focusZh || "").trim();
  if (id && (theme.entityIds || []).includes(id)) return true;
  if (id) {
    const idZh = zh(id);
    if ((theme.entityIds || []).some((eid) => eid === id || zh(eid) === idZh)) {
      return true;
    }
  }
  if (!label) return false;
  if (theme.title === label) return true;
  if ((theme.keyPoints || []).some((k) => k === label || zh(k) === label)) return true;
  return (theme.entityIds || []).some((eid) => zh(eid) === label);
}

export function pickThemeForFocus(
  doc: LectureNotesDoc,
  focusId?: string | null,
  focusZh?: string | null
): LectureTheme | null {
  const hits = doc.themes.filter((t) => themeMatchesFocus(t, focusId, focusZh));
  if (!hits.length) return null;
  hits.sort(
    (a, b) => (a.entityIds?.length || 99) - (b.entityIds?.length || 99)
  );
  return hits[0];
}

function normalizeBlocks(raw: unknown): NoteBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      const type = String((b as NoteBlock)?.type || "").trim() as NoteBlockType;
      if (!BLOCK_TYPES.has(type)) return null;
      const text = String((b as NoteBlock)?.text || "").trim();
      if (!text) return null;
      const label = String((b as NoteBlock)?.label || "").trim();
      const answer = String((b as NoteBlock)?.answer || "").trim();
      const out: NoteBlock = label ? { type, label, text } : { type, text };
      if (type === "cue" && answer) out.answer = answer;
      return out;
    })
    .filter(Boolean)
    .slice(0, 16) as NoteBlock[];
}

function localBlocksForCluster(
  seed: AppReviewPoint,
  members: AppReviewPoint[]
): NoteBlock[] {
  const top = [...members].sort((a, b) => b.importance - a.importance);
  const blocks: NoteBlock[] = [];
  const hookBits = [
    `这一块围绕「${seed.zh}」展开`,
    top
      .slice(0, 4)
      .map((m) => m.zh)
      .join("、"),
  ];
  blocks.push({
    type: "hook",
    label: "脉络",
    text: `${hookBits[0]}，连带 ${hookBits[1]}。复习时先能讲清「${seed.zh}」在整堂课里扮演什么角色。`,
  });

  for (const m of top.slice(0, 4)) {
    const def = (m.definition || m.summary || "").trim();
    if (!def) continue;
    blocks.push({
      type: "def",
      label: "定义",
      text: `${m.zh} — ${def.slice(0, 160)}${def.length > 160 ? "…" : ""}`,
    });
  }

  const facts: string[] = [];
  for (const m of top.slice(0, 5)) {
    for (const n of (m.neighbors || []).slice(0, 2)) {
      const stmt =
        n.natural_statement ||
        `${zh(n.subject)} —${n.label || n.predicate}→ ${zh(n.object)}`;
      if (stmt) facts.push(stmt);
    }
  }
  for (const f of [...new Set(facts)].slice(0, 3)) {
    blocks.push({ type: "fact", label: "关系", text: f });
  }

  const ev = (seed.evidence || [])
    .map((e) => String(e.text || "").trim())
    .filter(Boolean);
  if (ev[0]) {
    blocks.push({
      type: "example",
      label: "课堂",
      text: `老师提到：${ev[0].slice(0, 180)}${ev[0].length > 180 ? "…" : ""}`,
    });
  } else if (top[1]) {
    blocks.push({
      type: "example",
      label: "示意",
      text: `把「${seed.zh}」和「${top[1].zh}」放在一起对照：先写出各自定义，再看材料里的关系边。`,
    });
  }

  if (top.length >= 2) {
    blocks.push({
      type: "pitfall",
      label: "易混",
      text: `别把「${seed.zh}」和「${top[1].zh}」当成同一层级：先分清定义，再谈谁依赖谁。`,
    });
  }

  blocks.push({
    type: "cue",
    label: "自测",
    text: `合上材料：用一句话说清「${seed.zh}」是什么，并举一个和它相关的概念。`,
    answer: `${seed.zh}：${(seed.summary || seed.definition || "见课堂定义")
      .trim()
      .slice(0, 120)}；相关可提 ${top
      .slice(1, 3)
      .map((m) => m.zh)
      .join("、") || "同主题其他概念"}。`,
  });

  return blocks.slice(0, 14);
}

/** 无 LLM 时：按主题簇拼一份「有笔记感」的本地稿 */
export function buildLocalLectureNotes(input: {
  courseId: string;
  lectureId: string;
  title?: string;
  points: AppReviewPoint[];
}): LectureNotesDoc {
  const ranked = [...input.points].sort((a, b) => b.importance - a.importance);
  const clusters = clusterThemes(input.points, 8);

  const themes: LectureTheme[] = clusters.map((c, i) => ({
    id: `theme-${i + 1}`,
    title: c.seed.zh,
    oneLiner: (c.seed.summary || c.seed.definition || `围绕「${c.seed.zh}」及相关概念`).slice(
      0,
      80
    ),
    keyPoints: c.members.slice(0, 6).map((m) => m.zh),
    entityIds: c.members.map((m) => m.id),
  }));

  const themeSections: LectureNoteSection[] = clusters.map((c, i) => {
    const blocks = localBlocksForCluster(c.seed, c.members);
    return {
      id: `theme-${i + 1}`,
      kind: "theme" as const,
      title: c.seed.zh,
      summary: `课堂在「${c.seed.zh}」这一线串起 ${c.members.length} 个相关概念；先抓住定义，再看关系与例子。`,
      body: "",
      blocks,
      bullets: [],
      related: c.members.map((m) => m.zh),
      tips: [],
    };
  });

  const sections: LectureNoteSection[] = [
    ...themeSections,
    {
      id: "tips",
      kind: "tips",
      title: "易错与复习节奏",
      summary: "先主题一句话，再定义，再例子；别一上来背词条。",
      body: "每个主题至少留下一个「合上书能答」的自测问句；对照图谱边检查关系有没有说反。",
      blocks: [],
      bullets: ["主题一句话 → 定义/记号 → 例子 → 易错", "易混概念放在同一主题内对照"],
      related: [],
      tips: ["点左侧图谱节点可跳到对应主题"],
    },
    {
      id: "checklist",
      kind: "checklist",
      title: "按主题自测",
      summary: "每个主题至少能回答 cue 问句，并解释 2 个关键词。",
      body: "",
      blocks: [],
      bullets: themes.flatMap((t) => [
        `【${t.title}】${t.oneLiner || "一句话概括？"}`,
        ...t.keyPoints.slice(0, 3).map((k) => `能定义：${k}`),
      ]),
      related: ranked.slice(0, 14).map((p) => p.zh),
      tips: [],
    },
  ];

  return attachThemeEntities(
    {
      version: LECTURE_NOTES_VERSION,
      title:
        input.title ||
        (/^\d+_\d+$/.test(String(input.lectureId))
          ? `第 ${String(input.lectureId).replace("_", "–")} 讲 · 课堂笔记`
          : `第 ${input.lectureId} 讲 · 课堂笔记`),
      subtitle: "本地整理（未调用大模型）· 分主题笔记稿",
      overview: `本堂课收成 ${themes.length} 个主题：${themes
        .map((t) => t.title)
        .join("、")}。建议按主题展开：脉络 → 定义 → 性质/关系 → 例子 → 自测。`,
      themes,
      sections,
      source: "local",
      generatedAt: Date.now(),
    },
    input.points
  );
}

export async function fetchLectureNotes(input: {
  courseId: string;
  lectureId: string;
  title?: string;
  points: AppReviewPoint[];
  /** true 时跳过服务端磁盘缓存，强制重新生成 */
  force?: boolean;
}): Promise<LectureNotesDoc> {
  const r = await fetch(withBase("/api/review-notes"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      courseId: input.courseId,
      lectureId: input.lectureId,
      title: input.title,
      force: Boolean(input.force),
      points: input.points.map(packPoint),
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const local = buildLocalLectureNotes(input);
    return {
      ...local,
      subtitle:
        data?.error === "NO_LLM_KEY"
          ? "本地整理（未配置大模型密钥）"
          : `本地整理（生成失败：${data?.error || data?.message || r.status}）`,
    };
  }

  const themes: LectureTheme[] = Array.isArray(data.themes)
    ? data.themes.map((t: LectureTheme, i: number) => ({
        id: String(t.id || `theme-${i + 1}`),
        title: String(t.title || `主题 ${i + 1}`),
        oneLiner: String(t.oneLiner || ""),
        keyPoints: Array.isArray(t.keyPoints) ? t.keyPoints.map(String) : [],
        entityIds: Array.isArray(t.entityIds) ? t.entityIds.map(String) : [],
      }))
    : [];

  const sections: LectureNoteSection[] = Array.isArray(data.sections)
    ? data.sections.map((s: LectureNoteSection, i: number) => ({
        id: String(s.id || `sec-${i + 1}`),
        kind: (s.kind || "theme") as NoteSectionKind,
        title: String(s.title || ""),
        summary: String(s.summary || ""),
        body: String(s.body || ""),
        bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : [],
        related: Array.isArray(s.related) ? s.related.map(String) : [],
        tips: Array.isArray(s.tips) ? s.tips.map(String) : [],
        blocks: normalizeBlocks(s.blocks),
      }))
    : [];

  const filledThemes =
    themes.length > 0
      ? themes
      : sections
          .filter((s) => s.kind === "theme" || s.kind === "concept")
          .map((s, i) => ({
            id: s.id || `theme-${i + 1}`,
            title: s.title,
            oneLiner: s.summary.slice(0, 80),
            keyPoints: (s.related || []).slice(0, 6),
            entityIds: [] as string[],
          }));

  if (!filledThemes.length) {
    return buildLocalLectureNotes(input);
  }

  const fromDisk = Boolean(data.cachedFromDisk);
  const baseSubtitle = String(data.subtitle || "");
  const subtitle = fromDisk
    ? baseSubtitle
      ? `${baseSubtitle} · 服务端缓存`
      : "服务端缓存"
    : baseSubtitle;

  return attachThemeEntities(
    {
      version: LECTURE_NOTES_VERSION,
      title: String(data.title || `第 ${input.lectureId} 讲 · 课堂笔记`),
      subtitle,
      overview: String(data.overview || ""),
      themes: filledThemes,
      sections,
      model: data.model,
      source: fromDisk ? "disk" : "llm",
      generatedAt: Number(data.generatedAt) || Date.now(),
    },
    input.points
  );
}
