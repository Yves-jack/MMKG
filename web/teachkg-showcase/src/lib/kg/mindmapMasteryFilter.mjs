/**
 * Read-only mastery view of a mindmap. Filtering never changes the source tree
 * and never promotes a child past its original parent.
 */

const STATUS_ORDER = Object.freeze({
  learning: 0,
  mastered: 1,
  unlearned: 2,
  unrecorded: 3,
});

function requestedPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 100;
}

function isLectureNode(node) {
  return String(node.id || "").startsWith("__lecture__");
}

function scoreFor(node, masteryByZh) {
  const label = String(node.zh || "");
  const raw = masteryByZh instanceof Map
    ? masteryByZh.get(label)
    : Object.prototype.hasOwnProperty.call(masteryByZh || {}, label)
      ? masteryByZh[label]
      : undefined;
  if (raw === undefined || raw === null || raw === "") {
    return { status: "unrecorded", score: null };
  }
  const score = Number(raw);
  if (!Number.isFinite(score)) return { status: "unrecorded", score: null };
  const bounded = Math.min(5, Math.max(0, score));
  if (bounded === 0) return { status: "unlearned", score: bounded };
  return {
    status: bounded >= 4 ? "mastered" : "learning",
    score: bounded,
  };
}

function countByStatus(entries, visible) {
  const counts = { learning: 0, mastered: 0, unlearned: 0, unrecorded: 0 };
  for (const entry of entries) {
    if (!visible || visible.has(entry.index)) counts[entry.status] += 1;
  }
  return counts;
}

function comparePriority(left, right) {
  return STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
    || (left.score ?? 0) - (right.score ?? 0)
    || left.index - right.index;
}

/**
 * Retain the weakest/in-progress nodes before mastered and untouched nodes.
 * Ancestors are included in the same node budget. The requested percentage is
 * a target, except that required roots/selected-node paths may exceed it.
 *
 * @param {object} sourceDoc - MindmapDoc-shaped value.
 * @param {Record<string, number|null> | Map<string, number|null>} masteryByZh
 * @param {number} percent - Desired share of visible node occurrences, 0–100.
 * @param {{ selectedId?: string|null, selectedPath?: readonly number[]|null, balanceDomains?: boolean }} options
 */
export function filterMindmapByMastery(sourceDoc, masteryByZh, percent, options = {}) {
  const sourceRoots = Array.isArray(sourceDoc.roots) && sourceDoc.roots.length
    ? sourceDoc.roots
    : sourceDoc.root ? [sourceDoc.root] : [];
  const entries = [];
  const rootIndexes = [];
  const pathIndexes = new Map();
  const visit = (node, parent, depth, path) => {
    // Lecture containers are not knowledge points. Exclude their whole subtree,
    // matching the view's behavior, while retaining the original index paths.
    if (isLectureNode(node)) return;
    const index = entries.length;
    const mastery = scoreFor(node, masteryByZh);
    const domain = parent === -1 ? -1
      : entries[parent].parent === -1 ? index : entries[parent].domain;
    entries.push({ node, parent, depth, index, path, domain, children: [], ...mastery });
    pathIndexes.set(path.join("."), index);
    if (parent === -1) rootIndexes.push(index);
    else entries[parent].children.push(index);
    (node.children || []).forEach((child, childIndex) => {
      visit(child, index, depth + 1, [...path, childIndex]);
    });
  };
  sourceRoots.forEach((root, rootIndex) => visit(root, -1, 0, [rootIndex]));
  if (!rootIndexes.length) {
    throw new Error("Mindmap has no renderable root after excluding __lecture__ nodes");
  }

  const totalNodes = entries.length;
  const normalizedPercent = requestedPercent(percent);
  const requestedNodes = Math.ceil(totalNodes * normalizedPercent / 100);
  const visible = new Set(rootIndexes);
  const includePath = (index) => {
    for (let cursor = index; cursor !== -1; cursor = entries[cursor].parent) {
      visible.add(cursor);
    }
  };
  // A path identifies one occurrence even when distinct nodes share the same ID.
  // An explicitly supplied but invalid path does not fall back to every same-ID node.
  if (Array.isArray(options.selectedPath)) {
    const path = options.selectedPath;
    if (path.length && path.every((part) => Number.isInteger(part) && part >= 0)) {
      const selectedIndex = pathIndexes.get(path.join("."));
      if (selectedIndex !== undefined) includePath(selectedIndex);
    }
  } else if (options.selectedId) {
    const selectedId = String(options.selectedId);
    for (const entry of entries) {
      if (entry.node.id === selectedId) includePath(entry.index);
    }
  }
  const mandatoryNodes = visible.size;
  const targetNodes = Math.max(requestedNodes, mandatoryNodes);

  // A structural ancestor inherits the priority of its most useful descendant.
  // This makes the sequence of retained nodes independent of the target percent:
  // increasing the slider only adds nodes, never hides a previously visible one.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    let best = entry;
    for (const childIndex of entry.children) {
      const descendant = entries[childIndex].best;
      if (comparePriority(descendant, best) < 0) best = descendant;
    }
    entry.best = best;
  }
  const frontier = entries.filter((entry) =>
    !visible.has(entry.index)
    && entry.parent !== -1
    && visible.has(entry.parent)
  );
  const domainSizes = new Map();
  const visibleByDomain = new Map();
  if (options.balanceDomains) {
    for (const entry of entries) {
      if (entry.domain === -1) continue;
      domainSizes.set(entry.domain, (domainSizes.get(entry.domain) || 0) + 1);
      if (visible.has(entry.index)) {
        visibleByDomain.set(entry.domain, (visibleByDomain.get(entry.domain) || 0) + 1);
      }
    }
  }
  while (visible.size < targetNodes && frontier.length) {
    let next;
    if (options.balanceDomains) {
      // D'Hondt allocation produces a deterministic, house-monotone sequence
      // proportional to each first-level subtree's original node count.
      let chosenDomain = -1;
      for (const [domain, size] of domainSizes) {
        if (!frontier.some((entry) => entry.domain === domain)) continue;
        const chosenSize = domainSizes.get(chosenDomain) || 0;
        const count = visibleByDomain.get(domain) || 0;
        const chosenCount = visibleByDomain.get(chosenDomain) || 0;
        if (chosenDomain === -1
          || size * (chosenCount + 1) > chosenSize * (count + 1)
          || (size * (chosenCount + 1) === chosenSize * (count + 1)
            && domain < chosenDomain)) {
          chosenDomain = domain;
        }
      }
      let bestFrontierIndex = -1;
      for (let index = 0; index < frontier.length; index += 1) {
        const candidate = frontier[index];
        if (candidate.domain !== chosenDomain) continue;
        if (bestFrontierIndex === -1
          || comparePriority(candidate.best, frontier[bestFrontierIndex].best) < 0) {
          bestFrontierIndex = index;
        }
      }
      next = frontier.splice(bestFrontierIndex, 1)[0];
      visibleByDomain.set(chosenDomain, (visibleByDomain.get(chosenDomain) || 0) + 1);
    } else {
      frontier.sort((left, right) =>
        comparePriority(left.best, right.best) || left.index - right.index
      );
      next = frontier.shift();
    }
    visible.add(next.index);
    for (const childIndex of next.children) {
      if (!visible.has(childIndex)) frontier.push(entries[childIndex]);
    }
  }

  const prune = (index) => {
    const entry = entries[index];
    return {
      ...entry.node,
      __sourcePath: [...entry.path],
      children: entry.children.filter((child) => visible.has(child)).map(prune),
    };
  };
  const roots = rootIndexes.map(prune);
  const retainedIds = new Set([...visible].map((index) => entries[index].node.id));
  const remoteLinks = sourceDoc.remoteLinks?.filter((link) =>
    retainedIds.has(link.from) && retainedIds.has(link.to)
  );
  const maxDepth = [...visible].reduce((max, index) => Math.max(max, entries[index].depth), 0);
  const doc = {
    ...sourceDoc,
    root: roots[0] || sourceDoc.root,
    ...(sourceDoc.roots ? { roots } : {}),
    ...(sourceDoc.remoteLinks ? { remoteLinks } : {}),
    n_nodes: visible.size,
    max_depth: maxDepth,
  };
  const stats = {
    totalNodes,
    visibleNodes: visible.size,
    hiddenNodes: totalNodes - visible.size,
    requestedPercent: normalizedPercent,
    actualPercent: totalNodes ? visible.size / totalNodes * 100 : 0,
    requestedNodes,
    targetNodes,
    mandatoryNodes,
    totalByStatus: countByStatus(entries),
    visibleByStatus: countByStatus(entries, visible),
  };
  return { doc, stats };
}
