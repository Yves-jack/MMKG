/**
 * 扫描仓库 data/kg、data/viz 下的课程，生成：
 * - public/data/courses.json（课程列表）
 * - public/data/courses/{courseId}/…（每课 manifest 与静态资源）
 * - public/data/manifest.json 等扁平副本（默认课，兼容旧链接）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const outDir = path.join(appRoot, "public/data");
const defaultCourseEnv =
  process.env.TEACHKG_COURSE || "离散数学(图论+数理逻辑与集合论)";

/** /repo-data 下路径分段编码，兼容中文课程名；`+` 保持字面量，避免 %2B 在部分静态层未解码 */
function repoDataUrl(...parts) {
  const encoded = parts
    .join("/")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg).replace(/%2B/gi, "+"))
    .join("/");
  return `/repo-data/${encoded}`;
}

function encodeCourseSeg(course) {
  // 与前端 encodeCourseId 一致：保留字面量 `+`，避免 Vite public 静态路径 %2B 404→HTML
  return encodeURIComponent(String(course)).replace(/%2B/gi, "+");
}

function coursePublicDir(course) {
  // 磁盘用真实课程名；URL 仍 encode，由静态服务器解码后命中
  return path.join(outDir, "courses", String(course));
}

function courseWebBase(course) {
  return `/data/courses/${encodeCourseSeg(course)}`;
}

function courseRoute(course, sub = "") {
  const base = `/course/${encodeCourseSeg(course)}`;
  if (!sub) return base;
  return `${base}${sub.startsWith("/") ? sub : `/${sub}`}`;
}

function discoverCourses() {
  const kgRoot = path.join(repoRoot, "data/kg");
  const vizRoot = path.join(repoRoot, "data/viz");
  const names = new Set();
  for (const root of [kgRoot, vizRoot]) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      if (!fs.statSync(p).isDirectory()) continue;
      if (name.startsWith(".") || name === "node_modules") continue;
      names.add(name);
    }
  }
  const list = [...names].sort((a, b) => a.localeCompare(b, "zh"));
  if (!list.length && defaultCourseEnv) list.push(defaultCourseEnv);
  return list;
}

function copyDirJsonFiles(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir).filter((n) => n.endsWith(".json"))) {
    fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
  }
}

function syncOneCourse(course) {
  const vizDir = path.join(repoRoot, "data/viz", course);
  const kgDir = path.join(repoRoot, "data/kg", course);
  const courseOut = coursePublicDir(course);
  const pipelineOut = path.join(courseOut, "pipeline");
  const webBase = courseWebBase(course);

  fs.mkdirSync(pipelineOut, { recursive: true });

  const manifest = {
    courseId: course,
    generatedAt: new Date().toISOString(),
    items: [],
  };

  function add(item) {
    manifest.items.push(item);
  }

  // —— Importance ——
  const importanceSrc = path.join(vizDir, "importance_showcase.json");
  if (fs.existsSync(importanceSrc)) {
    fs.copyFileSync(importanceSrc, path.join(courseOut, "importance_showcase.json"));
    add({
      id: "importance_course",
      type: "importance",
      group: "重要性分析",
      title: "课程 · 实体重要性（全局 / 分讲 / 目录对照）",
      href: courseRoute(course, "/importance"),
      dataUrl: `${webBase}/importance_showcase.json`,
      scope: "course",
    });
  }

  // —— Assets ——
  const assetsLibSrc = path.join(kgDir, "assets", "library.json");
  if (fs.existsSync(assetsLibSrc)) {
    fs.copyFileSync(assetsLibSrc, path.join(courseOut, "assets_library.json"));
    add({
      id: "assets_library",
      type: "assets",
      group: "学科方法资产库",
      title: "定理 · 公式 · 例子",
      href: courseRoute(course, "/assets"),
      dataUrl: `${webBase}/assets_library.json`,
      scope: "course",
    });
  }

  // —— Mindmap ——
  const mindmapIndex = path.join(vizDir, "mindmap_showcase.json");
  const mindmapDir = path.join(vizDir, "mindmaps");
  if (fs.existsSync(mindmapIndex)) {
    fs.copyFileSync(mindmapIndex, path.join(courseOut, "mindmap_showcase.json"));
    const mindOut = path.join(courseOut, "mindmaps");
    fs.mkdirSync(mindOut, { recursive: true });
    if (fs.existsSync(mindmapDir)) {
      for (const name of fs.readdirSync(mindmapDir).filter((n) => n.endsWith(".json"))) {
        fs.copyFileSync(path.join(mindmapDir, name), path.join(mindOut, name));
      }
    }
    // 路径 A：章总结骨架（可选）
    const summariesSrc = path.join(vizDir, "summaries");
    if (fs.existsSync(summariesSrc)) {
      copyDirJsonFiles(summariesSrc, path.join(courseOut, "summaries"));
    }
    add({
      id: "mindmap_lectures",
      type: "mindmap",
      group: "思维导图",
      title: "课 · 章 · 讲 知识导图",
      href: courseRoute(course, "/mindmap"),
      dataUrl: `${webBase}/mindmap_showcase.json`,
      scope: "lecture",
    });
  }

  // —— Review（单课复习整理）——
  const reviewIndex = path.join(vizDir, "review_showcase.json");
  const reviewDir = path.join(vizDir, "review");
  if (fs.existsSync(reviewIndex)) {
    fs.copyFileSync(reviewIndex, path.join(courseOut, "review_showcase.json"));
    const reviewOut = path.join(courseOut, "review");
    fs.mkdirSync(reviewOut, { recursive: true });
    if (fs.existsSync(reviewDir)) {
      for (const name of fs.readdirSync(reviewDir).filter((n) => n.endsWith(".json"))) {
        fs.copyFileSync(path.join(reviewDir, name), path.join(reviewOut, name));
      }
    }
    let firstLecture = "1";
    try {
      const show = JSON.parse(fs.readFileSync(reviewIndex, "utf8"));
      const items = show.items || [];
      if (items[0]?.lecture_id) firstLecture = String(items[0].lecture_id);
      for (const it of items) {
        const lid = String(it.lecture_id || "");
        if (!lid) continue;
        add({
          id: `review_lecture_${lid}`,
          type: "review",
          group: "应用",
          title: it.title || `第 ${lid} 讲 · 复习整理`,
          href: courseRoute(course, `/apps/review/${lid}`),
          dataUrl: `${webBase}/review/lecture_${lid}.json`,
          scope: "lecture",
          lectureId: lid,
        });
      }
    } catch (err) {
      console.warn(`sync-data[${course}]: review showcase parse failed`, err.message);
    }
    // 门户入口卡（无分讲条目时兜底）
    if (!manifest.items.some((it) => it.type === "review")) {
      add({
        id: "review_app",
        type: "review",
        group: "应用",
        title: "单课复习整理",
        href: courseRoute(course, `/apps/review/${firstLecture}`),
        dataUrl: `${webBase}/review_showcase.json`,
        scope: "lecture",
        lectureId: firstLecture,
      });
    }
  }

  // —— Textbook KG ——
  const textbookKgDir = path.join(vizDir, "textbook_kg");
  const textbookPublicDir = path.join(courseOut, "textbook_kg");
  let textbookSrcDir = textbookKgDir;
  // 离散数学与数理逻辑共用同一套教材分片；缺省时回退到数理逻辑产物
  if (!fs.existsSync(textbookSrcDir)) {
    const fallback = path.join(repoRoot, "data/viz", "数理逻辑", "textbook_kg");
    if (
      (course.includes("离散数学") || course.includes("数理逻辑")) &&
      fs.existsSync(fallback)
    ) {
      textbookSrcDir = fallback;
      console.log(
        `sync-data[${course}]: textbook_kg missing, fallback → 数理逻辑`
      );
    }
  }
  if (fs.existsSync(textbookSrcDir)) {
    copyDirJsonFiles(textbookSrcDir, textbookPublicDir);
    const catalogSrc = path.join(textbookPublicDir, "catalog.json");
    if (fs.existsSync(catalogSrc)) {
      try {
        const catalog = JSON.parse(fs.readFileSync(catalogSrc, "utf8"));
        for (const f of catalog.files || []) {
          if (!f || typeof f !== "object") continue;
          // 统一为课内路径，避免旧的 /data/textbook_kg/... 在部分环境下 404
          f.dataUrl = `${webBase}/textbook_kg/${encodeURIComponent(String(f.id || "")).replace(/%2B/gi, "+")}.json`;
        }
        fs.writeFileSync(catalogSrc, JSON.stringify(catalog, null, 2), "utf8");
      } catch (err) {
        console.warn(`sync-data[${course}]: rewrite textbook catalog failed`, err.message);
      }
      add({
        id: "textbook_kg",
        type: "textbook",
        group: "教材知识图谱",
        title: "教材知识图谱 · 分章浏览",
        href: courseRoute(course, "/textbook"),
        dataUrl: `${webBase}/textbook_kg/catalog.json`,
        scope: "course",
      });
    }
  }

  const textbookSrc = path.join(
    fs.existsSync(path.join(vizDir, "textbook_kg_showcase.json"))
      ? vizDir
      : path.join(repoRoot, "data/viz", "数理逻辑"),
    "textbook_kg_showcase.json"
  );
  if (fs.existsSync(textbookSrc)) {
    fs.copyFileSync(textbookSrc, path.join(courseOut, "textbook_kg_showcase.json"));
  }

  // —— Pipeline JSON ——
  let pipelineCount = 0;
  if (fs.existsSync(vizDir)) {
    for (const name of fs
      .readdirSync(vizDir)
      .filter((n) => n.startsWith("pipeline_build_") && n.endsWith(".json"))) {
      const src = path.join(vizDir, name);
      const stem = name.replace(/^pipeline_build_/, "").replace(/\.json$/, "");
      const dest = path.join(pipelineOut, name);
      fs.copyFileSync(src, dest);
      pipelineCount += 1;

      const stemEarly = name.replace(/^pipeline_build_/, "").replace(/\.json$/, "");
      const lectureMatchEarly = stemEarly.match(/lecture_(\d+)/);
      const lectureIdEarly = lectureMatchEarly ? lectureMatchEarly[1] : undefined;

          try {
            const raw = JSON.parse(fs.readFileSync(dest, "utf8"));
            const rewriteMediaPath = (rawPath) => {
              if (!rawPath) return rawPath;
              let p = String(rawPath).replace(/\\/g, "/");
              if (p.startsWith("/repo-data/") || p.startsWith("http")) return p;
              if (p.startsWith("../../")) p = p.slice("../../".length);
              if (p.startsWith("../")) p = p.replace(/^(\.\.\/)+/, "");
              if (p.includes("/data/")) p = p.split("/data/").pop() || p;
              if (
                p.startsWith("segments/") ||
                p.startsWith("processed/") ||
                p.startsWith("kg/") ||
                p.startsWith("raw/")
              ) {
                const encoded = p
                  .split("/")
                  .filter(Boolean)
                  .map((seg) => encodeURIComponent(seg).replace(/%2B/gi, "+"))
                  .join("/");
                return `/repo-data/${encoded}`;
              }
              return rawPath;
            };
            if (Array.isArray(raw.ppt_gallery)) {
              raw.ppt_gallery = raw.ppt_gallery.map(rewriteMediaPath).filter(Boolean);
            }
            for (const it of raw.items || []) {
              const m = it.media || {};
              for (const k of ["clip", "ppt"]) {
                if (!m[k]) continue;
                m[k] = rewriteMediaPath(m[k]);
              }
              if (Array.isArray(m.ppt_pages)) {
                m.ppt_pages = m.ppt_pages.map(rewriteMediaPath).filter(Boolean);
              } else if (m.ppt) {
                m.ppt_pages = [m.ppt];
              }
              it.media = m;
            }
            // 若导出未写 ppt_gallery，从 OCR 目录补全（全部片段翻看用）
            if (!Array.isArray(raw.ppt_gallery) || !raw.ppt_gallery.length) {
              const lecIds = [];
              if (raw.mode === "session" && Array.isArray(raw.lecture_ids)) {
                lecIds.push(...raw.lecture_ids.map(String));
              } else if (raw.lecture_id && !String(raw.lecture_id).includes("+")) {
                lecIds.push(String(raw.lecture_id));
              } else if (lectureIdEarly) {
                lecIds.push(String(lectureIdEarly));
              }
              const gallery = [];
              const seen = new Set();
              for (const lid of lecIds) {
                const ocrDir = path.join(
                  repoRoot,
                  "data",
                  "segments",
                  course,
                  "asr_work",
                  lid,
                  "ocr"
                );
                if (!fs.existsSync(ocrDir)) continue;
                const pages = fs
                  .readdirSync(ocrDir)
                  .filter((n) => /^ppt_page_\d+\.jpg$/i.test(n))
                  .sort((a, b) => {
                    const ia = Number(a.match(/(\d+)/)?.[1] || 0);
                    const ib = Number(b.match(/(\d+)/)?.[1] || 0);
                    return ia - ib;
                  });
                for (const name of pages) {
                  const url = rewriteMediaPath(
                    `segments/${course}/asr_work/${lid}/ocr/${name}`
                  );
                  if (url && !seen.has(url)) {
                    seen.add(url);
                    gallery.push(url);
                  }
                }
              }
              if (gallery.length) raw.ppt_gallery = gallery;
            }
            fs.writeFileSync(dest, JSON.stringify(raw), "utf8");
          } catch (e) {
            console.warn("rewrite media failed", course, name, e.message);
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
          ? courseRoute(course, `/pipeline/${stem}`)
          : courseRoute(course, `/pipeline/${lectureId || "1"}`),
        dataUrl: `${webBase}/pipeline/${name}`,
      });
    }
  }

  // —— Lecture / course MMKG ——
  let lectureCount = 0;
  let hasKg = false;
  if (fs.existsSync(kgDir)) {
    for (const name of fs.readdirSync(kgDir)) {
      if (!name.startsWith("lecture_")) continue;
      const lid = name.replace("lecture_", "");
      const dir = path.join(kgDir, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const f = path.join(dir, "mmkg.json");
      if (!fs.existsSync(f)) continue;
      lectureCount += 1;
      hasKg = true;
      add({
        id: `mmkg_lecture_${lid}`,
        type: "mmkg",
        group: "讲次图谱",
        title: `第 ${lid} 讲 · MMKG`,
        lectureId: lid,
        source: "mmkg",
        scope: "lecture",
        href: courseRoute(course, `/kg/lecture/${lid}`),
        dataUrl: repoDataUrl("kg", course, `lecture_${lid}`, "mmkg.json"),
      });
    }

    const courseMmkg = path.join(kgDir, "mmkg.json");
    if (fs.existsSync(courseMmkg)) {
      hasKg = true;
      add({
        id: "mmkg_course",
        type: "mmkg",
        group: "课程图谱",
        title: "课程级 · MMKG",
        source: "mmkg",
        scope: "course",
        href: courseRoute(course, "/kg/course"),
        dataUrl: repoDataUrl("kg", course, "mmkg.json"),
      });
    }

    const readyLecs = fs
      .readdirSync(kgDir)
      .filter((n) => n.startsWith("lecture_") && fs.existsSync(path.join(kgDir, n, "mmkg.json")))
      .map((n) => n.replace("lecture_", ""))
      .filter((id) => /^\d+$/.test(id))
      .sort((a, b) => Number(a) - Number(b));
    // 仅相邻且「奇数起」的两讲合成一堂课；中间缺讲（如考试无图谱）时偶数讲会落单，
    // 前端 KgPage 会按 pipeline 孤儿讲次单独挂到侧栏（/kg/lecture/:id）。
    for (let i = 0; i + 1 < readyLecs.length; i++) {
      const a = readyLecs[i];
      const b = readyLecs[i + 1];
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
        href: courseRoute(course, `/kg/session/${sessionId}`),
        dataUrl: repoDataUrl("kg", course, `lecture_${a}`, "mmkg.json"),
      });
    }
  }

  const order = {
    importance: 0,
    mindmap: 1,
    pipeline: 2,
    session: 3,
    kg: 4,
    mmkg: 5,
    textbook: 6,
    assets: 7,
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

  fs.writeFileSync(path.join(courseOut, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  // —— textbook entity index（课相关；目前数理逻辑教材路径固定）——
  const textbookEntityCandidates = [
    path.join(repoRoot, "data/textbook/CS2501-离散数学（数理逻辑与集合论）/entity_final.json"),
    path.join(repoRoot, "data/textbook/CS2501-离散数学（数理逻辑与集合论）/entity.json"),
  ];
  const textbookEntitySrc = textbookEntityCandidates.find((p) => fs.existsSync(p));
  if (textbookEntitySrc && course.includes("数理逻辑")) {
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
      fs.writeFileSync(
        path.join(courseOut, "textbook_entity_index.json"),
        JSON.stringify(
          { names, byZh, byEn, source: path.relative(repoRoot, textbookEntitySrc) },
          null,
          2
        ),
        "utf8"
      );
    } catch (err) {
      console.warn(`sync-data[${course}]: textbook entity index failed`, err.message);
    }
  }

  // —— importance lookup ——
  {
    const fbPath = path.join(kgDir, "entity_importance_feedback.json");
    const prPath = path.join(kgDir, "entity_importance_pagerank.json");
    const bundlePath = path.join(
      repoRoot,
      "data/textbook/CS2501-离散数学（数理逻辑与集合论）/importance_bundle.json"
    );
    const scores = {};
    const base = {};
    const classroom = {};
    const pagerank = {};
    let byContext = {};
    let contributions = {};
    let version = 1;
    try {
      if (fs.existsSync(fbPath)) {
        const fb = JSON.parse(fs.readFileSync(fbPath, "utf8"));
        Object.assign(scores, fb.scores || {});
        version = fb.version || 1;
        byContext = fb.by_context || {};
        // 旧产物 by_context.entities 可能缺 classroom_norm：从 top / 字段补齐扁平 classroom
        // 仅写入 >0 的课堂分；0 表示「无课堂证据」，前端按缺失处理，避免后几讲筛空
        const takePositiveClassroom = (flat, name, cn) => {
          if (!name || !Number.isFinite(cn) || cn <= 1e-12) return;
          flat[name] = flat[name] == null ? cn : Math.max(flat[name], cn);
        };
        for (const [ctxKey, ctx] of Object.entries(byContext)) {
          if (!ctx || typeof ctx !== "object") continue;
          const flat = {};
          for (const [name, raw] of Object.entries(ctx.classroom || {})) {
            takePositiveClassroom(flat, name, Number(raw));
          }
          for (const [name, rec] of Object.entries(ctx.entities || {})) {
            if (!rec || typeof rec !== "object") continue;
            takePositiveClassroom(flat, name, Number(rec.classroom_norm));
          }
          for (const row of ctx.top || []) {
            if (!row || typeof row !== "object") continue;
            const name = String(row.name || "").trim();
            takePositiveClassroom(flat, name, Number(row.classroom_norm));
          }
          ctx.classroom = flat;
          byContext[ctxKey] = ctx;
        }
        for (const [name, rec] of Object.entries(fb.entities || {})) {
          if (!rec || typeof rec !== "object") continue;
          if (rec.contributions) contributions[name] = rec.contributions;
          takePositiveClassroom(classroom, name, Number(rec.classroom_norm));
        }
        for (const row of fb.top || []) {
          if (!row || typeof row !== "object") continue;
          const name = String(row.name || "").trim();
          if (!name) continue;
          takePositiveClassroom(classroom, name, Number(row.classroom_norm));
          if (row.contributions && !contributions[name]) {
            contributions[name] = row.contributions;
          }
        }
        if (!Object.keys(contributions).length && byContext.course?.entities) {
          for (const [name, rec] of Object.entries(byContext.course.entities)) {
            if (rec && typeof rec === "object" && rec.contributions) {
              contributions[name] = rec.contributions;
            }
            takePositiveClassroom(classroom, name, Number(rec?.classroom_norm));
          }
        }
      }
      // 纯 PageRank 实验产物：并入 lookup.pagerank / by_context.*.pagerank，不覆盖 classroom
      if (fs.existsSync(prPath)) {
        const pr = JSON.parse(fs.readFileSync(prPath, "utf8"));
        Object.assign(pagerank, pr.pagerank || pr.classroom || pr.scores || {});
        for (const [ctxKey, ctx] of Object.entries(pr.by_context || {})) {
          if (!ctx || typeof ctx !== "object") continue;
          const flat = {
            ...(ctx.pagerank || ctx.classroom || ctx.scores || {}),
          };
          if (!byContext[ctxKey]) byContext[ctxKey] = {};
          byContext[ctxKey].pagerank = flat;
        }
      }
      if (fs.existsSync(bundlePath) && course.includes("数理逻辑")) {
        const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
        for (const row of bundle.global || []) {
          if (Array.isArray(row) && row.length >= 2) {
            const name = String(row[0] || "").trim();
            const v = Number(row[1]);
            if (name && Number.isFinite(v)) base[name] = v;
          }
        }
      }
      fs.writeFileSync(
        path.join(courseOut, "entity_importance_lookup.json"),
        JSON.stringify(
          {
            course,
            version,
            scores,
            base,
            classroom,
            pagerank,
            contributions,
            by_context: byContext,
            sources: {
              feedback: fs.existsSync(fbPath)
                ? path.relative(repoRoot, fbPath).replace(/\\/g, "/")
                : null,
              pagerank: fs.existsSync(prPath)
                ? path.relative(repoRoot, prPath).replace(/\\/g, "/")
                : null,
              bundle:
                fs.existsSync(bundlePath) && course.includes("数理逻辑")
                  ? path.relative(repoRoot, bundlePath).replace(/\\/g, "/")
                  : null,
            },
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (err) {
      console.warn(`sync-data[${course}]: importance lookup failed`, err.message);
    }
  }

  console.log(
    `sync-data: course=${course} items=${manifest.items.length} → ${path.relative(appRoot, courseOut)}`
  );

  return {
    id: course,
    title: course,
    href: courseRoute(course),
    lectureCount,
    hasPipeline: pipelineCount > 0,
    hasKg,
    itemCount: manifest.items.length,
  };
}

/** 把默认课的目录镜像到 public/data 根，兼容旧 /data/* 链接 */
function mirrorCourseToRoot(course) {
  const src = coursePublicDir(course);
  if (!fs.existsSync(src)) return;
  const names = fs.readdirSync(src);
  for (const name of names) {
    // 勿把 courses 索引目录自身拷进根
    if (name === "courses") continue;
    const from = path.join(src, name);
    const to = path.join(outDir, name);
    try {
      const st = fs.statSync(from);
      if (st.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const child of fs.readdirSync(from)) {
          const cf = path.join(from, child);
          const ct = path.join(to, child);
          if (fs.statSync(cf).isDirectory()) {
            fs.cpSync(cf, ct, { recursive: true, force: true });
          } else {
            fs.copyFileSync(cf, ct);
          }
        }
      } else {
        fs.copyFileSync(from, to);
      }
    } catch (err) {
      console.warn(`sync-data: mirror ${name} failed`, err.message);
    }
  }
}

// —— main ——
fs.mkdirSync(outDir, { recursive: true });
const courses = discoverCourses();
const only = process.env.TEACHKG_COURSE;
const targets = only ? courses.filter((c) => c === only) : courses;
if (only && !targets.length) {
  console.warn(`TEACHKG_COURSE=${only} 未在 data/kg|viz 找到，仍尝试同步`);
  targets.push(only);
}

const courseCards = [];
for (const c of targets) {
  courseCards.push(syncOneCourse(c));
}

const defaultCourseId =
  courseCards.find((c) => c.id === defaultCourseEnv)?.id || courseCards[0]?.id || defaultCourseEnv;

const index = {
  generatedAt: new Date().toISOString(),
  defaultCourseId,
  courses: courseCards.map(({ id, title, href, lectureCount, hasPipeline, hasKg }) => ({
    id,
    title,
    href,
    lectureCount,
    hasPipeline,
    hasKg,
  })),
};
fs.writeFileSync(path.join(outDir, "courses.json"), JSON.stringify(index, null, 2), "utf8");

if (defaultCourseId) {
  mirrorCourseToRoot(defaultCourseId);
  console.log(`sync-data: mirrored default course=${defaultCourseId} → public/data/*`);
}

console.log(
  `sync-data: courses=${courseCards.length} default=${defaultCourseId} → public/data/courses.json`
);
