/**
 * 课堂图谱编辑补丁：独立文件，不改写 kg/mmkg。
 * GET/POST /api/kg-edits?courseId=&lectureId=
 *   lectureId 缺省或 "course" → course.json
 *   lectureId 含 "_" → session_{id}.json
 *   否则 → lecture_{id}.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const editsRoot = path.join(repoRoot, "data", "kg_edits");

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

function parseQuery(rawUrl) {
  const q = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "";
  const params = new URLSearchParams(q);
  return {
    courseId: String(params.get("courseId") || "").trim(),
    lectureId: String(params.get("lectureId") || "").trim(),
  };
}

function safeSegment(s) {
  return String(s || "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/[/\\]/g, "_")
    .trim();
}

function patchPath(courseId, lectureId) {
  const course = safeSegment(courseId);
  if (!course) return null;
  const dir = path.join(editsRoot, course);
  const lid = String(lectureId || "").trim();
  if (!lid || lid === "course") {
    return path.join(dir, "course.json");
  }
  if (lid.includes("_")) {
    return path.join(dir, `session_${safeSegment(lid)}.json`);
  }
  return path.join(dir, `lecture_${safeSegment(lid)}.json`);
}

function emptyPatch(courseId, lectureId) {
  return {
    courseId: courseId || "",
    lectureId: lectureId || "course",
    updatedAt: null,
    entityRenames: {},
    edgeEdits: {},
    deletedEntities: {},
    deletedEdges: {},
    deletedPptUrls: {},
  };
}

function asTrueMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v) out[k] = true;
  }
  return out;
}

function readPatch(file, courseId, lectureId) {
  if (!file || !fs.existsSync(file)) {
    return emptyPatch(courseId, lectureId);
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...emptyPatch(courseId, lectureId),
      ...data,
      entityRenames:
        data?.entityRenames && typeof data.entityRenames === "object"
          ? data.entityRenames
          : {},
      edgeEdits:
        data?.edgeEdits && typeof data.edgeEdits === "object" ? data.edgeEdits : {},
      deletedEntities: asTrueMap(data?.deletedEntities),
      deletedEdges: asTrueMap(data?.deletedEdges),
      deletedPptUrls: asTrueMap(data?.deletedPptUrls),
    };
  } catch {
    return emptyPatch(courseId, lectureId);
  }
}

function writePatchAtomic(file, patch) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(patch, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function mergePatch(base, body) {
  const next = {
    ...base,
    courseId: body.courseId || base.courseId,
    lectureId: body.lectureId || base.lectureId,
    updatedAt: new Date().toISOString(),
    entityRenames: { ...(base.entityRenames || {}) },
    edgeEdits: { ...(base.edgeEdits || {}) },
    deletedEntities: { ...(base.deletedEntities || {}) },
    deletedEdges: { ...(base.deletedEdges || {}) },
    deletedPptUrls: { ...(base.deletedPptUrls || {}) },
  };

  if (body.entityRenames && typeof body.entityRenames === "object") {
    for (const [k, v] of Object.entries(body.entityRenames)) {
      if (v == null || v === "") {
        delete next.entityRenames[k];
      } else {
        next.entityRenames[k] = String(v);
      }
    }
  }

  if (body.edgeEdits && typeof body.edgeEdits === "object") {
    for (const [k, v] of Object.entries(body.edgeEdits)) {
      if (v == null) {
        delete next.edgeEdits[k];
      } else if (typeof v === "object") {
        next.edgeEdits[k] = { ...(next.edgeEdits[k] || {}), ...v };
      }
    }
  }

  if (body.deletedEntities && typeof body.deletedEntities === "object") {
    for (const [k, v] of Object.entries(body.deletedEntities)) {
      if (v == null || v === false) {
        delete next.deletedEntities[k];
      } else {
        next.deletedEntities[k] = true;
      }
    }
  }

  if (body.deletedEdges && typeof body.deletedEdges === "object") {
    for (const [k, v] of Object.entries(body.deletedEdges)) {
      if (v == null || v === false) {
        delete next.deletedEdges[k];
      } else {
        next.deletedEdges[k] = true;
      }
    }
  }

  if (body.deletedPptUrls && typeof body.deletedPptUrls === "object") {
    for (const [k, v] of Object.entries(body.deletedPptUrls)) {
      if (v == null || v === false) {
        delete next.deletedPptUrls[k];
      } else {
        next.deletedPptUrls[k] = true;
      }
    }
  }

  // Full replace modes when client sends replace flags
  if (body.replaceEntityRenames && typeof body.entityRenames === "object") {
    next.entityRenames = Object.fromEntries(
      Object.entries(body.entityRenames).filter(([, v]) => v != null && v !== "")
    );
  }
  if (body.replaceEdgeEdits && typeof body.edgeEdits === "object") {
    next.edgeEdits = {};
    for (const [k, v] of Object.entries(body.edgeEdits)) {
      if (v != null && typeof v === "object") next.edgeEdits[k] = v;
    }
  }

  return next;
}

export function kgEditsMiddleware(_env = process.env) {
  return async (req, res, next) => {
    try {
      const rawUrl = String(req.url || "");
      if (!rawUrl.startsWith("/api/kg-edits")) return next();

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      const { courseId, lectureId } = parseQuery(rawUrl);
      if (!courseId) {
        json(res, 400, { error: "courseId required" });
        return;
      }
      const file = patchPath(courseId, lectureId);
      if (!file) {
        json(res, 400, { error: "invalid courseId" });
        return;
      }

      if (req.method === "GET") {
        json(res, 200, readPatch(file, courseId, lectureId || "course"));
        return;
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        const base = readPatch(file, courseId, lectureId || "course");
        const merged = mergePatch(base, {
          ...body,
          courseId,
          lectureId: lectureId || body.lectureId || "course",
        });
        writePatchAtomic(file, merged);
        json(res, 200, merged);
        return;
      }

      json(res, 405, { error: "GET or POST only" });
    } catch (e) {
      json(res, 500, { error: String(e?.message || e) });
    }
  };
}
