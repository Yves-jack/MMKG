import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { recommendSearchMiddleware } from "./server/recommendSearch.mjs";
import { qaChatMiddleware } from "./server/qaLlm.mjs";
import { reviewNotesMiddleware } from "./server/reviewNotes.mjs";
import { practiceQuizMiddleware } from "./server/practiceQuiz.mjs";
import { kgEditsMiddleware } from "./server/kgEdits.mjs";
import { mindmapOutlineMiddleware } from "./server/mindmapOutline.mjs";
import { knowledgeResourcesMiddleware } from "./server/knowledgeResources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const dataRoot = path.join(repoRoot, "data");
const publicDataRoot = path.join(__dirname, "public", "data");

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    ".json": "application/json; charset=utf-8",
    ".mp4": "video/mp4",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".html": "text/html; charset=utf-8",
  };
  return types[ext] || "application/octet-stream";
}

function serveFileFromRoot(
  root: string,
  urlPath: string,
  req: any,
  res: any,
  next: () => void
) {
  try {
    let rel = decodeURIComponent(urlPath.split("?")[0].replace(/^\/+/, ""));
    // path 中 `+` 偶发被当成空格
    if (rel.includes("图论 ") && rel.includes("离散数学") && !rel.includes("图论+")) {
      rel = rel.replace(/图论 /g, "图论+");
    }
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const stat = fs.statSync(file);
    const size = stat.size;
    const type = contentTypeFor(file);
    const range = String(req?.headers?.range || "");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", type);

    // 大视频必须支持 Range，否则浏览器会整文件缓冲，表现为一直加载
    const m = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        start >= size
      ) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        res.end();
        return;
      }
      const safeEnd = Math.min(end, size - 1);
      const chunk = safeEnd - start + 1;
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${safeEnd}/${size}`);
      res.setHeader("Content-Length", String(chunk));
      fs.createReadStream(file, { start, end: safeEnd }).pipe(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Length", String(size));
    if (String(req?.method || "").toUpperCase() === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  } catch {
    next();
  }
}

function serveRepoData() {
  return {
    name: "serve-repo-data",
    configureServer(server: any) {
      server.middlewares.use("/repo-data", (req: any, res: any, next: any) => {
        serveFileFromRoot(dataRoot, req.url || "", req, res, next);
      });
      // 覆盖 Vite/sirv 对 %2B 不解码的问题，确保含 `+` 的课程目录可命中
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = String(req.url || "");
        if (url.startsWith("/data/courses/") || url.startsWith("/data/textbook_kg/")) {
          const rel = url.slice("/data/".length);
          serveFileFromRoot(publicDataRoot, rel, req, res, next);
          return;
        }
        return next();
      });
    },
    configurePreviewServer(server: any) {
      server.middlewares.use("/repo-data", (req: any, res: any, next: any) => {
        serveFileFromRoot(dataRoot, req.url || "", req, res, next);
      });
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = String(req.url || "");
        if (url.startsWith("/data/courses/") || url.startsWith("/data/textbook_kg/")) {
          const rel = url.slice("/data/".length);
          serveFileFromRoot(publicDataRoot, rel, req, res, next);
          return;
        }
        return next();
      });
    },
  };
}

/** 子路径部署时，把 /teachkg/api|/repo-data 还原成中间件认识的根路径 */
function stripBaseForApiPlugin(basePath: string) {
  const base = (basePath || "/").replace(/\/$/, "");
  const rewrite = (req: any, _res: any, next: () => void) => {
    if (!base || base === "/") return next();
    const url = String(req.url || "");
    for (const prefix of ["/api/", "/repo-data/"]) {
      if (url.startsWith(`${base}${prefix}`)) {
        req.url = url.slice(base.length);
        break;
      }
    }
    return next();
  };
  return {
    name: "strip-base-for-api",
    configureServer(server: any) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(rewrite);
    },
  };
}

function recommendSearchPlugin(env: Record<string, string>) {
  const searchMw = recommendSearchMiddleware({ ...process.env, ...env });
  const qaMw = qaChatMiddleware({ ...process.env, ...env });
  const notesMw = reviewNotesMiddleware({ ...process.env, ...env });
  const practiceMw = practiceQuizMiddleware({ ...process.env, ...env });
  const kgEditsMw = kgEditsMiddleware({ ...process.env, ...env });
  const outlineMw = mindmapOutlineMiddleware({ ...process.env, ...env });
  const resourcesMw = knowledgeResourcesMiddleware({ ...process.env, ...env });
  return {
    name: "recommend-search-api",
    configureServer(server: any) {
      server.middlewares.use(searchMw);
      server.middlewares.use(qaMw);
      server.middlewares.use(notesMw);
      server.middlewares.use(practiceMw);
      server.middlewares.use(kgEditsMw);
      server.middlewares.use(outlineMw);
      server.middlewares.use(resourcesMw);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(searchMw);
      server.middlewares.use(qaMw);
      server.middlewares.use(notesMw);
      server.middlewares.use(practiceMw);
      server.middlewares.use(kgEditsMw);
      server.middlewares.use(outlineMw);
      server.middlewares.use(resourcesMw);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const base = env.VITE_BASE_PATH || process.env.VITE_BASE_PATH || "/";
  return {
    base,
    plugins: [
      react(),
      stripBaseForApiPlugin(base),
      serveRepoData(),
      recommendSearchPlugin(env),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    server: {
      fs: { allow: [repoRoot] },
      port: 5173,
    },
    preview: {
      host: true,
      port: 5173,
      allowedHosts: true,
    },
  };
});
