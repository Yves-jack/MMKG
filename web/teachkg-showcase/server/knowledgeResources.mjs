const MAX_BODY_BYTES = 16 * 1024;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function normalizedBase(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function bearer(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function responseJson(response, label) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

function meaningfulText(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "$1")
    .trim();
  return /^\[.*(?:失败|错误).*\]$/.test(text) ? "" : text;
}

export async function loadKnowledgeResources(
  { courseId, knowledgePointId, nodeName, nodeAliases = [], nodeContent, kgToken, accessToken },
  env = process.env,
  fetchImpl = fetch,
) {
  const aiBase = normalizedBase(env.AI_TEACHING_API_URL);
  const mmkgBase = normalizedBase(env.MMKG_API_URL);
  const videoSearchBase = normalizedBase(env.VIDEO_SEARCH_API_URL);
  const resources = [];
  const warnings = [];
  let match;
  const encodedCourse = encodeURIComponent(courseId);
  const encodedPoint = encodeURIComponent(knowledgePointId);

  if (aiBase && kgToken) {
    try {
      const aiQuery = new URLSearchParams();
      if (nodeName) aiQuery.set("node_name", nodeName);
      for (const alias of nodeAliases) {
        if (alias) aiQuery.append("node_alias", alias);
      }
      if (nodeContent) aiQuery.set("node_content", nodeContent);
      const encodedAiQuery = aiQuery.toString();
      const querySuffix = encodedAiQuery ? `?${encodedAiQuery}` : "";
      const response = await fetchImpl(
        `${aiBase}/api/knowledge-links/courses/${encodedCourse}/knowledge-points/${encodedPoint}/resources${querySuffix}`,
        { headers: { "X-KG-Token": kgToken } },
      );
      const payload = await responseJson(response, "AI-Teaching resources");
      if (Array.isArray(payload.resources)) resources.push(...payload.resources);
      if (Array.isArray(payload.warnings)) warnings.push(...payload.warnings.map(String));
      if (payload.match && typeof payload.match === "object") match = payload.match;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    warnings.push("AI-Teaching resource integration or kg_token is not configured");
  }

  if (mmkgBase && accessToken) {
    try {
      const videoQuery = new URLSearchParams();
      if (nodeName) videoQuery.set("name", nodeName);
      const encodedVideoQuery = videoQuery.toString();
      const videoSuffix = encodedVideoQuery ? `?${encodedVideoQuery}` : "";
      const response = await fetchImpl(
        `${mmkgBase}/v1/courses/${encodedCourse}/knowledge-points/${encodedPoint}/video-segments${videoSuffix}`,
        { headers: bearer(accessToken) },
      );
      const payload = await responseJson(response, "MMKG video relations");
      const refs = (Array.isArray(payload.video_refs) ? payload.video_refs : []).filter((ref) => (
        String(ref?.video_id || "").trim()
        && ref?.start_sec != null
        && Number.isFinite(Number(ref.start_sec))
      ));
      if (refs.length && !videoSearchBase) {
        warnings.push("VideoSearch API is not configured; linked videos were omitted");
      } else if (refs.length) {
        const metadataResponse = await fetchImpl(`${videoSearchBase}/api/v1/segments/by-video-refs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            course_id: courseId,
            refs: refs.map((ref) => ({
              video_id: String(ref.video_id).trim(),
              start_sec: Number(ref.start_sec),
            })),
          }),
        });
        const segments = await responseJson(metadataResponse, "VideoSearch segment metadata");
        for (const segment of Array.isArray(segments) ? segments : []) {
          const segmentId = String(segment?.id || "").trim();
          const videoId = String(segment?.video_id || "").trim();
          const lessonId = String(segment.lesson_id || "").trim();
          const startSec = Number(segment.start_sec);
          const endSec = Number(segment.end_sec);
          if (!segmentId || !videoId || !lessonId || !Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
          resources.push({
            resource_type: "video",
            resource_id: segmentId,
            course_id: courseId,
            title: `第 ${lessonId} 讲`,
            content: meaningfulText(segment.summary) || meaningfulText(segment.text) || meaningfulText(segment.asr_text),
            start_sec: startSec,
            end_sec: endSec,
            metadata: {
              video_id: videoId,
              lesson_id: lessonId,
              segment_id: segmentId,
            },
            path: `/video?course_id=${encodedCourse}&video_id=${encodeURIComponent(videoId)}&start_sec=${encodeURIComponent(startSec)}`,
          });
        }
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    warnings.push("MMKG API or access token is not configured");
  }

  const seen = new Set();
  const unique = resources.filter((item) => {
    const key = `${item?.resource_type || ""}:${item?.resource_id || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(item?.resource_type && item?.resource_id);
  });
  return {
    course_id: courseId,
    knowledge_point_id: knowledgePointId,
    resources: unique,
    warnings,
    match,
  };
}

export function knowledgeResourcesMiddleware(env = process.env, fetchImpl = fetch) {
  return async function knowledgeResources(req, res, next) {
    const rawUrl = String(req.url || "");
    const path = rawUrl.split("?")[0];
    if (path !== "/api/knowledge-resources") return next();
    if (String(req.method || "GET").toUpperCase() !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "method not allowed" });
    }
    if (rawUrl.length > MAX_BODY_BYTES) return json(res, 414, { error: "request URI too long" });
    const url = new URL(rawUrl, "http://localhost");
    const courseId = String(url.searchParams.get("course_id") || "").trim();
    const knowledgePointId = String(url.searchParams.get("knowledge_point_id") || "").trim();
    const nodeName = String(url.searchParams.get("node_name") || "").trim();
    const nodeAliases = url.searchParams.getAll("node_alias").map((value) => value.trim()).filter(Boolean);
    const nodeContent = String(url.searchParams.get("node_content") || "").trim();
    const kgToken = String(req.headers?.["x-kg-token"] || "").trim();
    const authorization = String(req.headers?.authorization || "");
    const [scheme, accessToken] = authorization.split(/\s+/, 2);
    if (!courseId || !knowledgePointId) {
      return json(res, 400, { error: "course_id and knowledge_point_id are required" });
    }
    try {
      return json(
        res,
        200,
        await loadKnowledgeResources(
          {
            courseId,
            knowledgePointId,
            nodeName,
            nodeAliases,
            nodeContent,
            kgToken,
            accessToken: scheme?.toLowerCase() === "bearer" ? accessToken : "",
          },
          env,
          fetchImpl,
        ),
      );
    } catch (error) {
      return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
