import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createMasteryForce,
  advanceMasteryForce,
  moveMasteryForce,
  renderMasteryForce,
} from "./masteryForceLayout.mjs";
import { preparePackedMindmap } from "./packedMindmapLayout.mjs";
import { collapseMindmap, masteryVisual } from "./mindmapMasteryBinding.mjs";
import { freeMasteryGeometry, mindmapMarkerPositions } from "./mindmapMarkerPositions.mjs";
import { filterMindmapByMastery } from "./mindmapMasteryFilter.mjs";
import {
  masteryLearningPath,
  visibleLearningPath,
} from "./masteryLearningPath.mjs";
const measure = (text, size) => text.length * size;
const doc = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../public/data/courses/离散数学(图论+数理逻辑与集合论)/mindmaps/student_mastery_course.json",
      import.meta.url,
    ),
  ),
);
test("free physics uses every current tree occurrence and parent edge without a 60-node cap", () => {
  const input = preparePackedMindmap(collapseMindmap(doc, 99), measure);
  const before = JSON.stringify(input);
  const sim = createMasteryForce(input);
  const result = renderMasteryForce(sim);
  assert.equal(result.nodes.length, 433);
  assert.deepEqual(
    new Set(result.nodes.map((n) => n.key)),
    new Set(input.records.map((n) => n.key)),
  );
  assert.deepEqual(
    result.edges.map((e) => [e.parent, e.child]),
    input.records.flatMap((n) => n.children.map((c) => [n.key, c])),
  );
  for (let i = 0; i < 40; i++)
    assert.ok(Number.isFinite(advanceMasteryForce(sim)));
  assert.ok(
    [...sim.bodies.values()].every(
      (n) => Number.isFinite(n.x) && Number.isFinite(n.y),
    ),
  );
  assert.equal(JSON.stringify(input), before);
});
test("dragging pins only the requested occurrence and updates its edges and personal arrows", () => {
  const input = preparePackedMindmap(collapseMindmap(doc, 3), measure);
  const sim = createMasteryForce(input);
  const keys = input.records
    .filter((n) => n.depth === 3)
    .slice(0, 2)
    .map((n) => n.key);
  const before = renderMasteryForce(sim);
  const arrowsBefore = visibleLearningPath(
    keys.map((key) => ({ key, score: 1 })),
    before.nodes,
  );
  const original = { ...sim.bodies.get(keys[0]) };
  const neighbour = { ...sim.bodies.get(keys[1]) };
  moveMasteryForce(sim, keys[0], 180, -95);
  assert.equal(sim.bodies.get(keys[0]).x, original.x + 180);
  assert.equal(sim.bodies.get(keys[1]).x, neighbour.x);
  const after = renderMasteryForce(sim);
  assert.notDeepEqual(
    after.edges.filter((e) => e.child === keys[0]),
    before.edges.filter((e) => e.child === keys[0]),
  );
  assert.notDeepEqual(
    visibleLearningPath(
      keys.map((key) => ({ key, score: 1 })),
      after.nodes,
    ),
    arrowsBefore,
  );
  advanceMasteryForce(sim);
  assert.equal(sim.bodies.get(keys[0]).x, original.x + 180);
  assert.equal(sim.bodies.get(keys[0]).fixed, true);
});
test("larger free-layout badges and labels fit the physics footprint", () => {
  const input = preparePackedMindmap(collapseMindmap(doc, 3), measure);
  const nodes = renderMasteryForce(createMasteryForce(input)).nodes;
  const largestOuterRadius = masteryVisual(0).radius * freeMasteryGeometry.badgeScale + 5.5;
  for (const node of nodes.filter((entry) => entry.depth > 0)) {
    const marker = mindmapMarkerPositions(node);
    const source = input.records.find((record) => record.key === node.key);
    assert.ok(node.fontSize > source.spec.fontSize);
    assert.ok(node.width / 2 >= largestOuterRadius);
    assert.ok(marker.middleY >= largestOuterRadius);
    assert.ok(node.height - marker.middleY >= largestOuterRadius);
    if (node.node.__hasChildren)
      assert.ok(
        marker.toggleX - 16 >= marker.badgeX + largestOuterRadius * 3 + 8,
      );
    if (node.lines.length) assert.ok(freeMasteryGeometry.labelTop > marker.middleY + largestOuterRadius);
  }
});
test("percent, folds, hidden label footprint and course title are shared by both modes", () => {
  const filtered = filterMindmapByMastery(doc, {}, 35, {
    balanceDomains: true,
  });
  const closed = collapseMindmap(filtered.doc, 3);
  const named = preparePackedMindmap(closed, measure);
  const hidden = preparePackedMindmap(closed, measure, { showLabels: false });
  const result = renderMasteryForce(createMasteryForce(hidden));
  const namedLayout = renderMasteryForce(createMasteryForce(named));
  assert.deepEqual(
    result.nodes.map((n) => n.key),
    namedLayout.nodes.map((n) => n.key),
  );
  assert.ok(result.nodes.length < 87);
  assert.equal(result.nodes.filter((n) => n.lines.length).length, 1);
  assert.ok(
    result.nodes.filter((n) => n.depth > 0).every((n) => n.textWidth === 0),
  );
  assert.ok(
    result.nodes.reduce((s, n) => s + n.width * n.height, 0) <
      namedLayout.nodes.reduce((s, n) => s + n.width * n.height, 0),
  );
});
