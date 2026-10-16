import test from 'node:test';
import assert from 'node:assert/strict';
import { packCourseBranches } from './compactCourseLayout.mjs';

const box = (x, y, width, height) => ({ x, y, width, height });
const branch = (height, boxes, width = 500) => ({ height, width, boxes,
  anchorY: boxes[0].y + boxes[0].height / 2, anchorHeight: boxes[0].height });
function check(branches, result) {
  let previous = -Infinity;
  const occupied = [];
  branches.forEach((b, i) => {
    const p = result.positions[i];
    assert.ok(p.y + b.anchorY > previous);
    previous = p.y + b.anchorY;
    assert.ok(p.y >= 0 && p.y + b.height <= result.height);
    assert.ok(p.x >= 0 && p.x <= 480 && p.x + b.width <= result.width);
    for (const r of b.boxes) {
      const rect = { ...r, x: r.x + p.x, y: r.y + p.y };
      for (const other of occupied) {
        assert.ok(rect.x >= other.x + other.width + 14 || other.x >= rect.x + rect.width + 14 ||
          rect.y >= other.y + other.height + 14 || other.y >= rect.y + rect.height + 14);
      }
    }
    occupied.push(...b.boxes.map(r => ({ ...r, x: r.x + p.x, y: r.y + p.y })));
  });
}
test('empty and single branch keep natural dimensions', () => {
  assert.deepEqual(packCourseBranches([]), { width: 0, height: 0, positions: [] });
  assert.deepEqual(packCourseBranches([branch(40, [box(22, 0, 150, 40)], 172)]),
    { width: 172, height: 40, positions: [{ x: 0, y: 0 }] });
});
test('unequal branches use longer connectors to reduce total height', () => {
  const make = height => branch(height, [box(22, height / 2 - 20, 150, 40), box(220, 0, 140, height)], 360);
  const branches = [make(500), make(60), make(60), make(60), make(500)];
  const result = packCourseBranches(branches);
  check(branches, result);
  assert.ok(result.height < 1236);
  assert.ok(result.positions[0].x > result.positions[1].x);
  assert.equal(result.positions[1].x, 0);
});

test('bottom-up packing anchors the final chapter at the bottom without reordering', () => {
  const branches = [branch(260, [box(0, 100, 120, 40), box(200, 0, 180, 260)]),
    branch(40, [box(0, 0, 120, 40)], 120),
    branch(80, [box(0, 20, 120, 40), box(200, 0, 180, 80)])];
  const result = packCourseBranches(branches);
  check(branches, result);
  assert.equal(result.positions.at(-1).y + branches.at(-1).height, result.height);
  assert.equal(result.positions[1].x, 0);
});
test('dense rectangular branches never overlap or reverse chapter order', () => {
  const branches = [200, 40, 420, 90, 180].map(h => branch(h, [box(0, 0, 500, h)]));
  check(branches, packCourseBranches(branches));
});
test('asymmetric, collapsed, resized and repeated layouts remain deterministic', () => {
  for (let count = 1; count <= 12; count++) {
    const branches = Array.from({ length: count }, (_, i) => {
      const height = 40 + (i * 137 % 500);
      return branch(height, [box(22, height * .2, 100 + i * 7, 32), box(260, 0, 120, height)]);
    });
    const result = packCourseBranches(branches);
    check(branches, result);
    assert.deepEqual(packCourseBranches(branches), result);
  }
});
