/**
 * 章导图骨架（课堂优先）：
 * 1. 人工大纲/总结（manual）
 * 2. PPT OCR 页标题（classroom_ppt）
 * 3. 复习浓缩知识点 + 片段标题（classroom_review，作 PPT 缺省代理）
 * 教材 TOC 仅作可选后备，默认不用。
 *
 * 骨架定 2–3 级父子后，再挂 KG 叶；关联走 related/deps/assets。
 */
import type { MindmapDoc, MindmapTreeNode } from "@/components/mindmap/MindmapTree";
import { cloneNode, docForest } from "@/lib/apps/mindmapEdits";
import { chapterNavId, type MindmapSource } from "@/lib/kg/mindmapTypes";

export type TocSection = {
  /** 展示标题 */
  title: string;
  /** 短名（匹配实体用） */
  bare: string;
  num?: string;
};

export type TocChapter = {
  title: string;
  sections: TocSection[];
};

export type SkeletonSource =
  | "manual"
  | "manual_llm"
  | "classroom_ppt"
  | "classroom_review"
  | "textbook_toc"
  | "summary";

export type ChapterSkeleton = {
  chapter: string;
  source: SkeletonSource;
  outline: string[];
  edges: { parent: string; child: string }[];
  sections: TocSection[];
  /** 可编辑原文（大纲输入框） */
  outline_text?: string;
};

const SECTION_NUM_RE = /^(\d+(?:\.\d+)*)\s+(.+)$/;
const CHAPTER_RE = /^第\s*\d+\s*章/;

function chapterBareOf(title: string): string {
  return title.replace(/^第\s*\d+\s*章\s*/, "").trim() || title;
}

function cleanOutlineLine(s: string): string {
  return String(s || "")
    .replace(/^[-*•·]\s*/, "")
    .replace(/^\d+(?:\.\d+)*[.)、]\s*/, "")
    .trim();
}

/** 人工大纲文本 → 骨架。支持缩进 / markdown # ## / 纯行列表 */
export function parseOutlineText(
  chapter: string,
  text: string,
  source: SkeletonSource = "manual"
): ChapterSkeleton {
  const chapterBare = chapterBareOf(chapter);
  const lines = String(text || "").split(/\r?\n/);
  const sections: TocSection[] = [];
  const edges: { parent: string; child: string }[] = [];
  const outline: string[] = [];
  let lastSection: string | null = null;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const md = raw.match(/^(#{1,4})\s+(.+)$/);
    if (md) {
      const level = md[1].length;
      const title = cleanOutlineLine(md[2]);
      if (!title || CHAPTER_RE.test(title)) continue;
      if (level <= 2) {
        sections.push({ title, bare: title });
        outline.push(title);
        edges.push({ parent: chapterBare, child: title });
        lastSection = title;
      } else if (lastSection) {
        edges.push({ parent: lastSection, child: title });
      }
      continue;
    }

    const indent = raw.match(/^(\s*)/)?.[1].length || 0;
    const title = cleanOutlineLine(raw);
    if (!title || title.length > 40) continue;
    if (indent >= 2 && lastSection) {
      edges.push({ parent: lastSection, child: title });
      continue;
    }
    const nm = title.match(SECTION_NUM_RE);
    const bare = (nm ? nm[2] : title).trim();
    sections.push({ title, bare, num: nm?.[1] });
    outline.push(bare);
    edges.push({ parent: chapterBare, child: bare });
    lastSection = bare;
  }

  return {
    chapter,
    source,
    outline,
    edges,
    sections,
    outline_text: text,
  };
}

export function skeletonToOutlineText(sk: ChapterSkeleton): string {
  if (sk.outline_text?.trim()) return sk.outline_text;
  const lines: string[] = [];
  const third = new Map<string, string[]>();
  for (const e of sk.edges) {
    if (sk.sections.some((s) => s.bare === e.parent)) {
      if (!third.has(e.parent)) third.set(e.parent, []);
      third.get(e.parent)!.push(e.child);
    }
  }
  for (const s of sk.sections) {
    lines.push(s.title);
    for (const c of third.get(s.bare) || []) {
      lines.push(`  ${c}`);
    }
  }
  return lines.join("\n");
}

/**
 * 从 PPT OCR 页文本抽标题行作骨架。
 * pages: { "0": "第一页…", … } 或 string[]
 */
export function skeletonFromPptOcr(
  chapter: string,
  pages: Record<string, string> | string[],
  opts: { maxSections?: number } = {}
): ChapterSkeleton | null {
  const maxSections = opts.maxSections ?? 16;
  const texts = Array.isArray(pages)
    ? pages
    : Object.keys(pages)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => pages[k]);
  const headings: string[] = [];
  const seen = new Set<string>();
  for (const page of texts) {
    const firstLines = String(page || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4);
    for (const line of firstLines) {
      const t = cleanOutlineLine(line)
        .replace(/[。；;]+$/g, "")
        .trim();
      if (t.length < 2 || t.length > 28) continue;
      if (/^(第\s*\d+\s*页|page\s*\d+)/i.test(t)) continue;
      if (/好，|那么|我们|今天|上课/.test(t)) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      headings.push(t);
      break; // 每页取首个合格标题
    }
    if (headings.length >= maxSections) break;
  }
  if (headings.length < 2) return null;
  return parseOutlineText(chapter, headings.join("\n"), "classroom_ppt");
}

/** 复习浓缩 points + 片段标题 → 课堂骨架（无 OCR 时的 PPT/板书代理） */
export function skeletonFromClassroomReview(
  chapter: string,
  reviewDocs: {
    points?: { id?: string; zh?: string }[];
    segments?: { title?: string }[];
  }[],
  opts: { maxSections?: number } = {}
): ChapterSkeleton | null {
  const maxSections = opts.maxSections ?? 14;
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string, maxLen = 24) => {
    const t = cleanOutlineLine(raw).replace(/[。；;]+$/g, "").trim();
    if (t.length < 2 || t.length > maxLen) return;
    if (/^片段\s*\d+$/.test(t) || /好，|那么|刚才|我们|上课/.test(t)) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(t);
  };
  for (const doc of reviewDocs) {
    for (const p of doc.points || []) {
      push(String(p.zh || primaryZh(String(p.id || ""))));
      if (lines.length >= maxSections) break;
    }
    if (lines.length >= maxSections) break;
  }
  // 片段标题弱补充
  if (lines.length < 4) {
    for (const doc of reviewDocs) {
      for (const seg of doc.segments || []) {
        push(String(seg.title || ""), 20);
        if (lines.length >= maxSections) break;
      }
    }
  }
  if (lines.length < 2) return null;
  return parseOutlineText(chapter, lines.join("\n"), "classroom_review");
}

export function skeletonFromSummaryDoc(
  chapter: string,
  data: {
    source?: string;
    outline?: string[];
    outline_text?: string;
    edges?: { parent: string; child: string }[];
    sections?: { title?: string; bare?: string; num?: string }[];
  }
): ChapterSkeleton | null {
  if (data.outline_text?.trim()) {
    const src = (data.source as SkeletonSource) || "manual";
    return parseOutlineText(chapter, data.outline_text, src);
  }
  if (data.sections?.length) {
    const sections: TocSection[] = data.sections.map((s) => ({
      title: String(s.title || s.bare || ""),
      bare: String(s.bare || s.title || ""),
      num: s.num,
    }));
    return {
      chapter,
      source: (data.source as SkeletonSource) || "summary",
      outline: data.outline || sections.map((s) => s.bare),
      edges: data.edges || sections.map((s) => ({
        parent: chapterBareOf(chapter),
        child: s.bare,
      })),
      sections,
    };
  }
  if (data.outline?.length) {
    return parseOutlineText(chapter, data.outline.join("\n"), (data.source as SkeletonSource) || "summary");
  }
  return null;
}

/** @deprecated 教材 TOC；默认构建不再调用 */
export function parseTextbookTocMarkdown(md: string): TocChapter[] {
  const chapters: TocChapter[] = [];
  let cur: TocChapter | null = null;
  for (const raw of String(md || "").split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(#{2,4})\s+(.+)$/);
    if (!m) continue;
    const level = m[1].length;
    const title = m[2].trim();
    if (level === 2 || CHAPTER_RE.test(title)) {
      if (CHAPTER_RE.test(title)) {
        cur = { title, sections: [] };
        chapters.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    if (level >= 3) {
      const numMatch = title.match(SECTION_NUM_RE);
      cur.sections.push({
        title,
        bare: (numMatch ? numMatch[2] : title).trim(),
        num: numMatch?.[1],
      });
    }
  }
  return chapters;
}

export function skeletonFromTocChapter(ch: TocChapter): ChapterSkeleton {
  return parseOutlineText(
    ch.title,
    ch.sections.map((s) => s.title).join("\n"),
    "textbook_toc"
  );
}

export function skeletonToSummaryDoc(sk: ChapterSkeleton) {
  return {
    chapter: sk.chapter,
    source: sk.source,
    outline: sk.outline,
    edges: sk.edges,
    sections: sk.sections.map((s) => ({
      title: s.title,
      bare: s.bare,
      num: s.num,
    })),
    outline_text: skeletonToOutlineText(sk),
  };
}

function primaryZh(idOrZh: string): string {
  return String(idOrZh || "").split("/")[0].trim();
}

function norm(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[/\-·•]/g, "");
}

/** 上位笼统标题：不宜靠子串把零散实体灌进来 */
function isUmbrellaTitle(title: string): boolean {
  const t = norm(title);
  if (!t) return true;
  if (
    /(基本)?(概念|术语|定义|分类|概述|小结|要点|表示|运算|导论|引言|其他)/.test(t) &&
    t.length <= 12
  ) {
    return true;
  }
  return /的(概念|术语|定义|分类|表示|运算)$/.test(t);
}

function splitTopicParts(label: string): string[] {
  const raw = String(label || "");
  // 端点（始点/终点）→ 端点、始点、终点
  const expanded = raw.replace(/[（(]([^）)]+)[）)]/g, "、$1");
  const parts = expanded
    .split(/[及和与、,/，]+|(?:\s+vs\.?\s+)/i)
    .map((x) => cleanOutlineLine(x).replace(/[（(].*?[）)]/g, "").trim())
    .filter((x) => x.length >= 1);
  for (const p of [...parts, raw]) {
    const m = String(p)
      .trim()
      .match(/^(.+?)的(定义|概念|性质|定理|运算|表示)$/);
    if (m && m[1].trim().length >= 1) parts.push(m[1].trim());
  }
  return [...new Set(parts.filter((x) => x.length >= 1))];
}

/** 实体与节/主题标题的贴合分（通用，不绑具体课程） */
export function scoreEntityToSection(
  entityId: string,
  entityZh: string,
  section: TocSection
): number {
  const ez = norm(entityZh || primaryZh(entityId));
  const bare = norm(section.bare);
  const full = norm(section.title);
  if (!ez || ez.length < 1) return 0;
  if (ez === bare || ez === full) return 10;

  // 短节名是实体真前缀（命题 ⊂ 命题逻辑）→ 弱相关，避免抢挂
  if (bare.length >= 2 && ez.startsWith(bare) && ez.length > bare.length + 1) {
    return 1.5;
  }

  // 并列/中心词拆分优先于整串包含（避免「边⊂增删点边」，且能挂「有限图与无限图」）
  const parts = splitTopicParts(section.bare || section.title).map(norm);
  let partHit = 0;
  for (const p of parts) {
    if (!p || p.length < 1) continue;
    if (ez === p) partHit = Math.max(partHit, p.length >= 2 ? 9 : 7);
    else if (p.length >= 2 && ez.length >= 2 && (ez.includes(p) || p.includes(ez))) {
      const shorter = Math.min(ez.length, p.length);
      const longer = Math.max(ez.length, p.length);
      if (shorter / longer >= 0.5) partHit = Math.max(partHit, 6);
    }
  }
  if (partHit) return partHit;

  // 双向包含：要求长度接近，且短串至少 2 字（避免「图⊂补图」）
  if (bare.length >= 2 && (ez.includes(bare) || bare.includes(ez))) {
    const shorter = Math.min(ez.length, bare.length);
    const longer = Math.max(ez.length, bare.length);
    if (shorter < 2 || shorter / longer < 0.55) return 0;
    const lenPenalty = Math.abs(ez.length - bare.length) * 0.15;
    return Math.max(2, 6 + Math.min(ez.length, bare.length) * 0.1 - lenPenalty);
  }

  return 0;
}

function sameDisplayName(leaf: MindmapTreeNode, label: string): boolean {
  const a = norm(leaf.zh || primaryZh(leaf.id));
  const b = norm(label);
  if (!a || !b || a !== b) return false;
  // 带括号别名/并列的主题不算「同名单实体」，避免只吸收中心词而丢掉始点/终点等
  if (/[（(/、与和及]/.test(label)) return false;
  return true;
}

function collectEntityLeaves(doc: MindmapDoc): MindmapTreeNode[] {
  const out: MindmapTreeNode[] = [];
  const seen = new Set<string>();
  const walk = (n: MindmapTreeNode) => {
    if (!n.id.startsWith("__") && !seen.has(n.id)) {
      seen.add(n.id);
      out.push({
        ...cloneNode(n),
        children: [], // 叶层：不再深挖；关联走 related/deps
      });
    }
    for (const c of n.children || []) walk(c);
  };
  for (const t of docForest(doc)) walk(t);
  return out;
}

/** 把复习浓缩 points 并入叶池（无对应讲次树时补实体） */
export function leavesFromReviewPoints(
  points: { id?: string; zh?: string; importance?: number }[] | undefined | null
): MindmapTreeNode[] {
  const out: MindmapTreeNode[] = [];
  const seen = new Set<string>();
  for (const p of points || []) {
    const id = String(p?.id || "").trim();
    const zh = String(p?.zh || primaryZh(id)).trim();
    if (!id || id.startsWith("__") || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      zh: zh || primaryZh(id),
      importance: Number(p?.importance) || 0.25,
      relation: null,
      related: [],
      children: [],
    });
  }
  return out;
}

function mergeLeafPool(
  pools: MindmapTreeNode[][]
): MindmapTreeNode[] {
  const leafPool: MindmapTreeNode[] = [];
  const leafSeen = new Set<string>();
  for (const pool of pools) {
    for (const leaf of pool) {
      if (leafSeen.has(leaf.id)) {
        const prev = leafPool.find((x) => x.id === leaf.id);
        if (prev && (leaf.importance || 0) > (prev.importance || 0)) {
          prev.importance = leaf.importance;
        }
        continue;
      }
      leafSeen.add(leaf.id);
      leafPool.push(leaf);
    }
  }
  return leafPool;
}

function pickLeavesForLabel(
  leafPool: MindmapTreeNode[],
  usedLeaf: Set<string>,
  label: string,
  opts: { minScore: number; max: number; allowUmbrella?: boolean }
): { l: MindmapTreeNode; s: number }[] {
  const sec = { title: label, bare: label };
  const umbrella = isUmbrellaTitle(label);
  const minScore = umbrella && !opts.allowUmbrella ? Math.max(opts.minScore, 9) : opts.minScore;
  return leafPool
    .filter((l) => !usedLeaf.has(l.id))
    .map((l) => ({ l, s: scoreEntityToSection(l.id, l.zh, sec) }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s || (b.l.importance || 0) - (a.l.importance || 0))
    .slice(0, opts.max);
}

function countNodes(n: MindmapTreeNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}

function depthOf(n: MindmapTreeNode, d = 0): number {
  if (!n.children.length) return d;
  return Math.max(...n.children.map((c) => depthOf(c, d + 1)));
}

/**
 * 骨架优先建章导图：章 → 节（2）→ [可选关键词 3] → KG/复习叶。
 * lectureDocs / extraLeaves 仅提供叶实体池与 importance。
 */
export function buildChapterMindmapFromSkeleton(
  skeleton: ChapterSkeleton,
  lectureDocs: { lectureId: string; doc: MindmapDoc }[],
  opts: {
    maxLeavesPerSection?: number;
    source?: MindmapSource;
    attachThirdLevel?: boolean;
    /** 额外叶（如 review points），与讲次树合并去重 */
    extraLeaves?: MindmapTreeNode[];
    /** 是否把未挂上的叶扫进「其他要点」；默认 false，避免杂项枝 */
    dumpLeftovers?: boolean;
  } = {}
): MindmapDoc {
  const maxLeaves = opts.maxLeavesPerSection ?? 8;
  const attachThird = opts.attachThirdLevel !== false;
  const dumpLeftovers = opts.dumpLeftovers === true;
  const chapterTitle = skeleton.chapter;
  const chapterBare =
    chapterTitle.replace(/^第\s*\d+\s*章\s*/, "").trim() || chapterTitle;

  const leafPool = mergeLeafPool([
    ...lectureDocs.map(({ doc }) => collectEntityLeaves(doc)),
    opts.extraLeaves || [],
  ]);

  const usedLeaf = new Set<string>();
  /** 第三级主题节点，供第二轮补挂 */
  const topicSlots: {
    node: MindmapTreeNode;
    label: string;
    sectionBare: string;
  }[] = [];

  const sectionNodes: MindmapTreeNode[] = skeleton.sections.map((sec) => {
    const sectionId = `__section__/${sec.title}`;
    const thirdLabels = attachThird
      ? skeleton.edges
          .filter((e) => e.parent === sec.bare)
          .map((e) => e.child)
          .filter((c) => c !== sec.bare)
      : [];

    const thirdNodes: MindmapTreeNode[] = [];
    for (const label of thirdLabels) {
      const tid = `__topic__/${sec.num || sec.bare}/${label}`;
      // 同名实体：吸收进主题壳，不再挂同名子叶（避免「完全图→完全图」）
      const exact = leafPool.find(
        (l) => !usedLeaf.has(l.id) && sameDisplayName(l, label)
      );
      let kids: MindmapTreeNode[] = [];
      if (exact) {
        usedLeaf.add(exact.id);
        // 主题壳保留大纲标题；同名叶只记 related，不重复显示
      } else {
        const scored = pickLeavesForLabel(leafPool, usedLeaf, label, {
          minScore: 6,
          max: Math.max(2, Math.floor(maxLeaves / 2)),
          allowUmbrella: true, // 子主题标题即使含「定义」也应可挂中心词
        });
        for (const { l } of scored) {
          usedLeaf.add(l.id);
          kids.push(l);
        }
      }
      const node: MindmapTreeNode = {
        id: tid,
        zh: label,
        importance: Math.max(
          0.35,
          exact?.importance || 0,
          ...kids.map((k) => k.importance || 0)
        ),
        relation: "toc_topic",
        related: exact ? [exact.zh || primaryZh(exact.id)] : [],
        children: kids,
      };
      thirdNodes.push(node);
      topicSlots.push({ node, label, sectionBare: sec.bare });
    }

    // 一级节：仅在无子主题时，或非笼统标题时，才直接挂叶；门槛更高
    const directKids: MindmapTreeNode[] = [];
    if (thirdNodes.length === 0 || !isUmbrellaTitle(sec.bare)) {
      const minScore = thirdNodes.length === 0 ? 6 : 8;
      const scored = pickLeavesForLabel(leafPool, usedLeaf, sec.bare, {
        minScore,
        max: maxLeaves,
        allowUmbrella: thirdNodes.length === 0,
      }).filter(
        ({ l }) => primaryZh(l.id) !== sec.bare && l.zh !== sec.bare
      );
      for (const { l } of scored) {
        usedLeaf.add(l.id);
        directKids.push(l);
      }
    }

    const children = [...thirdNodes, ...directKids];
    return {
      id: sectionId,
      zh: sec.title,
      importance: Math.max(0.4, ...children.map((c) => c.importance || 0)),
      relation: "toc_section",
      related: [],
      children,
    } satisfies MindmapTreeNode;
  });

  // 第二轮：未用叶补挂到最佳主题（仍要求较强匹配），避免「其他要点」垃圾箱
  const unused = leafPool.filter((l) => !usedLeaf.has(l.id));
  for (const leaf of unused) {
    if (usedLeaf.has(leaf.id)) continue;
    let best: { slot: (typeof topicSlots)[0]; s: number } | null = null;
    for (const slot of topicSlots) {
      const s = scoreEntityToSection(leaf.id, leaf.zh, {
        title: slot.label,
        bare: slot.label,
      });
      if (s < 6) continue;
      if (!best || s > best.s) best = { slot, s };
    }
    if (!best) {
      // 再试一级节（非笼统）
      for (const sec of skeleton.sections) {
        if (isUmbrellaTitle(sec.bare)) continue;
        const s = scoreEntityToSection(leaf.id, leaf.zh, sec);
        if (s < 8) continue;
        const host = sectionNodes.find((n) => n.zh === sec.title);
        if (!host) continue;
        usedLeaf.add(leaf.id);
        host.children.push(leaf);
        break;
      }
      continue;
    }
    if (sameDisplayName(leaf, best.slot.label)) {
      usedLeaf.add(leaf.id);
      continue;
    }
    if (best.slot.node.children.length >= Math.max(2, Math.floor(maxLeaves / 2))) {
      continue;
    }
    usedLeaf.add(leaf.id);
    best.slot.node.children.push(leaf);
  }

  const leftovers = leafPool
    .filter((l) => !usedLeaf.has(l.id))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0));
  if (dumpLeftovers && leftovers.length) {
    sectionNodes.push({
      id: `__section__/${chapterTitle}/其他要点`,
      zh: "其他要点",
      importance: 0.3,
      relation: "toc_section",
      related: [],
      children: leftovers.slice(0, maxLeaves),
      weak: true,
    });
  }

  const root: MindmapTreeNode = {
    id: `__chapter__/${chapterTitle}`,
    zh: chapterTitle,
    importance: 0.75,
    relation: null,
    related: [chapterBare],
    children: sectionNodes,
  };

  const src =
    skeleton.source === "manual" ||
    skeleton.source === "manual_llm" ||
    skeleton.source === "classroom_ppt"
      ? "summary+kg"
      : skeleton.source === "classroom_review"
        ? "review+kg"
        : "summary+kg";

  const leftoverCount = dumpLeftovers
    ? Math.max(0, leftovers.length - maxLeaves)
    : leftovers.length;

  return {
    lecture_id: chapterNavId(chapterTitle),
    root,
    roots: [root],
    n_nodes: countNodes(root),
    max_depth: depthOf(root),
    orphan_count: leftoverCount,
    meta: {
      chapter: chapterTitle,
      root_zh: chapterTitle,
      virtual_root: true,
      scope: "chapter",
      lecture_ids: lectureDocs.map((l) => l.lectureId),
      source: opts.source || src,
      n_trees: 1,
      skeleton_source: skeleton.source,
      n_sections: skeleton.sections.length,
    },
  };
}
