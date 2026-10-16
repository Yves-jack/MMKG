#!/usr/bin/env node
/**
 * 整课导图：章节点下一层（直接子节点）与知识图谱实体匹配统计。
 * 匹配逻辑对齐 MindmapPage.matchKgEntityId + entity_importance_lookup.scores。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COURSE =
  process.env.TEACHKG_COURSE || "离散数学(图论+数理逻辑与集合论)";
const root = path.resolve(__dirname, `../public/data/courses/${COURSE}`);

function shortEntityKey(id) {
  return String(id || "").split("/")[0]?.trim() || "";
}

function isSynthetic(node) {
  const id = String(node?.id || "");
  return (
    id.startsWith("__") ||
    id.startsWith("chapter:") ||
    id.startsWith("part:")
  );
}

function matchKg(node, kgIds, kgByShort, redirects) {
  if (isSynthetic(node)) return null;
  const tryIds = [
    node.id,
    node.zh,
    redirects?.[node.id],
    redirects?.[node.zh],
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  for (const id of tryIds) {
    if (kgIds.has(id)) return id;
    const short = shortEntityKey(id);
    if (short && kgByShort.has(short)) return kgByShort.get(short);
    if (kgByShort.has(id)) return kgByShort.get(id);
  }
  return null;
}

function walkCollectChapterChildren(node, out) {
  if (!node) return;
  const id = String(node.id || "");
  if (id.startsWith("__chapter__/")) {
    for (const c of node.children || []) {
      if (!isSynthetic(c)) out.push(c);
    }
  }
  for (const c of node.children || []) walkCollectChapterChildren(c, out);
}

const coursePath = path.join(root, "mindmaps", "course.json");
const lookupPath = path.join(root, "entity_importance_lookup.json");
const course = JSON.parse(fs.readFileSync(coursePath, "utf8"));
const lookup = JSON.parse(fs.readFileSync(lookupPath, "utf8"));
const scores =
  lookup.scores && typeof lookup.scores === "object" ? lookup.scores : {};
const kgIds = new Set(Object.keys(scores));
const kgByShort = new Map();
for (const id of kgIds) {
  const short = shortEntityKey(id);
  if (short && !kgByShort.has(short)) kgByShort.set(short, id);
}
const redirects = course.id_redirects || course.meta?.id_redirects || null;

const children = [];
const roots = course.roots?.length
  ? course.roots
  : course.root
    ? [course.root]
    : [];
for (const r of roots) walkCollectChapterChildren(r, children);

// 去重 by id
const seen = new Set();
const uniq = [];
for (const n of children) {
  const id = String(n.id || "");
  if (seen.has(id)) continue;
  seen.add(id);
  uniq.push(n);
}

const matched = [];
const unmatched = [];
for (const n of uniq) {
  const hit = matchKg(n, kgIds, kgByShort, redirects);
  if (hit) matched.push({ id: n.id, zh: n.zh, kg: hit });
  else unmatched.push({ id: n.id, zh: n.zh });
}

const total = uniq.length;
const ratio = total ? matched.length / total : 0;
const report = {
  course: COURSE,
  source: "mindmaps/course.json",
  kg_source: "entity_importance_lookup.json#scores",
  definition:
    "整课导图中 id 以 __chapter__/ 开头的节点的直接子节点（排除合成节点），与 KG scores 键匹配",
  total_chapter_children: total,
  matched: matched.length,
  unmatched: unmatched.length,
  ratio,
  ratio_pct: `${(ratio * 100).toFixed(2)}%`,
  unmatched_sample: unmatched.slice(0, 20),
};

console.log(JSON.stringify(report, null, 2));
