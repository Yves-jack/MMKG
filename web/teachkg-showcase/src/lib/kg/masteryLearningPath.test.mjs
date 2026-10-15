import test from "node:test";
import assert from "node:assert/strict";
import {
  masteryLearningPath,
  visibleLearningPath,
} from "./masteryLearningPath.mjs";
const n = (id, children = []) => ({ id, zh: id, children });
const chapter = n("__chapter__/1", [
  n("a", [n("deep")]),
  n("b"),
  n("boundary"),
  n("unknown"),
  n("invalid"),
]);
const doc = {
  root: n("course", [
    n("part", [chapter, n("__chapter__/2", [n("next")])]),
    n("part2", [n("__chapter__/3", [n("a")])]),
  ]),
};
const scores = { a: 0, b: 2.49, deep: 1, boundary: 2.5, invalid: NaN, next: 2 };
test("chapters retain source order; each section and all descendants finish before the next section", () => {
  const sequence = masteryLearningPath(doc, scores);
  assert.deepEqual(
    sequence.map((s) => s.label),
    ["a", "deep", "b", "next", "a"],
  );
  assert.deepEqual(
    sequence.map((s) => s.key),
    ["0.0.0.0", "0.0.0.0.0", "0.0.0.1", "0.0.1.0", "0.1.0.0"],
  );
});
test("zero is eligible, exactly 2.5 and absent/invalid scores are excluded", () => {
  assert.deepEqual(
    masteryLearningPath(doc, scores).map((s) => s.score),
    [0, 1, 2.49, 2, 0],
  );
  assert.deepEqual(masteryLearningPath(doc, {}), []);
});
test("collapsed/filtered nodes never acquire proxy arrows and visible ordering is stable", () => {
  const sequence = masteryLearningPath(doc, scores);
  const placed = [sequence[3], sequence[0], sequence[4]].map((s, i) => ({
    key: s.key,
    depth: 3,
    extra: 104,
    textWidth: 160,
    left: i * 300,
    top: i * 200,
    height: 60,
    side: i % 2 ? -1 : 1,
  }));
  const edges = visibleLearningPath(sequence, placed);
  assert.deepEqual(
    edges.map((e) => [e.from, e.to]),
    [
      [sequence[0].key, sequence[3].key],
      [sequence[3].key, sequence[4].key],
    ],
  );
  assert.ok(
    edges.every(
      (e) => /^M [-\d.]+ [-\d.]+ Q /.test(e.path) && !e.path.includes("NaN"),
    ),
  );
  assert.deepEqual(visibleLearningPath(sequence, []), []);
  assert.deepEqual(visibleLearningPath(sequence, placed.slice(0, 1)), []);
});
