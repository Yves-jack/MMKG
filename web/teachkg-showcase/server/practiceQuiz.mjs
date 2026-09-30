/**
 * 巩固练习：用 LLM 把课堂材料做成更像作业/测验的选择题，并给出详细解析。
 */
import { callLlm } from "./qaLlm.mjs";

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

function clip(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + "…";
}

/** 规范化选项文本，便于比对 */
function normOpt(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[《》「」""'']/g, "")
    .toLowerCase();
}

/**
 * 严格对齐「锁定正确答案」与选项。
 * 禁止短串 includes（避免「图」误命中「有向图」）。
 */
function resolveAnswerIndex(options, locked) {
  const list = (options || []).map((o) => String(o ?? "").trim());
  const y = normOpt(locked);
  if (!y || !list.length) return -1;

  let hit = list.findIndex((o) => normOpt(o) === y);
  if (hit >= 0) return hit;

  // 允许「合取」vs「合取/conjunction」或「合取（AND）」这类扩展，但不允许反向误伤
  hit = list.findIndex((o) => {
    const x = normOpt(o);
    if (!x) return false;
    if (x.startsWith(y) && (x.length === y.length || !/[\u4e00-\u9fffa-z0-9]/.test(x[y.length] || ""))) {
      return y.length >= 2;
    }
    if (x.includes("/") && x.split("/")[0] === y) return true;
    return false;
  });
  return hit;
}

const SYSTEM = `你是高校「离散数学 / 数理逻辑」课程的资深出题与阅卷教师。
任务：优先依据【本讲学习笔记】（复习页分主题笔记），必要时参考图谱材料，为每道种子题重新命制一道高质量四选一选择题，并撰写可供学生自学的详细解析。

质量标准（必须遵守）：
1. 知识只能来自材料；禁止编造材料未出现的定义、定理、关系。笔记与图谱冲突时，以笔记的主题讲解与要点为准。
2. 题干要像期末测验：完整、书面、可独立作答。禁止图谱腔（如 belong_to、存在「xx」关系的是、entityId）。可自然体现笔记中的主题名/一句话概括，但不要出现「根据笔记第x条」这类元话语。
3. 优先题型（按笔记选一种，勿千篇一律）：
   - 定义再认：用笔记中的释义/要点改写成严谨描述，问对应概念
   - 主题辨析：围绕同一主题下易混关键词出题
   - 关系判断：笔记或材料中出现的结构关系
4. 选项必须是 4 个短概念名（不要整句对错判断句）；其中恰好一个等于「锁定正确答案」原文（可加括号英文别名，但中文核心名必须一致）。
5. 干扰项优先选自同主题其它关键词或本讲邻近概念，禁止明显无关凑数；四个选项长度风格接近。
6. answerIndex 必须是锁定正确答案在 options 中的下标（0-3）。
7. 难度 easy/medium/hard 要名副其实。
8. explain：1–2 句点明考点与答案。
9. explainDetail 分点：【考点】【正确答案】【解析】【干扰项】；解析应回扣笔记表述。
10. 只输出 JSON（不要 Markdown 围栏）：
{
  "items": [
    {
      "id": "与输入相同",
      "prompt": "题干",
      "options": ["","","",""],
      "answerIndex": 0,
      "difficulty": "medium",
      "explain": "简要解析",
      "explainDetail": "详细解析"
    }
  ]
}`;

function parseJson(content) {
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

function packBatch(payload, items) {
  const lines = [];
  lines.push(`课程：${payload.courseId || ""}`);
  lines.push(`本批 ${items.length} 道题。请逐题依据学习笔记重写为高质量测验题。`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const correct =
      it.correctAnswer || (it.options || [])[it.answerIndex];
    lines.push(`\n### 题 ${i + 1}`);
    lines.push(`id: ${it.id}`);
    lines.push(`题型意图: ${it.type === "relation" ? "关系/结构" : "定义/辨析"}`);
    lines.push(`讲次: 第 ${it.lectureId || "?"} 讲`);
    lines.push(`核心概念: ${it.entityZh || it.entityId || ""}`);
    lines.push(`锁定正确答案: ${correct}`);
    lines.push(`参考题干(可大幅改写): ${clip(it.prompt, 220)}`);
    lines.push(
      `候选干扰项池: ${(it.options || [])
        .filter((_, j) => j !== it.answerIndex)
        .join("、")}`
    );
    if (it.context) {
      if (it.context.lectureOverview) {
        lines.push(`笔记·本讲总览: ${clip(it.context.lectureOverview, 280)}`);
      }
      const themes = Array.isArray(it.context.lectureThemes)
        ? it.context.lectureThemes.slice(0, 6)
        : [];
      if (themes.length) lines.push(`笔记·主题地图: ${themes.join("｜")}`);
      if (it.context.noteTheme) {
        lines.push(
          `笔记·所属主题: ${it.context.noteTheme}${
            it.context.noteOneLiner ? `（${clip(it.context.noteOneLiner, 80)}）` : ""
          }`
        );
      }
      if (it.context.noteSummary) {
        lines.push(`笔记·主题摘要: ${clip(it.context.noteSummary, 240)}`);
      }
      if (it.context.noteBody) {
        lines.push(`笔记·主题精讲: ${clip(it.context.noteBody, 700)}`);
      }
      const bullets = Array.isArray(it.context.noteBullets)
        ? it.context.noteBullets.slice(0, 8)
        : [];
      if (bullets.length) lines.push(`笔记·要点: ${bullets.join("；")}`);
      const tips = Array.isArray(it.context.noteTips) ? it.context.noteTips.slice(0, 4) : [];
      if (tips.length) lines.push(`笔记·技巧: ${tips.join("；")}`);
      lines.push(`材料·释义: ${clip(it.context.definition || "", 520)}`);
      if (it.context.summary && it.context.summary !== it.context.definition) {
        lines.push(`材料·摘要: ${clip(it.context.summary, 240)}`);
      }
      const rels = Array.isArray(it.context.relations) ? it.context.relations.slice(0, 8) : [];
      if (rels.length) lines.push(`材料·关系: ${rels.join("；")}`);
      const ev = Array.isArray(it.context.evidence) ? it.context.evidence.slice(0, 2) : [];
      if (ev.length) lines.push(`材料·课堂表述: ${ev.map((e) => clip(e, 160)).join(" / ")}`);
      const near = Array.isArray(it.context.nearConcepts) ? it.context.nearConcepts.slice(0, 8) : [];
      if (near.length) lines.push(`同讲易混/邻近概念: ${near.join("、")}`);
    }
  }
  lines.push("\n请输出完整 JSON。");
  return lines.join("\n");
}

function normalizeItems(parsed, seeds) {
  const byId = new Map((seeds || []).map((s) => [String(s.id), s]));
  const list = Array.isArray(parsed?.items) ? parsed.items : [];
  const usedSeed = new Set();
  const out = [];

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const id = String(raw?.id || "");
    let seed = byId.get(id);
    if (!seed && seeds[i] && !usedSeed.has(seeds[i].id)) seed = seeds[i];
    if (!seed) seed = seeds.find((s) => !usedSeed.has(s.id));
    if (!seed) continue;
    usedSeed.add(seed.id);

    const locked = String(
      seed.correctAnswer || seed.options[seed.answerIndex] || ""
    ).trim();
    let options = Array.isArray(raw.options)
      ? raw.options.map((o) => String(o).trim())
      : [];
    if (options.length !== 4 || new Set(options).size < 4) {
      options = [...seed.options];
    }

    let answerIndex = resolveAnswerIndex(options, locked);
    if (answerIndex < 0) {
      // 对不齐则整组回退种子选项，保证判分正确
      options = [...seed.options];
      answerIndex = resolveAnswerIndex(options, locked);
      if (answerIndex < 0) answerIndex = seed.answerIndex;
    }

    const diff = String(raw.difficulty || seed.difficulty || "medium").toLowerCase();
    const difficulty = ["easy", "medium", "hard"].includes(diff) ? diff : "medium";
    const prompt = String(raw.prompt || seed.prompt).trim() || seed.prompt;
    let explain = String(raw.explain || "").trim();
    let explainDetail = String(raw.explainDetail || "").trim();

    if (explain.length < 12) explain = seed.explain || explain;
    if (explainDetail.length < 40) {
      explainDetail =
        seed.explainDetail ||
        [
          `【考点】${seed.entityZh || ""}`,
          `【正确答案】${locked}`,
          `【解析】${explain || seed.explain || ""}`,
          `【干扰项】其余选项与题干特征不符，注意与「${locked}」区分。`,
        ].join("\n");
    }

    if (locked && !explainDetail.includes(String(locked).slice(0, Math.min(6, locked.length)))) {
      explainDetail = `【正确答案】${locked}\n${explainDetail}`;
    }

    out.push({
      ...seed,
      prompt,
      options,
      answerIndex,
      correctAnswer: locked,
      difficulty,
      explain,
      explainDetail,
      polished: true,
    });
  }

  return seeds.map((s) => {
    const hit = out.find((x) => x.id === s.id);
    if (hit) return hit;
    const locked = String(s.correctAnswer || s.options[s.answerIndex] || "").trim();
    return {
      ...s,
      correctAnswer: locked,
      answerIndex: resolveAnswerIndex(s.options, locked) >= 0
        ? resolveAnswerIndex(s.options, locked)
        : s.answerIndex,
      polished: false,
    };
  });
}

async function polishBatch(payload, batch, env) {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: packBatch(payload, batch) },
  ];
  const { content, model } = await callLlm(env, messages, {
    timeoutMs: 100000,
    temperature: 0.28,
  });
  const parsed = parseJson(content);
  if (!parsed) {
    const err = new Error("invalid_json");
    err.raw = String(content || "").slice(0, 400);
    throw err;
  }
  return { items: normalizeItems(parsed, batch), model };
}

export async function runPracticeQuiz(payload, env = process.env) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return { error: "empty items" };

  // 小批量出题，质量明显好于一次塞十题
  const size = 4;
  const merged = [];
  let model = "";
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    try {
      const part = await polishBatch(payload, batch, env);
      merged.push(...part.items);
      model = part.model || model;
    } catch (e) {
      // 单批失败则保留本地种子，不拖垮整组
      merged.push(...batch.map((s) => ({ ...s, polished: false })));
      if (!model && e?.message) {
        /* continue */
      }
    }
  }

  const byId = new Map(merged.map((x) => [x.id, x]));
  const ordered = items.map((s) => byId.get(s.id) || { ...s, polished: false });
  if (!ordered.some((x) => x.polished)) {
    return { error: "polish_failed", items: ordered };
  }
  return { items: ordered, model };
}

export function practiceQuizMiddleware(env = process.env) {
  return async (req, res, next) => {
    try {
      const rawUrl = String(req.url || "");
      if (!rawUrl.startsWith("/api/practice-quiz")) return next();

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "POST only" });
        return;
      }

      const payload = await readBody(req);
      try {
        const result = await runPracticeQuiz(payload, env);
        if (result.error && result.error === "empty items") {
          json(res, 400, result);
          return;
        }
        if (result.error && !result.items?.some((x) => x.polished)) {
          json(res, 502, result);
          return;
        }
        json(res, 200, result);
      } catch (e) {
        if (e?.code === "NO_LLM_KEY" || String(e?.message) === "NO_LLM_KEY") {
          json(res, 503, {
            error: "NO_LLM_KEY",
            message: "未配置 LLM_API_KEY",
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
