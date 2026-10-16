import { mindmapMarkerPositions } from "./mindmapMarkerPositions.mjs";

/**
 * Browser port of business-handoff-color-only.zip / business-handoff/layout.py.
 * Reference SHA-256: 48ba4fcd86527e52c1fa0a483b2fd13ecb65345164777e99f4dd90ee871a070e
 * Retains blocks/leaf_rows/needed, chapter_plan's 200-state silhouette beam,
 * side-height selection and smooth_curve's collision-tested route candidates.
 * Source-path keys preserve repeated knowledge IDs and interactive folding.
 */
const GRID_ROW_GAP = 18,
  SIBLING_GAP = 4,
  NODE_PAD = 8,
  DOMAIN_GAP = 250;
const OFFSETS = Array.from({ length: 23 }, (_, i) => -160 + 80 * i);
const routeFractions = [
  [0.08, 0.14, 0.58, 1],
  [0.06, 0.22, 0.48, 0.95],
  [0.1, 0.4, 0.35, 0.92],
  [0.04, 0.12, 0.7, 1],
  [0.14, 0.5, 0.25, 0.88],
  [0.03, 0.08, 0.82, 1],
  [0.18, 0.55, 0.18, 0.85],
  [0.22, 0.65, 0.12, 0.78],
  [0.3, 0.75, 0.08, 0.7],
  [0.4, 0.85, 0.05, 0.55],
];
function tupleCompare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (Array.isArray(a[i])) {
      const c = tupleCompare(a[i], b[i]);
      if (c) return c;
    } else if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}
function roundEven(value) {
  const floor = Math.floor(value),
    fraction = value - floor;
  return fraction === 0.5 ? floor + (floor % 2) : Math.round(value);
}
function cubic(a, p1, p2, b, t) {
  const u = 1 - t;
  return [
    u * u * u * a[0] +
      3 * u * u * t * p1[0] +
      3 * u * t * t * p2[0] +
      t * t * t * b[0],
    u * u * u * a[1] +
      3 * u * u * t * p1[1] +
      3 * u * t * t * p2[1] +
      t * t * t * b[1],
  ];
}
function inside(point, box) {
  return (
    box.left + 3 < point[0] &&
    point[0] < box.right - 3 &&
    box.top + 3 < point[1] &&
    point[1] < box.bottom - 3
  );
}

export function preparePackedMindmap(
  doc,
  measure,
  { markers = true, showLabels = true } = {},
) {
  const records = [];
  const visit = (node, depth, path, branch) => {
    const key = (node.__sourcePath || path).join(".");
    const fontSize =
      depth === 0 ? 48 : depth === 1 ? 42 : depth === 2 ? 34 : 27;
    const compact = !showLabels && depth > 0;
    const limit = fontSize < 34 ? 500 : 620;
    const lines = [];
    if (!compact) {
      let current = "";
      for (const char of String(node.zh || "")) {
        if (current && measure(current + char, fontSize) > limit) {
          lines.push(current);
          current = "";
        }
        current += char;
      }
      if (current || !lines.length) lines.push(current);
    }
    const textWidth = compact
      ? 0
      : Math.max(...lines.map((line) => measure(line, fontSize)));
    const extra = compact ? 0 : markers ? (depth === 0 ? 40 : 104) : 0;
    const hasChildren = node.__hasChildren ?? (node.children || []).length > 0;
    const record = {
      key,
      node,
      depth,
      branch,
      children: [],
      spec: {
        compact,
        lines,
        fontSize,
        textWidth,
        w: compact ? (hasChildren ? 112 : 64) : textWidth + 24 + extra,
        h: compact
          ? 64
          : Math.max(markers ? 58 : 0, lines.length * (fontSize + 9) + 10),
        extra,
      },
    };
    records.push(record);
    (node.children || []).forEach((child, index) => {
      if (String(child.id || "").startsWith("__lecture__")) return;
      record.children.push(
        visit(
          child,
          depth + 1,
          [...path, index],
          depth === 0 ? record.children.length : branch,
        ),
      );
    });
    return key;
  };
  const root = doc.roots?.[0] || doc.root;
  const rootKey = visit(root, 0, [0], -1);
  return { rootKey, records };
}

export function layoutPackedMindmap(input) {
  const { rootKey, records } = input;
  const byKey = new Map(records.map((record) => [record.key, record]));
  const children = (id) => byKey.get(id).children;
  const spec = (id) => byKey.get(id).spec;
  const domains = children(rootKey);
  const neededCache = new Map();
  function blocks(id) {
    const kids = children(id),
      leaves = kids.filter((kid) => !children(kid).length);
    if (leaves.length <= 4) return kids;
    return kids
      .filter((kid) => kid === leaves[0] || !leaves.includes(kid))
      .map((kid) => (kid === leaves[0] ? { leaves } : kid));
  }
  function leafRows(leaves) {
    const n = Math.ceil(leaves.length / 2);
    return leaves.slice(0, n).map((kid, i) => [kid, leaves[i + n]]);
  }
  function gridHeight(leaves) {
    const rows = leafRows(leaves);
    return (
      rows.reduce(
        (sum, row) =>
          sum + Math.max(...row.filter(Boolean).map((kid) => spec(kid).h)),
        0,
      ) +
      GRID_ROW_GAP * (rows.length - 1) +
      NODE_PAD
    );
  }
  function needed(id) {
    if (!neededCache.has(id)) {
      const kids = blocks(id),
        h = spec(id).h + NODE_PAD;
      const total = kids.reduce(
        (sum, kid) =>
          sum +
          (typeof kid === "string" ? needed(kid) : gridHeight(kid.leaves)),
        0,
      );
      neededCache.set(
        id,
        kids.length
          ? Math.max(h, total + Math.max(0, kids.length - 1) * SIBLING_GAP)
          : h,
      );
    }
    return neededCache.get(id);
  }
  class Layout {
    constructor() {
      this.items = new Map();
      this.edges = [];
      this.gridFar = new Map();
    }
    add(id, nearX, midY, side) {
      const s = spec(id),
        left = side === 1 ? nearX : nearX - s.w,
        top = midY - s.h / 2;
      this.items.set(id, {
        left,
        right: left + s.w,
        top,
        bottom: top + s.h,
        side,
      });
    }
    inner(id) {
      const a = this.items.get(id);
      return [a.side === 1 ? a.left : a.right, a.bottom];
    }
    outer(id) {
      const a = this.items.get(id);
      return [a.side === 1 ? a.right : a.left, a.bottom];
    }
    subtree(id, nearX, start, side) {
      this.add(id, nearX, start + needed(id) / 2, side);
      let cursor = start;
      for (const child of blocks(id)) {
        if (typeof child !== "string") {
          const rows = leafRows(child.leaves),
            near = Math.max(...rows.map(([inner]) => spec(inner).w));
          const nearX = this.outer(id)[0] + side * (spec(id).compact ? 28 : 60),
            farX = nearX + side * (near + (spec(id).compact ? 24 : 55));
          let rowCursor = cursor + NODE_PAD / 2;
          for (const [inner, outer] of rows) {
            const rowH = Math.max(
              ...[inner, outer].filter(Boolean).map((kid) => spec(kid).h),
            );
            const baseline = rowCursor + rowH;
            this.add(inner, nearX, baseline - spec(inner).h / 2, side);
            this.edges.push([id, inner]);
            if (outer) {
              this.add(outer, farX, baseline - spec(outer).h / 2, side);
              this.edges.push([id, outer]);
              this.gridFar.set(id + "/" + outer, inner);
            }
            rowCursor += rowH + GRID_ROW_GAP;
          }
          cursor += gridHeight(child.leaves) + SIBLING_GAP;
        } else {
          this.subtree(
            child,
            this.outer(id)[0] + side * (spec(id).compact ? 28 : 60),
            cursor,
            side,
          );
          this.edges.push([id, child]);
          cursor += needed(child) + SIBLING_GAP;
        }
      }
    }
  }
  function intrusions(domain, side, plan, height) {
    const trial = new Layout(),
      chapterOf = new Map();
    trial.add(domain, 0, height / 2, side);
    for (const [chapter, offset, start] of plan) {
      trial.subtree(chapter, side * (310 + offset), start, side);
      trial.edges.push([domain, chapter]);
      for (const member of trial.items.keys())
        if (member !== domain && !chapterOf.has(member))
          chapterOf.set(member, chapter);
    }
    let collisions = 0;
    // The reference has text only. Keep the added mastery/collapse controls
    // from colliding with a chapter when its parent domain is unusually wide.
    if (spec(domain).extra > 0 || spec(domain).compact) {
      const domainBox = trial.items.get(domain);
      for (const [id, box] of trial.items)
        if (
          id !== domain &&
          box.left < domainBox.right &&
          domainBox.left < box.right &&
          box.top < domainBox.bottom &&
          domainBox.top < box.bottom
        )
          collisions += 1000;
    }
    for (const [parent, child] of trial.edges) {
      const a = trial.items.get(parent),
        b = trial.items.get(child);
      const from = [side === -1 ? a.left : a.right, a.bottom],
        to = [side === -1 ? b.right : b.left, b.bottom];
      const dx = to[0] - from[0],
        dy = to[1] - from[1];
      let p1, p2;
      if (parent === domain) {
        p1 = [from[0] + dx * 0.08, from[1] + dy * 0.58];
        p2 = [from[0] + dx * 0.14, to[1]];
      } else if (Math.abs(dx) < 140) {
        p1 = [from[0], from[1] + dy * 0.55];
        p2 = [to[0], to[1] - dy * 0.38];
      } else {
        p1 = [from[0] + dx * 0.52, from[1]];
        p2 = [to[0] - dx * 0.4, to[1]];
      }
      const points = Array.from({ length: 31 }, (_, i) =>
        cubic(from, p1, p2, to, (i + 1) / 32),
      );
      const lowX = Math.min(...points.map((p) => p[0])),
        highX = Math.max(...points.map((p) => p[0]));
      const lowY = Math.min(...points.map((p) => p[1])),
        highY = Math.max(...points.map((p) => p[1]));
      for (const [target, box] of trial.items) {
        if (
          target === parent ||
          target === child ||
          chapterOf.get(target) === chapterOf.get(parent)
        )
          continue;
        if (
          box.right < lowX ||
          box.left > highX ||
          box.bottom < lowY ||
          box.top > highY
        )
          continue;
        if (points.some((point) => inside(point, box))) collisions++;
      }
    }
    return collisions;
  }
  function chapterPlan(domain, side) {
    if (!children(domain).length) return { plan: [], height: needed(domain) };
    const templates = new Map();
    for (const chapter of children(domain))
      for (const offset of OFFSETS) {
        const probe = new Layout();
        probe.subtree(chapter, side * (310 + offset), 0, side);
        templates.set(chapter + "/" + offset, [...probe.items.values()]);
      }
    let states = [{ plan: [], boxes: [], height: 0, width: 0, score: 0 }];
    for (const chapter of children(domain)) {
      const candidates = [];
      for (const state of states) {
        const previous = state.plan.at(-1);
        let minimum = previous
          ? previous[2] + Math.max(175, needed(previous[0]) * 0.3)
          : 0;
        if (previous)
          minimum = Math.max(
            minimum,
            previous[2] + needed(previous[0]) / 2 + 210 - needed(chapter) / 2,
          );
        for (const offset of OFFSETS) {
          if (
            side === 1 &&
            (offset < 240 || (previous && offset < previous[1]))
          )
            continue;
          const template = templates.get(chapter + "/" + offset);
          let start = minimum;
          for (const current of template)
            for (const earlier of state.boxes) {
              if (
                current.left < earlier.right + 12 &&
                earlier.left < current.right + 12
              )
                start = Math.max(start, earlier.bottom + 12 - current.top);
            }
          start = roundEven((start + 7) / 8) * 8;
          const height = Math.max(state.height, start + needed(chapter));
          const width = Math.max(
            state.width,
            ...template.map((a) => (side === -1 ? -a.left : a.right)),
          );
          const plan = [...state.plan, [chapter, offset, start]];
          const boxes = [
            ...state.boxes,
            ...template.map((a) => ({
              ...a,
              top: a.top + start,
              bottom: a.bottom + start,
            })),
          ];
          const score =
            height * (width + 700) +
            plan.reduce((sum, p) => sum + Math.max(0, p[1]) * needed(p[0]), 0) *
              0.055;
          candidates.push({ plan, boxes, height, width, score });
        }
      }
      candidates.sort((a, b) =>
        tupleCompare(
          [a.score, a.height, a.width, a.plan.map((p) => p[1])],
          [b.score, b.height, b.width, b.plan.map((p) => p[1])],
        ),
      );
      const firstCounts = new Map();
      states = [];
      for (const candidate of candidates) {
        const first = candidate.plan[0][1],
          count = firstCounts.get(first) || 0;
        if (count >= 8) continue;
        states.push(candidate);
        firstCounts.set(first, count + 1);
        if (states.length >= 200) break;
      }
    }
    let best = null,
      bestRank = null;
    for (const state of states) {
      const rank = [
        intrusions(domain, side, state.plan, state.height) * 1e12 + state.score,
        state.score,
      ];
      if (!bestRank || tupleCompare(rank, bestRank) < 0) {
        best = state;
        bestRank = rank;
      }
    }
    return { plan: best.plan, height: best.height };
  }
  const options = new Map();
  for (const domain of domains)
    for (const side of [-1, 1])
      options.set(domain + "/" + side, chapterPlan(domain, side));
  const sideHeight = (ids, side) =>
    ids.reduce((sum, id) => sum + options.get(id + "/" + side).height, 0) +
    DOMAIN_GAP * Math.max(0, ids.length - 1);
  let chosenSides = [],
    bestSideRank = null;
  function chooseSides(sides) {
    if (sides.length < domains.length) {
      chooseSides([...sides, -1]);
      chooseSides([...sides, 1]);
      return;
    }
    const left = domains.filter((_, i) => sides[i] === -1),
      right = domains.filter((_, i) => sides[i] === 1);
    if (domains.length > 1 && (!left.length || !right.length)) return;
    if (right.length > left.length) return;
    const lh = sideHeight(left, -1),
      rh = sideHeight(right, 1),
      rank = [Math.abs(lh - rh), Math.max(lh, rh), lh + rh, sides];
    if (!bestSideRank || tupleCompare(rank, bestSideRank) < 0) {
      bestSideRank = rank;
      chosenSides = sides;
    }
  }
  // A course has a few explicit root domains. No subject/title inference.
  chooseSides([]);
  const layout = new Layout();
  layout.add(rootKey, -spec(rootKey).w / 2, 0, 1);
  const plans = [];
  for (const side of [-1, 1]) {
    const ids = domains.filter((_, index) => chosenSides[index] === side);
    let cursor = -sideHeight(ids, side) / 2;
    for (const domain of ids) {
      const packed = options.get(domain + "/" + side),
        near = side * Math.max(475, spec(rootKey).w / 2 + 60);
      layout.add(domain, near, cursor + packed.height / 2, side);
      for (const [chapter, offset, start] of packed.plan) {
        layout.subtree(
          chapter,
          near + side * (310 + offset),
          cursor + start,
          side,
        );
        layout.edges.push([domain, chapter]);
      }
      layout.edges.push([rootKey, domain]);
      plans.push({ domain, side, ...packed });
      cursor += packed.height + DOMAIN_GAP;
    }
  }
  function curveHits(from, p1, p2, to, exclude) {
    const boxes = [...layout.items]
      .filter(([id]) => !exclude.includes(id))
      .map(([, box]) => box);
    for (let step = 1; step < 56; step++) {
      const point = cubic(from, p1, p2, to, step / 56);
      if (boxes.some((box) => inside(point, box))) return true;
    }
    return false;
  }
  function smoothCurve(from, to, exclude = []) {
    const dx = to[0] - from[0],
      dy = to[1] - from[1],
      adx = Math.abs(dx),
      ady = Math.abs(dy);
    if (adx < 0.5 && ady < 0.5) return `M ${from.join(" ")} L ${to.join(" ")}`;
    const sign = dx >= 0 ? 1 : -1,
      span =
        sign *
        (adx >= 120
          ? adx
          : Math.max(adx * 1.8, Math.min(160, Math.max(ady * 0.38, 72))));
    const candidates = routeFractions.map(([xa, xb, ya, yb]) => [
      [from[0] + span * xa, from[1] + dy * ya],
      [from[0] + span * xb, from[1] + dy * yb],
    ]);
    if (adx >= 100)
      for (const [xa, xb, ya, yb] of routeFractions.slice(0, 6))
        candidates.push([
          [from[0] + dx * xa, from[1] + dy * ya],
          [from[0] + dx * xb, from[1] + dy * yb],
        ]);
    for (const x of [
      from[0] + span * 0.35,
      from[0] + span * 0.5,
      from[0] + dx * 0.5,
    ])
      candidates.push([
        [x, from[1] + dy * 0.12],
        [x, from[1] + dy * 0.88],
      ]);
    const [p1, p2] =
      candidates.find(([p1, p2]) => !curveHits(from, p1, p2, to, exclude)) ||
      candidates[0];
    return `M ${from.join(" ")} C ${p1.join(" ")} ${p2.join(" ")} ${to.join(" ")}`;
  }
  function connector(id, outward) {
    const box = layout.items.get(id),
      record = byKey.get(id);
    if (!record.spec.compact)
      return outward ? layout.outer(id) : layout.inner(id);
    const marker = mindmapMarkerPositions({
      ...record,
      ...box,
      compact: true,
      width: record.spec.w,
      height: record.spec.h,
    });
    return [box.left + marker.badgeX, box.top + marker.middleY];
  }
  function edgePath(parent, child) {
    const inner = layout.gridFar.get(parent + "/" + child);
    if (inner) {
      const from = connector(inner, true),
        to = connector(child, false),
        dx = to[0] - from[0],
        bow = Math.min(42, Math.abs(dx) * 0.14),
        box = layout.items.get(parent),
        sign = from[1] >= (box.top + box.bottom) * 0.5 ? 1 : -1;
      return `M ${from.join(" ")} C ${from[0] + dx * 0.35} ${from[1] + sign * bow} ${from[0] + dx * 0.65} ${to[1] + sign * bow} ${to.join(" ")}`;
    }
    const a = layout.items.get(parent),
      b = layout.items.get(child);
    if (parent === rootKey)
      return smoothCurve(
        [b.side === -1 ? a.left : a.right, a.bottom],
        spec(child).compact
          ? connector(child, false)
          : [b.side === -1 ? b.right : b.left, b.bottom],
        [parent, child],
      );
    if (domains.includes(parent))
      return smoothCurve(
        spec(parent).compact
          ? connector(parent, true)
          : [b.right < a.left ? a.left : a.right, a.bottom],
        connector(child, false),
        [parent, child],
      );
    return smoothCurve(connector(parent, true), connector(child, false), [
      parent,
      child,
    ]);
  }
  const nodes = [...layout.items].map(([key, box]) => ({
    ...byKey.get(key),
    ...box,
    compact: spec(key).compact || false,
    width: spec(key).w,
    height: spec(key).h,
    fontSize: spec(key).fontSize,
    lines: spec(key).lines,
    textWidth: spec(key).textWidth,
    extra: spec(key).extra,
  }));
  const minX = Math.min(...nodes.map((n) => n.left)) - 120,
    maxX = Math.max(...nodes.map((n) => n.right)) + 120;
  const minY = Math.min(...nodes.map((n) => n.top)) - 120,
    maxY = Math.max(...nodes.map((n) => n.bottom)) + 120;
  const edges = layout.edges.map(([parent, child]) => ({
    key: parent + "/" + child,
    parent,
    child,
    path: edgePath(parent, child),
    depth: byKey.get(parent).depth,
    branch: byKey.get(child).branch,
  }));
  return {
    nodes,
    edges,
    domains: domains.map((key) => byKey.get(key).node),
    plans,
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}
