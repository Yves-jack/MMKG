import test from "node:test";
import assert from "node:assert/strict";
import { resolveVideoPracticeContext, buildVideoPracticeResource } from "./videoPracticeContext.mjs";

const points = [
  { id: "tree", zh: "最小生成树", evidence: [{ start_sec: 59 }] },
  { id: "subtree", zh: "生成树" },
  { id: "path", zh: "最短路径" },
];
const captions = [
  { start: 0, end: 10, text: "最小生成树的定义" },
  { start: 10, end: 20, text: "下面来看最短路径" },
  { start: 20, end: 30, text: "我们再来看一个例子" },
  { start: 60, end: 70, text: "最小生成树" },
];
const resolve = (extra = {}) => resolveVideoPracticeContext({ points, captions, sec: 15, ...extra });

test("clicked concept takes precedence over a previous search and subtitles", () => {
  const context = resolve({ selected: { id: "tree", zh: "最小生成树" }, search: "最短路径" });
  assert.equal(context.source, "selection");
  assert.equal(context.points[0].id, "tree");
});
test("search concept takes precedence over subtitle and point evidence timestamps", () => {
  assert.equal(resolve({ search: "最小生成树" }).points[0].id, "tree");
});
test("current subtitle takes precedence over all graph evidence timestamps", () => {
  const context = resolve({ sec: 65, points: [{ ...points[2], evidence: [{ start_sec: 64 }] }, ...points.slice(0, 2)] });
  assert.deepEqual(context.points.map(p => p.id), ["tree"]);
  assert.equal(context.captionStart, 60);
});
test("empty current subtitle searches backwards for the nearest concept", () => {
  const context = resolve({ sec: 25 });
  assert.deepEqual(context.points.map(p => p.id), ["path"]);
  assert.equal(context.captionStart, 10);
});
test("future subtitles are never used, even within a fraction of a second", () => {
  assert.equal(resolve({ sec: 59.9 }).points[0].id, "path");
  assert.equal(resolve({ sec: 0, captions: [{ start: 0.1, end: 1, text: "最小生成树" }] }), null);
});
test("playback at zero uses the first subtitle and prefers the complete concept", () => {
  assert.deepEqual(resolve({ sec: 0 }).points.map(p => p.id), ["tree"]);
});
test("catalog concepts can match subtitles when the current review graph is unavailable", () => {
  assert.equal(resolve({ points: [], catalog: points }).points[0].id, "path");
});
test("unordered subtitles are scanned by time rather than input order", () => {
  assert.equal(resolve({ captions: [...captions].reverse(), sec: 25 }).points[0].id, "path");
});
test("an unrelated or cleared search does not reuse a stale URL knowledge point", () => {
  assert.equal(resolve({ search: "随便输入" }).points[0].id, "path");
  assert.equal(resolve({ search: "" }).points[0].id, "path");
});
test("no known subtitle concept or empty subtitle data produces no invented fallback", () => {
  assert.equal(resolve({ captions: [] }), null);
  assert.equal(resolve({ captions: [{ start: 0, end: 100, text: "今天开始上课" }] }), null);
  assert.equal(resolve({ sec: -1 }), null);
});
test("multiple distinct concepts in the nearest subtitle retain their spoken order", () => {
  const context = resolve({ captions: [{ start: 0, end: 20, text: "比较最短路径与最小生成树" }] });
  assert.deepEqual(context.points.map(p => p.id), ["path", "tree"]);
});
test("practice payload uses official matched IDs and labels at every routing field", async () => {
  const context = resolve({ search: "最小生成树" });
  const result = await buildVideoPracticeResource(context, "92311", async point => {
    assert.equal(point.id, "tree");
    return { match: { matched_knowledge_points: [{ id: "official-uuid", content: "最小生成树" }] },
      resources: [{ knowledge_point_id: "unrelated-question-kp" }] };
  });
  assert.equal(result.resource_id, "official-uuid");
  assert.deepEqual(result.knowledge_point_ids, ["official-uuid"]);
  assert.equal(result.metadata.seed_knowledge_point_id, "official-uuid");
  assert.equal(result.metadata.seed_knowledge_point_label, "最小生成树");
  assert.equal(result.metadata.practice_mode, "knowledge_point");
});
test("failed official matching stops navigation instead of passing a graph ID", async () => {
  await assert.rejects(buildVideoPracticeResource(resolve(), "92311", async () => ({ match: {} })), /未找到对应/);
  await assert.rejects(buildVideoPracticeResource(resolve(), "92311", async () => { throw new Error("upstream unavailable"); }), /upstream unavailable/);
});
