const clean = (value) => (typeof value === "string" ? value.trim() : "");
const names = (entity) => [
  ...new Set(
    [
      entity.id,
      entity.label,
      entity.zh,
      entity.canonicalName,
      ...(entity.aliases || []),
    ]
      .flatMap((value) => {
        const s = clean(value);
        return s ? [s, ...s.split("/").map(clean)] : [];
      })
      .filter(Boolean),
  ),
];
/** Exact identities/aliases only; an ambiguous label must not acquire another entity's definition. */
export function createMasteryEntityIndex(nodes = [], definitions = {}) {
  const exact = new Map(),
    candidates = new Map();
  for (const entity of nodes) {
    if (clean(entity.id)) exact.set(entity.id, entity);
    for (const name of names(entity)) {
      const rows = candidates.get(name) || [];
      rows.push(entity);
      candidates.set(name, rows);
    }
  }
  return { exact, candidates, definitions };
}
export function masteryEntityDetails(node, index) {
  const id = clean(node.id),
    label = clean(node.zh);
  const entity =
    index.exact.get(id) ||
    (index.candidates.get(label)?.length === 1
      ? index.candidates.get(label)[0]
      : null);
  const canonical = clean(entity?.canonicalName) || clean(entity?.id) || label;
  const aliases = [
    ...new Set(
      (entity?.aliases || [])
        .map(clean)
        .filter((a) => a && a !== canonical && a !== label),
    ),
  ];
  const keys = entity ? names(entity) : [id, label];
  const owned = clean(entity?.description);
  const definition =
    owned && !/反馈后\s*:|PageRank|重要性筛选/i.test(owned)
      ? owned
      : keys
          .map((k) => clean(index.definitions[k]))
          .find(
            (value) => value && !/反馈后\s*:|PageRank|重要性筛选/i.test(value),
          ) || "";
  return { canonical, aliases, definition };
}
