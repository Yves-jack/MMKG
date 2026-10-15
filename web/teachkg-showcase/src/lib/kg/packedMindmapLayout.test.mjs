import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  layoutPackedMindmap,
  preparePackedMindmap,
} from "./packedMindmapLayout.mjs";
import { collapseMindmap } from "./mindmapMasteryBinding.mjs";
const measure = (text, size) =>
  [...text].reduce(
    (sum, c) => sum + (c.charCodeAt(0) < 128 ? 0.55 : 1) * size,
    0,
  );

test("chapter packing matches an independent oracle executed from the ZIP Python source", () => {
  const golden = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/zipPackedLayout.golden.json", import.meta.url),
    ),
  );
  const records = golden.nodes.map(([key, parent, depth, w, h]) => ({
    key,
    node: { id: key, zh: key, children: [] },
    depth,
    branch: key.startsWith("D0") ? 0 : 1,
    children: golden.nodes.filter((row) => row[1] === key).map((row) => row[0]),
    spec: { w, h, fontSize: 27, lines: [key], textWidth: w - 24, extra: 0 },
  }));
  const result = layoutPackedMindmap({ rootKey: "root", records });
  for (const plan of result.plans)
    assert.deepEqual(
      { plan: plan.plan, height: plan.height },
      golden.expected[`${plan.domain}/${plan.side}`],
    );
  assert.equal(result.nodes.length, records.length);
  assert.equal(result.edges.length, records.length - 1);
});

test("mixed leaf and non-leaf children use the ZIP two-column leaf grid without changing identity", () => {
  const leaf = (i) => ({ id: `leaf-${i}`, zh: `叶 ${i}`, children: [] });
  const section = {
    id: "section",
    zh: "节",
    children: [
      leaf(0),
      { id: "sub", zh: "子树", children: [leaf(9)] },
      ...Array.from({ length: 5 }, (_, i) => leaf(i + 1)),
    ],
  };
  const chapter = { id: "chapter", zh: "章", children: [section] };
  const domain = { id: "domain", zh: "分支", children: [chapter] };
  const root = { id: "root", zh: "课", children: [domain] };
  const input = preparePackedMindmap({ root }, measure);
  const before = JSON.stringify(root),
    result = layoutPackedMindmap(input);
  const leaves = result.nodes.filter(
    (n) => n.node.id.startsWith("leaf-") && n.node.id !== "leaf-9",
  );
  assert.equal(new Set(leaves.map((n) => n.left)).size, 2);
  assert.equal(result.nodes.length, input.records.length);
  assert.equal(JSON.stringify(root), before);
  for (let i = 0; i < result.nodes.length; i++)
    for (let j = i + 1; j < result.nodes.length; j++) {
      const a = result.nodes[i],
        b = result.nodes[j];
      assert.ok(
        a.right <= b.left ||
          b.right <= a.left ||
          a.bottom <= b.top ||
          b.bottom <= a.top,
        `${a.key} overlaps ${b.key}`,
      );
    }
});

test("wrapping bounds long labels and folded duplicate IDs retain source occurrences", () => {
  const child = { id: "same", zh: "很长的知识点名称".repeat(10), children: [] };
  const root = {
    id: "root",
    zh: "课",
    children: [
      {
        id: "domain",
        zh: "分支",
        children: [
          { id: "chapter", zh: "章", children: [child, { ...child }] },
        ],
      },
    ],
  };
  const input = preparePackedMindmap({ root }, measure);
  assert.equal(
    new Set(input.records.map((n) => n.key)).size,
    input.records.length,
  );
  assert.ok(
    input.records.find((n) => n.node.id === "same").spec.lines.length > 1,
  );
  const closed = preparePackedMindmap(collapseMindmap({ root }, 2), measure);
  assert.equal(closed.records.length, 3);
  assert.equal(layoutPackedMindmap(closed).nodes.length, 3);
});

test("the complete course retains every occurrence and has no overlapping node/control boxes", (t) => {
  const doc = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../../public/data/courses/离散数学(图论+数理逻辑与集合论)/mindmaps/student_mastery_course.json",
        import.meta.url,
      ),
    ),
  );
  for (const depth of [2, 3, 99]) {
    const input = preparePackedMindmap(collapseMindmap(doc, depth), measure);
    const start = performance.now(),
      result = layoutPackedMindmap(input);
    assert.equal(result.nodes.length, input.records.length);
    if (depth === 3) {
      const section = result.nodes.find(n => n.node.zh === "图的定义");
      assert.ok(section, "default expansion includes chapter sections");
      assert.ok(!result.nodes.some(n => n.key.startsWith(section.key + ".")), "knowledge below the section remains collapsed");
    }
    for (let i = 0; i < result.nodes.length; i++)
      for (let j = i + 1; j < result.nodes.length; j++) {
        const a = result.nodes[i],
          b = result.nodes[j];
        assert.ok(
          a.right <= b.left ||
            b.right <= a.left ||
            a.bottom <= b.top ||
            b.bottom <= a.top,
          `${a.key} overlaps ${b.key}`,
        );
      }
    t.diagnostic(
      `${result.nodes.length} nodes: ${Math.round(performance.now() - start)} ms, no rectangle overlaps`,
    );
  }
});
