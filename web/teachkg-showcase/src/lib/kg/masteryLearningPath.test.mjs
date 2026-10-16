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

test("hidden-label learning paths follow compact circle positions rather than old text widths", () => {
  const sequence = [
    { key: "a", score: 0 },
    { key: "b", score: 1 },
  ];
  const placed = [
    {
      key: "a",
      compact: true,
      side: 1,
      left: 0,
      top: 0,
      width: 112,
      height: 64,
      textWidth: 900,
    },
    {
      key: "b",
      compact: true,
      side: -1,
      left: 300,
      top: 0,
      width: 64,
      height: 64,
      textWidth: 900,
    },
  ];
  const [edge] = visibleLearningPath(sequence, placed);
  const numbers = edge.path.match(/-?[\d.]+/g).map(Number);
  assert.equal(numbers[1], 32);
  assert.equal(numbers.at(-1), 32);
  assert.ok(numbers[0] > 32 && numbers[0] < 80);
  assert.ok(numbers.at(-2) > 280 && numbers.at(-2) < 332);
});

test("free-layout arrows end beyond the enlarged badge and still connect close nodes", () => {
  const sequence = [
    { key: "a", score: 0 },
    { key: "b", score: 1 },
  ];
  const nodes = [0, 300].map((left, index) => ({
    key: sequence[index].key,
    free: true,
    depth: 3,
    left,
    top: 0,
    width: 100,
    height: 100,
    textWidth: 0,
  }));
  const [distant] = visibleLearningPath(sequence, nodes);
  const targetX = Number(distant.path.match(/([-\d.]+) ([-\d.]+)$/)[1]);
  assert.ok(targetX < 350 - (23.8 * 1.3 + 5) * 3);

  nodes[1].left = 180;
  const [close] = visibleLearningPath(sequence, nodes);
  assert.equal(close.from, "a");
  assert.equal(close.to, "b");
  assert.match(close.path, / C /);
});
