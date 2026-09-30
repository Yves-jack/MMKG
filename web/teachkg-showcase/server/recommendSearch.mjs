/**
 * 联网资源推荐：以搜索引擎为主（Brave/Bing/SerpAPI/DuckDuckGo），
 * B 站视频直达播放页；用正文/简介与知识点比对相关度，并打多标签。
 */

import { callLlm } from "./qaLlm.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hasCjk(s) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(s);
}

function isSearchPortalUrl(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return true;
  if (/search\.bilibili\.com/.test(u)) return true;
  if (/youtube\.com\/results/.test(u)) return true;
  if (/google\.[^/]+\/search/.test(u)) return true;
  if (/bing\.com\/search/.test(u)) return true;
  if (/baidu\.com\/s\?/.test(u)) return true;
  if (/duckduckgo\.com\/\?/.test(u)) return true;
  if (/\/search(\?|\/|$)/.test(u)) return true;
  return false;
}

/** 按产品要求排除的资源域 */
function isExcludedSourceUrl(url) {
  const u = String(url || "").toLowerCase();
  return (
    /arxiv\.org/.test(u) ||
    /wikipedia\.org|wiktionary\.org/.test(u) ||
    /youtube\.com|youtu\.be/.test(u)
  );
}

async function fetchText(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 18000);
  try {
    const r = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        ...(init.headers || {}),
      },
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, init = {}) {
  const { ok, status, text, error } = await fetchText(url, init);
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok, status, data, text, error };
}

function item(fields) {
  if (!fields?.title || !fields?.url) return null;
  if (isSearchPortalUrl(fields.url) || isExcludedSourceUrl(fields.url)) return null;
  return {
    kind: fields.kind || "web",
    title: String(fields.title).slice(0, 200),
    url: String(fields.url),
    snippet: String(fields.snippet || "").slice(0, 400),
    content: String(fields.content || fields.snippet || "").slice(0, 2400),
    source: fields.source || domainOf(fields.url) || "web",
    score: Number(fields.score) || 0,
    domain: domainOf(fields.url),
    description: String(fields.description || "").slice(0, 600),
    relevance: Number(fields.relevance) || 0,
    tags: Array.isArray(fields.tags) ? fields.tags.slice(0, 8) : [],
  };
}

function tokenizeKp(text) {
  const s = String(text || "").toLowerCase().trim();
  const out = new Set();
  if (!s) return [];
  out.add(s);
  const cjkRuns = s.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length >= 2) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
    if (run.length >= 3) {
      for (let i = 0; i < run.length - 2; i++) out.add(run.slice(i, i + 3));
    }
  }
  const words = s.match(/[a-z0-9_]{2,}/g) || [];
  for (const w of words) out.add(w);
  return [...out].filter((t) => t.length >= 2);
}

function charOverlapRatio(a, b) {
  const aa = String(a || "").toLowerCase().replace(/[^\u3400-\u9fffa-z0-9]/g, "");
  const bb = String(b || "").toLowerCase().replace(/[^\u3400-\u9fffa-z0-9]/g, "");
  if (!aa || !bb) return 0;
  const setB = new Set([...bb]);
  let hit = 0;
  for (const ch of aa) if (setB.has(ch)) hit += 1;
  return hit / aa.length;
}

/** 知识点近义词/别名，避免「四色问题」打不到「四色定理」 */
function kpNameVariants(kpName) {
  const kp = String(kpName || "").trim().toLowerCase();
  const out = new Set();
  if (!kp) return [];
  out.add(kp);
  const compact = kp.replace(/[的了与和及：:·\s]/g, "");
  if (compact) out.add(compact);

  if (/四色/.test(kp)) {
    for (const v of ["四色定理", "四色问题", "四色猜想", "四色地图", "four color", "four-color"]) {
      out.add(v);
    }
  }
  if (/问题$/.test(kp)) {
    out.add(kp.replace(/问题$/, "定理"));
    out.add(kp.replace(/问题$/, "猜想"));
  }
  if (/定理$/.test(kp)) {
    out.add(kp.replace(/定理$/, "问题"));
    out.add(kp.replace(/定理$/, "猜想"));
  }
  if (/猜想$/.test(kp)) {
    out.add(kp.replace(/猜想$/, "定理"));
    out.add(kp.replace(/猜想$/, "问题"));
  }
  return [...out].filter((t) => t.length >= 2);
}

function contentHitsKp(content, kp) {
  const variants = kpNameVariants(kp);
  for (const v of variants) {
    if (content.includes(v)) return v === String(kp).toLowerCase() ? 0.94 : 0.9;
  }
  return 0;
}

/**
 * 相关度：优先用知识点名称（短），避免把长释义切成大量 2-gram 导致全 0。
 * 返回 0–1。含跑题信号时大幅降权（避免「四色问题」撞上游戏成就）。
 */
export function scoreRelevance(kpName, contentText) {
  const kp = String(kpName || "").trim().toLowerCase();
  const content = String(contentText || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!kp) return 0;
  if (!content) return 0;

  const off = offTopicPenalty(content, kp);
  if (off >= 0.85) return Math.min(0.18, charOverlapRatio(kp, content) * 0.2);

  let base = contentHitsKp(content, kp);
  if (!base) {
    const compact = kp.replace(/[的了与和及：:·\s]/g, "");
    const tokens = tokenizeKp(kp);
    // 把近义词也纳入 token
    for (const v of kpNameVariants(kp)) {
      if (!tokens.includes(v)) tokens.push(v);
    }
    if (!tokens.length) {
      base = Math.min(0.45, charOverlapRatio(kp, content) * 0.8);
    } else {
      let hits = 0;
      let weight = 0;
      for (const t of tokens) {
        const w = t === kp || t === compact ? 3 : t.length >= 3 ? 1.6 : 0.55;
        weight += w;
        if (content.includes(t)) hits += w;
      }
      const ratio = weight ? hits / weight : 0;
      const overlap = charOverlapRatio(kp, content) * 0.35;
      base = Math.max(0, Math.min(1, ratio * 0.85 + overlap));
    }
  }

  // 教学/证明信号加权；跑题信号降权
  const eduBoost = educationalBoost(content);
  return Math.max(0, Math.min(1, base * (1 - off * 0.75) + eduBoost * 0.08));
}

/** 0–1：越大越像娱乐/游戏/广告等非课内资源 */
function offTopicPenalty(text, kp) {
  const t = String(text || "");
  let p = 0;
  if (
    /崩铁|崩坏|星穹铁道|原神|王者荣耀|英雄联盟|\blol\b|绝区零|鸣潮|明日方舟|阴阳师|第五人格/.test(
      t
    )
  ) {
    p = Math.max(p, 0.95);
  }
  if (/隐藏成就|游戏成就|通关|副本|角色攻略|手游|端游|开服|抽卡|皮肤/.test(t)) {
    p = Math.max(p, 0.9);
  }
  // 「××成就」且无教学语境：多为游戏成就撞知识点名
  if (
    /成就/.test(t) &&
    !/数学|定理|证明|图论|学术|教学|讲解|课件|教材|难题|地图着色/.test(t)
  ) {
    p = Math.max(p, 0.9);
  }
  if (/直播带货|带货|开箱测评|美食探店|搞笑合集|鬼畜|番剧|动漫推荐/.test(t)) {
    p = Math.max(p, 0.85);
  }
  // 「四色」印刷/设计语境，且无数学信号
  if (
    /四色转专色|潘通|pantone|印刷四色|\bcmyk\b|专色|配色方案/.test(t) &&
    !/定理|图论|证明|地图着色|四色问题|四色猜想|graph\s*theory|four[\s-]?color/.test(t)
  ) {
    p = Math.max(p, 0.92);
  }
  // 标题撞词但通篇无教学信号
  const hasKp = kp && contentHitsKp(t, kp) > 0;
  const hasEdu = educationalBoost(t) > 0;
  if (hasKp && !hasEdu && /娱乐|杂谈|整活|整活视频|沙雕/.test(t)) {
    p = Math.max(p, 0.8);
  }
  return p;
}

function educationalBoost(text) {
  const t = String(text || "");
  let n = 0;
  if (/定理|证明|图论|离散数学|数学|课件|讲义|课堂|教材|定义|引理|推论/.test(t)) n += 1;
  if (/讲解|精讲|原理|推导|例题|习题|知识点|考研|课程|百科|科普/.test(t)) n += 1;
  if (/theorem|proof|graph\s*theory|discrete\s*math|combinator/.test(t)) n += 1;
  return Math.min(1, n / 2);
}

function isEducationalDomain(urlOrDomain) {
  const u = String(urlOrDomain || "").toLowerCase();
  return (
    /baike\.baidu|zhihu\.com|csdn\.net|juejin\.cn|cnblogs\.com|jianshu\.com/.test(u) ||
    /\.edu(\.|$)|edu\.cn|mooc|icourse163|xuetangx|coursera|khanacademy/.test(u) ||
    /runoob\.com|w3school|liaoxuefeng|geeksforgeeks|brilliant\.org/.test(u)
  );
}

/**
 * 仅凭标题/正文信号判断是否明显不适合（不看 relevance，可在打分前调用）
 */
export function isObviouslyUnsuitable(it, kp) {
  const text = `${it.title || ""}\n${it.content || ""}\n${it.snippet || ""}\n${it.description || ""}`;
  if (offTopicPenalty(text, kp) >= 0.8) return true;
  if (
    /不建议作为推荐|不适合作为推荐|不建议推荐|不宜推荐|与课内无关|跑题|名不副实|仅标题撞词|娱乐向|游戏内容|游戏成就/.test(
      text
    )
  ) {
    return true;
  }
  return false;
}

/**
 * 硬过滤：明显不适合作为课内推荐的资源（含相关度阈值，须在打分后使用）
 */
export function isUnsuitableResource(it, kp) {
  if (isObviouslyUnsuitable(it, kp)) return true;
  const rel = Number(it.relevance) || 0;
  const text = `${it.title || ""}\n${it.content || ""}\n${it.snippet || ""}`;
  const edu = educationalBoost(text);
  const eduSite = isEducationalDomain(it.url || it.domain || "");

  // 百科/教学站：阈值更松；纯撞词娱乐站：更严
  if (eduSite || edu >= 0.5) {
    if (rel < 0.22) return true;
  } else if (rel < 0.3) {
    return true;
  }
  return false;
}

function buildTags(it) {
  const tags = [];
  tags.push(it.kind === "video" ? "视频" : "网页");
  if (it.domain) tags.push(it.domain);
  if (it.source) tags.push(`引擎:${it.source}`);

  const u = String(it.url || "").toLowerCase();
  const blob = `${it.title || ""} ${it.content || ""} ${it.snippet || ""}`;
  if (/bilibili\.com/.test(u) && educationalBoost(blob) > 0) tags.push("讲解视频");
  else if (/bilibili\.com/.test(u)) tags.push("视频平台");
  if (/zhihu\.com/.test(u)) tags.push("问答社区");
  if (/csdn\.net|juejin\.cn|cnblogs\.com|jianshu\.com/.test(u)) tags.push("技术博客");
  if (/github\.com|gitee\.com/.test(u)) tags.push("开源");
  if (/\.edu(\.|$)|edu\.cn/.test(u)) tags.push("教育机构");
  if (/runoob\.com|w3school|liaoxuefeng|geeksforgeeks|baike\.baidu/.test(u)) {
    tags.push("百科教程");
  }
  if (/\.pdf(\?|$)/i.test(u) || /课件|讲义|ppt/i.test(it.title || "")) tags.push("课件文档");

  const rel = Number(it.relevance) || 0;
  if (!(it.content || it.snippet)) tags.push("简介不足");
  else if (rel >= 0.55) tags.push("高相关");
  else if (rel >= 0.3) tags.push("中相关");
  else tags.push("低相关");

  return [...new Set(tags)].slice(0, 7);
}

function buildDescription(it, kp, context) {
  const kindLabel = it.kind === "video" ? "视频" : "网页资料";
  const relPct = Math.round((it.relevance || 0) * 100);
  const body = String(it.content || it.snippet || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  let why;
  if (isUnsuitableResource(it, kp)) {
    why = `与「${kp}」关联不可靠（约 ${relPct}%），更像娱乐/游戏或其他主题，不纳入推荐列表。`;
  } else if (!(it.content || it.snippet)) {
    why = `暂未抓到可用简介，相关度按标题估算为 ${relPct}%；请结合课内笔记核对。`;
  } else if (relPct >= 55) {
    why = `与知识点「${kp}」相关度较高（约 ${relPct}%），标题/简介中出现了相近表述。`;
  } else if (relPct >= 32) {
    why = `与「${kp}」有一定关联（约 ${relPct}%），可作为拓展阅读。`;
  } else {
    why = `与「${kp}」字面重合偏低（约 ${relPct}%），可能不够贴合课内主题。`;
  }
  const ctxHint = context
    ? `课内要点参考：${String(context).replace(/\s+/g, " ").trim().slice(0, 80)}。`
    : "";
  return [
    `「${it.title}」来自 ${it.domain || it.source}，类型为${kindLabel}。`,
    body ? `内容提要：${body}${body.length >= 160 ? "…" : ""}` : "",
    why,
    ctxHint,
  ]
    .filter(Boolean)
    .join(" ");
}

async function translateToEn(q) {
  if (!hasCjk(q)) return q;
  const url =
    "https://api.mymemory.translated.net/get?" +
    new URLSearchParams({ q: q.slice(0, 80), langpair: "zh|en" });
  const { ok, data } = await fetchJson(url);
  const t = data?.responseData?.translatedText;
  if (ok && t && typeof t === "string" && t.trim() && t.toLowerCase() !== q.toLowerCase()) {
    return t.trim();
  }
  return q;
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapDdgHref(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return href.startsWith("http") ? href : "";
  } catch {
    return "";
  }
}

/** 国内可用：必应网页版（无 API Key） */
async function searchBingHtml(q, limit = 10) {
  const url =
    "https://cn.bing.com/search?" +
    new URLSearchParams({
      q,
      mkt: "zh-CN",
      setlang: "zh-hans",
    });
  const { ok, text } = await fetchText(url, {
    headers: { Accept: "text/html", Referer: "https://cn.bing.com/" },
  });
  if (!ok || !text) return [];
  const out = [];
  const seen = new Set();
  const re =
    /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    const href = m[1];
    const title = stripHtml(m[2]);
    if (!href || !title || seen.has(href)) continue;
    if (/bing\.com|microsoft\.com/i.test(href)) continue;
    seen.add(href);
    // 尝试同块截取摘要
    const after = text.slice(m.index, m.index + 1200);
    const snip = stripHtml((after.match(/<p>([\s\S]*?)<\/p>/i) || [])[1] || "");
    out.push(
      item({
        kind: "web",
        title,
        url: href,
        snippet: snip,
        content: snip,
        source: "Bing",
        score: 0.88 - out.length * 0.03,
      })
    );
  }
  return out.filter(Boolean);
}

/** 国内可用：360 搜索（无 API Key） */
async function searchSo360(q, limit = 10) {
  const url = "https://www.so.com/s?" + new URLSearchParams({ q });
  const { ok, text } = await fetchText(url, {
    headers: { Accept: "text/html", Referer: "https://www.so.com/" },
  });
  if (!ok || !text) return [];
  const out = [];
  const seen = new Set();
  const re =
    /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*(?:data-mdurl="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    let href = (m[2] || m[1] || "").trim();
    if (href.startsWith("//")) href = "https:" + href;
    const title = stripHtml(m[3]);
    if (!href.startsWith("http") || !title || seen.has(href)) continue;
    if (/so\.com|360\.cn|hao\.360/i.test(href)) continue;
    seen.add(href);
    out.push(
      item({
        kind: "web",
        title,
        url: href,
        snippet: "",
        content: "",
        source: "360",
        score: 0.84 - out.length * 0.03,
      })
    );
  }
  return out.filter(Boolean);
}

async function searchDuckDuckGo(q, limit = 8) {
  const url =
    "https://html.duckduckgo.com/html/?" + new URLSearchParams({ q });
  const { ok, text } = await fetchText(url, {
    headers: { Accept: "text/html" },
  });
  if (!ok || !text) return [];
  const out = [];
  const blockRe =
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>)?/gi;
  let m;
  while ((m = blockRe.exec(text)) && out.length < limit) {
    const href = unwrapDdgHref(m[1]);
    const title = stripHtml(m[2]);
    const snip = stripHtml(m[3] || "");
    if (!href || !title) continue;
    out.push(
      item({
        kind: "web",
        title,
        url: href,
        snippet: snip,
        content: snip,
        source: "DuckDuckGo",
        score: 0.8 - out.length * 0.03,
      })
    );
  }
  return out.filter(Boolean);
}

async function searchBrave(q, apiKey, limit = 10) {
  const url =
    "https://api.search.brave.com/res/v1/web/search?" +
    new URLSearchParams({ q, count: String(limit) });
  const { ok, data } = await fetchJson(url, {
    headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
  });
  if (!ok || !data?.web?.results) return [];
  return data.web.results
    .map((r, i) => {
      const u = r.url || "";
      if (/\.(pdf|pptx?|docx?)(\?|$)/i.test(u)) return null;
      return item({
        kind: "web",
        title: r.title,
        url: u,
        snippet: r.description || "",
        content: r.description || "",
        source: "Brave",
        score: 0.9 - i * 0.03,
      });
    })
    .filter(Boolean);
}

async function searchBing(q, apiKey, limit = 10) {
  const url =
    "https://api.bing.microsoft.com/v7.0/search?" +
    new URLSearchParams({ q, count: String(limit), mkt: "zh-CN" });
  const { ok, data } = await fetchJson(url, {
    headers: { "Ocp-Apim-Subscription-Key": apiKey },
  });
  if (!ok || !data?.webPages?.value) return [];
  return data.webPages.value
    .map((r, i) => {
      const u = r.url || "";
      if (/\.(pdf|pptx?|docx?)(\?|$)/i.test(u)) return null;
      return item({
        kind: "web",
        title: r.name,
        url: u,
        snippet: r.snippet || "",
        content: r.snippet || "",
        source: "Bing",
        score: 0.9 - i * 0.03,
      });
    })
    .filter(Boolean);
}

async function searchSerpApi(q, apiKey, engine, limit = 10) {
  const url =
    "https://serpapi.com/search.json?" +
    new URLSearchParams({
      engine,
      q,
      api_key: apiKey,
      num: String(limit),
      hl: "zh-CN",
    });
  const { ok, data } = await fetchJson(url);
  if (!ok || !Array.isArray(data?.organic_results)) return [];
  const label = engine === "bing" ? "Serp·Bing" : "Serp·Google";
  return data.organic_results
    .map((r, i) => {
      const u = r.link || "";
      if (/\.(pdf|pptx?|docx?)(\?|$)/i.test(u)) return null;
      return item({
        kind: "web",
        title: r.title,
        url: u,
        snippet: r.snippet || "",
        content: r.snippet || "",
        source: label,
        score: 0.92 - i * 0.03,
      });
    })
    .filter(Boolean);
}

/** B 站：搜索页抓 BV + view 接口取简介（search API 常被 -412） */
async function searchBilibili(q, limit = 8) {
  const pageUrl =
    "https://search.bilibili.com/all?" + new URLSearchParams({ keyword: q });
  const { ok, text } = await fetchText(pageUrl, {
    headers: {
      Accept: "text/html",
      Referer: "https://www.bilibili.com/",
    },
  });
  if (!ok || !text) return [];

  const bvids = [...new Set(text.match(/BV[\w]{10}/g) || [])].slice(0, limit);
  if (!bvids.length) return [];

  const out = [];
  for (let i = 0; i < bvids.length; i++) {
    const bvid = bvids[i];
    const viewUrl =
      "https://api.bilibili.com/x/web-interface/view?" +
      new URLSearchParams({ bvid });
    const { ok: vok, data } = await fetchJson(viewUrl, {
      headers: { Referer: `https://www.bilibili.com/video/${bvid}` },
    });
    const d = data?.data;
    if (vok && data?.code === 0 && d?.title) {
      const desc = stripHtml(d.desc || "");
      out.push(
        item({
          kind: "video",
          title: d.title,
          url: `https://www.bilibili.com/video/${bvid}`,
          snippet: desc.slice(0, 280),
          content: desc.slice(0, 2400),
          source: "Bilibili",
          score: 0.86 - i * 0.03,
        })
      );
    } else {
      out.push(
        item({
          kind: "video",
          title: `B站视频 ${bvid}`,
          url: `https://www.bilibili.com/video/${bvid}`,
          snippet: "",
          content: "",
          source: "Bilibili",
          score: 0.7 - i * 0.03,
        })
      );
    }
  }
  return out.filter(Boolean);
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it?.url || isSearchPortalUrl(it.url) || isExcludedSourceUrl(it.url)) continue;
    const key = it.url.replace(/#.*$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function enrichWebMeta(it) {
  if (it.kind !== "web") return it;
  if (String(it.content || "").trim().length >= 100) return it;
  const { ok, text } = await fetchText(it.url, {
    headers: { Accept: "text/html" },
  });
  if (!ok || !text) return it;
  const og =
    text.match(/property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
    text.match(/content=["']([^"']+)["']\s+property=["']og:description["']/i) ||
    text.match(/name=["']description["']\s+content=["']([^"']+)["']/i) ||
    text.match(/content=["']([^"']+)["']\s+name=["']description["']/i);
  const desc = stripHtml(og?.[1] || "");
  if (!desc || desc.length < 20) return it;
  return {
    ...it,
    content: desc.slice(0, 2400),
    snippet: (it.snippet && it.snippet.length > 40 ? it.snippet : desc).slice(0, 280),
  };
}

async function enrichBatch(items) {
  const out = [];
  const queue = [...items];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const it = queue.shift();
      if (!it) break;
      out.push(await enrichWebMeta(it));
    }
  });
  await Promise.all(workers);
  return out;
}

async function polishDescriptionsWithLlm(items, kp, context, env) {
  try {
    const payload = items.slice(0, 12).map((it, i) => ({
      i,
      kind: it.kind,
      title: it.title,
      source: it.source,
      domain: it.domain,
      relevance: it.relevance,
      tags: it.tags,
      content: String(it.content || it.snippet || "").slice(0, 500),
    }));
    const { content } = await callLlm(
      env,
      [
        {
          role: "system",
          content:
            "你是课程助教。判断每条资源是否适合作为该知识点的课内学习推荐，并写 2–4 句中文说明。游戏、娱乐、成就攻略、印刷配色、仅标题撞词等应标记 suitable=false。只返回 JSON：{\"items\":[{\"i\":0,\"suitable\":true,\"description\":\"...\"}]}",
        },
        {
          role: "user",
          content: JSON.stringify({
            knowledgePoint: kp,
            lectureContext: String(context || "").slice(0, 400),
            resources: payload,
          }),
        },
      ],
      { temperature: 0.2, timeoutMs: 45000 }
    );
    const raw = String(content || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(raw);
    const rows = parsed?.items || [];
    if (!Array.isArray(rows)) return items;
    const map = new Map();
    for (const r of rows) {
      if (r && typeof r.i === "number") {
        map.set(r.i, {
          description: r.description ? String(r.description).slice(0, 600) : "",
          suitable: r.suitable !== false,
        });
      }
    }
    return items
      .map((it, i) => {
        const hit = map.get(i);
        if (!hit) return it;
        return {
          ...it,
          description: hit.description || it.description,
          suitable: hit.suitable,
        };
      })
      .filter((it) => it.suitable !== false);
  } catch {
    return items;
  }
}

export async function runRecommendSearch(query, env = process.env, opts = {}) {
  const q = String(query || "").trim().slice(0, 120);
  const kp = String(opts.knowledgePoint || q).trim().slice(0, 80);
  const context = String(opts.context || "").trim().slice(0, 800);
  if (!q) {
    return { query: "", items: [], providers: [], notice: "empty query", enQuery: "" };
  }

  const brave = env.BRAVE_API_KEY || env.VITE_BRAVE_API_KEY;
  const bing = env.BING_SEARCH_KEY || env.VITE_BING_SEARCH_KEY;
  const serp = env.SERPAPI_KEY || env.VITE_SERPAPI_KEY;

  const enQuery = await translateToEn(kp || q);
  const providers = [];
  const tasks = [];
  // 主查询只用知识点名，避免「定理/离散数学」等词干扰国内搜索切词
  const zhQuery = (kp || q).trim().slice(0, 40);
  const zhQueryWide = `${zhQuery} 离散数学`.slice(0, 50);

  // 有 Key 的搜索引擎并行多用
  if (brave) {
    providers.push("brave");
    tasks.push(searchBrave(zhQuery, brave, 10));
  }
  if (bing) {
    providers.push("bing-api");
    tasks.push(searchBing(zhQuery, bing, 10));
  }
  if (serp) {
    providers.push("serp-google", "serp-bing");
    tasks.push(searchSerpApi(zhQuery, serp, "google", 8));
    tasks.push(searchSerpApi(zhQuery, serp, "bing", 8));
  }

  // 无 Key：国内可访问的网页搜索
  if (!brave && !bing && !serp) {
    providers.push("bing-html", "360");
    tasks.push(searchBingHtml(zhQuery, 10));
    tasks.push(searchSo360(zhQuery, 10));
    tasks.push(searchBingHtml(zhQueryWide, 6));
  }

  providers.push("bilibili");
  // 视频检索加教学语境，减少游戏/娱乐撞词
  tasks.push(searchBilibili(`${zhQuery} 数学`, 6));
  tasks.push(searchBilibili(`${zhQuery} 讲解`, 6));

  const settled = await Promise.allSettled(tasks);
  const raw = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && Array.isArray(s.value)) raw.push(...s.value);
  }

  // 若仍为空，再试扩写查询
  if (!raw.length) {
    providers.push("retry");
    const retryQs = [zhQueryWide, `${zhQuery} 图论`, `${zhQuery} 定理`, enQuery].filter(
      (x) => x && String(x).trim()
    );
    for (const rq of retryQs) {
      const more = await Promise.allSettled([
        searchBingHtml(String(rq), 8),
        searchSo360(String(rq), 8),
        searchBilibili(`${String(rq)} 数学`, 6),
      ]);
      for (const s of more) {
        if (s.status === "fulfilled") raw.push(...s.value);
      }
      if (raw.length) break;
    }
  }

  let items = dedupe(raw);
  // 打分前只丢掉明显娱乐/游戏撞词（不可用 relevance，此时尚未计算）
  items = items.filter((it) => !isObviouslyUnsuitable(it, kp));
  items = await enrichBatch(items);

  items = items
    .map((it) => {
      const text = `${it.title}\n${it.content || ""}\n${it.snippet || ""}`;
      let relevance = scoreRelevance(kp, text);
      const titleRel = scoreRelevance(kp, it.title || "");
      // 标题命中但正文跑题时，不以标题高分盖过
      if (offTopicPenalty(text, kp) >= 0.8) {
        relevance = Math.min(relevance, 0.2);
      } else {
        relevance = Math.min(1, Math.max(relevance, titleRel * 0.85));
      }
      if (context) {
        const ctxTokens = tokenizeKp(context.slice(0, 40)).slice(0, 4);
        if (ctxTokens.length) {
          const boost = scoreRelevance(ctxTokens.join(""), text) * 0.12;
          relevance = Math.min(1, relevance + boost);
        }
      }
      // 教育域名略抬相关度下限，避免百科因切词差异被挤掉
      if (isEducationalDomain(it.url || it.domain) && relevance >= 0.2) {
        relevance = Math.min(1, Math.max(relevance, 0.36));
      }
      const score =
        (Number(it.score) || 0) * 0.25 +
        relevance * 0.65 +
        educationalBoost(text) * 0.1;
      const withRel = { ...it, relevance, score };
      const tagged = { ...withRel, tags: buildTags(withRel) };
      return {
        ...tagged,
        description: buildDescription(tagged, kp, context),
      };
    })
    .filter((it) => !isSearchPortalUrl(it.url) && !isExcludedSourceUrl(it.url))
    .filter((it) => !isUnsuitableResource(it, kp))
    .sort((a, b) => b.score - a.score)
    .slice(0, 28);

  items = await polishDescriptionsWithLlm(items, kp, context, env);
  // LLM 可能改写描述；再按规则与否定表述过滤一次
  items = items
    .filter((it) => !isUnsuitableResource(it, kp))
    .sort((a, b) => b.score - a.score)
    .slice(0, 18);

  return {
    query: q,
    knowledgePoint: kp,
    enQuery: enQuery !== q && enQuery !== kp ? enQuery : "",
    providers: [...new Set(providers)],
    notice: null,
    items,
  };
}

export function recommendSearchMiddleware(env = process.env) {
  return async (req, res, next) => {
    try {
      const raw = String(req.url || "");
      if (!raw.startsWith("/api/recommend-search")) return next();
      const u = new URL(raw, "http://local");
      if (req.method !== "GET") {
        json(res, 405, { error: "GET only" });
        return;
      }
      const q = u.searchParams.get("q") || "";
      const knowledgePoint = u.searchParams.get("kp") || q;
      const context = u.searchParams.get("context") || "";
      const result = await runRecommendSearch(q, env, { knowledgePoint, context });
      json(res, 200, result);
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
  };
}
