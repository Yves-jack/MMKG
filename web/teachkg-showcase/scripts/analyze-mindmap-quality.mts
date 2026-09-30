/**
 * 实课导图质量快照（数理逻辑 L1–L4）
 * npx vite-node scripts/analyze-mindmap-quality.mts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMindmapFromForest,
  collectMindmapTreeEdges,
  mindmapQualityStats,
} from "../src/lib/kg/mindmapFromProcessedGraph";
import { loadReviewClassroomGraph } from "../src/lib/apps/loadReviewClassroomGraph";
import type { MindmapTreeNode } from "../src/components/mindmap/MindmapTree";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const courseId = "数理逻辑";
const dataRoot = path.resolve(
  __dirname,
  "../public/data/courses",
  courseId
);

const gFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  const m = url.match(/\/data\/courses\/[^/]+\/(.+?)(?:\?|$)/);
  if (m) {
    const rel = decodeURIComponent(m[1]);
    const fp = path.join(dataRoot, rel);
    if (!fs.existsSync(fp)) {
      return new Response("missing", { status: 404 });
    }
    const body = fs.readFileSync(fp);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return gFetch(input as any, init);
}) as typeof fetch;

function indentTree(n: MindmapTreeNode, depth = 0, lines: string[] = [], max = 40) {
  if (lines.length >= max) return lines;
  const flags = [
    n.weak ? "弱" : "",
    n.copy ? "副本" : "",
    n.salvaged ? "补充" : "",
    n.deps?.length ? `依${n.deps.length}` : "",
  ]
    .filter(Boolean)
    .join(",");
  const pad = "  ".repeat(depth);
  lines.push(
    `${pad}- ${n.zh} (${n.relation || "-"}) imp=${(n.importance || 0).toFixed(2)}${flags ? `[${flags}]` : ""}${n.children.length ? "" : " kids=0"}`
  );
  for (const c of n.children) indentTree(c, depth + 1, lines, max);
  return lines;
}

function findInvertPairs(n: MindmapTreeNode, out: string[] = []) {
  for (const c of n.children || []) {
    if (
      !n.id.startsWith("__lecture__/") &&
      !c.weak &&
      !c.copy &&
      (c.importance || 0) - (n.importance || 0) > 0.2
    ) {
      out.push(`${n.zh}(${(n.importance || 0).toFixed(2)})←${c.zh}(${(c.importance || 0).toFixed(2)})`);
    }
    findInvertPairs(c, out);
  }
  return out;
}

function topLevel(n: MindmapTreeNode): MindmapTreeNode[] {
  if (n.id.startsWith("__lecture__/")) return n.children || [];
  return [n];
}

async function analyze(lid: string) {
  const g = await loadReviewClassroomGraph(courseId, lid, {
    importanceSource: "pagerank",
  });
  const doc = buildMindmapFromForest(g.forest, { lectureId: lid });
  if (!doc) {
    console.log(`\n===== L${lid} EMPTY =====`);
    return;
  }
  const qs = mindmapQualityStats(doc.root);
  const edges = collectMindmapTreeEdges(doc.root);
  const retain = g.stats.nodes ? doc.n_nodes / g.stats.nodes : 0;
  const inverts = findInvertPairs(doc.root);
  const tops = topLevel(doc.root);

  // 谓词出现次数
  let pred = 0;
  const walk = (n: MindmapTreeNode) => {
    if (n.zh === "谓词" || n.id.startsWith("谓词/")) pred += 1;
    for (const c of n.children) walk(c);
  };
  walk(doc.root);

  console.log(`\n===== L${lid} =====`);
  console.log(
    `graph=${g.stats.nodes}n/${g.stats.edges}e → mindmap=${doc.n_nodes} depth=${doc.max_depth} virtual=${Boolean(doc.meta?.virtual_root)} retain=${retain.toFixed(2)}`
  );
  console.log(
    `leafRatio=${qs.leafRatio.toFixed(2)} copies=${qs.copies} salvaged=${qs.salvaged} invertStrong=${qs.invertEdges} attached_orphans=${doc.meta?.attached_orphans || 0}`
  );
  console.log(`谓词出现=${pred} 强倒挂边=${inverts.slice(0, 5).join(" | ") || "无"}`);
  console.log(
    `顶层(${tops.length}): ${tops.map((t) => `${t.zh}@${(t.importance || 0).toFixed(2)}${t.salvaged ? "[补]" : ""}`).join(" · ")}`
  );

  // 抽样：命题逻辑/谓词逻辑父子
  const sample = edges.filter(
    (e) =>
      e.parent.includes("谓词逻辑") ||
      e.child.includes("谓词逻辑") ||
      e.parent.includes("命题逻辑") ||
      e.child.includes("命题逻辑") ||
      e.parent.includes("量词") ||
      e.child.includes("全称") ||
      e.child.includes("存在")
  );
  console.log(
    "关键边抽样:",
    sample
      .slice(0, 12)
      .map((e) => `${e.child.split("/")[0]}-${e.rel}→${e.parent.split("/")[0]}`)
      .join("; ") || "(无)"
  );
  console.log(indentTree(doc.root).join("\n"));
}

for (const lid of ["1", "2", "3", "4"]) {
  await analyze(lid);
}
