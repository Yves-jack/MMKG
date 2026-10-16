#!/usr/bin/env node
/**
 * 从 review/lecture_*.json 预计算实体 → 视频片段映射，供检索一次加载。
 * Usage:
 *   node scripts/buildEntityEvidenceIndex.mjs [courseDir]
 * Default courseDir: public/data/courses/离散数学(图论+数理逻辑与集合论)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_COURSE = path.join(
  ROOT,
  "public/data/courses/离散数学(图论+数理逻辑与集合论)",
);

function zhName(name) {
  return String(name || "").split("/")[0].trim() || String(name || "");
}

function clipSnippet(raw, maxLen = 100) {
  const t = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen).replace(/[，,。；;：:\s]+$/g, "")}…`;
}

function build(courseDir) {
  const reviewDir = path.join(courseDir, "review");
  if (!fs.existsSync(reviewDir)) {
    throw new Error(`missing review dir: ${reviewDir}`);
  }
  const files = fs
    .readdirSync(reviewDir)
    .filter((f) => /^lecture_\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  /** @type {Map<string, {id:string, zh:string}>} */
  const entities = new Map();
  /** @type {Map<string, Array<object>>} */
  const byId = new Map();
  /** @type {Map<string, Set<string>>} */
  const zhToIds = new Map();

  let lectures = 0;
  let points = 0;
  let hits = 0;

  for (const file of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(reviewDir, file), "utf8"));
    const lectureId = String(doc.lecture_id || file.match(/\d+/)[0]);
    lectures += 1;
    for (const p of doc.points || []) {
      const id = String(p.id || "").trim();
      if (!id) continue;
      points += 1;
      const pointZh = String(p.zh || zhName(id)).trim() || id;
      if (!entities.has(id)) entities.set(id, { id, zh: pointZh });
      const zhKey = zhName(id);
      if (!zhToIds.has(zhKey)) zhToIds.set(zhKey, new Set());
      zhToIds.get(zhKey).add(id);
      if (pointZh && pointZh !== zhKey) {
        if (!zhToIds.has(pointZh)) zhToIds.set(pointZh, new Set());
        zhToIds.get(pointZh).add(id);
      }

      const evidence = Array.isArray(p.evidence) ? p.evidence : [];
      const timed = evidence.filter((e) => Number.isFinite(Number(e.start_sec)));
      const rows = timed.length
        ? timed
        : [
            {
              text: p.summary || p.definition || pointZh,
              start_sec: 0,
              end_sec: null,
            },
          ];

      if (!byId.has(id)) byId.set(id, []);
      const bucket = byId.get(id);
      const seen = new Set(bucket.map((h) => `${h.lecture_id}:${Math.floor(h.start_sec)}`));

      for (const e of rows) {
        const start = Number(e.start_sec) || 0;
        const key = `${lectureId}:${Math.floor(start)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const text =
          clipSnippet(String(e.text || "")) ||
          clipSnippet(p.summary || "") ||
          clipSnippet(p.definition || "") ||
          pointZh;
        bucket.push({
          lecture_id: lectureId,
          start_sec: start,
          end_sec: e.end_sec ?? null,
          text,
          point_id: id,
          point_zh: pointZh,
        });
        hits += 1;
      }
    }
  }

  for (const bucket of byId.values()) {
    bucket.sort(
      (a, b) =>
        Number(a.lecture_id) - Number(b.lecture_id) ||
        a.start_sec - b.start_sec,
    );
  }

  const byZh = {};
  for (const [zh, ids] of zhToIds) {
    byZh[zh] = [...ids];
  }

  const out = {
    version: 1,
    course_id: path.basename(courseDir),
    generated_at: new Date().toISOString(),
    n_lectures: lectures,
    n_entities: entities.size,
    n_hits: hits,
    entities: [...entities.values()].sort((a, b) =>
      a.zh.localeCompare(b.zh, "zh"),
    ),
    by_id: Object.fromEntries(byId),
    by_zh: byZh,
  };

  const outPath = path.join(reviewDir, "entity_evidence_index.json");
  fs.writeFileSync(outPath, JSON.stringify(out), "utf8");
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(
    JSON.stringify(
      {
        out: outPath,
        lectures,
        points,
        entities: entities.size,
        hits,
        size_kb: Number(kb),
      },
      null,
      2,
    ),
  );
  return outPath;
}

const courseDir = path.resolve(process.argv[2] || DEFAULT_COURSE);
build(courseDir);
