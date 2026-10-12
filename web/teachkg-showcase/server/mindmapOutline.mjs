/**
 * 章大纲/总结：读写 summaries；可选用 LLM 把不规则草稿整理成 2–3 级大纲。
 * 亦可落盘章导图 mindmaps/chapter_*.json（persist_mindmap / mindmap 字段）。
 * GET  /api/mindmap-outline?courseId=&chapter=
 * POST /api/mindmap-outline
 *   { courseId, chapter, outline_text, normalize?, incremental?, existing_outline?, mindmap? }
 *   incremental=true（默认在已有大纲时）→ 与已存大纲增量合并
 *   { courseId, chapter, mindmap, persist_mindmap: true }  // 仅写导图
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callLlm } from "./qaLlm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const showcasePublic = path.resolve(__dirname, "../public/data/courses");

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

function chapterFileSlug(chapter) {
  const bare = String(chapter || "")
    .replace(/^第\s*\d+\s*章\s*/, "")
    .trim();
  const base = bare || String(chapter || "chapter");
  return base
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function parseQuery(rawUrl) {
  const q = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
  const params = new URLSearchParams(q);
  return {
    courseId: String(params.get("courseId") || "").trim(),
    chapter: String(params.get("chapter") || "").trim(),
  };
}

const COURSE_SKELETON_KEY = "__course_skeleton__";

function isCourseSkeletonKey(chapter) {
  const s = String(chapter || "").trim();
  return s === COURSE_SKELETON_KEY || s === "course:skeleton";
}

function summaryPaths(courseId, chapter) {
  const course = safeSegment(courseId);
  if (!course) return [];
  if (isCourseSkeletonKey(chapter)) {
    return [
      path.join(repoRoot, "data/viz", courseId, "summaries", "course_skeleton.json"),
      path.join(showcasePublic, courseId, "summaries", "course_skeleton.json"),
    ];
  }
  const slug = chapterFileSlug(chapter);
  if (!slug) return [];
  const name = `chapter_${slug}.json`;
  return [
    path.join(repoRoot, "data/viz", courseId, "summaries", name),
    path.join(showcasePublic, courseId, "summaries", name),
  ];
}

function mindmapPaths(courseId, chapter) {
  const course = safeSegment(courseId);
  if (!course) return [];
  if (isCourseSkeletonKey(chapter)) {
    return [
      path.join(repoRoot, "data/viz", courseId, "mindmaps", "course_skeleton.json"),
      path.join(showcasePublic, courseId, "mindmaps", "course_skeleton.json"),
    ];
  }
  const slug = chapterFileSlug(chapter);
  if (!slug) return [];
  const name = `chapter_${slug}.json`;
  return [
    path.join(repoRoot, "data/viz", courseId, "mindmaps", name),
    path.join(showcasePublic, courseId, "mindmaps", name),
  ];
}

function indexPaths(courseId) {
  const course = safeSegment(courseId);
  if (!course) return [];
  return [
    path.join(repoRoot, "data/viz", courseId, "mindmaps", "index.json"),
    path.join(showcasePublic, courseId, "mindmaps", "index.json"),
  ];
}

function chapterNavId(chapter) {
  return `chapter:${chapter}`;
}

function parseOutlineText(chapter, text, source = "manual") {
  const chapterBare =
    String(chapter || "").replace(/^第\s*\d+\s*章\s*/, "").trim() || chapter;
  const sections = [];
  const edges = [];
  const outline = [];
  let lastSection = null;
  const clean = (s) =>
    String(s || "")
      .replace(/^[-*•·]\s*/, "")
      .replace(/^\d+(?:\.\d+)*[.)、]\s*/, "")
      .trim();

  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const md = raw.match(/^(#{1,4})\s+(.+)$/);
    if (md) {
      const level = md[1].length;
      const title = clean(md[2]);
      if (!title || /^第\s*\d+\s*章/.test(title)) continue;
      if (level <= 2) {
        sections.push({ title, bare: title });
        outline.push(title);
        edges.push({ parent: chapterBare, child: title });
        lastSection = title;
      } else if (lastSection) {
        edges.push({ parent: lastSection, child: title });
      }
      continue;
    }
    const indent = raw.match(/^(\s*)/)?.[1].length || 0;
    const title = clean(raw);
    if (!title || title.length > 40) continue;
    if (indent >= 2 && lastSection) {
      edges.push({ parent: lastSection, child: title });
      continue;
    }
    sections.push({ title, bare: title });
    outline.push(title);
    edges.push({ parent: chapterBare, child: title });
    lastSection = title;
  }
  return {
    chapter,
    source,
    outline,
    edges,
    sections,
    outline_text: text,
    updatedAt: new Date().toISOString(),
  };
}

function outlineTextFromLlmJson(parsed) {
  const lines = [];
  const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
  if (sections.length) {
    for (const s of sections) {
      const title = String(s?.title || s?.name || s?.bare || "").trim();
      if (!title) continue;
      lines.push(title);
      const kids = Array.isArray(s?.children)
        ? s.children
        : Array.isArray(s?.items)
          ? s.items
          : Array.isArray(s?.topics)
            ? s.topics
            : [];
      for (const c of kids) {
        const t = String(
          typeof c === "string" ? c : c?.title || c?.name || ""
        ).trim();
        if (t) lines.push(`  ${t}`);
      }
    }
    return lines.join("\n");
  }
  if (Array.isArray(parsed?.outline) && parsed.outline.length) {
    return parsed.outline.map((x) => String(x).trim()).filter(Boolean).join("\n");
  }
  if (typeof parsed?.outline_text === "string" && parsed.outline_text.trim()) {
    return parsed.outline_text.trim();
  }
  return "";
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
    return null;
  }
}

const COURSE_SKELETON_SYSTEM = `你是课程助教，只整理「整课大纲层级」：章 → 节/一级主题。

任务：从用户草稿中抽出课程结构骨架，用于「骨架展示」思维导图。最外层必须是章。

严格规则：
1. 只保留章名与其下节/一级主题名；不要输出细概念、实体术语列表、例题、公式、证明步骤。
2. 章标题尽量规范为「第N章 …」；若草稿已有章号则保留顺序。
3. 每章下挂 0–12 个节/主题；节标题短（≤16 字），不要再嵌套第三层细节。
4. 不要发明草稿里没有的大块新章；可轻微规范化用词与合并同义节名。
5. 必须输出 JSON（不要 Markdown 围栏）：
{
  "chapters": [
    { "title": "第N章 xxx", "sections": ["主题A", "主题B"] }
  ],
  "notes": "一句说明归纳了哪些层级"
}`;

const COURSE_SKELETON_INCREMENTAL_SYSTEM = `你是课程助教，把「已有整课大纲骨架」与「本次新增/修改」做增量合并。

任务：输出合并后的完整 章→节 骨架（覆盖已有 + 新增）。不要输出实体细节。

合并原则：
1. 以已有章节结构为骨架，无故不删已有章/节。
2. 新内容并入最合适的章；必要时新增少量章或节。
3. 同义去重；标题短；不要细概念叶。
4. 必须输出 JSON：
{
  "chapters": [
    { "title": "第N章 xxx", "sections": ["主题A", "主题B"] }
  ],
  "notes": "一句说明合并了什么"
}`;

function courseSkeletonOutlineTextFromJson(parsed) {
  const chapters = Array.isArray(parsed?.chapters) ? parsed.chapters : [];
  const lines = [];
  for (const ch of chapters) {
    const title = String(ch?.title || "").trim();
    if (!title) continue;
    lines.push(title);
    const secs = Array.isArray(ch?.sections) ? ch.sections : [];
    for (const s of secs) {
      const name =
        typeof s === "string"
          ? String(s).trim()
          : String(s?.title || "").trim();
      if (name) lines.push(`  ${name}`);
    }
    lines.push("");
  }
  if (lines.length) return lines.join("\n").trim();
  if (typeof parsed?.outline_text === "string" && parsed.outline_text.trim()) {
    return parsed.outline_text.trim();
  }
  return "";
}

const NORMALIZE_SYSTEM = `你是课程助教，负责把老师随手写的不规则笔记整理成「章导图骨架」。

任务：从用户草稿中抽取 2–3 级主题大纲，用于思维导图骨架（不是写讲义、不扩写教材）。

层级原则（最重要）：
1. 上一层用「概括性范畴名」，表达这一组在讲什么；禁止把子项简单用「与/和/、/vs」拼成父标题。
   - 差例：父=「有限图与无限图」，子=有限图、无限图
   - 好例：父=「图的分类」或「图的类型」，子=有限图、无限图、有向图、无向图…
2. 子节点尽量是不可再拆的原子概念（单个术语/对象）；若草稿写「A vs B」「A/B」「A、B、C」，应拆成并列原子子节点，而不是保留整句作一个子节点。
3. 在不发明新知识点的前提下，尽量完整覆盖草稿中出现的概念；同义合并可以，漏项不行。
4. 仅当一组并列项可再归纳时，才提升出概括父节点；若某条本身已是概括标题且下列已是原子项，则保持该结构。

其他规则：
5. 只保留概念/主题名，去掉口语、例题过程、公式细节、过长句子。
6. 一级主题宁少勿碎（通常 4–10 个），优先保留草稿的大段分组与顺序；不要把同一条列举拆成多个一级主题。
7. 每个一级主题下挂 0–12 个原子子节点；子节点一般不再嵌套（除非草稿已有明确三级小标题）。
8. 不要发明草稿里完全没有的大块新章节；可轻微规范化用词（如「支撑子图/生成子图」→「生成子图」）。
9. 标题尽量短（父≤12 字，子≤10 字），中文。
10. 必须输出 JSON（不要 Markdown 围栏）：
{
  "sections": [
    { "title": "概括性一级主题", "children": ["原子概念", "..."] }
  ],
  "notes": "一句说明你做了哪些归纳与拆分"
}`;

const INCREMENTAL_SYSTEM = `你是课程助教，负责把「已有章导图大纲」与「本次新增/修改草稿」做增量合并。

任务：输出合并后的完整 2–3 级章导图骨架（覆盖已有 + 新增），不是只输出增量片段。

合并原则：
1. 以已有大纲为骨架：保留合理分组与已有概念，无故删除已有节点。
2. 把本次草稿中的新概念并入最合适的父级；必要时微调父级概括名，或新增少量一级主题。
3. 同义去重（支撑子图/生成子图 → 生成子图）；冲突时优先更规范、更原子的写法。
4. 父级用概括范畴名，禁止「A与B」式拼接；子级尽量是不可再拆的原子概念，并尽量完整。
5. 不要发明两边都未出现的大块新章节；可轻微规范化用词。
6. 标题尽量短（父≤12 字，子≤10 字），中文。
7. 必须输出 JSON（不要 Markdown 围栏）：
{
  "sections": [
    { "title": "概括性一级主题", "children": ["原子概念", "..."] }
  ],
  "notes": "一句说明合并了哪些内容、如何归位"
}`;

async function normalizeOutlineWithLlm(
  env,
  chapter,
  rawText,
  opts = {}
) {
  const draft = String(rawText || "").trim();
  const existing = String(opts.existingOutline || "").trim();
  const incremental = Boolean(opts.incremental) && Boolean(existing);
  const courseSkeleton = Boolean(opts.courseSkeleton) || isCourseSkeletonKey(chapter);

  if (!draft) {
    const err = new Error("empty outline");
    err.code = "EMPTY";
    throw err;
  }

  let system = courseSkeleton ? COURSE_SKELETON_SYSTEM : NORMALIZE_SYSTEM;
  let user;
  if (courseSkeleton) {
    if (incremental) {
      system = COURSE_SKELETON_INCREMENTAL_SYSTEM;
      user = [
        "【已有整课大纲骨架】（章→节）",
        existing.slice(0, 8000),
        "",
        "【本次新增或修改】",
        draft.slice(0, 8000),
        "",
        "请输出合并后的完整 章→节 JSON。不要输出细概念。",
      ].join("\n");
    } else {
      user = [
        "【老师草稿 / 课程大纲素材】",
        draft.slice(0, 8000),
        "",
        "请整理成整课 章→节 骨架 JSON。最外层是章；不要细概念。",
      ].join("\n");
    }
  } else if (incremental) {
    system = INCREMENTAL_SYSTEM;
    user = [
      `课程章名：${chapter}`,
      "",
      "【已有章大纲】（请保留合理结构与已有概念）",
      existing.slice(0, 8000),
      "",
      "【本次新增或修改】（并入上面的大纲；去重；可调整归纳）",
      draft.slice(0, 8000),
      "",
      "请输出合并后的完整章导图骨架 JSON。",
    ].join("\n");
  } else {
    user = [
      `课程章名：${chapter}`,
      "",
      "【老师草稿 / 不规则知识点列举】",
      draft.slice(0, 8000),
      "",
      "请整理成章导图骨架 JSON。",
      "注意：父级用概括范畴名（勿拼接子项）；子级拆成尽量完整的原子概念列表。",
    ].join("\n");
  }

  const { content, model } = await callLlm(
    env,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.2, timeoutMs: 90000 }
  );
  const parsed = parseModelJson(content);
  const outline_text = courseSkeleton
    ? courseSkeletonOutlineTextFromJson(parsed || {})
    : outlineTextFromLlmJson(parsed || {});
  if (!outline_text.trim()) {
    const err = new Error("LLM 未返回可用大纲");
    err.code = "BAD_LLM";
    err.raw = String(content || "").slice(0, 500);
    throw err;
  }
  return {
    outline_text,
    notes: String(parsed?.notes || "").trim(),
    model,
    raw_draft: draft,
    incremental,
    existing_outline: incremental ? existing : undefined,
    chapters: courseSkeleton ? parsed?.chapters : undefined,
    course_skeleton: courseSkeleton,
  };
}

function readSummary(courseId, chapter) {
  for (const p of summaryPaths(courseId, chapter)) {
    if (!fs.existsSync(p)) continue;
    try {
      return {
        ...JSON.parse(fs.readFileSync(p, "utf8")),
        path: path.relative(repoRoot, p).replace(/\\/g, "/"),
      };
    } catch {
      /* continue */
    }
  }
  return null;
}

function writeSummary(courseId, chapter, doc) {
  const written = [];
  for (const p of summaryPaths(courseId, chapter)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n", "utf8");
    written.push(path.relative(repoRoot, p).replace(/\\/g, "/"));
  }
  return written;
}

function writeMindmapDoc(courseId, chapter, mindmap) {
  if (isCourseSkeletonKey(chapter)) {
    const relPath = "mindmaps/course_skeleton.json";
    const doc = {
      ...mindmap,
      lecture_id: "course:skeleton",
      meta: {
        ...(mindmap?.meta || {}),
        scope: "course",
        skeleton_view: true,
        virtual_root: true,
      },
    };
    const written = [];
    for (const p of mindmapPaths(courseId, chapter)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n", "utf8");
      written.push(path.relative(repoRoot, p).replace(/\\/g, "/"));
    }
    return { written, path: relPath, doc };
  }

  const slug = chapterFileSlug(chapter);
  const relPath = `mindmaps/chapter_${slug}.json`;
  const doc = {
    ...mindmap,
    lecture_id: mindmap?.lecture_id || chapterNavId(chapter),
    meta: {
      ...(mindmap?.meta || {}),
      chapter: mindmap?.meta?.chapter || chapter,
      scope: "chapter",
      root_zh: mindmap?.meta?.root_zh || chapter,
      virtual_root: true,
    },
  };
  const written = [];
  for (const p of mindmapPaths(courseId, chapter)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n", "utf8");
    written.push(path.relative(repoRoot, p).replace(/\\/g, "/"));
  }

  // 同步 index 条目元数据（存在才改，不造整课索引）
  for (const ip of indexPaths(courseId)) {
    if (!fs.existsSync(ip)) continue;
    try {
      const idx = JSON.parse(fs.readFileSync(ip, "utf8"));
      if (!Array.isArray(idx.items)) continue;
      const nav = chapterNavId(chapter);
      let hit = false;
      idx.items = idx.items.map((it) => {
        if (
          it.lecture_id === nav ||
          (it.scope === "chapter" && it.chapter === chapter)
        ) {
          hit = true;
          return {
            ...it,
            lecture_id: nav,
            chapter,
            chapter_id: chapter,
            root_zh: doc.meta?.root_zh || chapter,
            n_nodes: doc.n_nodes ?? it.n_nodes,
            max_depth: doc.max_depth ?? it.max_depth,
            orphan_count: doc.orphan_count ?? it.orphan_count,
            path: relPath,
            scope: "chapter",
            lecture_ids: doc.meta?.lecture_ids || it.lecture_ids || [],
            source: doc.meta?.source || it.source || "summary+kg",
          };
        }
        return it;
      });
      if (!hit) {
        idx.items.push({
          lecture_id: nav,
          chapter,
          chapter_id: chapter,
          root_zh: doc.meta?.root_zh || chapter,
          n_nodes: doc.n_nodes || 0,
          max_depth: doc.max_depth || 0,
          orphan_count: doc.orphan_count || 0,
          path: relPath,
          scope: "chapter",
          lecture_ids: doc.meta?.lecture_ids || [],
          source: doc.meta?.source || "summary+kg",
        });
      }
      fs.writeFileSync(ip, JSON.stringify(idx, null, 2) + "\n", "utf8");
      written.push(path.relative(repoRoot, ip).replace(/\\/g, "/"));
    } catch {
      /* ignore index sync errors */
    }
  }
  return { written, path: relPath, doc };
}

export function mindmapOutlineMiddleware(env = process.env) {
  return async function mindmapOutlineMw(req, res, next) {
    try {
      const rawUrl = String(req.url || "");
      if (!rawUrl.startsWith("/api/mindmap-outline")) return next();

      if (req.method === "GET") {
        const { courseId, chapter } = parseQuery(rawUrl);
        if (!courseId || !chapter) {
          return json(res, 400, { error: "courseId and chapter required" });
        }
        const doc = readSummary(courseId, chapter);
        if (!doc) {
          return json(res, 200, {
            courseId,
            chapter,
            source: null,
            outline_text: "",
            outline: [],
            edges: [],
            sections: [],
            empty: true,
          });
        }
        const outline_text =
          doc.outline_text ||
          (Array.isArray(doc.outline) ? doc.outline.join("\n") : "") ||
          (Array.isArray(doc.sections)
            ? doc.sections
                .map((s) => s.title || s.bare)
                .filter(Boolean)
                .join("\n")
            : "");
        return json(res, 200, {
          courseId,
          chapter,
          ...doc,
          outline_text,
          empty: false,
        });
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        const courseId = String(body.courseId || "").trim();
        const chapter = String(body.chapter || "").trim();
        let outline_text = String(body.outline_text ?? body.text ?? "");
        const normalize = Boolean(body.normalize);
        const mindmap = body.mindmap && typeof body.mindmap === "object" ? body.mindmap : null;
        const persistMindmap = Boolean(body.persist_mindmap) || Boolean(mindmap);
        if (!courseId || !chapter) {
          return json(res, 400, { error: "courseId and chapter required" });
        }

        // 仅落盘章导图（大纲已在先前请求写过）
        if (mindmap && !outline_text.trim() && (body.persist_mindmap || body.mindmap_only)) {
          const mm = writeMindmapDoc(courseId, chapter, mindmap);
          return json(res, 200, {
            ok: true,
            courseId,
            chapter,
            written_mindmap: mm.written,
            path: mm.path,
            mindmap_only: true,
          });
        }

        if (!outline_text.trim()) {
          return json(res, 400, { error: "outline_text required" });
        }

        let llmMeta = null;
        let source = "manual";
        if (normalize) {
          try {
            const existingDoc = readSummary(courseId, chapter);
            const existingOutline = String(
              body.existing_outline ??
                existingDoc?.outline_text ??
                (Array.isArray(existingDoc?.outline)
                  ? existingDoc.outline.join("\n")
                  : "") ??
                ""
            ).trim();
            // 默认：有已存大纲则增量；body.incremental === false 时全新整理
            const wantIncremental =
              body.incremental === undefined || body.incremental === null
                ? Boolean(existingOutline)
                : Boolean(body.incremental);
            llmMeta = await normalizeOutlineWithLlm(env, chapter, outline_text, {
              incremental: wantIncremental,
              existingOutline,
              courseSkeleton: isCourseSkeletonKey(chapter) || Boolean(body.course_skeleton),
            });
            outline_text = llmMeta.outline_text;
            source = "manual_llm";
          } catch (e) {
            if (e?.code === "NO_LLM_KEY") {
              return json(res, 503, {
                error: "未配置 LLM_API_KEY，无法 AI 整理；可直接保存原文大纲",
                code: "NO_LLM_KEY",
              });
            }
            return json(res, 502, {
              error: String(e?.message || e),
              code: e?.code || "LLM_FAIL",
            });
          }
        }

        const doc = isCourseSkeletonKey(chapter)
          ? {
              courseId,
              chapter: COURSE_SKELETON_KEY,
              source,
              outline_text,
              chapters: llmMeta?.chapters || undefined,
              raw_draft: llmMeta?.raw_draft || undefined,
              llm_notes: llmMeta?.notes || undefined,
              llm_model: llmMeta?.model || undefined,
              incremental: llmMeta?.incremental || false,
              course_skeleton: true,
            }
          : {
              ...parseOutlineText(chapter, outline_text, source),
              raw_draft: llmMeta?.raw_draft || undefined,
              llm_notes: llmMeta?.notes || undefined,
              llm_model: llmMeta?.model || undefined,
              incremental: llmMeta?.incremental || false,
            };
        const written = writeSummary(courseId, chapter, doc);
        let written_mindmap = null;
        let mindmap_path = null;
        if (persistMindmap && mindmap) {
          const mm = writeMindmapDoc(courseId, chapter, mindmap);
          written_mindmap = mm.written;
          mindmap_path = mm.path;
        }
        return json(res, 200, {
          ok: true,
          courseId,
          chapter,
          ...doc,
          written,
          written_mindmap,
          path: mindmap_path,
          normalized: Boolean(normalize),
          incremental: Boolean(llmMeta?.incremental),
          rebuildHint: mindmap ? "saved" : "client",
        });
      }

      return json(res, 405, { error: "method not allowed" });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  };
}
