#!/usr/bin/env node
/**
 * 用 note_match session finals 校准 mindmaps/index.json：
 * - 章 lecture_ids 按 finals 子章反推
 * - 讲次条目 chapter 对齐其所属主章（取该讲在 finals 中出现的首个章）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COURSE = process.env.TEACHKG_COURSE || "离散数学(图论+数理逻辑与集合论)";
const mindDir = path.resolve(
  __dirname,
  `../public/data/courses/${COURSE}/mindmaps`,
);
const idxPath = path.join(mindDir, "index.json");
const nmDir = path.join(mindDir, "note_match");

const chapterToLids = new Map();
const lectureToChapters = new Map();

for (const f of fs.readdirSync(nmDir).filter((x) => x.endsWith(".final.json") && x.startsWith("session_"))) {
  const m = f.match(/session_(\d+(?:_\d+)?)\.final/);
  if (!m) continue;
  const parts = m[1].split("_");
  const d = JSON.parse(fs.readFileSync(path.join(nmDir, f), "utf8"));
  for (const c of d.root?.children || []) {
    const ch = String(c.zh || "").trim();
    if (!ch) continue;
    if (!chapterToLids.has(ch)) chapterToLids.set(ch, new Set());
    for (const lid of parts) {
      chapterToLids.get(ch).add(lid);
      if (!lectureToChapters.has(lid)) lectureToChapters.set(lid, []);
      if (!lectureToChapters.get(lid).includes(ch)) {
        lectureToChapters.get(lid).push(ch);
      }
    }
  }
}

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

function countNodes(n) {
  if (!n) return 0;
  return 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
}

function depthOf(n, d = 0) {
  if (!n?.children?.length) return d;
  return Math.max(...n.children.map((c) => depthOf(c, d + 1)));
}

const catalogPath = path.resolve(
  __dirname,
  `../public/data/courses/${COURSE}/chapter_catalog.json`,
);
const catalog = fs.existsSync(catalogPath)
  ? JSON.parse(fs.readFileSync(catalogPath, "utf8"))
  : null;

const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
let chapterUpdates = 0;
let lectureUpdates = 0;
let lectureAdds = 0;
let chapterAdds = 0;

// 为 note_match 中出现、但 index 缺失的讲次补占位条目（侧栏课次导航依赖此列表）
{
  const existing = new Set(
    (idx.items || [])
      .filter(
        (it) =>
          it.scope !== "course" &&
          it.scope !== "chapter" &&
          !String(it.lecture_id || "").startsWith("chapter:") &&
          /^\d+$/.test(String(it.lecture_id || "")),
      )
      .map((it) => String(it.lecture_id)),
  );
  const allLids = [...lectureToChapters.keys()].sort(
    (a, b) => Number(a) - Number(b),
  );
  for (const lid of allLids) {
    if (existing.has(lid)) continue;
    const chs = lectureToChapters.get(lid) || [];
    idx.items.push({
      lecture_id: lid,
      scope: "lecture",
      chapter: chs[0] || undefined,
      chapter_id: chs[0] || undefined,
      n_nodes: 0,
      max_depth: 0,
      orphan_count: 0,
      path: `note_match/session_${Number(lid) % 2 === 1 ? `${lid}_${Number(lid) + 1}` : `${Number(lid) - 1}_${lid}`}.final.json`,
      source: "review+kg",
    });
    lectureAdds += 1;
  }
}

// 按 chapter_catalog + 磁盘 chapter_*.json + note_match 补全章节索引（侧栏「章节」依赖）
{
  const catalogNames = [
    ...(catalog?.chapter_order || []),
    ...[...(chapterToLids.keys())],
  ];
  const names = [...new Set(catalogNames.map((x) => String(x || "").trim()).filter(Boolean))];
  const byNav = new Map();
  for (const it of idx.items || []) {
    if (it.scope === "chapter" || String(it.lecture_id || "").startsWith("chapter:")) {
      const key = String(it.chapter || it.root_zh || it.lecture_id || "").trim();
      if (key) byNav.set(key.startsWith("chapter:") ? key.slice(8) : key, it);
      byNav.set(String(it.lecture_id || ""), it);
    }
  }
  for (const ch of names) {
    const navId = `chapter:${ch}`;
    const slug = chapterFileSlug(ch);
    const fileRel = `mindmaps/chapter_${slug}.json`;
    const fileAbs = path.join(mindDir, `chapter_${slug}.json`);
    let n_nodes = 0;
    let max_depth = 0;
    if (fs.existsSync(fileAbs)) {
      try {
        const doc = JSON.parse(fs.readFileSync(fileAbs, "utf8"));
        const root = doc.root || (doc.roots && doc.roots[0]);
        n_nodes = Number(doc.n_nodes) || countNodes(root);
        max_depth = Number(doc.max_depth) || depthOf(root);
      } catch {
        /* keep 0 */
      }
    }
    const lids = [...(chapterToLids.get(ch) || [])].sort(
      (a, b) => Number(a) - Number(b),
    );
    // note_match 章名有时不带「第N章」前缀：再试 bare 名
    if (!lids.length) {
      const bare = ch.replace(/^第\s*\d+\s*章\s*/, "").trim();
      for (const [k, set] of chapterToLids) {
        if (k === bare || k.replace(/^第\s*\d+\s*章\s*/, "").trim() === bare) {
          for (const x of set) lids.push(x);
        }
      }
      lids.sort((a, b) => Number(a) - Number(b));
    }
    const uniqLids = [...new Set(lids)];
    const existing = byNav.get(ch) || byNav.get(navId);
    if (existing) {
      let changed = false;
      if (uniqLids.length) {
        const prev = (existing.lecture_ids || []).map(String);
        if (JSON.stringify(prev) !== JSON.stringify(uniqLids)) {
          existing.lecture_ids = uniqLids;
          changed = true;
        }
      }
      if (n_nodes > 0 && Number(existing.n_nodes || 0) <= 1) {
        existing.n_nodes = n_nodes;
        existing.max_depth = max_depth;
        existing.path = fileRel;
        changed = true;
      }
      if (!existing.path && fs.existsSync(fileAbs)) {
        existing.path = fileRel;
        changed = true;
      }
      if (changed) chapterUpdates += 1;
      continue;
    }
    if (!fs.existsSync(fileAbs) && uniqLids.length === 0) continue;
    idx.items.push({
      lecture_id: navId,
      chapter: ch,
      chapter_id: ch,
      root_zh: ch.replace(/^第\s*\d+\s*章\s*/, "").trim() || ch,
      n_nodes: Math.max(n_nodes, uniqLids.length ? 2 : 0),
      max_depth,
      orphan_count: 0,
      path: fs.existsSync(fileAbs) ? fileRel : "",
      scope: "chapter",
      lecture_ids: uniqLids,
      source: "summary+kg",
    });
    chapterAdds += 1;
  }
}

for (const it of idx.items || []) {
  const isChapter =
    it.scope === "chapter" || String(it.lecture_id || "").startsWith("chapter:");
  if (isChapter) {
    const ch = String(it.chapter || it.root_zh || "").trim();
    const lids = chapterToLids.get(ch);
    if (!lids) continue;
    const next = [...lids].sort((a, b) => Number(a) - Number(b));
    const prev = (it.lecture_ids || []).map(String);
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      it.lecture_ids = next;
      chapterUpdates += 1;
    }
    continue;
  }

  const lid = String(it.lecture_id || "").trim();
  if (!/^\d+$/.test(lid)) continue;
  const chs = lectureToChapters.get(lid);
  if (!chs?.length) continue;
  // 主章：该讲首次出现的章（课次顺序已由 session 文件遍历保证大致合理）
  const primary = chs[0];
  if (it.chapter !== primary || it.chapter_id !== primary) {
    it.chapter = primary;
    it.chapter_id = primary;
    lectureUpdates += 1;
  }
}

fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2) + "\n", "utf8");

// 同步到 viz，供 sync-data 拷贝（staging 上 /workspace/data 常为只读，失败忽略）
const vizMind = path.resolve(
  __dirname,
  `../../../data/viz/${COURSE}/mindmaps`,
);
try {
  if (fs.existsSync(path.dirname(vizMind))) {
    fs.mkdirSync(vizMind, { recursive: true });
    fs.copyFileSync(idxPath, path.join(vizMind, "index.json"));
    const vizNm = path.join(vizMind, "note_match");
    fs.mkdirSync(vizNm, { recursive: true });
    for (const f of fs.readdirSync(nmDir).filter((x) => x.endsWith(".json"))) {
      fs.copyFileSync(path.join(nmDir, f), path.join(vizNm, f));
    }
  }
} catch (e) {
  console.warn("viz sync skipped:", String(e && e.message ? e.message : e));
}

console.log(
  JSON.stringify(
    {
      chapterUpdates,
      chapterAdds,
      lectureUpdates,
      lectureAdds,
      chapters_mapped: chapterToLids.size,
      chapter_index: (idx.items || []).filter(
        (it) =>
          it.scope === "chapter" ||
          String(it.lecture_id || "").startsWith("chapter:"),
      ).length,
      lecture_ids: [...lectureToChapters.keys()].sort(
        (a, b) => Number(a) - Number(b),
      ),
      lecture_1_chapters: lectureToChapters.get("1") || [],
      sample_图: [...(chapterToLids.get("第1章 图的基本概念与表示") || [])],
      sample_命题: [...(chapterToLids.get("第1章 命题逻辑的基本概念") || [])],
    },
    null,
    2,
  ),
);
