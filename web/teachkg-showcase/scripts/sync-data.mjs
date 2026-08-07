/**
 * 扫描仓库 data/，生成 public/data/manifest.json，并复制 pipeline JSON。
 * KG/MMKG 通过 /repo-data 直读，不整包复制大文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const course = process.env.TEACHKG_COURSE || "shuliluoji";
const vizDir = path.join(repoRoot, "data/viz", course);
const kgDir = path.join(repoRoot, "data/kg", course);
const outDir = path.join(appRoot, "public/data");
const pipelineOut = path.join(outDir, "pipeline");

fs.mkdirSync(pipelineOut, { recursive: true });

const manifest = {
  courseId: course,
  generatedAt: new Date().toISOString(),
  items: [],
};

function add(item) {
  manifest.items.push(item);
}

// —— Importance showcase ——
const importanceSrc = path.join(vizDir, "importance_showcase.json");
if (fs.existsSync(importanceSrc)) {
  const dest = path.join(outDir, "importance_showcase.json");
  fs.copyFileSync(importanceSrc, dest);
  add({
    id: "importance_course",
    type: "importance",
    group: "重要性分析",
    title: "课程 · 实体重要性（全局 / 分讲 / 目录对照）",
    href: "/importance",
    dataUrl: "/data/importance_showcase.json",
    scope: "course",
  });
}

// —— 学科方法资产库（定理 / 原理 / 技术） ——
const assetsLibSrc = path.join(kgDir, "assets", "library.json");
if (fs.existsSync(assetsLibSrc)) {
  const dest = path.join(outDir, "assets_library.json");
  fs.copyFileSync(assetsLibSrc, dest);
  add({
    id: "assets_library",
    type: "assets",
    group: "学科方法资产库",
    title: "定理 · 原理 · 技术（学科方法）",
    href: "/kg",
    dataUrl: "/data/assets_library.json",
    scope: "course",
  });
}

// —— Mindmap showcase ——
const mindmapIndex = path.join(vizDir, "mindmap_showcase.json");
const mindmapDir = path.join(vizDir, "mindmaps");
if (fs.existsSync(mindmapIndex)) {
  fs.copyFileSync(mindmapIndex, path.join(outDir, "mindmap_showcase.json"));
  const mindOut = path.join(outDir, "mindmaps");
  fs.mkdirSync(mindOut, { recursive: true });
  if (fs.existsSync(mindmapDir)) {
    for (const name of fs.readdirSync(mindmapDir).filter((n) => n.endsWith(".json"))) {
      fs.copyFileSync(path.join(mindmapDir, name), path.join(mindOut, name));
    }
  }
  add({
    id: "mindmap_lectures",
    type: "mindmap",
    group: "思维导图",
    title: "讲次 · 图谱投影思维导图",
    href: "/mindmap",
    dataUrl: "/data/mindmap_showcase.json",
    scope: "lecture",
  });
}

// —— Textbook KG showcase（多文件 + 分章） ——
const textbookKgDir = path.join(vizDir, "textbook_kg");
const textbookPublicDir = path.join(outDir, "textbook_kg");
if (fs.existsSync(textbookKgDir)) {
  fs.mkdirSync(textbookPublicDir, { recursive: true });
  for (const name of fs.readdirSync(textbookKgDir).filter((n) => n.endsWith(".json"))) {
    fs.copyFileSync(path.join(textbookKgDir, name), path.join(textbookPublicDir, name));
  }
  const catalogSrc = path.join(textbookKgDir, "catalog.json");
  if (fs.existsSync(catalogSrc)) {
    add({
      id: "textbook_kg",
      type: "textbook",
      group: "教材知识图谱",
      title: "教材知识图谱 · 分章浏览",
      href: "/textbook",
      dataUrl: "/data/textbook_kg/catalog.json",
      scope: "course",
    });
  }
}

const textbookSrc = path.join(vizDir, "textbook_kg_showcase.json");
if (fs.existsSync(textbookSrc)) {
  const dest = path.join(outDir, "textbook_kg_showcase.json");
  fs.copyFileSync(textbookSrc, dest);
}

// —— Pipeline JSON ——
if (fs.existsSync(vizDir)) {
  for (const name of fs.readdirSync(vizDir).filter((n) => n.startsWith("pipeline_build_") && n.endsWith(".json"))) {
    const src = path.join(vizDir, name);
    const stem = name.replace(/^pipeline_build_/, "").replace(/\.json$/, "");
    const dest = path.join(pipelineOut, name);
    fs.copyFileSync(src, dest);

    // 媒体路径：原 HTML 相对 viz/course → ../../segments/...；改为 /repo-data/segments/...
    try {
      const raw = JSON.parse(fs.readFileSync(dest, "utf8"));
      for (const it of raw.items || []) {
        const m = it.media || {};
        for (const k of ["clip", "ppt"]) {
          if (!m[k]) continue;
          let p = String(m[k]).replace(/\\/g, "/");
          if (p.startsWith("../../")) p = p.slice("../../".length);
          if (p.startsWith("../")) p = p.replace(/^(\.\.\/)+/, "");
          if (!p.startsWith("/repo-data/") && !p.startsWith("http")) {
            // segments/... 或 data-relative
            if (p.startsWith("segments/") || p.startsWith("processed/") || p.startsWith("kg/")) {
              m[k] = `/repo-data/${p}`;
            } else if (p.includes("/segments/")) {
              m[k] = `/repo-data/${p.split("/data/").pop() || p}`;
            }
          }
        }
        it.media = m;
      }
      fs.writeFileSync(dest, JSON.stringify(raw), "utf8");
    } catch (e) {
      console.warn("rewrite media failed", name, e.message);
    }

    const isSession = stem.startsWith("session_");
    const until = stem.includes("_until_") ? stem.split("_until_")[1] : null;
    const lectureMatch = stem.match(/lecture_(\d+)/);
    const lectureId = lectureMatch ? lectureMatch[1] : undefined;
    add({
      id: `pipeline_${stem}`,
      type: isSession ? "session" : "pipeline",
      group: isSession ? "会话融合" : until ? "流水线（截断）" : "流水线构建",
      title: isSession
        ? `会话融合 · ${stem.replace("session_", "").replace("_", "+")}`
        : until
          ? `第 ${lectureId || "?"} 讲 · 至 ${until}`
          : `第 ${lectureId || "?"} 讲 · 构建过程`,
      stem,
      lectureId,
      href: isSession
        ? `/pipeline/${stem}`
        : `/pipeline/${lectureId || "1"}`,
      dataUrl: `/data/pipeline/${name}`,
    });
  }
}

// —— Lecture KG / MMKG ——
if (fs.existsSync(kgDir)) {
  for (const name of fs.readdirSync(kgDir)) {
    if (!name.startsWith("lecture_")) continue;
    const lid = name.replace("lecture_", "");
    const dir = path.join(kgDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const source of ["mmkg"]) {
      const f = path.join(dir, `${source}.json`);
      if (!fs.existsSync(f)) continue;
      add({
        id: `${source}_lecture_${lid}`,
        type: "mmkg",
        group: "讲次图谱",
        title: `第 ${lid} 讲 · MMKG`,
        lectureId: lid,
        source: "mmkg",
        scope: "lecture",
        href: `/kg/lecture/${lid}`,
        dataUrl: `/repo-data/kg/${course}/lecture_${lid}/${source}.json`,
      });
    }
  }

  for (const source of ["mmkg"]) {
    const f = path.join(kgDir, `${source}.json`);
    if (!fs.existsSync(f)) continue;
    add({
      id: `${source}_course`,
      type: "mmkg",
      group: "课程图谱",
      title: `课程级 · MMKG`,
      source: "mmkg",
      scope: "course",
      href: `/kg/course`,
      dataUrl: `/repo-data/kg/${course}/${source}.json`,
    });
  }

  // 相邻两讲（一整节课）融合入口：两侧 lecture_*/mmkg.json 均存在时写入
  const readyLecs = fs
    .readdirSync(kgDir)
    .filter((n) => n.startsWith("lecture_") && fs.existsSync(path.join(kgDir, n, "mmkg.json")))
    .map((n) => n.replace("lecture_", ""))
    .filter((id) => /^\d+$/.test(id))
    .sort((a, b) => Number(a) - Number(b));
  for (let i = 0; i + 1 < readyLecs.length; i++) {
    const a = readyLecs[i];
    const b = readyLecs[i + 1];
    // 一整节课 = 相邻两讲，且从奇数讲起：1–2、3–4…
    if (Number(b) !== Number(a) + 1) continue;
    if (Number(a) % 2 !== 1) continue;
    const sessionId = `${a}_${b}`;
    add({
      id: `mmkg_session_${sessionId}`,
      type: "mmkg",
      group: "一堂课融合",
      title: `第 ${a}–${b} 讲 · 一堂课融合`,
      source: "mmkg",
      scope: "session",
      sessionId,
      lectureIds: [a, b],
      lectureId: a,
      href: `/kg/session/${sessionId}`,
      dataUrl: `/repo-data/kg/${course}/lecture_${a}/mmkg.json`,
    });
  }
}

// sort: importance, mindmap, pipeline, session, lecture kg/mmkg by lecture number
const order = {
  importance: 0,
  mindmap: 1,
  pipeline: 2,
  session: 3,
  kg: 4,
  mmkg: 5,
  textbook: 6,
};

function lectureNum(it) {
  if (it.lectureId != null && String(it.lectureId) !== "") {
    const n = Number(it.lectureId);
    if (!Number.isNaN(n)) return n;
  }
  const fromStem = String(it.stem || "").match(/lecture[_-]?(\d+)/i);
  if (fromStem) return Number(fromStem[1]);
  const fromTitle = String(it.title || "").match(/第?\s*(\d+)\s*讲/);
  if (fromTitle) return Number(fromTitle[1]);
  return 9999;
}

manifest.items.sort((a, b) => {
  const ga = order[a.type] ?? 9;
  const gb = order[b.type] ?? 9;
  if (ga !== gb) return ga - gb;
  const courseA = a.scope === "course" ? 0 : 1;
  const courseB = b.scope === "course" ? 0 : 1;
  if (courseA !== courseB) return courseA - courseB;
  const la = lectureNum(a);
  const lb = lectureNum(b);
  if (la !== lb) return la - lb;
  const truncA = String(a.stem || a.id || "").includes("until") ? 1 : 0;
  const truncB = String(b.stem || b.id || "").includes("until") ? 1 : 0;
  if (truncA !== truncB) return truncA - truncB;
  return String(a.title).localeCompare(String(b.title), "zh");
});

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

// —— 教材实体索引：课堂 KG 新实体二次匹配 ——
const textbookEntityCandidates = [
  path.join(repoRoot, "data/textbook/CS2501-离散数学（数理逻辑与集合论）/entity_final.json"),
  path.join(repoRoot, "data/textbook/CS2501-离散数学（数理逻辑与集合论）/entity.json"),
];
const textbookEntitySrc = textbookEntityCandidates.find((p) => fs.existsSync(p));
if (textbookEntitySrc) {
  try {
    const ents = JSON.parse(fs.readFileSync(textbookEntitySrc, "utf8"));
    const list = Array.isArray(ents) ? ents : ents.entities || [];
    const names = [];
    const byZh = {};
    const byEn = {};
    const putZh = (k, name) => {
      const key = String(k || "").trim().toLowerCase();
      if (key && !byZh[key]) byZh[key] = name;
    };
    const putEn = (k, name) => {
      const key = String(k || "").trim().toLowerCase();
      if (key && !byEn[key]) byEn[key] = name;
    };
    for (const e of list) {
      const name = String(e?.name || e?.id || "").trim();
      if (!name) continue;
      names.push(name);
      const zh = name.split("/")[0].trim();
      const en = name.includes("/") ? name.split("/").slice(1).join("/").trim() : "";
      putZh(zh, name);
      putEn(en, name);
      for (const a of e.aliases || []) {
        const raw = String(a || "").trim();
        if (!raw) continue;
        putZh(raw.split("/")[0], name);
        if (raw.includes("/")) putEn(raw.split("/").slice(1).join("/"), name);
      }
    }
    const indexPath = path.join(outDir, "textbook_entity_index.json");
    fs.writeFileSync(
      indexPath,
      JSON.stringify({ names, byZh, byEn, source: path.relative(repoRoot, textbookEntitySrc) }, null, 2),
      "utf8"
    );
    console.log(
      `sync-data: textbook entity index names=${names.length} → public/data/textbook_entity_index.json`
    );
  } catch (err) {
    console.warn("sync-data: failed to build textbook entity index", err);
  }
}

// —— 实体重要性查找表（课堂 KG 侧栏：教材先验 / 反馈后 / Δ / by_context）——
{
  const fbPath = path.join(kgDir, "entity_importance_feedback.json");
  const bundlePath = path.join(
    repoRoot,
    "data/textbook/CS2501-离散数学（数理逻辑与集合论）/importance_bundle.json"
  );
  const scores = {};
  const base = {};
  let byContext = {};
  let contributions = {};
  let version = 1;
  try {
    if (fs.existsSync(fbPath)) {
      const fb = JSON.parse(fs.readFileSync(fbPath, "utf8"));
      Object.assign(scores, fb.scores || {});
      version = fb.version || 1;
      byContext = fb.by_context || {};
      for (const [name, rec] of Object.entries(fb.entities || {})) {
        if (rec && typeof rec === "object" && rec.contributions) {
          contributions[name] = rec.contributions;
        }
      }
      // 若顶层 entities 为空，从 course context 取
      if (!Object.keys(contributions).length && byContext.course?.entities) {
        for (const [name, rec] of Object.entries(byContext.course.entities)) {
          if (rec && typeof rec === "object" && rec.contributions) {
            contributions[name] = rec.contributions;
          }
        }
      }
    }
    if (fs.existsSync(bundlePath)) {
      const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
      for (const row of bundle.global || []) {
        if (Array.isArray(row) && row.length >= 2) {
          const name = String(row[0] || "").trim();
          const v = Number(row[1]);
          if (name && Number.isFinite(v)) base[name] = v;
        }
      }
    }
    const lookupPath = path.join(outDir, "entity_importance_lookup.json");
    fs.writeFileSync(
      lookupPath,
      JSON.stringify(
        {
          course,
          version,
          scores,
          base,
          contributions,
          by_context: byContext,
          sources: {
            feedback: fs.existsSync(fbPath)
              ? path.relative(repoRoot, fbPath).replace(/\\/g, "/")
              : null,
            bundle: fs.existsSync(bundlePath)
              ? path.relative(repoRoot, bundlePath).replace(/\\/g, "/")
              : null,
          },
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(
      `sync-data: importance lookup scores=${Object.keys(scores).length} base=${Object.keys(base).length} contexts=${Object.keys(byContext).length} → public/data/entity_importance_lookup.json`
    );
  } catch (err) {
    console.warn("sync-data: failed to build importance lookup", err);
  }
}

console.log(
  `sync-data: course=${course} items=${manifest.items.length} → public/data/manifest.json`
);
