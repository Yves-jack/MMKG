#!/usr/bin/env node
/**
 * postbuild：保证 dist 里有 note_match（vite 会从 public 拷；若 public 缺失则从仓库旁路补）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const COURSE = process.env.TEACHKG_COURSE || "离散数学(图论+数理逻辑与集合论)";

function copyJsonDir(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(src).filter((f) => f.endsWith(".json"))) {
    fs.copyFileSync(path.join(src, name), path.join(dest, name));
    n += 1;
  }
  return n;
}

const noteMatchCandidates = [
  path.join(root, "public/data/courses", COURSE, "mindmaps/note_match"),
  path.join(root, "../../data/viz", COURSE, "mindmaps/note_match"),
];
const noteMatchSrc = noteMatchCandidates.find(
  (p) =>
    fs.existsSync(p) &&
    fs.readdirSync(p).some((f) => f.endsWith(".final.json")),
);

let noteCopied = 0;
if (noteMatchSrc) {
  noteCopied += copyJsonDir(
    noteMatchSrc,
    path.join(root, "dist/data/courses", COURSE, "mindmaps/note_match"),
  );
  noteCopied += copyJsonDir(
    noteMatchSrc,
    path.join(root, "public/data/courses", COURSE, "mindmaps/note_match"),
  );
} else {
  console.warn("[ensureNoteMatchInDist] no note_match source found; skip");
}

// 检索预计算索引：与 note_match 一样，重建后必须落在 dist
const evidenceName = "entity_evidence_index.json";
const evidenceCandidates = [
  path.join(root, "public/data/courses", COURSE, "review", evidenceName),
  path.join(root, "../../data/viz", COURSE, "review", evidenceName),
];
const evidenceSrc = evidenceCandidates.find((p) => fs.existsSync(p));
let evidenceOk = false;
if (evidenceSrc) {
  for (const base of [
    path.join(root, "dist/data/courses", COURSE, "review"),
    path.join(root, "public/data/courses", COURSE, "review"),
  ]) {
    fs.mkdirSync(base, { recursive: true });
    fs.copyFileSync(evidenceSrc, path.join(base, evidenceName));
  }
  evidenceOk = fs.existsSync(
    path.join(root, "dist/data/courses", COURSE, "review", evidenceName),
  );
} else {
  console.warn("[ensureNoteMatchInDist] no entity_evidence_index found; skip");
}

const sample = path.join(
  root,
  "dist/data/courses",
  COURSE,
  "mindmaps/note_match/session_1_2.final.json",
);
console.log(
  JSON.stringify({
    ok: fs.existsSync(sample) && evidenceOk,
    note_match_src: noteMatchSrc || null,
    note_copied: noteCopied,
    has_session_1_2: fs.existsSync(sample),
    evidence_src: evidenceSrc || null,
    has_evidence_index: evidenceOk,
  }),
);
