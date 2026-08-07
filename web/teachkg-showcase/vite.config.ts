import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const dataRoot = path.join(repoRoot, "data");

function serveFile(urlPath: string, res: any, next: () => void) {
  try {
    const rel = decodeURIComponent(urlPath.split("?")[0].replace(/^\/+/, ""));
    const file = path.normalize(path.join(dataRoot, rel));
    if (!file.startsWith(dataRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const types: Record<string, string> = {
      ".json": "application/json; charset=utf-8",
      ".mp4": "video/mp4",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    };
    res.setHeader("Content-Type", types[ext] || "application/octet-stream");
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
        serveFile(req.url || "", res, next);
      });
    },
    configurePreviewServer(server: any) {
      server.middlewares.use("/repo-data", (req: any, res: any, next: any) => {
        serveFile(req.url || "", res, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveRepoData()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    fs: { allow: [repoRoot] },
    port: 5173,
  },
});
