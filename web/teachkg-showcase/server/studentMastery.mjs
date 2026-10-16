/** Read-only, student-scoped proxy for the AI-Teaching mastery endpoint. */

const ENDPOINT = "/api/student-mastery";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "X-KG-Token");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

function apiBase(env) {
  const raw = String(env?.AI_TEACHING_API_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return raw;
  } catch {
    return "";
  }
}

function upstreamStatus(status) {
  // Preserve meaningful authorization, throttling, and availability errors;
  // convert unexpected server failures to a gateway error.
  return (status >= 400 && status < 500) || status === 503 ? status : 502;
}

function parseMastery(payload, courseId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || String(payload.course_id) !== courseId
      || !payload.mastery || typeof payload.mastery !== "object"
      || Array.isArray(payload.mastery)) {
    return null;
  }
  const mastery = Object.create(null);
  for (const [zh, score] of Object.entries(payload.mastery)) {
    if (!zh || typeof score !== "number" || !Number.isFinite(score)
        || score < 0 || score > 5) return null;
    mastery[zh] = score;
  }
  const result = { course_id: courseId, mastery };
  if (payload.scope !== undefined) {
    if (!["personal", "class_average"].includes(payload.scope)) return null;
    result.scope = payload.scope;
  }
  if (payload.learner_count !== undefined) {
    if (!Number.isInteger(payload.learner_count) || payload.learner_count < 0) return null;
    result.learner_count = payload.learner_count;
  }
  if (payload.missing_records === "zero") result.missing_records = "zero";
  if (payload.knowledge_points !== undefined) {
    if (!Array.isArray(payload.knowledge_points)) return null;
    result.knowledge_points = [];
    const seen = new Set();
    for (const point of payload.knowledge_points) {
      if (!point || typeof point.id !== "string" || typeof point.name !== "string"
          || seen.has(point.id) || !Object.hasOwn(mastery, point.id)
          || point.mastery !== mastery[point.id]) return null;
      seen.add(point.id);
      result.knowledge_points.push({ id: point.id, name: point.name, mastery: point.mastery });
    }
  }
  return result;
}

export function studentMasteryMiddleware(env = process.env, fetchImpl = fetch) {
  return async function studentMastery(req, res, next) {
    const rawUrl = String(req.url || "");
    if (rawUrl.split("?", 1)[0] !== ENDPOINT) return next();
    if (String(req.method || "GET").toUpperCase() !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "method not allowed" });
    }

    // Identity is determined only by the signed KG token, never by a query
    // parameter supplied by the iframe or its embedding page.
    const token = req.headers?.["x-kg-token"];
    if (typeof token !== "string" || !token.trim()) {
      return json(res, 401, { error: "KG token required" });
    }

    let courseId;
    try {
      const params = new URL(rawUrl, "http://localhost").searchParams;
      if ([...params.keys()].some((key) => key !== "course_id")
          || params.getAll("course_id").length !== 1) {
        return json(res, 400, { error: "only one course_id is allowed" });
      }
      courseId = String(params.get("course_id") || "").trim();
    } catch {
      return json(res, 400, { error: "invalid request URL" });
    }
    if (!courseId || courseId.length > 128) {
      return json(res, 400, { error: "invalid course_id" });
    }

    const currentEnv = typeof env === "function" ? env() : env;
    const base = apiBase(currentEnv);
    if (!base) return json(res, 503, { error: "AI-Teaching API is not configured" });

    try {
      const response = await fetchImpl(
        `${base}/api/knowledge-links/courses/${encodeURIComponent(courseId)}/mastery`,
        {
          method: "GET",
          headers: { "X-KG-Token": token.trim(), Accept: "application/json" },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        return json(res, upstreamStatus(response.status), {
          error: "AI-Teaching mastery request failed",
          upstream_status: response.status,
        });
      }
      const payload = parseMastery(await response.json(), courseId);
      if (!payload) return json(res, 502, { error: "invalid AI-Teaching mastery response" });
      return json(res, 200, payload);
    } catch {
      // Do not expose upstream exception text: it may contain the token or URL.
      return json(res, 502, { error: "AI-Teaching mastery unavailable" });
    }
  };
}
