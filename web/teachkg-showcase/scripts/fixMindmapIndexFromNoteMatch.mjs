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

const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
let chapterUpdates = 0;
let lectureUpdates = 0;

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

// 同步到 viz，供 sync-data 拷贝
const vizMind = path.resolve(
  __dirname,
  `../../../data/viz/${COURSE}/mindmaps`,
);
if (fs.existsSync(path.dirname(vizMind))) {
  fs.mkdirSync(vizMind, { recursive: true });
  fs.copyFileSync(idxPath, path.join(vizMind, "index.json"));
  const vizNm = path.join(vizMind, "note_match");
  fs.mkdirSync(vizNm, { recursive: true });
  for (const f of fs.readdirSync(nmDir).filter((x) => x.endsWith(".json"))) {
    fs.copyFileSync(path.join(nmDir, f), path.join(vizNm, f));
  }
}

console.log(
  JSON.stringify(
    {
      chapterUpdates,
      lectureUpdates,
      chapters_mapped: chapterToLids.size,
      lecture_1_chapters: lectureToChapters.get("1") || [],
      sample_图: [...(chapterToLids.get("第1章 图的基本概念与表示") || [])],
      sample_命题: [...(chapterToLids.get("第1章 命题逻辑的基本概念") || [])],
    },
    null,
    2,
  ),
);
