import { mindmapMarkerPositions } from "./mindmapMarkerPositions.mjs";
import { masteryScore, masteryVisual } from "./mindmapMasteryBinding.mjs";

/** Source chapter order, then depth first within each chapter. Never order by layout coordinates. */
export function masteryLearningPath(doc, mastery) {
  const chapters = [];
  const find = (node, path) => {
    if (node.id.startsWith("__chapter__/") || path.length === 3) {
      chapters.push({ node, path });
      return;
    }
    (node.children || []).forEach((child, i) => find(child, [...path, i]));
  };
  (doc.roots?.length ? doc.roots : [doc.root]).forEach((node, i) =>
    find(node, [i]),
  );
  const result = [];
  for (const chapter of chapters) {
    const visit = ({ node, path }) => {
      const score = masteryScore(node, mastery);
      if (score != null && score < 2.5)
        result.push({ key: path.join("."), score, label: node.zh });
      (node.children || []).forEach((child, j) =>
        visit({ node: child, path: [...path, j] }),
      );
    };
    visit(chapter);
  }
  return result;
}

/** Hidden occurrences stay hidden; connect only the remaining visible circles in curriculum order. */
export function visibleLearningPath(sequence, nodes) {
  const placed = new Map(nodes.map((node) => [node.key, node]));
  const steps = sequence
    .filter((step) => placed.has(step.key))
    .map((step) => {
      const node = placed.get(step.key);
      const marker = mindmapMarkerPositions(node);
      return {
        ...step,
        x: node.left + marker.badgeX,
        y: node.top + marker.middleY,
        radius: masteryVisual(step.score).radius + 5,
      };
    });
  return steps
    .slice(1)
    .map((to, index) => {
      const from = steps[index];
      const dx = to.x - from.x,
        dy = to.y - from.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= from.radius + to.radius + 12) return null;
      const ux = dx / distance,
        uy = dy / distance;
      const sx = from.x + ux * (from.radius + 3),
        sy = from.y + uy * (from.radius + 3);
      const tx = to.x - ux * (to.radius + 8),
        ty = to.y - uy * (to.radius + 8);
      const bend = Math.min(90, distance * 0.16);
      return {
        from: from.key,
        to: to.key,
        path: `M ${sx} ${sy} Q ${(sx + tx) / 2 - uy * bend} ${(sy + ty) / 2 + ux * bend} ${tx} ${ty}`,
      };
    })
    .filter(Boolean);
}
