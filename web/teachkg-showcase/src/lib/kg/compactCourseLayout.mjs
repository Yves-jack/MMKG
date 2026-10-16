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
