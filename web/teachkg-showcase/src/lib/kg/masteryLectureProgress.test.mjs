import test from "node:test";
import assert from "node:assert/strict";
import { filterMindmapByLectureProgress, loadPersonalMasteryProgress, personalMasteryLectureLimit } from "./masteryLectureProgress.mjs";
import { filterMindmapByMastery } from "./mindmapMasteryFilter.mjs";
import { collapseMindmap } from "./mindmapMasteryBinding.mjs";
import { masteryLearningPath } from "./masteryLearningPath.mjs";
const node = (id, children = [], zh = id) => ({ id, zh, importance: .5, related: [], children });
const makeDoc = () => {
  const root = node("__course__/course", [node("__part__/graph", [node("__chapter__/one", [
    node("__section__/section", [node("early"), node("tenth"), node("eleventh")]),
  ])]), node("__part__/future", [node("__chapter__/later", [node("future")])])]);
  return { root, roots: [root], n_nodes: 10, max_depth: 4, orphan_count: 0, meta: { scope: "course" },
    remoteLinks: [{ from: "early", to: "tenth" }, { from: "early", to: "future" }] };
};
const sources = () => Array.from({ length: 11 }, (_, i) => ({ lecture_id: String(i + 1), nodes: [{ id: i === 9 ? "tenth" : i === 10 ? "eleventh" : "early" }] }));
const ids = (doc) => {
  const out = [];
  const walk = (n) => { out.push(n.id); n.children.forEach(walk); };
  (doc.roots || [doc.root]).forEach(walk);
  return out;
};
test("lecture 10 is inclusive, 11 excluded; preserve ancestors/order without unrelated branches", () => {
  const original = makeDoc(), snapshot = structuredClone(original);
  const result = filterMindmapByLectureProgress(original, sources(), 10);
  assert.deepEqual(ids(result), ["__course__/course", "__part__/graph", "__chapter__/one", "__section__/section", "early", "tenth"]);
  assert.equal(result.n_nodes, 6);
  assert.equal(result.max_depth, 4);
  assert.equal(result.meta.n_chapters, 1);
  assert.equal(result.meta.n_parts, 1);
  assert.deepEqual(result.meta.lecture_ids, Array.from({ length: 10 }, (_, i) => String(i + 1)));
  assert.deepEqual(result.remoteLinks, [{ from: "early", to: "tenth" }]);
  assert.equal(result.root, result.roots[0]);
  assert.deepEqual(original, snapshot);
});
test("a taught parent does not expose untaught descendants, even at full expansion/100%", () => {
  const doc = { root: node("__course__/course", [node("parent", [node("future")])]), n_nodes: 3, max_depth: 2 };
  const limited = filterMindmapByLectureProgress(doc, [{ lecture_id: "1", nodes: [{ id: "parent" }] }], 1);
  const full = collapseMindmap(filterMindmapByMastery(limited, { parent: 1, future: 0 }, 100).doc, 100);
  assert.deepEqual(ids(full), ["__course__/course", "parent"]);
  assert.ok(masteryLearningPath(limited, { parent: 1, future: 0 }).every(n => n.id !== "future"));
});
test("bilingual identities match exactly; do not fuzzy match future concepts", () => {
  const doc = { root: node("__course__/course", [node("__topic__/x/平面图", [], "平面图"), node("__topic__/x/平面图判定", [], "平面图判定")]) };
  const result = filterMindmapByLectureProgress(doc, [{ lecture_id: "1", nodes: [{ id: "平面图/planar graph" }] }], 1);
  assert.deepEqual(ids(result), ["__course__/course", "__topic__/x/平面图"]);
});
test("missing lecture evidence fails closed instead of showing the entire future course", () => {
  assert.throws(() => filterMindmapByLectureProgress(makeDoc(), sources().filter(s => s.lecture_id !== "10"), 10), /缺少第 10 讲/);
  assert.throws(() => filterMindmapByLectureProgress(makeDoc(), sources(), 0), /正整数/);
});
test("prefer uncapped processed lecture KG; fallback to lecture map when absent", async () => {
  const requested = [];
  const result = await loadPersonalMasteryProgress(makeDoc(), 2, async (path) => {
    requested.push(path);
    if (path === "pipeline/kg_processed_lecture_1.json") return { lecture_id: "1", nodes: [{ id: "early" }] };
    if (path === "mindmaps/lecture_1.json") return { lecture_id: "1", root: node("__lecture__/1", [node("early")]) };
    if (path === "mindmaps/lecture_2.json") return { lecture_id: "2", root: node("__lecture__/2", [node("tenth")]) };
    return null;
  });
  assert.deepEqual(ids(result).slice(-2), ["early", "tenth"]);
  assert.ok(requested.includes("pipeline/kg_processed_lecture_1.json"));
  assert.ok(requested.includes("mindmaps/lecture_2.json"));
});
test("wrong lecture artifact cannot stand in for a completed lecture", async () => {
  await assert.rejects(loadPersonalMasteryProgress(makeDoc(), 1, async () => ({ lecture_id: "11", nodes: [{ id: "eleventh" }] })), /缺少第 1 讲/);
});
test("progress is course-specific, unrelated courses have no cutoff", () => {
  assert.equal(personalMasteryLectureLimit("离散数学(图论+数理逻辑与集合论)"), 10);
  assert.equal(personalMasteryLectureLimit("other course"), null);
});

test("same-name concepts in future chapters do not acquire earlier chapter evidence", () => {
  const doc = { root: node("__course__/course", [
    node("__chapter__/early", [node("__topic__/early/公理", [], "公理")], "第1章 已讲"),
    node("__chapter__/future", [node("__topic__/later/公理", [], "公理")], "第3章 未讲"),
  ]) };
  const result = filterMindmapByLectureProgress(doc, [{ lecture_id: "1", chapter_names: ["第1章 已讲"], nodes: [{ id: "公理/axiom" }] }], 1);
  assert.deepEqual(ids(result), ["__course__/course", "__chapter__/early", "__topic__/early/公理"]);
});

test("completed graph lectures do not show introductory set or logic branches", async () => {
  const root = node("__course__/course", [
    node("__part__/graph", [node("__chapter__/graph", [node("graph-concept")], "第1章 图的基本概念")]),
    node("__part__/set", [node("__chapter__/set", [node("set-concept")], "第9章 集合")]),
  ]);
  const result = await loadPersonalMasteryProgress({ root }, 1, async (path) => {
    if (path.startsWith("pipeline/")) return { lecture_id: "1", nodes: [{ id: "graph-concept" }, { id: "set-concept" }] };
    return { lecture_id: "1", root: node("__lecture__/1", [
      node("__chapter__/graph", [node("graph-concept")], "第1章 图的基本概念"),
      node("__chapter__/set", [node("set-concept")], "第9章 集合"),
    ]) };
  }, "离散数学(图论+数理逻辑与集合论)");
  assert.deepEqual(ids(result), ["__course__/course", "__part__/graph", "__chapter__/graph", "graph-concept"]);
});
