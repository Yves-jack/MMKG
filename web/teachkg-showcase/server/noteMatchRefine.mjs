/**
 * 课次笔记 × 章导图：初步匹配 → LLM 剔除非主要内容 → 落盘 prelim / final
 *
 * 用法（容器内）：
 *   node server/noteMatchRefine.mjs [--only 1_2,3_4] [--limit N] [--skip-llm]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callLlm } from "./qaLlm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const COURSE =
  process.env.COURSE_ID || "离散数学(图论+数理逻辑与集合论)";

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] || null;
}

const ONLY = new Set(
  String(argVal("--only") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const LIMIT = Number(argVal("--limit") || 0) || 0;
const SKIP_LLM = process.argv.includes("--skip-llm");

function coursePublicDir(courseId) {
  return path.join(
    __dirname,
    "../public/data/courses",
    courseId
  );
}

function notesCacheDir(courseId) {
  return path.join(__dirname, "../.review_notes_cache", courseId);
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function cloneNode(n) {
  return {
    ...n,
    children: (n.children || []).map(cloneNode),
  };
}

function countNodes(n) {
  return 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
}

function depthOf(n, d = 0) {
  let m = d;
  for (const c of n.children || []) m = Math.max(m, depthOf(c, d + 1));
  return m;
}

function docForest(doc) {
  if (doc?.roots?.length) return doc.roots;
  if (doc?.root) return [doc.root];
  return [];
}

function normMatchKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[/\-·•,_，、]/g, "");
}

function collectLectureMatchKeys(terms) {
  const out = [];
  const seen = new Set();
  for (const raw of terms) {
    const k = normMatchKey(raw);
    if (!k || k.length < 2) continue;
    if (/^片段\d*$/.test(k) || /好那么刚才|无有效口播/.test(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function extractPhrasesFromNoteText(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const out = [];
  const push = (s) => {
    const x = String(s || "").trim();
    if (x.length < 2 || x.length > 16) return;
    if (/^[0-9.]+$/.test(x)) return;
    out.push(x);
  };
  for (const m of t.matchAll(/[「『“"]([^」』”"]{2,16})[」』”"]/g)) push(m[1]);
  for (const m of t.matchAll(
    /(?:称为|叫做|又称|即|记作|写作)\s*([A-Za-z\u4e00-\u9fff¬∧∨→↔∀∃]{1,16})/g
  )) {
    push(m[1]);
  }
  for (const m of t.matchAll(
    /([\u4e00-\u9fff]{2,12})\s*[（(][^）)]{0,12}[）)]/g
  )) {
    push(m[1]);
  }
  return out;
}

function appendNoteCorpus(parts, ...chunks) {
  for (const c of chunks) {
    const s = String(c || "").trim();
    if (s.length >= 2) parts.push(s);
  }
}

function notesToCorpus(doc) {
  if (!doc || typeof doc !== "object") return { phrases: [], corpus: "" };
  const phrases = [];
  const corpusParts = [];
  appendNoteCorpus(corpusParts, doc.overview, doc.subtitle, doc.title);
  if (Array.isArray(doc.outline)) {
    for (const o of doc.outline) {
      phrases.push(String(o || ""));
      appendNoteCorpus(corpusParts, o);
    }
  }
  for (const raw of Array.isArray(doc.sections) ? doc.sections : []) {
    const s = raw || {};
    phrases.push(String(s.title || ""));
    appendNoteCorpus(
      corpusParts,
      s.title,
      s.summary,
      s.body,
      ...(Array.isArray(s.bullets) ? s.bullets : []),
      ...(Array.isArray(s.tips) ? s.tips : [])
    );
    for (const b of Array.isArray(s.blocks) ? s.blocks : []) {
      appendNoteCorpus(corpusParts, b?.label, b?.text);
      phrases.push(...extractPhrasesFromNoteText(String(b?.text || "")));
    }
    phrases.push(
      ...extractPhrasesFromNoteText(
        [s.summary, s.body].filter(Boolean).join("\n")
      )
    );
  }
  return { phrases, corpus: corpusParts.join("\n") };
}

function loadSignal(courseId, lids, sessionId) {
  const order = [];
  const seen = new Set();
  const noteParts = [];
  const pushUnique = (...keys) => {
    for (const raw of keys) {
      const k = String(raw || "").trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      order.push(k);
    }
  };

  const publicDir = coursePublicDir(courseId);
  for (const lid of lids) {
    const rev = readJson(path.join(publicDir, `review/lecture_${lid}.json`));
    if (!rev) continue;
    for (const p of Array.isArray(rev.points) ? rev.points : []) {
      pushUnique(String(p?.id || ""), String(p?.zh || ""));
      const def = String(p?.definition || "");
      const sum = String(p?.summary || "");
      if (def || sum) {
        appendNoteCorpus(noteParts, def, sum);
        for (const ph of extractPhrasesFromNoteText(`${sum}\n${def}`)) {
          pushUnique(ph);
        }
      }
    }
    for (const seg of Array.isArray(rev.segments) ? rev.segments : []) {
      const title = String(seg?.title || "").trim();
      if (title.length < 2 || title.length > 24) continue;
      if (/^片段\s*\d+$/.test(title) || /好，|那么|刚才/.test(title)) continue;
      pushUnique(title);
      appendNoteCorpus(noteParts, title);
    }
  }

  const noteIds = [
    ...lids.map(String),
    sessionId ? String(sessionId) : "",
    lids.length >= 2 ? `${lids[0]}_${lids[1]}` : "",
  ].filter(Boolean);
  const cacheRoot = notesCacheDir(courseId);
  for (const nid of [...new Set(noteIds)]) {
    const doc = readJson(path.join(cacheRoot, `${nid}.json`));
    // 与前端 LECTURE_NOTES_VERSION 对齐；兼容上一版 v10
    const ver = Number(doc?.version);
    if (!doc || (ver !== 11 && ver !== 10)) continue;
    if (!Array.isArray(doc.sections) || !doc.sections.length) continue;
    const peeked = notesToCorpus(doc);
    appendNoteCorpus(noteParts, peeked.corpus);
    for (const ph of peeked.phrases) pushUnique(ph);
    for (const ph of extractPhrasesFromNoteText(peeked.corpus)) pushUnique(ph);
  }

  return {
    order,
    noteCorpus: noteParts.join("\n").trim() || "",
  };
}

function nodeMatchScore(node, keys, noteCorpusNorm) {
  const zh = normMatchKey(node.zh || "");
  const idTail = normMatchKey(
    String(node.id || "")
      .split("/")
      .filter(Boolean)
      .slice(-1)[0] || ""
  );
  if (!zh && !idTail) return 0;
  let best = 0;
  if (noteCorpusNorm && zh.length >= 2 && noteCorpusNorm.includes(zh)) {
    best = Math.max(best, zh.length >= 4 ? 9 : 7);
  }
  for (const k of keys) {
    if (!k) continue;
    if (zh === k || idTail === k) best = Math.max(best, 10);
    else if (zh.includes(k) || k.includes(zh)) {
      const shorter = Math.min(zh.length, k.length);
      const longer = Math.max(zh.length || 1, k.length);
      if (shorter >= 2 && shorter / longer >= 0.45) {
        best = Math.max(best, shorter >= 4 ? 8 : 6);
      }
    } else if (idTail && (idTail.includes(k) || k.includes(idTail))) {
      best = Math.max(best, 5);
    }
  }
  return best;
}

function extractMatchingSubtree(root, matchTerms, opts = {}) {
  const keys = collectLectureMatchKeys(matchTerms);
  const noteCorpusNorm = opts.noteCorpus ? normMatchKey(opts.noteCorpus) : "";
  if (!keys.length && !noteCorpusNorm) return null;
  const minScore = opts.minScore ?? 6;

  const walk = (node) => {
    const kids = node.children || [];
    const kept = [];
    let childHits = 0;
    for (const c of kids) {
      const sub = walk(c);
      if (!sub) continue;
      kept.push(sub.node);
      if (sub.hit) childHits += 1;
    }
    const selfScore = nodeMatchScore(node, keys, noteCorpusNorm);
    const selfHit = selfScore >= minScore;
    const isVirtual = String(node.id || "").startsWith("__");
    if (isVirtual && String(node.id).startsWith("__chapter__/")) {
      if (!kept.length) return null;
      return {
        node: {
          ...cloneNode(node),
          children: kept,
          weak: kept.length < kids.length ? true : node.weak,
        },
        hit: true,
      };
    }
    if (!selfHit && !kept.length) return null;
    const incomplete =
      kids.length > 0 && kept.length > 0 && kept.length < kids.length;
    const children = selfHit && !kept.length ? [] : kept;
    return {
      node: {
        ...cloneNode(node),
        children,
        weak:
          incomplete ||
          (selfHit && kids.length > 0 && !kept.length) ||
          node.weak,
      },
      hit: selfHit || childHits > 0,
    };
  };

  return walk(root)?.node || null;
}

function findChapterItemsForLectures(items, lectureIds) {
  const want = new Set(lectureIds.map(String));
  const chapters = items.filter(
    (i) => i.scope === "chapter" || String(i.lecture_id).startsWith("chapter:")
  );
  const hit = chapters.filter((ch) =>
    (ch.lecture_ids || []).some((lid) => want.has(String(lid)))
  );
  if (hit.length) return hit;
  return [];
}

function loadChapterDoc(courseId, item) {
  const p =
    item.path ||
    `mindmaps/chapter_${chapterFileSlug(item.chapter || item.root_zh || "")}.json`;
  return readJson(path.join(coursePublicDir(courseId), p));
}

function scoreChapterAgainstTerms(doc, matchTerms, noteCorpus) {
  const keys = collectLectureMatchKeys(matchTerms);
  const noteCorpusNorm = noteCorpus ? normMatchKey(noteCorpus) : "";
  if (!keys.length && !noteCorpusNorm) return 0;
  const root = docForest(doc)[0];
  if (!root) return 0;
  let score = 0;
  const walk = (n) => {
    score += nodeMatchScore(n, keys, noteCorpusNorm);
    for (const c of n.children || []) walk(c);
  };
  walk(root);
  return score;
}

function sliceChaptersForLectures(chapters, lids, opts) {
  const matchKeys = collectLectureMatchKeys(opts.matchTerms || []);
  const noteCorpus = String(opts.noteCorpus || "").trim();
  const hasMatchSignal = matchKeys.length > 0 || noteCorpus.length > 0;
  const minNodes = opts.minNodes ?? 3;
  const matchOpts = { noteCorpus: noteCorpus || undefined };
  const pieces = [];

  for (const { chapter, doc } of chapters) {
    const root = docForest(doc)[0];
    if (!root) continue;
    let piece = null;
    if (hasMatchSignal) {
      const matched = extractMatchingSubtree(root, matchKeys, matchOpts);
      if (matched && countNodes(matched) >= 2) piece = matched;
    }
    if (!piece) continue;
    if (!String(piece.id || "").startsWith("__chapter__/")) {
      piece = {
        id: `__chapter__/${chapter}`,
        zh: chapter,
        importance: 0.7,
        relation: "toc_chapter",
        related: [],
        children: piece.children?.length
          ? piece.children
          : piece.id?.startsWith("__")
            ? []
            : [piece],
        weak: piece.weak,
      };
    } else {
      piece = { ...piece, zh: chapter };
    }
    pieces.push(piece);
  }
  if (!pieces.length) return null;

  const sessionId =
    opts.sessionId ||
    (lids.length === 2 ? `${lids[0]}_${lids[1]}` : lids[0] || "session");
  const nums = lids.map(Number).filter((n) => n > 0);
  const sessIdx = Math.ceil(Math.min(...nums) / 2) || 1;
  const label = `第 ${sessIdx} 次课`;
  // 单章/多章均保留 __chapter__ 壳，树上可见章节名称
  const root = {
    id: `__lecture__/${sessionId}`,
    zh: label,
    importance: 0.6,
    relation: null,
    related: [],
    children: pieces,
  };
  const n_nodes = countNodes(root);
  if (n_nodes < minNodes) return null;
  return {
    lecture_id: sessionId,
    root,
    roots: [root],
    n_nodes,
    max_depth: depthOf(root),
    orphan_count: 0,
    meta: {
      root_zh: label,
      virtual_root: true,
      scope: "lecture",
      lecture_ids: lids.map(String),
      source: "review+kg",
      n_trees: 1,
      composed_from: "chapter_slice",
      pipeline: "note_match_prelim_v1",
      note_match: {
        stage: "prelim",
        session_id: sessionId,
      },
    },
  };
}

function buildPrelim(courseId, lids, sessionId) {
  const index = readJson(
    path.join(coursePublicDir(courseId), "mindmaps/index.json")
  );
  const items = index?.items || [];
  const signal = loadSignal(courseId, lids, sessionId);
  const matchTerms = signal.order || [];
  const noteCorpus = signal.noteCorpus || "";

  let chapterItems = findChapterItemsForLectures(items, lids);
  const loaded = [];
  for (const it of chapterItems) {
    const doc = loadChapterDoc(courseId, it);
    if (!doc) continue;
    loaded.push({ chapter: String(it.chapter || ""), doc });
  }

  const scoreAllChapters = () => {
    const allChapterItems = items.filter(
      (i) => i.scope === "chapter" || String(i.lecture_id).startsWith("chapter:")
    );
    const scored = [];
    for (const it of allChapterItems) {
      const doc = loadChapterDoc(courseId, it);
      if (!doc) continue;
      const chapter = String(it.chapter || it.root_zh || "");
      const score = scoreChapterAgainstTerms(doc, matchTerms, noteCorpus);
      if (score > 0) scored.push({ chapter, doc, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  };

  // lecture_ids 命中后仍用笔记打分过滤，避免错挂讲次导致串章（如 28→命题逻辑）
  if (loaded.length && (matchTerms.length || noteCorpus)) {
    const global = scoreAllChapters();
    const top = global[0]?.score || 0;
    const kept = [];
    for (const row of loaded) {
      const score = scoreChapterAgainstTerms(row.doc, matchTerms, noteCorpus);
      if (score >= Math.max(12, top * 0.22)) {
        kept.push({ ...row, score });
      }
    }
    loaded.length = 0;
    if (kept.length) {
      kept.sort((a, b) => b.score - a.score);
      for (const k of kept.slice(0, 4)) {
        loaded.push({ chapter: k.chapter, doc: k.doc });
      }
    } else if (top > 0) {
      for (const s of global
        .filter((x) => x.score >= Math.max(20, top * 0.35))
        .slice(0, 4)) {
        loaded.push({ chapter: s.chapter, doc: s.doc });
      }
    }
  }

  if (!loaded.length && (matchTerms.length || noteCorpus)) {
    const scored = scoreAllChapters();
    const top = scored[0]?.score || 0;
    for (const s of scored
      .filter((x) => x.score >= Math.max(20, top * 0.35))
      .slice(0, 4)) {
      loaded.push({ chapter: s.chapter, doc: s.doc });
    }
  }

  if (!loaded.length) return { prelim: null, signal };
  const prelim = sliceChaptersForLectures(loaded, lids, {
    matchTerms,
    noteCorpus,
    sessionId,
    minNodes: 3,
  });
  return { prelim, signal };
}

function flattenForLlm(root, maxNodes = 160) {
  const rows = [];
  const walk = (n, depth, parentZh) => {
    if (rows.length >= maxNodes) return;
    const id = String(n.id || "");
    const zh = String(n.zh || "").trim();
    // text_first 树节点多为 __section__/__topic__ 虚 id，仍需交给 LLM
    const skipList =
      id.startsWith("__lecture__/") || id.startsWith("__part__/");
    if (zh && !skipList) {
      rows.push({
        id,
        zh,
        depth,
        parent: parentZh || "",
        weak: Boolean(n.weak),
      });
    }
    for (const c of n.children || []) walk(c, depth + 1, zh || parentZh);
  };
  walk(root, 0, "");
  return rows;
}

function parseKeepDrop(content) {
  const raw = String(content || "").trim();
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const m = unfenced.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

function pruneByKeepIds(root, keepIds) {
  const keep = new Set(keepIds.map(String));
  const walk = (node) => {
    const id = String(node.id || "");
    const zh = String(node.zh || "").trim();
    const kids = (node.children || []).map(walk).filter(Boolean);
    const marked = keep.has(id) || (zh && keep.has(zh));
    // 命中自身，或有保留的后代（祖先路径）
    if (!marked && !kids.length) return null;
    const { weak: _w, ...rest } = node;
    return {
      ...rest,
      children: kids,
    };
  };
  return walk(root);
}

async function llmRefine(prelim, noteCorpus, sessionId) {
  const root = prelim.root || prelim.roots?.[0];
  if (!root) return null;
  const rows = flattenForLlm(root, 140);
  if (rows.length < 3) {
    // 过小：直接当 final
    return {
      ...prelim,
      meta: {
        ...prelim.meta,
        pipeline: "note_match_llm_v1",
        note_match: {
          stage: "final",
          session_id: sessionId,
          skipped_llm: "too_small",
          prelim_nodes: prelim.n_nodes,
        },
      },
    };
  }

  const corpusClip = String(noteCorpus || "").slice(0, 6000);
  const nodeList = rows
    .map(
      (r, i) =>
        `${i + 1}. id=${r.id} | ${r.zh} | depth=${r.depth} | parent=${r.parent || "-"}${r.weak ? " | weak" : ""}`
    )
    .join("\n");

  const system = `你是离散数学课程助教。任务：对照课次笔记，从「初步匹配的导图节点」中保留本课**主要内容**节点，剔除次要/附属/跑题节点。

规则：
1. 主要内容：笔记大纲与正文明确讲授的定义/定理/核心概念与主线。
2. 应剔除：笔记未展开的边角、其它章节串入、过细叶节点、与本课主题无关的内容。
3. 节点 id 多为 __section__/__topic__/__chapter__/…，请原样放进 keep_ids / drop_ids。
4. 章节名称必须保留：凡有主要内容子节点的 __chapter__/… 章节点一律 keep（勿删章壳）；无关章整枝可 drop。
5. 宁可少而准；父子都重要则都 keep。通常应删掉 prelim 里 30%–60% 的非主内容节点。
6. 只输出 JSON（无 Markdown 围栏）：
{"keep_ids":["节点id",...],"drop_ids":["节点id",...],"note":"一句话说明"}`;

  const user = `课次：${sessionId}

【课次笔记语料（截断）】
${corpusClip || "（无笔记正文，请按节点标题与常识保守保留核心概念）"}

【初步匹配导图节点】
${nodeList}

请给出 keep_ids（主要内容）。drop_ids 可列明确要删的。`;

  const { content, model } = await callLlm(
    process.env,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.1, timeoutMs: 90000, retries: 2 }
  );

  const parsed = parseKeepDrop(content);
  let keepIds = Array.isArray(parsed?.keep_ids)
    ? parsed.keep_ids.map(String)
    : [];
  const dropIds = new Set(
    (Array.isArray(parsed?.drop_ids) ? parsed.drop_ids : []).map(String)
  );

  // 若模型只给了 drop：默认全保留再减
  if (!keepIds.length && dropIds.size) {
    keepIds = rows.map((r) => r.id).filter((id) => !dropIds.has(id));
  }
  // 若给了 keep 仍含 drop，以 drop 为准去掉
  keepIds = keepIds.filter((id) => !dropIds.has(id));

  // 也允许用中文名匹配
  const zhToId = new Map(rows.map((r) => [r.zh, r.id]));
  keepIds = keepIds.map((k) => zhToId.get(k) || k);

  if (!keepIds.length) {
    // 兜底：保留非 weak 节点
    keepIds = rows.filter((r) => !r.weak).map((r) => r.id);
  }

  const pruned = pruneByKeepIds(root, keepIds);
  if (!pruned || countNodes(pruned) < 2) {
    return {
      ...prelim,
      meta: {
        ...prelim.meta,
        pipeline: "note_match_llm_v1",
        note_match: {
          stage: "final",
          session_id: sessionId,
          model,
          fallback: "prune_too_small",
          keep_count: keepIds.length,
          llm_note: parsed?.note || "",
          prelim_nodes: prelim.n_nodes,
        },
      },
    };
  }

  const n_nodes = countNodes(pruned);
  return {
    lecture_id: sessionId,
    root: pruned,
    roots: [pruned],
    n_nodes,
    max_depth: depthOf(pruned),
    orphan_count: 0,
    meta: {
      ...prelim.meta,
      pipeline: "note_match_llm_v1",
      composed_from: "chapter_slice",
      note_match: {
        stage: "final",
        session_id: sessionId,
        model,
        keep_count: keepIds.length,
        drop_count: dropIds.size,
        llm_note: parsed?.note || "",
        prelim_nodes: prelim.n_nodes,
        final_nodes: n_nodes,
      },
    },
  };
}

function listSessionIds(courseId) {
  const dir = notesCacheDir(courseId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+_\d+\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort((a, b) => {
      const na = Number(a.split("_")[0]);
      const nb = Number(b.split("_")[0]);
      return na - nb || a.localeCompare(b);
    });
}

function outPaths(courseId, sessionId) {
  const base = path.join(
    coursePublicDir(courseId),
    "mindmaps",
    "note_match"
  );
  const distBase = path.join(
    __dirname,
    "../dist/data/courses",
    courseId,
    "mindmaps",
    "note_match"
  );
  return {
    prelim: path.join(base, `session_${sessionId}.prelim.json`),
    final: path.join(base, `session_${sessionId}.final.json`),
    distPrelim: path.join(distBase, `session_${sessionId}.prelim.json`),
    distFinal: path.join(distBase, `session_${sessionId}.final.json`),
  };
}

function mirrorWrite(file, distFile, obj) {
  writeJson(file, obj);
  try {
    writeJson(distFile, obj);
  } catch {
    /* dist 可能不可写时忽略 */
  }
}

async function processSession(courseId, sessionId) {
  const lids = sessionId.split("_").filter(Boolean);
  console.log(`\n=== session ${sessionId} lids=${lids.join(",")} ===`);
  const { prelim, signal } = buildPrelim(courseId, lids, sessionId);
  const paths = outPaths(courseId, sessionId);
  if (!prelim) {
    console.log("  skip: no prelim match", {
      terms: signal.order?.length || 0,
      corpus: (signal.noteCorpus || "").length,
    });
    return { sessionId, ok: false, reason: "no_prelim" };
  }
  const chNames = (prelim.root?.children || [])
    .filter((c) => String(c.id || "").startsWith("__chapter__/"))
    .map((c) => c.zh)
    .join(" | ");
  console.log(
    `  prelim nodes=${prelim.n_nodes} corpus=${(signal.noteCorpus || "").length} terms=${signal.order?.length || 0}`
  );
  console.log(`  chapters: ${chNames || "(none)"}`);
  mirrorWrite(paths.prelim, paths.distPrelim, prelim);

  let finalDoc = prelim;
  if (!SKIP_LLM) {
    try {
      finalDoc = await llmRefine(prelim, signal.noteCorpus, sessionId);
      console.log(
        `  final nodes=${finalDoc.n_nodes} keep=${finalDoc.meta?.note_match?.keep_count ?? "?"}`
      );
    } catch (e) {
      console.log("  llm failed, save prelim as final fallback:", String(e?.message || e));
      finalDoc = {
        ...prelim,
        meta: {
          ...prelim.meta,
          pipeline: "note_match_llm_v1",
          note_match: {
            stage: "final",
            session_id: sessionId,
            fallback: "llm_error",
            error: String(e?.message || e).slice(0, 200),
            prelim_nodes: prelim.n_nodes,
          },
        },
      };
    }
  } else {
    finalDoc = {
      ...prelim,
      meta: {
        ...prelim.meta,
        pipeline: "note_match_llm_v1",
        note_match: {
          stage: "final",
          session_id: sessionId,
          skipped_llm: true,
          prelim_nodes: prelim.n_nodes,
        },
      },
    };
  }
  mirrorWrite(paths.final, paths.distFinal, finalDoc);
  return {
    sessionId,
    ok: true,
    prelim_nodes: prelim.n_nodes,
    final_nodes: finalDoc.n_nodes,
  };
}

async function main() {
  const courseId = COURSE;
  let sessions = listSessionIds(courseId);
  if (ONLY.size) sessions = sessions.filter((s) => ONLY.has(s));
  if (LIMIT > 0) sessions = sessions.slice(0, LIMIT);
  console.log("course", courseId);
  console.log("sessions", sessions.length, sessions.join(", "));
  console.log("skip_llm", SKIP_LLM);
  console.log("notes_dir", notesCacheDir(courseId));
  console.log("out_dir", path.join(coursePublicDir(courseId), "mindmaps/note_match"));

  const summary = [];
  for (const sid of sessions) {
    try {
      summary.push(await processSession(courseId, sid));
    } catch (e) {
      console.log("session error", sid, e);
      summary.push({ sessionId: sid, ok: false, reason: String(e?.message || e) });
    }
  }

  const manifest = {
    courseId,
    generatedAt: new Date().toISOString(),
    skip_llm: SKIP_LLM,
    results: summary,
  };
  const manPath = path.join(
    coursePublicDir(courseId),
    "mindmaps/note_match/manifest.json"
  );
  writeJson(manPath, manifest);
  try {
    writeJson(
      path.join(
        __dirname,
        "../dist/data/courses",
        courseId,
        "mindmaps/note_match/manifest.json"
      ),
      manifest
    );
  } catch {
    /* ignore */
  }
  console.log("\nDONE", JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
