/**
 * 复习页课次学习笔记：每次课（通常两讲，如 1_2）一篇连贯讲义。
 * 结构：大纲 + 若干部分展开讲解（不分主题簇、不按概念拆词条）。
 *
 * 持久化：.review_notes_cache/{course}/{sessionOrLectureId}.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callLlm } from "./qaLlm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
/** 与前端 LECTURE_NOTES_VERSION 对齐 */
const NOTES_VERSION = 11;

function sessionHeading(lectureId, title) {
  const id = String(lectureId || "").trim();
  const m = id.match(/^(\d+)_(\d+)$/);
  if (m) {
    const idx = Math.ceil(Number(m[1]) / 2);
    return {
      idx,
      range: `${m[1]}–${m[2]}`,
      defaultTitle: `第 ${idx} 次课 · 笔记`,
      subtitle: title || `第 ${m[1]}–${m[2]} 讲`,
    };
  }
  return {
    idx: Number(id) || 1,
    range: id || "?",
    defaultTitle: title || `第 ${id || "?"} 讲 · 笔记`,
    subtitle: "单讲课次",
  };
}

function resolveNotesRoot() {
  const candidates = [
    process.env.REVIEW_NOTES_DIR,
    // 容器内可写（/workspace/data 在 staging 常为 :ro）
    path.join(__dirname, "../.review_notes_cache"),
    path.join("/tmp", "mmkg_review_notes"),
    path.join(repoRoot, "data", "review_notes"),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* try next */
    }
  }
  return path.join("/tmp", "mmkg_review_notes");
}

const notesRoot = resolveNotesRoot();

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeSegment(s) {
  return String(s || "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/[/\\]/g, "_")
    .trim();
}

function notesPath(courseId, lectureId) {
  const course = safeSegment(courseId);
  const lecture = safeSegment(lectureId);
  if (!course || !lecture) return null;
  return path.join(notesRoot, course, `${lecture}.json`);
}

function statusPath(courseId, lectureId) {
  const file = notesPath(courseId, lectureId);
  if (!file) return null;
  return file.replace(/\.json$/, ".status.json");
}

/** in-flight jobs keyed by course::lecture — avoid duplicate LLM calls */
const inflight = new Map();

function readStatus(courseId, lectureId) {
  const file = statusPath(courseId, lectureId);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeStatus(courseId, lectureId, status) {
  const file = statusPath(courseId, lectureId);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ ...status, updatedAt: Date.now() }, null, 2),
    "utf8"
  );
  fs.renameSync(tmp, file);
}

function clearStatus(courseId, lectureId) {
  const file = statusPath(courseId, lectureId);
  if (!file || !fs.existsSync(file)) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function jobKey(courseId, lectureId) {
  return `${courseId}::${lectureId}`;
}

function startNotesJob(payload, env) {
  const courseId = String(payload.courseId || "").trim();
  const lectureId = String(payload.lectureId || "").trim();
  const key = jobKey(courseId, lectureId);
  if (inflight.has(key)) return inflight.get(key);

  writeStatus(courseId, lectureId, {
    status: "generating",
    startedAt: Date.now(),
    message: "正在生成教材体例笔记…",
  });

  const promise = (async () => {
    try {
      const result = await runReviewNotes(payload, env);
      if (result?.error) {
        writeStatus(courseId, lectureId, {
          status: "failed",
          error: result.error,
          message: result.message || result.error,
        });
        return result;
      }
      writeDiskNotes(courseId, lectureId, result);
      clearStatus(courseId, lectureId);
      return result;
    } catch (e) {
      const msg = String(e?.message || e);
      writeStatus(courseId, lectureId, {
        status: "failed",
        error: e?.code || "GEN_FAILED",
        message: msg,
      });
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  // prevent unhandled rejection if nobody awaits
  promise.catch(() => {});
  return promise;
}

function parseQuery(rawUrl) {
  const q = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
  // 课名含「图论+数理…」时，查询串里的 + 必须当字面量；URLSearchParams 会把 + 当成空格
  const params = new URLSearchParams(q.replace(/\+/g, "%2B"));
  return {
    courseId: String(params.get("courseId") || "").trim(),
    lectureId: String(params.get("lectureId") || "").trim(),
    force: ["1", "true", "yes"].includes(
      String(params.get("force") || "").trim().toLowerCase()
    ),
  };
}

function readDiskNotes(courseId, lectureId) {
  const file = notesPath(courseId, lectureId);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!doc || typeof doc !== "object") return null;
    if (Number(doc.version) !== NOTES_VERSION) return null;
    if (!Array.isArray(doc.sections) || !doc.sections.length) return null;
    return {
      ...doc,
      themes: Array.isArray(doc.themes) ? doc.themes : [],
      cachedFromDisk: true,
      cachePath: path.relative(repoRoot, file).replace(/\\/g, "/"),
    };
  } catch {
    return null;
  }
}

function deleteDiskNotes(courseId, lectureId) {
  const file = notesPath(courseId, lectureId);
  if (!file || !fs.existsSync(file)) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function writeDiskNotes(courseId, lectureId, doc) {
  const file = notesPath(courseId, lectureId);
  if (!file || !doc) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    ...doc,
    version: NOTES_VERSION,
    themes: [],
    courseId,
    lectureId,
    savedAt: Date.now(),
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function clip(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + "…";
}

/** 解析课次 id → 讲次列表：5_6 → ["5","6"] */
function lectureIdsFromSession(lectureId) {
  const id = String(lectureId || "").trim();
  const m = id.match(/^(\d+)_(\d+)$/);
  if (m) return [m[1], m[2]];
  if (/^\d+$/.test(id)) return [id];
  return [];
}

function coursePublicDir(courseId) {
  const safe = String(courseId || "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .trim();
  if (!safe) return null;
  return path.join(__dirname, "../public/data/courses", safe);
}

/** 从落盘 review/pipeline 抽本课两讲的视频主线（书面短介绍 + 抽取文） */
function loadVideoOutlinePack(courseId, lectureId) {
  const lids = lectureIdsFromSession(lectureId);
  const root = coursePublicDir(courseId);
  if (!root || !lids.length) return "";
  const lines = [];
  lines.push("## 本课两讲视频主线（必须覆盖；勿写视频未讲的后续章节）");
  for (const lid of lids) {
    lines.push(`### 第 ${lid} 讲视频要点`);
    const revPath = path.join(root, "review", `lecture_${lid}.json`);
    const pipePath = path.join(root, "pipeline", `pipeline_build_lecture_${lid}.json`);
    let n = 0;
    try {
      if (fs.existsSync(revPath)) {
        const rev = JSON.parse(fs.readFileSync(revPath, "utf8"));
        for (const s of Array.isArray(rev.segments) ? rev.segments : []) {
          const cap = String(s?.summary || s?.title || "").trim();
          if (!cap || cap.length < 6) continue;
          lines.push(`- [${Math.round(Number(s.start_sec) || 0)}s] ${clip(cap, 120)}`);
          n += 1;
          if (n >= 14) break;
        }
      }
    } catch {
      /* ignore */
    }
    if (n < 4) {
      try {
        if (fs.existsSync(pipePath)) {
          const pipe = JSON.parse(fs.readFileSync(pipePath, "utf8"));
          for (const it of Array.isArray(pipe.items) ? pipe.items : []) {
            const raw = String(it.extract_text || it.asr_text || "").trim();
            if (!raw) continue;
            const first = raw.split(/[。！？\n]/)[0]?.trim() || raw;
            if (first.length < 6) continue;
            lines.push(
              `- [${Math.round(Number(it.start_sec) || 0)}s] ${clip(first, 120)}`
            );
            n += 1;
            if (n >= 14) break;
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (!n) lines.push("- （暂无分段要点）");
  }
  return lines.join("\n");
}

function buildLecturePack(payload) {
  const points = Array.isArray(payload.points) ? payload.points : [];
  const ranked = [...points].sort(
    (a, b) => Number(b.importance || 0) - Number(a.importance || 0)
  );
  const head = sessionHeading(payload.lectureId, payload.title);
  const lines = [];
  lines.push(`# 课次材料 · ${head.defaultTitle}`);
  lines.push(`覆盖讲次：${head.range}`);
  if (payload.title) lines.push(`标题：${payload.title}`);
  lines.push("");
  const videoPack = loadVideoOutlinePack(payload.courseId, payload.lectureId);
  if (videoPack) {
    lines.push(videoPack);
    lines.push("");
  }
  lines.push(
    "## 知识点材料（按课堂重要性排序；请整理成「一篇课次讲义」，不要按概念拆成词条）"
  );
  const take = ranked.slice(0, 22);
  for (const p of take) {
    const name = String(p.zh || p.id || "").trim();
    if (!name) continue;
    lines.push(`### ${name}`);
    lines.push(`- id: ${p.id || ""}`);
    if (p.definition) lines.push(`- 定义: ${clip(p.definition, 420)}`);
    if (p.summary) lines.push(`- 摘要: ${clip(p.summary, 280)}`);
    const neigh = Array.isArray(p.neighbors) ? p.neighbors : [];
    if (neigh.length) {
      const bits = neigh
        .slice(0, 5)
        .map((n) => {
          const a = String(n.subject || "").split("/")[0];
          const b = String(n.object || "").split("/")[0];
          const rel = String(n.predicate || n.relation || "").trim();
          return rel ? `${a}—${rel}→${b}` : `${a}→${b}`;
        })
        .filter(Boolean);
      if (bits.length) lines.push(`- 关系: ${bits.join("；")}`);
    }
    const ev = Array.isArray(p.evidence) ? p.evidence : [];
    for (const e of ev.slice(0, 2)) {
      if (e?.text) {
        const t = e.start_sec != null ? `@${Math.round(Number(e.start_sec))}s ` : "";
        lines.push(`- 课堂摘录: ${t}${clip(e.text, 280)}`);
      }
    }
  }
  if (!take.length) lines.push("（本次课暂无浓缩知识点）");
  return lines.join("\n");
}

const SYSTEM = `你是离散数学助教。把「一次课」（通常含两讲，如第 1–2 讲）的材料整理成一篇连贯学习笔记。

写作目标：整次课只有一篇笔记。先给大纲，再分若干部分讲解；每部分可串讲多个相关知识点。不要按概念拆成词条卡片，不要做「主题簇」命名游戏。

【与视频对齐——硬性规则】
A. 笔记主线必须覆盖「本课两讲视频主线」里的核心主题（如定义、判定定理、表示法、重要应用）；视频反复出现的概念（如同构、补图、握手定理、欧拉判定等）不要漏掉。
B. 禁止超前：视频这两讲尚未展开的章节内容不要写进正文当主线（例如还在讲命题联结词时，不要用整节写谓词公理系统；还在图论前半时不要整节写集合论公理）。
C. 允许浓缩细节，但不要用无关模块的概念来充数；知识点材料仅作补充，若与视频主线冲突，以视频主线为准。
D. 大纲各节应能在视频要点中找到对应；顺序大致按两讲教学推进（先第 N 讲主线，再第 N+1 讲主线）。

体例要求：
1. title：如「第 1 次课 · 笔记」；subtitle：如「第 1–2 讲」（前端可能不展示）。
2. overview：80～150 字，以「本次课聚焦……」起笔，概括学什么、各部分如何衔接；不要写「本次课为单课复习」。
3. outline：字符串数组，3～6 条，即各部分标题（与 sections.title 一一对应，可略短）。
4. sections：3～5 个部分（kind 一律 "part"）。每部分覆盖一组相关知识点，写成讲义段落，不是「一个概念一节」。
5. 每部分字段：
   - title：部分标题（如「一、命题与真值」）
   - summary：一句提要
   - body：连贯正文 2～5 段，用 \\n\\n 分段；把定义、关系自然写进叙述里（不要单独出定义卡片）
   - blocks：可选 0～3 条补充——仅 fact（性质/说明）、example（例）、pitfall（注）；不要 def；没有可 []
   - related：本部分涉及的概念中文名（供图谱对齐）
6. 不要 themes / tips / checklist / hook / cue / def；themes 输出 []。
7. 课堂未出现的定理编号不要编造；数学用 $...$。
8. 控制篇幅，保证可在两分钟内生成完。
9. 只输出纯 JSON（不要 Markdown 围栏）：
{
  "title": "第 1 次课 · 笔记",
  "subtitle": "第 1–2 讲",
  "overview": "本次课聚焦……",
  "outline": ["一、……", "二、……", "三、……"],
  "themes": [],
  "sections": [
    {
      "id": "part-1",
      "kind": "part",
      "title": "一、……",
      "summary": "一句提要",
      "body": "段落一。\\n\\n段落二。",
      "blocks": [
        { "type": "example", "label": "例", "text": "…" }
      ],
      "bullets": [],
      "related": ["概念A", "概念B"],
      "tips": []
    }
  ]
}`;

const BLOCK_TYPES = new Set(["hook", "def", "fact", "example", "pitfall", "cue"]);

function parseNotesJson(content) {
  const raw = String(content || "").trim();
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

function polishOverview(text) {
  return String(text || "")
    .replace(/本次课为单课复习[，,]?\s*/g, "本次课")
    .replace(/本次课\s*聚焦/g, "本次课聚焦")
    .trim();
}

function normalizeBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      const type = String(b?.type || "").trim();
      if (!BLOCK_TYPES.has(type)) return null;
      // 教材体例：丢掉博客式 hook/cue，以及单独的定义卡片
      if (type === "hook" || type === "cue" || type === "def") return null;
      const text = String(b?.text || "").trim();
      if (!text) return null;
      let label = String(b?.label || "").trim();
      if (type === "fact" && !label) label = "性质";
      if (type === "example" && (!label || label === "课堂" || label === "例子")) {
        label = "例";
      }
      if (type === "pitfall" && !label) label = "注";
      return label ? { type, label, text } : { type, text };
    })
    .filter(Boolean)
    .slice(0, 10);
}

function blocksFromPointFallback(title, section) {
  const blocks = [];
  const bullets = Array.isArray(section?.bullets) ? section.bullets : [];
  for (const b of bullets.slice(0, 4)) {
    const t = String(b || "").trim();
    if (!t) continue;
    if (/^例|例如|比如/.test(t)) {
      blocks.push({ type: "example", label: "例", text: t });
    } else if (/注|易错|易混|注意/.test(t)) {
      blocks.push({ type: "pitfall", label: "注", text: t });
    } else {
      blocks.push({ type: "fact", label: "性质", text: t });
    }
  }
  return blocks.slice(0, 8);
}

function normalizeNotes(parsed, payload, model) {
  const head = sessionHeading(payload.lectureId, payload.title);
  const sectionsIn = Array.isArray(parsed?.sections) ? parsed.sections : [];
  const sections = sectionsIn
    .map((s, i) => {
      let kind = String(s?.kind || "part").trim();
      if (
        kind === "theme" ||
        kind === "overview" ||
        kind === "structure" ||
        kind === "concept"
      ) {
        kind = "part";
      }
      if (kind !== "part") kind = "part";
      const title = String(s?.title || `第 ${i + 1} 部分`).trim();
      const id = String(s?.id || `part-${i + 1}`).slice(0, 48);
      const body = String(s?.body || "").trim();
      let blocks = normalizeBlocks(s?.blocks);
      if (!body && !blocks.length) {
        blocks = blocksFromPointFallback(title, s);
      }
      return {
        id,
        kind,
        title,
        summary: String(s?.summary || "").trim(),
        body,
        blocks,
        bullets: Array.isArray(s?.bullets)
          ? s.bullets.map(String).filter(Boolean).slice(0, 8)
          : [],
        related: Array.isArray(s?.related)
          ? s.related.map(String).filter(Boolean).slice(0, 12)
          : [],
        tips: [],
      };
    })
    .filter((s) => s.title && (s.body || s.blocks.length || s.summary));

  let outline = Array.isArray(parsed?.outline)
    ? parsed.outline.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  if (!outline.length) {
    outline = sections.map((s) => s.title).slice(0, 8);
  }

  return {
    version: NOTES_VERSION,
    title: String(parsed?.title || head.defaultTitle).trim(),
    subtitle: String(parsed?.subtitle || head.subtitle).trim(),
    overview: polishOverview(String(parsed?.overview || "").trim()),
    outline,
    themes: [],
    sections,
    model,
    source: "llm",
    generatedAt: Date.now(),
  };
}

export async function runReviewNotes(payload, env = process.env) {
  const points = Array.isArray(payload.points) ? payload.points : [];
  if (!points.length) {
    return { error: "empty points" };
  }

  const pack = buildLecturePack(payload);
  const messages = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `${pack}\n\n请输出完整 JSON 课次笔记：一篇到底；含 outline 与若干 part；themes 必须为 []；不要按概念拆词条。务必覆盖「本课两讲视频主线」中的核心主题，禁止写入这两讲视频未讲的后续章节。`,
    },
  ];

  const { content, model } = await callLlm(env, messages, {
    timeoutMs: 180000,
    temperature: 0.2,
  });
  const parsed = parseNotesJson(content);
  if (!parsed) {
    return { error: "invalid_json", raw: String(content || "").slice(0, 400) };
  }
  const notes = normalizeNotes(parsed, payload, model);
  if (!notes.sections.length) {
    return { error: "empty_sections", model };
  }
  return notes;
}

export function reviewNotesMiddleware(envOrFactory = process.env) {
  const resolveEnv = () => {
    const base =
      typeof envOrFactory === "function" ? envOrFactory() : envOrFactory || {};
    return { ...base, ...process.env };
  };

  return async (req, res, next) => {
    try {
      const rawUrl = String(req.url || "");
      if (!rawUrl.startsWith("/api/review-notes")) return next();

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      const q = parseQuery(rawUrl);

      if (req.method === "GET") {
        const courseId = q.courseId;
        const lectureId = q.lectureId;
        if (!courseId || !lectureId) {
          json(res, 400, { error: "courseId and lectureId required" });
          return;
        }
        const cached = readDiskNotes(courseId, lectureId);
        if (cached) {
          json(res, 200, cached);
          return;
        }
        const st = readStatus(courseId, lectureId);
        if (st?.status === "generating" || inflight.has(jobKey(courseId, lectureId))) {
          json(res, 202, {
            status: "generating",
            message: st?.message || "正在生成…",
            startedAt: st?.startedAt,
          });
          return;
        }
        if (st?.status === "failed") {
          json(res, 502, {
            error: st.error || "GEN_FAILED",
            message: st.message || "生成失败",
            status: "failed",
          });
          return;
        }
        json(res, 404, { error: "NOT_CACHED" });
        return;
      }

      if (req.method !== "POST") {
        json(res, 405, { error: "GET or POST only" });
        return;
      }

      const payload = await readBody(req);
      const courseId = String(payload.courseId || q.courseId || "").trim();
      const lectureId = String(payload.lectureId || q.lectureId || "").trim();
      const force = Boolean(payload.force) || q.force;
      // 默认异步：校外 / 前置 nginx 约 60s 会 504，LLM 常需更久
      const asyncMode = payload.async !== false && payload.wait !== true;

      if (!force && courseId && lectureId) {
        const cached = readDiskNotes(courseId, lectureId);
        if (cached) {
          json(res, 200, cached);
          return;
        }
      }

      if (force && courseId && lectureId) {
        deleteDiskNotes(courseId, lectureId);
        clearStatus(courseId, lectureId);
      }

      const env = resolveEnv();
      const points = Array.isArray(payload.points) ? payload.points : [];
      if (!points.length) {
        json(res, 400, { error: "empty points" });
        return;
      }

      if (asyncMode) {
        startNotesJob({ ...payload, courseId, lectureId }, env);
        json(res, 202, {
          status: "generating",
          message: "已开始生成，请轮询 GET /api/review-notes",
          courseId,
          lectureId,
        });
        return;
      }

      try {
        const result = await runReviewNotes({ ...payload, courseId, lectureId }, env);
        if (result.error) {
          json(res, result.error === "empty points" ? 400 : 502, result);
          return;
        }
        if (courseId && lectureId && result && !result.error) {
          try {
            writeDiskNotes(courseId, lectureId, result);
            clearStatus(courseId, lectureId);
          } catch (e) {
            result.diskSaveError = String(e?.message || e);
          }
        }
        json(res, 200, result);
      } catch (e) {
        if (e?.code === "NO_LLM_KEY" || String(e?.message) === "NO_LLM_KEY") {
          json(res, 503, {
            error: "NO_LLM_KEY",
            message:
              "未配置 LLM_API_KEY（或 OPENAI_API_KEY / SJTU_LLM_API_KEY）。请在 compose .env 配置后重启前端容器。",
          });
          return;
        }
        const msg = String(e?.message || e);
        json(res, 502, {
          error: msg,
          message:
            /fetch failed|ECONNREFUSED|ECONNRESET|UND_ERR/i.test(msg)
              ? "大模型连接失败：请确认 LLM_BASE_URL 与密钥可用后重试"
              : msg,
        });
      }
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
  };
}
