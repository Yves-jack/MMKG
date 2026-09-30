/**
 * 图谱问答 LLM：课堂材料优先，不足时才允许课外知识（需标注）。
 * OpenAI 兼容接口：LLM_API_KEY + LLM_BASE_URL + LLM_MODEL
 */

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

function buildClassroomPack(payload) {
  const points = Array.isArray(payload.points) ? payload.points : [];
  const lines = [];
  lines.push(`课程：${payload.courseId || ""}`);
  lines.push(`讲次：第 ${payload.lectureId || "?"} 讲`);
  if (payload.intent) lines.push(`用户意图偏向：${payload.intent}`);
  lines.push("");
  lines.push("【课堂材料】（来自本讲图谱浓缩与课堂证据，优先依据这些内容回答）");

  for (let i = 0; i < Math.min(points.length, 8); i++) {
    const p = points[i];
    lines.push(`\n### 概念 ${i + 1}: ${p.zh || p.id}`);
    if (p.definition) lines.push(`定义/释义：${clip(p.definition, 600)}`);
    else if (p.summary) lines.push(`摘要：${clip(p.summary, 400)}`);
    const neighbors = Array.isArray(p.neighbors) ? p.neighbors.slice(0, 8) : [];
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
      lines.push("课堂证据：");
      for (const e of evidence) {
        const t =
          e.start_sec != null && Number.isFinite(Number(e.start_sec))
            ? `[${Math.floor(Number(e.start_sec) / 60)}:${String(
                Math.floor(Number(e.start_sec) % 60)
              ).padStart(2, "0")}] `
            : "";
        lines.push(`- ${t}${clip(e.text, 280)}`);
      }
    }
  }

  if (!points.length) {
    lines.push("（本问未命中具体概念；仅有讲次上下文。材料不足时再谨慎补充通用知识。）");
  }

  return lines.join("\n");
}

const SYSTEM = `你是离散数学 / 数理逻辑课程的课堂助教，回答必须「课堂优先」。

硬性规则：
1. 优先且尽量只根据用户提供的【课堂材料】（概念释义、关系边、课堂证据口述）作答。
2. 当课堂材料足够时：不要引入教材外常识；表述应能被材料支撑。
3. 仅当课堂材料明显不足、无法回答关键问题时，才可补充课外知识；补充部分必须单独成段，并以「【课外补充】」开头，且简要说明为何材料不够。
4. 禁止编造「老师原话」或虚假时间戳；可引用材料里已有的时间标记。
5. 用简洁中文；可用条目；数学可用 LaTeX（$...$）。
6. 必须输出 JSON 对象（不要 Markdown 代码围栏），字段：
{
  "answer": "主回答（课堂依据为主）",
  "bullets": ["可选要点，最多4条"],
  "used_extra": false,
  "extra_note": "若 used_extra=true，一句话说明补充了什么；否则空字符串",
  "cited_concepts": ["用到的课堂概念中文名"]
}`;

export async function callLlm(env, messages, opts = {}) {
  const apiKey =
    env.LLM_API_KEY ||
    env.OPENAI_API_KEY ||
    env.DASHSCOPE_API_KEY ||
    env.VITE_LLM_API_KEY ||
    env.VITE_OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("NO_LLM_KEY");
    err.code = "NO_LLM_KEY";
    throw err;
  }

  const base = String(
    env.LLM_BASE_URL ||
      env.OPENAI_BASE_URL ||
      env.DASHSCOPE_BASE_URL ||
      env.VITE_LLM_BASE_URL ||
      "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model =
    env.LLM_MODEL ||
    env.OPENAI_MODEL ||
    env.VITE_LLM_MODEL ||
    "deepseek-v4-flash-0731";

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60000;
  const temperature = opts.temperature != null ? Number(opts.temperature) : 0.2;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        response_format: { type: "json_object" },
        messages,
      }),
    });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!r.ok) {
      // 部分兼容网关不支持 response_format，再试一次
      const msg =
        data?.error?.message || data?.message || text.slice(0, 240) || `HTTP ${r.status}`;
      if (/response_format|json_object|unsupported/i.test(msg)) {
        const r2 = await fetch(`${base}/chat/completions`, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature,
            messages,
          }),
        });
        const text2 = await r2.text();
        let data2 = null;
        try {
          data2 = text2 ? JSON.parse(text2) : null;
        } catch {
          data2 = null;
        }
        if (!r2.ok) {
          throw new Error(
            data2?.error?.message || data2?.message || text2.slice(0, 240) || `HTTP ${r2.status}`
          );
        }
        return {
          content: data2?.choices?.[0]?.message?.content || "",
          model,
          raw: data2,
        };
      }
      throw new Error(msg);
    }
    const content = data?.choices?.[0]?.message?.content || "";
    return { content, model, raw: data };
  } finally {
    clearTimeout(timer);
  }
}

function parseModelJson(content) {
  const raw = String(content || "").trim();
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    return {
      answer: unfenced || raw,
      bullets: [],
      used_extra: /【课外补充】/.test(unfenced),
      extra_note: "",
      cited_concepts: [],
    };
  }
}

export async function runQaChat(payload, env = process.env) {
  const question = String(payload.question || "").trim();
  if (!question) {
    return { error: "empty question" };
  }

  const classroom = buildClassroomPack(payload);
  const history = Array.isArray(payload.history) ? payload.history.slice(-6) : [];

  const messages = [{ role: "system", content: SYSTEM }];
  for (const h of history) {
    if (!h?.text) continue;
    messages.push({
      role: h.role === "user" ? "user" : "assistant",
      content: String(h.text).slice(0, 800),
    });
  }
  messages.push({
    role: "user",
    content: `${classroom}\n\n【学生问题】\n${question}\n\n请按规则用 JSON 回答。`,
  });

  const { content, model } = await callLlm(env, messages);
  const parsed = parseModelJson(content);
  const answer = String(parsed.answer || "").trim();
  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets.map((b) => String(b)).filter(Boolean).slice(0, 4)
    : [];
  const usedExtra = Boolean(parsed.used_extra) || /【课外补充】/.test(answer);
  const extraNote = String(parsed.extra_note || "").trim();

  return {
    answer,
    bullets,
    usedExtra,
    extraNote,
    citedConcepts: Array.isArray(parsed.cited_concepts)
      ? parsed.cited_concepts.map(String).slice(0, 8)
      : [],
    model,
  };
}

export function qaChatMiddleware(env = process.env) {
  return async (req, res, next) => {
    try {
      const rawUrl = String(req.url || "");
      if (!rawUrl.startsWith("/api/qa-chat")) return next();

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
        const result = await runQaChat(payload, env);
        if (result.error) {
          json(res, 400, result);
          return;
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
