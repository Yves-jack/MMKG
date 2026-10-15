import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { callLlm } from "./qaLlm.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
async function loadTs(rel) {
  // Exercise the real TypeScript modules with Vite's locked compiler dependency.
  const result = await build({
    entryPoints: [path.join(appRoot, rel)], bundle: true, write: false,
    format: "esm", platform: "node", alias: { "@": path.join(appRoot, "src") },
    define: { "import.meta.env": JSON.stringify({ BASE_URL: "/staging/kg/" }) },
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

test("100 percent and unset importance preserve isolated nodes and clear stale flags", async () => {
  const { applyImportanceFilter } = await loadTs("src/lib/kg/importanceFilter.ts");
  const nodes = [{ id: "isolated", importance: 0, filtered_by_importance: true }];
  for (const opts of [{ keepPercent: 100 }, {}, { keepPercent: 150 }]) {
    const result = applyImportanceFilter(nodes, [], opts);
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].filtered_by_importance, false);
    assert.equal(result.filteredCount, 0);
  }
  assert.equal(nodes[0].filtered_by_importance, true);
});

test("active importance filters still remove low importance nodes", async () => {
  const { applyImportanceFilter } = await loadTs("src/lib/kg/importanceFilter.ts");
  const result = applyImportanceFilter([{ id: "high", importance: 5 }, { id: "low", importance: 0 }], [], { keepPercent: 50, mode: "reveal" });
  assert.equal(result.nodes.find(n => n.id === "low").filtered_by_importance, true);
  assert.equal(result.filteredCount, 1);
});

test("legacy raw video course aliases resolve under the staging base without changing other media", async () => {
  const { toMediaUrl } = await loadTs("src/lib/kg/adaptToPipeline.ts");
  for (const course of ["数理逻辑", "图论", "集合论"]) {
    const result = decodeURIComponent(toMediaUrl(`data\\raw\\${course}\\video\\1.mp4`));
    assert.equal(result, "/staging/kg/repo-data/raw/离散数学(图论+数理逻辑与集合论)/video/1.mp4");
  }
  assert.equal(toMediaUrl("https://example.com/a.mp4"), "https://example.com/a.mp4");
  assert.equal(decodeURIComponent(toMediaUrl("data/segments/图论/a.mp4")), "/staging/kg/repo-data/segments/图论/a.mp4");
  assert.equal(toMediaUrl(null), null);
});

test("practice seed prefers the matched AI-Teaching ID rather than a graph ID", async () => {
  const { matchedKnowledgePointId, matchedKnowledgePointLabel, resolvePracticeSeedKp } = await loadTs("src/lib/integration/knowledgeResources.ts");
  const match = { matched_knowledge_points: [{ id: "kp-uuid", content: "最小生成树" }] };
  assert.equal(matchedKnowledgePointId(match), "kp-uuid");
  assert.equal(matchedKnowledgePointLabel(match), "最小生成树");
  assert.equal(resolvePracticeSeedKp({ matchedKpId: "kp-uuid", selectedNodeId: "graph-name" }), "kp-uuid");
  assert.equal(resolvePracticeSeedKp({ selectedNodeId: "graph-name", edgeEndpointId: "edge" }), "graph-name");
});

test("deployment temporary edit unlock is not restored for embedded students", async () => {
  const { canEditKnowledgeGraph } = await loadTs("src/lib/integration/editPermission.ts");
  assert.equal(canEditKnowledgeGraph({ embedMode: "ai-teaching", role: "student" }), false);
  assert.equal(canEditKnowledgeGraph({ embedMode: "ai-teaching", role: "teacher" }), true);
});

test("sync-data preserves note-match, merged textbook definitions and processed-graph artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mmkg-pr3-sync-"));
  const put = async (rel, value) => {
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, JSON.stringify(value));
  };
  try {
    const course = "离散数学(图论+数理逻辑与集合论)";
    const app = path.join(root, "web/teachkg-showcase");
    await fs.mkdir(path.join(app, "scripts"), { recursive: true });
    await fs.copyFile(path.join(appRoot, "scripts/sync-data.mjs"), path.join(app, "scripts/sync-data.mjs"));
    await put(`data/viz/${course}/mindmap_showcase.json`, { items: [] });
    await put(`data/viz/${course}/mindmaps/note_match/lecture_1.json`, { sentinel: "note-match" });
    await put(`web/teachkg-showcase/public/data/courses/${course}/mindmaps/student_mastery_course.json`, { sentinel: "mastery-tree" });
    await put(`data/viz/${course}/kg_processed_course.json`, { nodes: [], edges: [] });
    await put("data/textbook/CS2501-离散数学（图论+数理逻辑与集合论）/entity_final.json", [{ name: "最小生成树/MST", definition: "merged textbook definition" }]);
    await put(`data/kg/${course}/mmkg_enrichment.json`, { entities: [{ id: "额外概念", description: "enrichment definition" }] });
    execFileSync(process.execPath, [path.join(app, "scripts/sync-data.mjs")], { env: { ...process.env, TEACHKG_COURSE: course }, stdio: "pipe" });
    const out = path.join(app, "public/data/courses", course);
    const get = async rel => JSON.parse(await fs.readFile(path.join(out, rel), "utf8"));
    assert.equal((await get("mindmaps/note_match/lecture_1.json")).sentinel, "note-match");
    assert.equal((await get("mindmaps/student_mastery_course.json")).sentinel, "mastery-tree");
    const definitions = await get("entity_definitions.json");
    assert.equal(definitions["最小生成树"], "merged textbook definition");
    assert.equal(definitions["额外概念"], "enrichment definition");
    assert.deepEqual(await get("pipeline/kg_processed_course.json"), { nodes: [], edges: [] });
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LLM retries transient failures while preserving explicit deployment model/base", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) throw new Error("fetch failed");
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  };
  try {
    await callLlm({ LLM_API_KEY: "test-only", EXERCISE_LLM_BASE_URL: "http://unit.invalid/api", EXERCISE_LLM_MODEL: "deployment-model" }, [], { retries: 1 });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "http://unit.invalid/api/chat/completions");
    assert.equal(requests[1].body.model, "deployment-model");
  } finally { globalThis.fetch = original; }
});

test("LLM retries without JSON response format for incompatible upstreams", async () => {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: "unsupported response_format" } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  };
  try {
    await callLlm({ LLM_API_KEY: "test-only" }, [], { retries: 0 });
    assert.deepEqual(bodies[0].response_format, { type: "json_object" });
    assert.equal(bodies[1].response_format, undefined);
  } finally { globalThis.fetch = original; }
});
