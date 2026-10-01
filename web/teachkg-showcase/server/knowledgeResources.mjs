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

async function kgAccessToken({ kgBase, kgToken, fetchImpl }) {
  if (!kgToken) throw new Error("missing kg_token for video relation lookup");
  const response = await fetchImpl(`${kgBase}/jxb_login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kg_token: kgToken }),
  });
  const payload = await responseJson(response, "Knowledge-Graph login");
  if (!payload.access_token) throw new Error("Knowledge-Graph login omitted access_token");
  return String(payload.access_token);
}

export async function loadKnowledgeResources(
  { courseId, knowledgePointId, kgToken },
  env = process.env,
  fetchImpl = fetch,
) {
  const aiBase = normalizedBase(env.AI_TEACHING_API_URL);
  const kgBase = normalizedBase(env.KNOWLEDGE_GRAPH_API_URL);
  const resources = [];
  const warnings = [];
  const encodedCourse = encodeURIComponent(courseId);
  const encodedPoint = encodeURIComponent(knowledgePointId);

  if (aiBase && kgToken) {
    try {
      const response = await fetchImpl(
        `${aiBase}/api/knowledge-links/courses/${encodedCourse}/knowledge-points/${encodedPoint}/resources`,
        { headers: { "X-KG-Token": kgToken } },
      );
      const payload = await responseJson(response, "AI-Teaching resources");
      if (Array.isArray(payload.resources)) resources.push(...payload.resources);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    warnings.push("AI-Teaching resource integration or kg_token is not configured");
  }

  if (kgBase) {
    try {
      const token = await kgAccessToken({
        kgBase,
        kgToken,
        fetchImpl,
      });
      const response = await fetchImpl(
        `${kgBase}/v1/courses/${encodedCourse}/knowledge-points/${encodedPoint}/video-segments`,
        { headers: bearer(token) },
      );
      const payload = await responseJson(response, "Knowledge-Graph video relations");
      const ids = Array.isArray(payload.segment_ids) ? payload.segment_ids : [];
      for (const id of ids) {
        const resourceId = String(id || "").trim();
        if (!resourceId) continue;
        resources.push({
          resource_type: "video",
          resource_id: resourceId,
          course_id: courseId,
          title: `视频片段 ${resourceId}`,
          metadata: {},
          path: `/video?segment_id=${encodeURIComponent(resourceId)}`,
        });
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    warnings.push("Knowledge-Graph video relation integration is not configured");
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
    const kgToken = String(url.searchParams.get("kg_token") || "").trim();
    if (!courseId || !knowledgePointId) {
      return json(res, 400, { error: "course_id and knowledge_point_id are required" });
    }
    try {
      return json(
        res,
        200,
        await loadKnowledgeResources(
          { courseId, knowledgePointId, kgToken },
          env,
          fetchImpl,
        ),
      );
    } catch (error) {
      return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
