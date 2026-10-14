/**
 * 离线预计算 KgPage 用图谱：process + 课堂分 + 父子传递。
 * 复用前端 TS 逻辑（vite ssrLoadModule），写入：
 *   - public/data/courses/{course}/pipeline/kg_processed_*.json
 *   - data/viz/{course}/kg_processed_*.json（供 sync-data 再同步）
 *
 * 用法：
 *   npm run export-kg-processed
 *   npm run export-kg-processed -- --course "离散数学(图论+数理逻辑与集合论)" --only course
 *   npm run export-kg-processed -- --only lecture --lectures 1,2
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");
const defaultCourse =
  process.env.TEACHKG_COURSE || "离散数学(图论+数理逻辑与集合论)";

function parseArgs(argv) {
  const out = {
    course: defaultCourse,
    only: "all", // all | course | lecture | session
    lectures: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--course") out.course = argv[++i] || out.course;
    else if (a === "--only") out.only = argv[++i] || out.only;
    else if (a === "--lectures") {
      out.lectures = String(argv[++i] || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return out;
}

function listLectureIds(pipelineDir) {
  if (!fs.existsSync(pipelineDir)) return [];
  const ids = [];
  for (const name of fs.readdirSync(pipelineDir)) {
    const m = /^pipeline_build_lecture_(\d+)\.json$/.exec(name);
    if (m) ids.push(m[1]);
  }
  return ids.sort((a, b) => Number(a) - Number(b));
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const course = args.course;
  const publicPipeline = path.join(
    appRoot,
    "public/data/courses",
    course,
    "pipeline"
  );
  const vizDir = path.join(repoRoot, "data/viz", course);
  const pipelineDir = fs.existsSync(publicPipeline)
    ? publicPipeline
    : path.join(vizDir);

  if (!fs.existsSync(pipelineDir)) {
    console.error("找不到 pipeline 目录:", pipelineDir);
    process.exit(1);
  }

  const lectureIds =
    args.lectures?.length > 0 ? args.lectures : listLectureIds(pipelineDir);
  if (!lectureIds.length) {
    console.error("无 pipeline_build_lecture_*.json");
    process.exit(1);
  }

  console.log(`[export-kg-processed] course=${course}`);
  console.log(`[export-kg-processed] lectures=${lectureIds.length} from ${pipelineDir}`);

  const vite = await createServer({
    // 不用完整 vite.config，避免扫描 index/CSS 与 middleware 副作用
    configFile: false,
    root: appRoot,
    resolve: {
      alias: { "@": path.join(appRoot, "src") },
    },
    server: { middlewareMode: true },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  try {
    const {
      parseLecturePipelinePayload,
      classUnitsFromLectureIds,
    } = await vite.ssrLoadModule("/src/lib/kg/pipelineMergeSource.ts");
    const {
      buildLectureOrSessionProcessed,
      buildCourseProcessed,
      kgProcessedFileStem,
    } = await vite.ssrLoadModule("/src/lib/kg/kgProcessedArtifact.ts");

    const allCues = [];
    const multiRelDecisions = {};
    for (const lid of lectureIds) {
      const buildPath = path.join(
        pipelineDir,
        `pipeline_build_lecture_${lid}.json`
      );
      if (!fs.existsSync(buildPath)) {
        console.warn("  skip missing", buildPath);
        continue;
      }
      const raw = loadJson(buildPath);
      const { cues } = parseLecturePipelinePayload(raw, lid);
      cues.forEach((c, idx) => {
        const labelPrefix = `第${lid}讲·片段${idx + 1}`;
        allCues.push({
          ...c,
          edges: c.edges.map((e) => ({
            ...e,
            lecture_id: e.lecture_id || lid,
            cue_label: e.cue_label?.startsWith("第")
              ? e.cue_label
              : `${labelPrefix}${
                  c.startSec != null ? ` · ${Math.round(c.startSec)}s` : ""
                }`,
          })),
          crossCueEdges: (c.crossCueEdges || []).map((e) => ({
            ...e,
            lecture_id: e.lecture_id || lid,
            cue_label: e.cue_label?.startsWith("第")
              ? e.cue_label
              : `${labelPrefix}${
                  c.startSec != null ? ` · ${Math.round(c.startSec)}s` : ""
                }`,
          })),
        });
      });

      const collapsePath = path.join(
        pipelineDir,
        `multi_rel_collapse_lecture_${lid}.json`
      );
      if (fs.existsSync(collapsePath)) {
        try {
          const dec = loadJson(collapsePath)?.decisions || {};
          Object.assign(multiRelDecisions, dec);
        } catch {
          /* ignore */
        }
      }
    }

    if (!allCues.length) {
      console.error("未解析到任何片段");
      process.exit(1);
    }

    const units = classUnitsFromLectureIds(lectureIds);
    const want = (kind) =>
      args.only === "all" || args.only === kind;

    const { applyPropertyMergeDecisions } = await vite.ssrLoadModule(
      "/src/lib/kg/propertyMerge.ts"
    );

    const loadPropertyMerges = (decName) => {
      for (const dir of [publicPipeline, vizDir]) {
        const p = path.join(dir, decName);
        if (!fs.existsSync(p)) continue;
        try {
          return loadJson(p)?.decisions || {};
        } catch {
          /* ignore */
        }
      }
      return {};
    };

    const persist = (stem, artifact, propertyDecisions) => {
      let art = artifact;
      if (propertyDecisions && Object.keys(propertyDecisions).length) {
        art = {
          ...artifact,
          nodes: applyPropertyMergeDecisions(
            artifact.nodes || [],
            propertyDecisions
          ),
        };
      }
      const publicOut = path.join(publicPipeline, `${stem}.json`);
      const vizOut = path.join(vizDir, `${stem}.json`);
      writeJson(publicOut, art);
      writeJson(vizOut, art);
      const n = art.nodes?.length || 0;
      const e = art.kept_edges?.length || 0;
      console.log(`  wrote ${stem}.json  nodes=${n} kept_edges=${e}`);
    };

    if (want("lecture")) {
      for (const lid of lectureIds) {
        const cues = allCues.filter((c) => String(c.lectureId) === String(lid));
        if (!cues.length) continue;
        const t0 = Date.now();
        const art = buildLectureOrSessionProcessed({
          courseId: course,
          scope: "lecture",
          lectureId: lid,
          cues,
          multiRelDecisions,
        });
        const propDec = loadPropertyMerges(
          `property_merge_lecture_${lid}.json`
        );
        persist(
          kgProcessedFileStem("lecture", { lectureId: lid }),
          art,
          propDec
        );
        console.log(`    lecture ${lid} ${Date.now() - t0}ms`);
      }
    }

    if (want("session")) {
      for (const unit of units) {
        if (unit.kind !== "session") continue;
        const [a, b] = unit.pair;
        const cues = allCues.filter(
          (c) => String(c.lectureId) === a || String(c.lectureId) === b
        );
        if (!cues.length) continue;
        const t0 = Date.now();
        const art = buildLectureOrSessionProcessed({
          courseId: course,
          scope: "session",
          sessionPair: unit.pair,
          cues,
          multiRelDecisions,
        });
        persist(kgProcessedFileStem("session", { sessionPair: unit.pair }), art);
        console.log(`    session ${a}+${b} ${Date.now() - t0}ms`);
      }
    }

    if (want("course")) {
      const t0 = Date.now();
      const art = buildCourseProcessed({
        courseId: course,
        cues: allCues,
        units,
        multiRelDecisions,
      });
      const propDec = loadPropertyMerges("property_merge_course.json");
      persist(kgProcessedFileStem("course", {}), art, propDec);
      console.log(`    course ${Date.now() - t0}ms`);
    }

    console.log("[export-kg-processed] done");
  } finally {
    await vite.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
