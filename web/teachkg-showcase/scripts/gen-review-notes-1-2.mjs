/**
 * 对离散数学第 1–2 讲生成新版课堂笔记，写出预览 JSON。
 * 用法：node scripts/gen-review-notes-1-2.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runReviewNotes } from "../server/reviewNotes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function loadEnvLocal() {
  const candidates = [
    path.join(root, ".env.local"),
    path.join(root, ".env"),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] == null || process.env[m[1]] === "") {
        process.env[m[1]] = v;
      }
    }
  }
}

function packPoint(p) {
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

function mergePoints(parts) {
  const byId = new Map();
  for (const { lectureId, points } of parts) {
    for (const p of points) {
      const prev = byId.get(p.id);
      if (!prev) {
        byId.set(p.id, {
          ...p,
          source_lecture_ids: [lectureId],
        });
        continue;
      }
      const next = { ...prev };
      next.importance = Math.max(Number(prev.importance || 0), Number(p.importance || 0));
      if ((p.definition || "").length > (prev.definition || "").length) {
        next.definition = p.definition;
      }
      if ((p.summary || "").length > (prev.summary || "").length) {
        next.summary = p.summary;
      }
      const lids = new Set([...(prev.source_lecture_ids || []), lectureId]);
      next.source_lecture_ids = [...lids];
      const nb = [...(prev.neighbors || []), ...(p.neighbors || [])];
      next.neighbors = nb.slice(0, 8);
      const ev = [...(prev.evidence || []), ...(p.evidence || [])];
      next.evidence = ev.slice(0, 4);
      byId.set(p.id, next);
    }
  }
  return [...byId.values()].sort(
    (a, b) => Number(b.importance || 0) - Number(a.importance || 0)
  );
}

async function main() {
  loadEnvLocal();
  const course = "离散数学(图论+数理逻辑与集合论)";
  const dataDir = path.join(root, "public", "data", "courses", course, "review");
  const lec1 = JSON.parse(fs.readFileSync(path.join(dataDir, "lecture_1.json"), "utf8"));
  const lec2 = JSON.parse(fs.readFileSync(path.join(dataDir, "lecture_2.json"), "utf8"));
  const points = mergePoints([
    { lectureId: "1", points: lec1.points || [] },
    { lectureId: "2", points: lec2.points || [] },
  ]);
  console.log(`merged points: ${points.length}`);

  const payload = {
    courseId: course,
    lectureId: "1_2",
    title: "第 1–2 讲 · 课堂笔记",
    points: points.map(packPoint),
  };

  const outDir = path.join(root, "tmp");
  fs.mkdirSync(outDir, { recursive: true });

  let notes;
  try {
    notes = await runReviewNotes(payload, process.env);
  } catch (e) {
    console.error("LLM failed:", e?.message || e);
    process.exitCode = 1;
    return;
  }
  if (notes.error) {
    console.error("notes error:", notes);
    process.exitCode = 1;
    return;
  }

  const outPath = path.join(outDir, "review-notes-1_2.preview.json");
  fs.writeFileSync(outPath, JSON.stringify(notes, null, 2), "utf8");
  console.log(`wrote ${outPath}`);
  console.log(`title: ${notes.title}`);
  console.log(`subtitle: ${notes.subtitle}`);
  console.log(`themes (${notes.themes.length}):`);
  for (const t of notes.themes) {
    console.log(`  - ${t.title}: ${t.oneLiner}`);
  }
  for (const s of notes.sections.filter((x) => x.kind === "theme")) {
    const types = (s.blocks || []).map((b) => b.type).join(",");
    console.log(`section ${s.id} blocks: [${types}]`);
  }
}

main();
