/**
 * 复习页整讲学习笔记：课堂材料优先，整理成「真像笔记」的分主题结构。
 * 参考数学笔记常见做法：DTPE（定义–结论–例子）+ 易错 + 自测线索。
 *
 * 持久化：成功生成的笔记写入 data/review_notes/{course}/{lecture}.json，
 * 下次优先读盘，避免浏览器缓存丢失后反复调 LLM。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callLlm } from "./qaLlm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const notesRoot = path.join(repoRoot, "data", "review_notes");
/** 与前端 LECTURE_NOTES_VERSION 对齐；升级结构时递增以失效旧缓存 */
const NOTES_VERSION = 5;

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

function parseQuery(rawUrl) {
  const q = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
  const params = new URLSearchParams(q);
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
    if (!Array.isArray(doc.themes) || !doc.themes.length) return null;
    if (!Array.isArray(doc.sections) || !doc.sections.length) return null;
    return {
      ...doc,
      cachedFromDisk: true,
      cachePath: path.relative(repoRoot, file).replace(/\\/g, "/"),
    };
  } catch {
    return null;
  }
}

function writeDiskNotes(courseId, lectureId, doc) {
  const file = notesPath(courseId, lectureId);
  if (!file || !doc) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    ...doc,
    version: NOTES_VERSION,
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

function buildLecturePack(payload) {
  const points = Array.isArray(payload.points) ? payload.points : [];
  const ranked = [...points].sort(
    (a, b) => Number(b.importance || 0) - Number(a.importance || 0)
  );
  const lines = [];
  lines.push(`课程：${payload.courseId || ""}`);
  const lectureId = String(payload.lectureId || "");
  const lectureLabel = payload.title
    ? payload.title
    : lectureId.includes("_")
      ? `第 ${lectureId.replace("_", "–")} 讲`
      : `第 ${lectureId || "?"} 讲`;
  lines.push(`讲次：${lectureLabel}`);
  if (payload.title) lines.push(`标题：${payload.title}`);
  lines.push(`知识点数量：${points.length}`);
  lines.push("");
  lines.push("【本堂课课堂材料】（释义、关系、课堂证据；笔记须以此为准）");

  // 控制材料长度，避免长 JSON 笔记超时；重要性高的优先
  const take = ranked.slice(0, 28);
  for (let i = 0; i < take.length; i++) {
    const p = take[i];
    lines.push(`\n### ${i + 1}. ${p.zh || p.id}`);
    if (p.importance != null) lines.push(`重要性：${Number(p.importance).toFixed(3)}`);
    if (p.origin) lines.push(`来源：${p.origin}`);
    if (p.definition) lines.push(`释义：${clip(p.definition, 320)}`);
    else if (p.summary) lines.push(`摘要：${clip(p.summary, 220)}`);
    const neighbors = Array.isArray(p.neighbors) ? p.neighbors.slice(0, 4) : [];
    if (neighbors.length) {
      lines.push("关系：");
      for (const n of neighbors) {
        lines.push(
          `- ${n.natural_statement || `${n.subject} —${n.label || n.predicate}→ ${n.object}`}`
        );
      }
    }
    const evidence = Array.isArray(p.evidence) ? p.evidence.slice(0, 3) : [];
    if (evidence.length) {
      lines.push("课堂证据（可改写为例子/老师原话线索）：");
      for (const e of evidence) {
        const t =
          e.start_sec != null && Number.isFinite(Number(e.start_sec))
            ? `[${Math.floor(Number(e.start_sec))}s] `
            : "";
        lines.push(`- ${t}${clip(e.text, 280)}`);
      }
    }
  }
  if (!take.length) lines.push("（本讲暂无浓缩知识点）");
  return lines.join("\n");
}

const SYSTEM = `你是认真听完离散数学课后、正在重写笔记的学长/学姐。目标：写出「合上书还能用来复习」的课堂笔记，而不是百科词条列表。

好的数学笔记习惯（请内化，不要在输出里解释方法名）：
- 每个主题像课堂小节：先交代「老师在解决什么问题」，再写定义/记号，再写关键性质或结论，再写课堂例子，最后留下易错与自测。
- 用自己的话串联，少用「A：定义…… B：定义……」的词条堆砌。
- 定义要可背、可指认记号；性质要写清「所以怎样 / 为何重要」；例子优先改写课堂证据，没有证据就用材料里的关系编一个最小例子（标明「示意」）。
- 仍然分成多个主题（5～8 个），主题名要像板书小标题。

硬性规则：
1. 定义、关系、课堂表述必须以材料为准，不要编造老师没讲过的定理编号或课本外结论。
2. 5～8 个主题；不要一概念一主题，也不要超过 10 个。
3. themes[].oneLiner = 合上书后还能想起的「本主题一句话」。
4. 每个主题 section 必须含 blocks（按顺序尽量齐全）：
   - hook：2～4 句课堂脉络（为什么讲、接上文什么）
   - def：1～3 条，格式「概念名 — 定义/记号…」；可多条分多 block
   - fact：1～3 条关键性质/结论/关系（写清含义，不只名词）
   - example：至少 1 条（课堂例子或示意）
   - pitfall：0～2 条易混/易错
   - cue：1 条自测；text=问句，answer=2～4 句参考答（要点齐全，勿只写「见上文」）
5. themes[].oneLiner = 合上书一句话（折叠预览用这一句即可）。
6. summary 可与 oneLiner 相同或留空，不要另写一段意思差不多的话（避免开头重复）。
7. body 一律空字符串；不要再写收尾总结段。
8. related = 本主题概念中文名（供图谱对齐，界面可不展示）；keyPoints 与之呼应。
9. 主题后可附 tips / checklist 各至多 1 节。
10. 数学用 $...$；必须输出纯 JSON（不要 Markdown 围栏）：
{
  "title": "…",
  "subtitle": "这一堂课在解决什么问题（一句）",
  "overview": "80-140字：几个主题、主线怎么走，像写在笔记本首页",
  "themes": [
    {
      "id": "theme-1",
      "title": "板书感主题名",
      "oneLiner": "合上书还能想起的一句话",
      "keyPoints": ["概念1", "概念2"]
    }
  ],
  "sections": [
    {
      "id": "theme-1",
      "kind": "theme",
      "title": "与 themes 同名",
      "summary": "",
      "body": "",
      "blocks": [
        { "type": "hook", "label": "脉络", "text": "…" },
        { "type": "def", "label": "定义", "text": "集合 — …" },
        { "type": "fact", "label": "性质", "text": "…" },
        { "type": "example", "label": "例", "text": "…" },
        { "type": "pitfall", "label": "易错", "text": "…" },
        {
          "type": "cue",
          "label": "自测",
          "text": "自测问句？",
          "answer": "参考答：要点 1；要点 2。"
        }
      ],
      "bullets": [],
      "related": ["概念中文名"],
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

function normalizeBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      const type = String(b?.type || "").trim();
      if (!BLOCK_TYPES.has(type)) return null;
      const text = String(b?.text || "").trim();
      if (!text) return null;
      const label = String(b?.label || "").trim();
      const answer = String(b?.answer || "").trim();
      const out = label ? { type, label, text } : { type, text };
      if (type === "cue" && answer) out.answer = answer;
      return out;
    })
    .filter(Boolean)
    .slice(0, 16);
}

/** 旧式 bullets「概念：释义」升成 blocks，保证 UI 仍有笔记感 */
function blocksFromLegacy(section, theme) {
  const blocks = [];
  const summary = String(section?.summary || theme?.oneLiner || "").trim();
  if (summary) {
    blocks.push({ type: "hook", label: "脉络", text: summary });
  }
  const bullets = Array.isArray(section?.bullets) ? section.bullets : [];
  for (const b of bullets.slice(0, 6)) {
    const t = String(b || "").trim();
    if (!t) continue;
    if (/^【?(定义|记号)/.test(t) || /：/.test(t) || /—/.test(t)) {
      blocks.push({ type: "def", label: "定义", text: t.replace(/^【?定义】?[:：\s]*/, "") });
    } else if (/易错|易混|注意/.test(t)) {
      blocks.push({ type: "pitfall", label: "易错", text: t });
    } else if (/^例|例如|比如/.test(t)) {
      blocks.push({ type: "example", label: "例", text: t });
    } else {
      blocks.push({ type: "fact", label: "要点", text: t });
    }
  }
  for (const tip of section?.tips || []) {
    const t = String(tip || "").trim();
    if (t) blocks.push({ type: "pitfall", label: "易错", text: t });
  }
  if (theme?.oneLiner) {
    blocks.push({
      type: "cue",
      label: "自测",
      text: `不看笔记，你能否用一句话说清「${theme.title}」在讲什么？`,
    });
  }
  return blocks.slice(0, 14);
}

function normalizeNotes(parsed, payload, model) {
  const allowed = new Set([
    "theme",
    "tips",
    "extra",
    "checklist",
    "overview",
    "concept",
    "structure",
  ]);

  const themesIn = Array.isArray(parsed?.themes) ? parsed.themes : [];
  let themes = themesIn
    .map((t, i) => ({
      id: String(t?.id || `theme-${i + 1}`).slice(0, 48),
      title: String(t?.title || `主题 ${i + 1}`).trim(),
      oneLiner: String(t?.oneLiner || t?.summary || "").trim(),
      keyPoints: Array.isArray(t?.keyPoints)
        ? t.keyPoints.map(String).filter(Boolean).slice(0, 8)
        : Array.isArray(t?.keywords)
          ? t.keywords.map(String).filter(Boolean).slice(0, 8)
          : [],
    }))
    .filter((t) => t.title);

  const sectionsIn = Array.isArray(parsed?.sections) ? parsed.sections : [];
  const sections = sectionsIn
    .map((s, i) => {
      let kind = String(s?.kind || "theme");
      if (kind === "concept" || kind === "structure" || kind === "overview") kind = "theme";
      let blocks = normalizeBlocks(s?.blocks);
      const title = String(s?.title || `小节 ${i + 1}`).trim();
      const id = String(s?.id || `sec-${i + 1}`).slice(0, 48);
      const theme = themes.find((t) => t.id === id || t.title === title);
      if (!blocks.length && (kind === "theme" || !kind)) {
        blocks = blocksFromLegacy(s, theme);
      }
      return {
        id,
        kind: allowed.has(kind) ? kind : "theme",
        title,
        summary: String(s?.summary || "").trim(),
        body: String(s?.body || "").trim(),
        blocks,
        bullets: Array.isArray(s?.bullets)
          ? s.bullets.map(String).filter(Boolean).slice(0, 12)
          : [],
        related: Array.isArray(s?.related)
          ? s.related.map(String).filter(Boolean).slice(0, 12)
          : [],
        tips: Array.isArray(s?.tips) ? s.tips.map(String).filter(Boolean).slice(0, 8) : [],
      };
    })
    .filter((s) => s.title && (s.summary || s.body || s.bullets.length || s.blocks.length));

  if (!themes.length) {
    themes = sections
      .filter((s) => s.kind === "theme")
      .map((s, i) => ({
        id: s.id || `theme-${i + 1}`,
        title: s.title,
        oneLiner: s.summary.slice(0, 100),
        keyPoints: (s.related || []).slice(0, 6),
      }));
  }

  for (const t of themes) {
    if (!sections.some((s) => s.id === t.id || s.title === t.title)) {
      sections.unshift({
        id: t.id,
        kind: "theme",
        title: t.title,
        summary: t.oneLiner,
        body: "",
        blocks: [
          { type: "hook", label: "脉络", text: t.oneLiner },
          ...t.keyPoints.slice(0, 3).map((k) => ({
            type: "def",
            label: "定义",
            text: `${k} — （见课堂材料）`,
          })),
          {
            type: "cue",
            label: "自测",
            text: `「${t.title}」一句话怎么概括？`,
          },
        ],
        bullets: t.keyPoints.map((k) => `掌握：${k}`),
        related: t.keyPoints,
        tips: [],
      });
    }
  }

  // 主题节补齐 cue；缺 answer 时用 oneLiner/summary 垫一句，避免自测无参考
  for (const s of sections) {
    if (s.kind !== "theme") continue;
    const theme = themes.find((t) => t.id === s.id || t.title === s.title);
    let cue = s.blocks.find((b) => b.type === "cue");
    if (!cue) {
      cue = {
        type: "cue",
        label: "自测",
        text: `合上笔记：用一句话说清「${s.title}」讲了什么？`,
        answer: theme?.oneLiner
          ? `参考：${theme.oneLiner}`
          : s.summary
            ? `参考：${s.summary}`
            : `先复述本主题定义与一个例子。`,
      };
      s.blocks.push(cue);
    } else if (!cue.answer) {
      cue.answer = theme?.oneLiner
        ? `参考：${theme.oneLiner}；再补一条定义或例子。`
        : s.summary
          ? `参考：${s.summary}`
          : `对照本主题「定义/例」两段自行核对。`;
    }
    // 折叠预览用 oneLiner；summary 与之重复则清空，避免双段开场
    if (
      theme?.oneLiner &&
      s.summary &&
      (s.summary === theme.oneLiner ||
        s.summary.includes(theme.oneLiner.slice(0, 12)) ||
        theme.oneLiner.includes(s.summary.slice(0, 12)))
    ) {
      s.summary = "";
    }
    s.body = "";
  }

  return {
    version: NOTES_VERSION,
    title: String(parsed?.title || `第 ${payload.lectureId || "?"} 讲 · 课堂笔记`).trim(),
    subtitle: String(parsed?.subtitle || "").trim(),
    overview: String(parsed?.overview || "").trim(),
    themes,
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
      content: `${pack}\n\n请按规则输出完整 JSON 课堂笔记（分主题，blocks 齐全）。`,
    },
  ];

  const { content, model } = await callLlm(env, messages, {
    timeoutMs: 240000,
    temperature: 0.4,
  });
  const parsed = parseNotesJson(content);
  if (!parsed) {
    return { error: "invalid_json", raw: String(content || "").slice(0, 400) };
  }
  const notes = normalizeNotes(parsed, payload, model);
  if (!notes.sections.length || !notes.themes.length) {
    return { error: "empty_sections", model };
  }
  return notes;
}

export function reviewNotesMiddleware(env = process.env) {
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
        if (!cached) {
          json(res, 404, { error: "NOT_CACHED" });
          return;
        }
        json(res, 200, cached);
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

      if (!force && courseId && lectureId) {
        const cached = readDiskNotes(courseId, lectureId);
        if (cached) {
          json(res, 200, cached);
          return;
        }
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
          } catch (e) {
            // 写盘失败不阻断返回；下次仍可再生成
            result.diskSaveError = String(e?.message || e);
          }
        }
        json(res, 200, result);
      } catch (e) {
        if (e?.code === "NO_LLM_KEY" || String(e?.message) === "NO_LLM_KEY") {
          json(res, 503, {
            error: "NO_LLM_KEY",
            message:
              "未配置 LLM_API_KEY（或 OPENAI_API_KEY）。请在 .env.local 配置后重启 dev。",
          });
          return;
        }
        json(res, 502, { error: String(e?.message || e) });
      }
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
  };
}
