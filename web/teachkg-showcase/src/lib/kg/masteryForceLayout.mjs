import { mindmapMarkerPositions } from "./mindmapMarkerPositions.mjs";

/** Old dashboard physics: repulsion + edge springs + centre gravity, with the current tree identities. */
export function createMasteryForce(input, previous = new Map()) {
  const bodies = new Map();
  input.records.forEach((record, i) => {
    const root = record.depth === 0;
    const compact = !!record.spec.compact;
    const width = root
      ? record.spec.w
      : Math.max(
          compact ? 64 : record.spec.textWidth + 24,
          record.node.__hasChildren ? 128 : 64,
        );
    const height = root
      ? record.spec.h
      : compact
        ? 64
        : record.spec.lines.length * (record.spec.fontSize + 9) + 82;
    const old = previous.get(record.key);
    const angle = i * 2.399963229728653;
    const radius = 150 + Math.sqrt(i) * 110;
    const node = {
      ...record,
      free: true,
      compact,
      width,
      height,
      fontSize: record.spec.fontSize,
      textWidth: record.spec.textWidth,
      lines: record.spec.lines,
      extra: 0,
      side: 1,
    };
    bodies.set(record.key, {
      node,
      x: old?.x ?? (root ? 0 : Math.cos(angle) * radius),
      y: old?.y ?? (root ? 0 : Math.sin(angle) * radius),
      vx: 0,
      vy: 0,
      fixed: old?.fixed ?? root,
    });
  });
  const edges = input.records.flatMap((parent) =>
    parent.children.map((child) => ({
      key: parent.key + "/" + child,
      parent: parent.key,
      child,
      depth: parent.depth,
      branch: bodies.get(child).node.branch,
    })),
  );
  const sim = {
    bodies,
    autoFit: true,
    edges,
    domains: input.records.filter((n) => n.depth === 1).map((n) => n.node),
    bounds: { x: -500, y: -400, width: 1000, height: 800 },
  };
  for (let i = 0; i < 120; i++) advanceMasteryForce(sim);
  sim.bounds = forceBounds(sim);
  return sim;
}

export function advanceMasteryForce(sim) {
  const bodies = [...sim.bodies.values()];
  const forces = bodies.map(() => ({ x: 0, y: 0 }));
  const index = new Map(bodies.map((body, i) => [body.node.key, i]));
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i],
        b = bodies[j];
      let dx = a.x - b.x,
        dy = a.y - b.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.01) {
        dx = (i + 1) * 0.013;
        dy = (j + 1) * 0.017;
      }
      const distance = Math.max(1, Math.hypot(dx, dy));
      const minDistance =
        Math.hypot(a.node.width, a.node.height) / 2 +
        Math.hypot(b.node.width, b.node.height) / 2 +
        18;
      const repulsion = Math.min(
        30,
        ((minDistance * minDistance) / (distance * distance)) * 4.5,
      );
      const fx = (dx / distance) * repulsion,
        fy = (dy / distance) * repulsion;
      forces[i].x += fx;
      forces[i].y += fy;
      forces[j].x -= fx;
      forces[j].y -= fy;
      // Labels occupy real rectangles; hidden labels reserve only badges/fold controls.
      const overlapX = (a.node.width + b.node.width) / 2 + 20 - Math.abs(dx);
      const overlapY = (a.node.height + b.node.height) / 2 + 24 - Math.abs(dy);
      if (overlapX > 0 && overlapY > 0) {
        if (overlapX < overlapY) {
          const f = Math.sign(dx || 1) * Math.min(12, overlapX * 0.12);
          forces[i].x += f;
          forces[j].x -= f;
        } else {
          const f = Math.sign(dy || 1) * Math.min(12, overlapY * 0.12);
          forces[i].y += f;
          forces[j].y -= f;
        }
      }
    }
  for (const edge of sim.edges) {
    const i = index.get(edge.parent),
      j = index.get(edge.child);
    if (i == null || j == null) continue;
    const a = bodies[i],
      b = bodies[j],
      dx = b.x - a.x,
      dy = b.y - a.y;
    const distance = Math.max(0.01, Math.hypot(dx, dy));
    const ideal = Math.max(120, (a.node.width + b.node.width) * 0.5 + 80);
    const pull = (distance - ideal) * 0.015;
    const fx = (dx / distance) * pull,
      fy = (dy / distance) * pull;
    forces[i].x += fx;
    forces[i].y += fy;
    forces[j].x -= fx;
    forces[j].y -= fy;
  }
  let energy = 0;
  bodies.forEach((body, i) => {
    if (body.fixed) {
      body.vx = 0;
      body.vy = 0;
      return;
    }
    const f = forces[i];
    const gravity = body.node.compact ? 0.008 : 0.002;
    body.vx = Math.max(
      -18,
      Math.min(18, (body.vx + f.x - body.x * gravity) * 0.86),
    );
    body.vy = Math.max(
      -18,
      Math.min(18, (body.vy + f.y - body.y * gravity) * 0.86),
    );
    body.x += body.vx;
    body.y += body.vy;
    energy += body.vx * body.vx + body.vy * body.vy;
  });
  return energy / Math.max(1, bodies.length);
}

export function moveMasteryForce(sim, key, dx, dy) {
  const body = sim.bodies.get(key);
  if (!body || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  sim.autoFit = false;
  body.x += dx;
  body.y += dy;
  body.vx = 0;
  body.vy = 0;
  body.fixed = true;
}

export function forceBounds(sim) {
  const boxes = [...sim.bodies.values()].map((body) => {
    const marker = mindmapMarkerPositions(body.node);
    return {
      left: body.x - marker.badgeX,
      right: body.x - marker.badgeX + body.node.width,
      top: body.y - marker.middleY,
      bottom: body.y - marker.middleY + body.node.height,
    };
  });
  if (!boxes.length) return { x: -500, y: -400, width: 1000, height: 800 };
  const minX = Math.min(...boxes.map((b) => b.left)) - 140;
  const minY = Math.min(...boxes.map((b) => b.top)) - 140;
  return {
    x: minX,
    y: minY,
    width: Math.max(800, Math.max(...boxes.map((b) => b.right)) + 140 - minX),
    height: Math.max(600, Math.max(...boxes.map((b) => b.bottom)) + 140 - minY),
  };
}

export function renderMasteryForce(sim) {
  const nodes = [...sim.bodies.values()].map((body) => {
    const marker = mindmapMarkerPositions(body.node);
    const left = body.x - marker.badgeX,
      top = body.y - marker.middleY;
    return {
      ...body.node,
      left,
      top,
      right: left + body.node.width,
      bottom: top + body.node.height,
    };
  });
  const edges = sim.edges.map((edge) => {
    const a = sim.bodies.get(edge.parent),
      b = sim.bodies.get(edge.child);
    return { ...edge, path: `M ${a.x} ${a.y} L ${b.x} ${b.y}` };
  });
  return { nodes, edges, domains: sim.domains, plans: [], bounds: sim.bounds };
}
