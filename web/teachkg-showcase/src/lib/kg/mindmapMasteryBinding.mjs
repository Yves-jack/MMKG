/** Bind database identities to imported mindmap labels without fuzzy matches. */
function nameKey(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}
export function bindMasteryToMindmap(payload) {
  const scores = Object.create(null);
  const names = new Map();
  const ambiguous = new Set();
  for (const [id, value] of Object.entries(payload?.mastery || {})) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5) scores[id] = value;
  }
  for (const point of payload?.knowledge_points || []) {
    if (!point || !Object.hasOwn(scores, point.id)) continue;
    // content may be bilingual; retain the full identity and its explicit Chinese label.
    for (const label of new Set([nameKey(point.name), nameKey(String(point.name).split("/")[0])])) {
      if (!label) continue;
      if (names.has(label) && names.get(label).id !== point.id) ambiguous.add(label);
      else names.set(label, { id: point.id, score: scores[point.id] });
    }
  }
  for (const [label, entry] of names) {
    if (!ambiguous.has(label) && !Object.hasOwn(scores, label)) scores[label] = entry.score;
  }
  return scores;
}

export function masteryScore(node, mastery) {
  // Imported course trees use zh as their knowledge identity; UUID trees use id.
  for (const key of [node.zh, nameKey(node.zh), node.id]) {
    const score = mastery?.[key];
    if (typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 5) return score;
  }
  return undefined;
}

export function masteryVisual(score) {
  if (score == null) return { radius: 18, color: "#9da7ae", status: "unrecorded", label: "暂无记录" };
  const value = Math.max(0, Math.min(5, score));
  const t = value / 5;
  return {
    radius: 25 - value * 1.2,
    color: `rgb(${Math.round(180 - t * 90)}, ${Math.round(90 + t * 70)}, ${Math.round(80 + t * 40)})`,
    status: value === 0 ? "unlearned" : value >= 4 ? "mastered" : "learning",
    label: `${value === 0 ? "未学习" : value >= 4 ? "已掌握" : "学习中"} · ${Math.round(value * 20)}%`,
  };
}

/** Collapsing is independent from percentage filtering and keyed to source occurrences. */
export function collapseMindmap(doc, expandDepth, overrides = {}) {
  const walk = (node, depth, fallbackPath) => {
    const path = node.__sourcePath || fallbackPath;
    const key = path.join(".");
    const open = Object.hasOwn(overrides, key) ? overrides[key] : depth < expandDepth;
    return { ...node, __sourcePath: path, __hasChildren: node.children.length > 0, __open: open,
      children: open ? node.children.map((child, index) => walk(child, depth + 1, [...path, index])) : [] };
  };
  const roots = (doc.roots?.length ? doc.roots : [doc.root]).map((root, index) => walk(root, 0, [index]));
  return { ...doc, root: roots[0], ...(doc.roots ? { roots } : {}) };
}
