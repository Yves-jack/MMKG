/**
 * 章导图构建（课堂优先）：
 * 1. 已有 summaries（尤其 manual）→ 骨架
 * 2. segments/.../ocr/ppt_ocr.json → PPT 页标题骨架
 * 3. review/lecture_*.json 知识点+片段标题 → 课堂代理骨架
 * 4. 再无则退回讲次枝融合
 * 5. 课总图 = 章浅拼接
 *
 * 不再默认使用教材 toc.md（导图须对齐真实课堂）。
 *
 *   node scripts/build-chapter-mindmaps.mjs
 *   node scripts/build-chapter-mindmaps.mjs --course 数理逻辑
 *   node scripts/build-chapter-mindmaps.mjs --allow-textbook-toc  # 可选后备
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");

const COURSE_TEXTBOOK = {
  数理逻辑: "data/textbook/CS2501-离散数学（数理逻辑与集合论）",
  "离散数学(图论+数理逻辑与集合论)":
    "data/textbook/CS2501-离散数学（图论+数理逻辑与集合论）",
};

function chapterFileSlug(chapter) {
  const bare = String(chapter || "")
    .replace(/^第\s*\d+\s*章\s*/, "")
    .trim();
  const base = bare || String(chapter || "chapter");
  return base
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function chapterNavId(chapter) {
  return `chapter:${String(chapter || "").trim()}`;
}

function cloneNode(n) {
  return {
    ...n,
    children: Array.isArray(n.children) ? n.children.map(cloneNode) : [],
  };
}

function countNodes(n) {
  return 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
}

function depthOf(n, d = 0) {
  if (!n.children?.length) return d;
  return Math.max(...n.children.map((c) => depthOf(c, d + 1)));
}

function forestRoots(doc) {
  if (doc.roots?.length) return doc.roots.map(cloneNode);
  if (doc.root) return [cloneNode(doc.root)];
  return [];
}

function primaryZh(idOrZh) {
  return String(idOrZh || "").split("/")[0].trim();
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "");
}

function cleanOutlineLine(s) {
  return String(s || "")
    .replace(/^[-*•·]\s*/, "")
    .replace(/^\d+(?:\.\d+)*[.)、]\s*/, "")
    .trim();
}

function parseOutlineText(chapter, text, source = "manual") {
  const chapterBare =
    String(chapter || "").replace(/^第\s*\d+\s*章\s*/, "").trim() || chapter;
  const sections = [];
  const edges = [];
  const outline = [];
  let lastSection = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const md = raw.match(/^(#{1,4})\s+(.+)$/);
    if (md) {
      const level = md[1].length;
      const title = cleanOutlineLine(md[2]);
      if (!title || /^第\s*\d+\s*章/.test(title)) continue;
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
    sections.push({ title, bare: title });
    outline.push(title);
    edges.push({ parent: chapterBare, child: title });
    lastSection = title;
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

function skeletonFromSummaryFile(chapter, data) {
  if (!data) return null;
  if (data.source === "textbook_toc") return null; // 忽略旧教材骨架
  // manual / manual_llm / classroom_* 均可用
  if (data.outline_text?.trim()) {
    return parseOutlineText(
      chapter,
      data.outline_text,
      data.source || "manual"
    );
  }
  if (Array.isArray(data.outline) && data.outline.length) {
    return parseOutlineText(
      chapter,
      data.outline.join("\n"),
      data.source || "summary"
    );
  }
  if (Array.isArray(data.sections) && data.sections.length && data.source !== "textbook_toc") {
    const lines = data.sections.map((s) => s.title || s.bare).filter(Boolean);
    return parseOutlineText(chapter, lines.join("\n"), data.source || "summary");
  }
  return null;
}

function skeletonFromPptOcr(chapter, pagesObj) {
  if (!pagesObj || typeof pagesObj !== "object") return null;
  const keys = Object.keys(pagesObj).sort((a, b) => Number(a) - Number(b));
  const headings = [];
  const seen = new Set();
  for (const k of keys) {
    const first = String(pagesObj[k] || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4);
    for (const line of first) {
      const t = cleanOutlineLine(line).replace(/[。；;]+$/g, "").trim();
      if (t.length < 2 || t.length > 28) continue;
      if (/^(第\s*\d+\s*页|page\s*\d+)/i.test(t)) continue;
      if (/好，|那么|我们|今天|上课/.test(t)) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      headings.push(t);
      break;
    }
    if (headings.length >= 16) break;
  }
  if (headings.length < 2) return null;
  return parseOutlineText(chapter, headings.join("\n"), "classroom_ppt");
}

function skeletonFromReviewDocs(chapter, reviewDocs) {
  const lines = [];
  const seen = new Set();
  const push = (raw, maxLen = 24) => {
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
      if (lines.length >= 14) break;
    }
    if (lines.length >= 14) break;
  }
  if (lines.length < 4) {
    for (const doc of reviewDocs) {
      for (const seg of doc.segments || []) push(String(seg.title || ""), 20);
    }
  }
  if (lines.length < 2) return null;
  return parseOutlineText(chapter, lines.join("\n"), "classroom_review");
}

function scoreEntityToSection(entityId, entityZh, section) {
  const ez = norm(entityZh || primaryZh(entityId));
  const bare = norm(section.bare);
  const full = norm(section.title);
  if (!ez) return 0;
  if (ez === bare || ez === full) return 10;
  if (bare.length >= 2 && ez.startsWith(bare) && ez.length > bare.length + 1) {
    return 1.5;
  }
  const parts = [];
  const pushPart = (x) => {
    const t = String(x || "")
      .replace(/^[-*•·]\s*/, "")
      .replace(/[（(].*?[）)]/g, "")
      .trim();
    if (t.length >= 1) parts.push(t);
  };
  const expanded = String(section.bare || section.title || "").replace(
    /[（(]([^）)]+)[）)]/g,
    "、$1"
  );
  for (const x of expanded.split(/[及和与、,/，]+|(?:\s+vs\.?\s+)/i)) {
    pushPart(x);
  }
  for (const p of [...parts]) {
    const m = String(p).match(/^(.+?)的(定义|概念|性质|定理|运算|表示)$/);
    if (m?.[1]) pushPart(m[1]);
  }
  let partHit = 0;
  for (const raw of parts) {
    const p = norm(raw);
    if (!p) continue;
    if (ez === p) partHit = Math.max(partHit, p.length >= 2 ? 9 : 7);
    else if (p.length >= 2 && ez.length >= 2 && (ez.includes(p) || p.includes(ez))) {
      const shorter = Math.min(ez.length, p.length);
      const longer = Math.max(ez.length, p.length);
      if (shorter / longer >= 0.5) partHit = Math.max(partHit, 6);
    }
  }
  if (partHit) return partHit;
  if (bare.length >= 2 && (ez.includes(bare) || bare.includes(ez))) {
    const shorter = Math.min(ez.length, bare.length);
    const longer = Math.max(ez.length, bare.length);
    if (shorter < 2 || shorter / longer < 0.55) return 0;
    const lenPenalty = Math.abs(ez.length - bare.length) * 0.15;
    return Math.max(2, 6 + Math.min(ez.length, bare.length) * 0.1 - lenPenalty);
  }
  return 0;
}

function isUmbrellaTitle(title) {
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

function sameDisplayName(leaf, label) {
  const a = norm(leaf.zh || primaryZh(leaf.id));
  const b = norm(label);
  if (!a || !b || a !== b) return false;
  if (/[（(/、与和及]/.test(label)) return false;
  return true;
}

function pickLeavesForLabel(leafPool, usedLeaf, label, opts) {
  const minScoreBase = opts.minScore;
  const umbrella = isUmbrellaTitle(label);
  const minScore =
    umbrella && !opts.allowUmbrella ? Math.max(minScoreBase, 9) : minScoreBase;
  return leafPool
    .filter((l) => !usedLeaf.has(l.id))
    .map((l) => ({
      l,
      s: scoreEntityToSection(l.id, l.zh, { title: label, bare: label }),
    }))
    .filter((x) => x.s >= minScore)
    .sort(
      (a, b) => b.s - a.s || (b.l.importance || 0) - (a.l.importance || 0)
    )
    .slice(0, opts.max);
}

function collectEntityLeaves(doc) {
  const out = [];
  const seen = new Set();
  const walk = (n) => {
    if (!String(n.id).startsWith("__") && !seen.has(n.id)) {
      seen.add(n.id);
      out.push({
        id: n.id,
        zh: n.zh,
        importance: n.importance || 0,
        relation: n.relation || null,
        related: n.related || [],
        deps: n.deps || [],
        children: [],
      });
    }
    for (const c of n.children || []) walk(c);
  };
  for (const t of forestRoots(doc)) walk(t);
  return out;
}

function buildChapterFromSkeleton(skeleton, lectures, maxLeaves = 8, opts = {}) {
  const dumpLeftovers = opts.dumpLeftovers === true;
  const extraLeaves = opts.extraLeaves || [];
  const chapterTitle = skeleton.chapter;
  const leafPool = [];
  const leafSeen = new Set();
  const pushLeaf = (leaf) => {
    if (leafSeen.has(leaf.id)) {
      const prev = leafPool.find((x) => x.id === leaf.id);
      if (prev && (leaf.importance || 0) > (prev.importance || 0)) {
        prev.importance = leaf.importance;
      }
      return;
    }
    leafSeen.add(leaf.id);
    leafPool.push(leaf);
  };
  for (const { doc } of lectures) {
    for (const leaf of collectEntityLeaves(doc)) pushLeaf(leaf);
  }
  for (const leaf of extraLeaves) pushLeaf(leaf);

  const usedLeaf = new Set();
  const topicSlots = [];
  const sectionNodes = skeleton.sections.map((sec) => {
    const thirdLabels = skeleton.edges
      .filter((e) => e.parent === sec.bare)
      .map((e) => e.child)
      .filter((c) => c !== sec.bare);

    const thirdNodes = [];
    for (const label of thirdLabels) {
      const exact = leafPool.find(
        (l) => !usedLeaf.has(l.id) && sameDisplayName(l, label)
      );
      let kids = [];
      if (exact) {
        usedLeaf.add(exact.id);
      } else {
        const scored = pickLeavesForLabel(leafPool, usedLeaf, label, {
          minScore: 6,
          max: Math.max(2, Math.floor(maxLeaves / 2)),
          allowUmbrella: true,
        });
        for (const { l } of scored) {
          usedLeaf.add(l.id);
          kids.push(l);
        }
      }
      const node = {
        id: `__topic__/${sec.num || sec.bare}/${label}`,
        zh: label,
        importance: Math.max(
          0.35,
          exact?.importance || 0,
          ...kids.map((k) => k.importance || 0),
          0.35
        ),
        relation: "toc_topic",
        related: exact ? [exact.zh || primaryZh(exact.id)] : [],
        children: kids,
      };
      thirdNodes.push(node);
      topicSlots.push({ node, label, sectionBare: sec.bare });
    }

    const directKids = [];
    if (thirdNodes.length === 0 || !isUmbrellaTitle(sec.bare)) {
      const minScore = thirdNodes.length === 0 ? 6 : 8;
      const scored = pickLeavesForLabel(leafPool, usedLeaf, sec.bare, {
        minScore,
        max: maxLeaves,
        allowUmbrella: thirdNodes.length === 0,
      }).filter(({ l }) => primaryZh(l.id) !== sec.bare && l.zh !== sec.bare);
      for (const { l } of scored) {
        usedLeaf.add(l.id);
        directKids.push(l);
      }
    }

    const children = [...thirdNodes, ...directKids];
    return {
      id: `__section__/${sec.title}`,
      zh: sec.title,
      importance: Math.max(0.4, ...children.map((c) => c.importance || 0), 0.4),
      relation: "toc_section",
      related: [],
      children,
    };
  });

  const unused = leafPool.filter((l) => !usedLeaf.has(l.id));
  for (const leaf of unused) {
    if (usedLeaf.has(leaf.id)) continue;
    let best = null;
    for (const slot of topicSlots) {
      const s = scoreEntityToSection(leaf.id, leaf.zh, {
        title: slot.label,
        bare: slot.label,
      });
      if (s < 6) continue;
      if (!best || s > best.s) best = { slot, s };
    }
    if (!best) {
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
    if (
      best.slot.node.children.length >= Math.max(2, Math.floor(maxLeaves / 2))
    ) {
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

  const root = {
    id: `__chapter__/${chapterTitle}`,
    zh: chapterTitle,
    importance: 0.75,
    relation: null,
    related: [],
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
  return {
    lecture_id: chapterNavId(chapterTitle),
    root,
    roots: [root],
    n_nodes: countNodes(root),
    max_depth: depthOf(root),
    orphan_count: leftovers.length,
    meta: {
      chapter: chapterTitle,
      root_zh: chapterTitle,
      virtual_root: true,
      scope: "chapter",
      lecture_ids: lectures.map((l) => l.lectureId),
      source: src,
      n_trees: 1,
      skeleton_source: skeleton.source,
      n_sections: skeleton.sections.length,
    },
  };
}

function dedupeAcrossLectures(branches) {
  const seen = new Set();
  const strip = (n) => {
    if (seen.has(n.id) && !String(n.id).startsWith("__")) {
      return { ...n, copy: true, weak: true, children: [] };
    }
    if (
      !String(n.id).startsWith("__lecture__/") &&
      !String(n.id).startsWith("__chapter__/")
    ) {
      seen.add(n.id);
    }
    return { ...n, children: (n.children || []).map(strip) };
  };
  return branches.map(strip);
}

function buildChapterDocLectureBranches(chapter, lectures, source = "kg") {
  const lectureIds = lectures.map((l) => l.lectureId);
  const branches = lectures.map(({ lectureId, doc }) => {
    const trees = forestRoots(doc);
    return {
      id: `__lecture__/${lectureId}`,
      zh: `第 ${lectureId} 讲`,
      importance: Math.max(0.3, ...trees.map((t) => Number(t.importance) || 0)),
      relation: "toc_lecture",
      related: [],
      children: trees,
    };
  });
  const root = {
    id: `__chapter__/${chapter}`,
    zh: chapter,
    importance: 0.7,
    relation: null,
    related: [],
    children: dedupeAcrossLectures(branches),
  };
  return {
    lecture_id: chapterNavId(chapter),
    root,
    roots: [root],
    n_nodes: countNodes(root),
    max_depth: depthOf(root),
    orphan_count: lectures.reduce((s, l) => s + (l.doc.orphan_count || 0), 0),
    meta: {
      chapter,
      root_zh: chapter,
      virtual_root: true,
      scope: "chapter",
      lecture_ids: lectureIds,
      source,
      n_trees: 1,
    },
  };
}

function resolveCourseDirs(course) {
  return {
    viz: path.join(repoRoot, "data/viz", course),
    pub: path.join(appRoot, "public/data/courses", course),
  };
}

function loadIndex(courseDir) {
  const p = path.join(courseDir, "mindmap_showcase.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadLectureDoc(mindDir, lectureId) {
  const p = path.join(mindDir, `lecture_${lectureId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadReviewDoc(courseDir, lectureId) {
  const p = path.join(courseDir, "review", `lecture_${lectureId}.json`);
  if (!fs.existsSync(p)) {
    const vizAlt = path.join(
      repoRoot,
      "data/viz",
      path.basename(courseDir),
      "review",
      `lecture_${lectureId}.json`
    );
    if (fs.existsSync(vizAlt)) {
      return JSON.parse(fs.readFileSync(vizAlt, "utf8"));
    }
    return null;
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadPptOcrPages(courseId, lectureIds) {
  const merged = {};
  let offset = 0;
  for (const lid of lectureIds) {
    const p = path.join(
      repoRoot,
      "data/segments",
      courseId,
      "asr_work",
      String(lid),
      "ocr",
      "ppt_ocr.json"
    );
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const pages = data.pages || {};
      for (const [k, v] of Object.entries(pages)) {
        merged[String(offset + Number(k))] = v;
      }
      offset += Object.keys(pages).length + 1;
    } catch {
      /* ignore */
    }
  }
  return Object.keys(merged).length ? merged : null;
}

function writeSummary(courseDir, chapter, skeleton) {
  const sumDir = path.join(courseDir, "summaries");
  fs.mkdirSync(sumDir, { recursive: true });
  const out = path.join(sumDir, `chapter_${chapterFileSlug(chapter)}.json`);
  const doc = {
    chapter: skeleton.chapter,
    source: skeleton.source,
    outline: skeleton.outline,
    edges: skeleton.edges,
    sections: skeleton.sections,
    outline_text:
      skeleton.outline_text ||
      skeleton.sections.map((s) => s.title).join("\n"),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return out;
}

function resolveSkeleton(courseId, courseDir, chapter, lectureIds, allowTextbook) {
  const slug = chapterFileSlug(chapter);
  const sumPath = path.join(courseDir, "summaries", `chapter_${slug}.json`);
  if (fs.existsSync(sumPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(sumPath, "utf8"));
      const sk = skeletonFromSummaryFile(chapter, data);
      if (sk?.sections?.length) return sk;
    } catch {
      /* continue */
    }
  }

  const pptPages = loadPptOcrPages(courseId, lectureIds);
  if (pptPages) {
    const sk = skeletonFromPptOcr(chapter, pptPages);
    if (sk?.sections?.length) return sk;
  }

  const reviews = [];
  for (const lid of lectureIds) {
    const doc = loadReviewDoc(courseDir, lid);
    if (doc) reviews.push(doc);
  }
  const fromReview = skeletonFromReviewDocs(chapter, reviews);
  if (fromReview?.sections?.length) return fromReview;

  if (allowTextbook) {
    const rel = COURSE_TEXTBOOK[courseId];
    if (rel) {
      const tocPath = path.join(repoRoot, rel, "toc.md");
      if (fs.existsSync(tocPath)) {
        const md = fs.readFileSync(tocPath, "utf8");
        const block = md
          .split(/^## /m)
          .map((b) => b.trim())
          .find((b) => b.startsWith(chapter.replace(/^第/, "第")) || b.startsWith(chapter));
        // simple: find ## chapter then ### lines
        const lines = [];
        let inCh = false;
        for (const raw of md.split(/\r?\n/)) {
          if (raw.startsWith("## ")) {
            inCh = raw.slice(3).trim() === chapter;
            continue;
          }
          if (inCh && raw.startsWith("### ")) lines.push(raw.slice(4).trim());
          if (inCh && raw.startsWith("## ")) break;
        }
        if (lines.length) {
          return parseOutlineText(chapter, lines.join("\n"), "textbook_toc");
        }
      }
    }
  }
  return null;
}

function processCourse(course, allowTextbook) {
  const { viz, pub } = resolveCourseDirs(course);
  const targets = [viz, pub].filter((d) => fs.existsSync(d));
  if (!targets.length) {
    console.warn(`skip ${course}: no viz/public dir`);
    return;
  }

  for (const courseDir of targets) {
    const index = loadIndex(courseDir);
    if (!index?.items?.length) {
      console.warn(`skip ${courseDir}: no mindmap_showcase.json`);
      continue;
    }
    const mindDir = path.join(courseDir, "mindmaps");
    fs.mkdirSync(mindDir, { recursive: true });

    const courseItems = [];
    const lectureItems = [];
    for (const it of index.items) {
      if (it.scope === "course" || it.lecture_id === "course") {
        courseItems.push({ ...it, scope: "course", source: it.source || "kg" });
      } else if (
        it.scope !== "chapter" &&
        !String(it.lecture_id).startsWith("chapter:")
      ) {
        lectureItems.push({
          ...it,
          scope: "lecture",
          source: it.source || "kg",
          chapter_id: it.chapter_id || it.chapter,
        });
      }
    }

    const byChapter = new Map();
    for (const it of lectureItems) {
      const ch = String(it.chapter || "").trim();
      if (!ch) continue;
      if (!byChapter.has(ch)) byChapter.set(ch, []);
      byChapter.get(ch).push(it);
    }

    const chapterItems = [];
    for (const [ch, items] of [...byChapter.entries()].sort((a, b) => {
      const na = Number(String(a[0]).match(/第\s*(\d+)\s*章/)?.[1] || 999);
      const nb = Number(String(b[0]).match(/第\s*(\d+)\s*章/)?.[1] || 999);
      return na - nb || a[0].localeCompare(b[0], "zh");
    })) {
      const lids = items
        .map((i) => i.lecture_id)
        .filter(Boolean)
        .sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)));
      const lectures = [];
      for (const lid of lids) {
        const doc = loadLectureDoc(mindDir, lid);
        if (!doc) {
          console.warn(`  missing lecture_${lid}.json under ${mindDir}`);
          continue;
        }
        lectures.push({ lectureId: String(lid), doc });
      }
      if (!lectures.length) continue;

      const skeleton = resolveSkeleton(
        course,
        courseDir,
        ch,
        lids.map(String),
        allowTextbook
      );
      let doc;
      let source;
      if (skeleton?.sections?.length) {
        doc = buildChapterFromSkeleton(skeleton, lectures);
        source = doc.meta.source;
        writeSummary(courseDir, ch, skeleton);
      } else {
        source = "kg";
        doc = buildChapterDocLectureBranches(ch, lectures, source);
      }

      const slug = chapterFileSlug(ch);
      const relPath = `mindmaps/chapter_${slug}.json`;
      const outPath = path.join(courseDir, relPath);
      fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), "utf8");
      console.log(
        `wrote ${outPath} (${doc.n_nodes} nodes, source=${source}, skeleton=${doc.meta?.skeleton_source || "none"})`
      );

      chapterItems.push({
        lecture_id: chapterNavId(ch),
        chapter: ch,
        chapter_id: ch,
        root_zh: ch.replace(/^第\s*\d+\s*章\s*/, "").trim() || ch,
        n_nodes: doc.n_nodes,
        max_depth: doc.max_depth,
        orphan_count: doc.orphan_count,
        path: relPath,
        scope: "chapter",
        lecture_ids: lids.map(String),
        source,
      });
    }

    if (chapterItems.length) {
      const courseTitle =
        courseItems[0]?.root_zh ||
        courseItems[0]?.chapter ||
        index.courseId ||
        course;
      const chapterNodes = [];
      for (const it of chapterItems) {
        const chPath = path.join(courseDir, it.path);
        if (!fs.existsSync(chPath)) continue;
        const chDoc = JSON.parse(fs.readFileSync(chPath, "utf8"));
        const chRoot = (chDoc.roots && chDoc.roots[0]) || chDoc.root;
        const topics = [];
        const seen = new Set();
        for (const child of chRoot?.children || []) {
          const id = String(child.id || "");
          if (id.startsWith("__section__/")) {
            if (seen.has(id)) continue;
            seen.add(id);
            topics.push({
              id,
              zh: child.zh,
              importance: child.importance || 0.4,
              relation: "toc_section",
              related: [],
              children: [],
            });
          } else if (id.startsWith("__lecture__/")) {
            for (const t of child.children || []) {
              if (!t?.id || String(t.id).startsWith("__") || seen.has(t.id)) continue;
              seen.add(t.id);
              topics.push({
                id: t.id,
                zh: t.zh,
                importance: t.importance || 0,
                relation: t.relation || "chapter_topic",
                related: [],
                children: [],
              });
            }
          }
        }
        topics.sort((a, b) => (b.importance || 0) - (a.importance || 0));
        chapterNodes.push({
          id: `__chapter__/${it.chapter}`,
          zh: it.chapter,
          importance: 0.65,
          relation: "toc_chapter",
          related: [],
          children: topics.slice(0, 10),
        });
      }
      const courseRoot = {
        id: `__course__/${courseTitle}`,
        zh: courseTitle,
        importance: 0.9,
        relation: null,
        related: [],
        children: chapterNodes,
      };
      const courseSource = chapterItems.some(
        (c) => c.source === "summary+kg" || c.source === "review+kg"
      )
        ? "summary+kg"
        : "kg";
      const courseDoc = {
        lecture_id: "course",
        root: courseRoot,
        roots: [courseRoot],
        n_nodes: countNodes(courseRoot),
        max_depth: depthOf(courseRoot),
        orphan_count: 0,
        meta: {
          chapter: courseTitle,
          root_zh: courseTitle,
          virtual_root: true,
          scope: "course",
          source: courseSource,
          n_chapters: chapterNodes.length,
          n_trees: 1,
          composed_from: "chapters",
        },
      };
      fs.writeFileSync(
        path.join(mindDir, "course.json"),
        JSON.stringify(courseDoc, null, 2),
        "utf8"
      );
      console.log(`wrote course.json (stitched ${chapterNodes.length} chapters)`);
      courseItems.length = 0;
      courseItems.push({
        lecture_id: "course",
        chapter: courseTitle,
        root_zh: courseTitle,
        n_nodes: courseDoc.n_nodes,
        max_depth: courseDoc.max_depth,
        orphan_count: 0,
        path: "mindmaps/course.json",
        scope: "course",
        source: courseSource,
      });
    }

    const next = {
      courseId: index.courseId || course,
      title: index.title || "思维导图",
      items: [...courseItems, ...chapterItems, ...lectureItems],
    };
    fs.writeFileSync(
      path.join(courseDir, "mindmap_showcase.json"),
      JSON.stringify(next, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(mindDir, "index.json"),
      JSON.stringify(next, null, 2),
      "utf8"
    );
    console.log(
      `index → ${path.join(courseDir, "mindmap_showcase.json")} (${next.items.length} items)`
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  let courses = [];
  let allowTextbook = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--course" && args[i + 1]) courses.push(args[++i]);
    if (args[i] === "--allow-textbook-toc") allowTextbook = true;
  }
  if (!courses.length) {
    courses = ["数理逻辑", "离散数学(图论+数理逻辑与集合论)"];
  }
  for (const c of courses) processCourse(c, allowTextbook);
}

main();
