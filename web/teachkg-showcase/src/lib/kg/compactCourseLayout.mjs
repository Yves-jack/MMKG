// Coordinates point outwards from the central root, on either side.
export function packCourseBranches(branches) {
  if (!branches.length) return { width: 0, height: 0, positions: [] };
  const gap = 14;
  const minHeight = Math.min(...branches.map(b => b.height));
  const maxHeight = Math.max(...branches.map(b => b.height));
  // Establish short connectors for small branches first. Larger branches can
  // extend further, but the original chapter ordering is never sorted away.
  const smallFirst = branches.map((branch, index) => ({ branch, index }))
    .sort((a, b) => a.branch.height - b.branch.height || b.index - a.index);
  // Reflect vertically so the collision sweep starts at the bottom and moves up.
  const bottomUp = branches.map(branch => ({ ...branch,
    anchorY: branch.height - branch.anchorY,
    incoming: branch.incoming ? { ...branch.incoming, y: branch.height - branch.incoming.y } : undefined,
    boxes: branch.boxes.map(r => ({ ...r, y: branch.height - r.y - r.height })),
  })).reverse();
  let best;
  for (const reach of [0, 120, 240, 360, 480]) {
    const offsets = [];
    for (const { branch, index } of smallFirst) {
      offsets[index] = maxHeight === minHeight ? 0 : Math.round(reach * (branch.height - minHeight) / (maxHeight - minHeight));
    }
    const placed = [];
    const positions = [];
    let height = 0, width = 0, previousCenter = -Infinity, previousAnchorHeight = 0;
    for (const [i, branch] of bottomUp.entries()) {
      const x = offsets[branches.length - 1 - i];
      // Preserve chapter order at the attachment node, even for asymmetric trees.
      let y = Math.max(0, previousCenter + gap + (previousAnchorHeight + branch.anchorHeight) / 2 - branch.anchorY);
      const boxes = branch.boxes.map(r => ({ ...r, x: r.x + x }));
      // Reserve the entire incoming horizontal connector, including the space
      // created by moving a large subtree outwards. Other subtrees cannot occupy it.
      if (branch.incoming) boxes.push({ x: 0, y: branch.incoming.y - 4,
        width: x + branch.incoming.x, height: 8 });
      const forbidden = [];
      for (const box of boxes) for (const other of placed) {
        if (box.x < other.x + other.width + gap && box.x + box.width + gap > other.x) {
          forbidden.push([other.y - box.y - box.height - gap, other.y + other.height + gap - box.y]);
        }
      }
      forbidden.sort((a, b) => a[0] - b[0]);
      for (const [start, end] of forbidden) if (y > start && y < end) y = end;
      y = Math.ceil(y * 4) / 4;
      positions.push({ x, y });
      placed.push(...boxes.map(r => ({ ...r, y: r.y + y })));
      previousCenter = y + branch.anchorY;
      previousAnchorHeight = branch.anchorHeight;
      height = Math.max(height, y + branch.height);
      width = Math.max(width, x + branch.width);
    }
    // Width is allowed to grow moderately; prefer shorter lines for equal heights.
    const score = height * (width + 1400);
    if (!best || score < best.score) best = { score, width, height,
      positions: positions.reverse().map((p, i) => ({ x: p.x, y: height - p.y - branches[i].height })),
    };
  }
  const { score: _, ...result } = best;
  return result;
}

export function courseUnderlineY(top, height, kind) {
  const thickness = kind === 'chapter' ? 4 : kind === 'topic' ? 2.8 : kind === 'leaf' ? 2 : 2.5;
  return top + height - thickness / 2;
}

// Rounded orthogonal connectors stay inside reserved horizontal/vertical lanes.
export function courseConnectorPath(parent, child, spineX) {
  const dx = Math.sign(child.x - parent.x) || 1;
  const dy = Math.sign(child.y - parent.y);
  const radius = Math.min(6, Math.abs(child.y - parent.y) / 2,
    Math.abs(spineX - parent.x) / 2, Math.abs(child.x - spineX) / 2);
  if (!dy || radius < .1) return `M${parent.x},${parent.y} H${spineX} V${child.y} H${child.x}`;
  return `M${parent.x},${parent.y} H${spineX - dx * radius} Q${spineX},${parent.y} ${spineX},${parent.y + dy * radius} V${child.y - dy * radius} Q${spineX},${child.y} ${spineX + dx * radius},${child.y} H${child.x}`;
}

export function courseConnectorBoxes(parent, child, spineX) {
  const segment = (x1, y1, x2, y2) => ({ x: Math.min(x1, x2) - 4,
    y: Math.min(y1, y2) - 4, width: Math.abs(x2 - x1) + 8, height: Math.abs(y2 - y1) + 8 });
  return [segment(parent.x, parent.y, spineX, parent.y),
    segment(spineX, parent.y, spineX, child.y), segment(spineX, child.y, child.x, child.y)];
}
