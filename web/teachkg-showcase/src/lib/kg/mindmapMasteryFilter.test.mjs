import assert from "node:assert/strict";
import test from "node:test";

import { filterMindmapByMastery } from "./mindmapMasteryFilter.mjs";

function node(id, zh = id, children = []) {
  return { id, zh, importance: 0.5, children };
}

function doc(root, extras = {}) {
  return {
    lecture_id: "course",
    root,
    roots: [root],
    n_nodes: 1,
    max_depth: 0,
    orphan_count: 0,
    ...extras,
  };
}

function ids(root) {
  return [root.id, ...root.children.flatMap(ids)];
}

test("keeps in-progress and weakest concepts before mastered or untouched nodes", () => {
  const source = doc(node("root", "课程", [
    node("complete", "已掌握"),
    node("unknown", "无记录"),
    node("developing", "学习中"),
    node("unlearned", "未学"),
    node("weak", "薄弱"),
  ]));
  const mastery = { 已掌握: 4.8, 学习中: 3.2, 未学: 0, 薄弱: 0.8 };

  const quarter = filterMindmapByMastery(source, mastery, 50);
  assert.deepEqual(ids(quarter.doc.root), ["root", "developing", "weak"]);
  assert.equal(quarter.stats.visibleNodes, 3);
  assert.equal(quarter.stats.hiddenNodes, 3);
  assert.deepEqual(quarter.stats.visibleByStatus, {
    learning: 2, mastered: 0, unlearned: 0, unrecorded: 1,
  });

  const expanded = filterMindmapByMastery(source, mastery, 100 * 4 / 6);
  assert.deepEqual(ids(expanded.doc.root), ["root", "complete", "developing", "weak"]);
  assert.equal(expanded.stats.visibleNodes, 4);
});

test("keeps roots and the selected node's exact ancestor chain even at zero percent", () => {
  const selected = node("selected", "目标");
  const source = doc(node("root", "课程", [
    node("left", "左", [node("other", "其他")]),
    node("right", "右", [selected]),
  ]));
  const { doc: result, stats } = filterMindmapByMastery(
    source, new Map([["目标", 0]]), 0, { selectedId: "selected" },
  );
  assert.deepEqual(ids(result.root), ["root", "right", "selected"]);
  assert.equal(stats.requestedNodes, 0);
  assert.equal(stats.mandatoryNodes, 3);
  assert.equal(stats.visibleNodes, 3);
  assert.equal(result.max_depth, 2);
});

test("selectedPath protects one duplicate-ID occurrence and preserves original indices", () => {
  const source = doc(node("root", "课程", [
    node("left", "左", [node("same", "左侧节点")]),
    node("right", "右", [node("same", "右侧节点")]),
  ]));
  const before = structuredClone(source);
  const { doc: result, stats } = filterMindmapByMastery(source, {}, 0, {
    selectedId: "same",
    selectedPath: [0, 1, 0],
  });

  assert.deepEqual(ids(result.root), ["root", "right", "same"]);
  assert.equal(result.root.children[0].children[0].zh, "右侧节点");
  assert.deepEqual(result.root.__sourcePath, [0]);
  assert.deepEqual(result.root.children[0].__sourcePath, [0, 1]);
  assert.deepEqual(result.root.children[0].children[0].__sourcePath, [0, 1, 0]);
  assert.equal(stats.mandatoryNodes, 3);
  assert.deepEqual(source, before);
});

test("excludes lecture subtrees from filtering without renumbering source paths", () => {
  const source = doc(node("root", "课程", [
    node("left", "左"),
    node("__lecture__/week-1", "第一讲", [node("ghost", "讲次占位")]),
    node("right", "右", [node("target", "目标")]),
  ]));
  const { doc: result, stats } = filterMindmapByMastery(source, {}, 0, {
    selectedPath: [0, 2, 0], balanceDomains: true,
  });

  assert.equal(stats.totalNodes, 4);
  assert.equal(stats.visibleNodes, 3);
  assert.equal(stats.hiddenNodes, 1);
  assert.deepEqual(ids(result.root), ["root", "right", "target"]);
  assert.deepEqual(result.root.children[0].__sourcePath, [0, 2]);
  assert.deepEqual(result.root.children[0].children[0].__sourcePath, [0, 2, 0]);
});

test("preserves hierarchy and original sibling order without mutating source", () => {
  const source = doc(node("root", "课程", [
    node("branch", "分支", [node("weak", "薄弱"), node("hidden", "未学")]),
    node("complete", "已掌握"),
  ]), {
    remoteLinks: [
      { id: "kept", from: "branch", to: "weak" },
      { id: "removed", from: "hidden", to: "complete" },
    ],
  });
  const before = structuredClone(source);
  const first = filterMindmapByMastery(source, { 薄弱: 1, 未学: 0, 已掌握: 5 }, 60);
  const second = filterMindmapByMastery(source, { 薄弱: 1, 未学: 0, 已掌握: 5 }, 60);

  assert.deepEqual(ids(first.doc.root), ["root", "branch", "weak"]);
  assert.deepEqual(first.doc.remoteLinks, [{ id: "kept", from: "branch", to: "weak" }]);
  assert.deepEqual(first, second);
  assert.deepEqual(source, before);
  assert.notEqual(first.doc.root, source.root);
  assert.notEqual(first.doc.root.children[0], source.root.children[0]);
});

test("handles multiple roots, duplicate selected IDs, and clamped percentages", () => {
  const source = doc(node("one", "一", [node("same", "重复")]), {
    roots: [
      node("one", "一", [node("same", "重复")]),
      node("two", "二", [node("same", "重复")]),
    ],
  });
  const result = filterMindmapByMastery(source, {}, -10, { selectedId: "same" });
  assert.equal(result.stats.requestedPercent, 0);
  assert.equal(result.stats.mandatoryNodes, 4);
  assert.equal(result.doc.roots.length, 2);
  assert.deepEqual(result.doc.roots.map(ids), [["one", "same"], ["two", "same"]]);
  assert.equal(filterMindmapByMastery(source, {}, 200).stats.visibleNodes, 4);
});

test("distinguishes zero from missing and ignores invalid scores", () => {
  const source = doc(node("root", "课程", [
    node("zero", "零"), node("bad", "坏"), node("low", "低"),
  ]));
  const result = filterMindmapByMastery(source, { 零: 0, 坏: Number.NaN, 低: 1.5 }, 100);
  assert.deepEqual(result.stats.totalByStatus, {
    learning: 1, mastered: 0, unlearned: 1, unrecorded: 2,
  });
  assert.equal(result.stats.actualPercent, 100);
});

test("percentage changes are monotone and preferentially open paths to weak nodes", () => {
  const source = doc(node("root", "课程", [
    node("mastered", "熟练"),
    node("part", "分册", [
      node("chapter", "章", [node("weak", "薄弱")]),
    ]),
    node("untouched", "未学"),
  ]));
  const mastery = { 熟练: 4.8, 薄弱: 1.1, 未学: 0 };
  let previous = new Set();
  for (const percent of [0, 20, 40, 60, 80, 100]) {
    const { doc: filtered } = filterMindmapByMastery(source, mastery, percent);
    const current = new Set(ids(filtered.root));
    for (const id of previous) assert.ok(current.has(id), `${id} disappeared at ${percent}%`);
    previous = current;
  }
  assert.deepEqual(ids(filterMindmapByMastery(source, mastery, 50).doc.root), [
    "root", "part", "chapter",
  ]);
  assert.deepEqual(ids(filterMindmapByMastery(source, mastery, 67).doc.root), [
    "root", "mastered", "part", "chapter", "weak",
  ]);
});

test("optional domain balancing distributes budget by original subtree size", () => {
  const branch = (id, size) => node(id, id, Array.from({ length: size - 1 }, (_, index) =>
    node(`${id}-${index}`, `${id}-${index}`)));
  const source = doc(node("root", "课程", [
    branch("small", 4), branch("medium", 7), branch("large", 10),
  ]));
  const mastery = {
    ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`small-${index}`, 1])),
    "medium-0": 0.5,
    ...Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`medium-${index + 1}`, 4.5])),
  };
  let previous = new Set();
  for (const percent of [0, 25, 50, 75, 100]) {
    const { doc: result, stats } = filterMindmapByMastery(source, mastery, percent, {
      balanceDomains: true,
    });
    const current = new Set(ids(result.root));
    for (const id of previous) assert.ok(current.has(id), `${id} disappeared at ${percent}%`);
    previous = current;
    assert.equal(stats.visibleNodes, Math.max(1, Math.ceil(22 * percent / 100)));
    if (percent === 50) {
      const counts = result.root.children.map((child) => ids(child).length);
      assert.equal(counts.reduce((sum, count) => sum + count, 0), 10);
      for (const [index, size] of [4, 7, 10].entries()) {
        assert.ok(Math.abs(counts[index] - 10 * size / 21) <= 1.5,
          `domain ${index} has ${counts[index]} visible nodes`);
      }
      assert.ok(current.has("medium-0"), "weakest item inside medium domain stays visible");
    }
  }
  const global = filterMindmapByMastery(source, mastery, 50);
  assert.ok(global.doc.root.children.some((child) => child.id === "small"));
});
