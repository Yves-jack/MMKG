function resourceQueryKey(query) {
  return `${query.matchMode || "full"}\u0000${query.entityId || ""}\u0000${(
    query.entityAliases || []
  ).join("\u0001")}`;
}

/**
 * 从选中子树的叶节点向上逐层汇总资源查询。
 * 每个父节点只合并自身查询和直接子节点已汇总的结果。
 */
export function aggregateMindmapResourceQueries(node, directQuery) {
  const childQueries = (node.children || []).flatMap((child) =>
    aggregateMindmapResourceQueries(child, directQuery)
  );
  const own = directQuery(node);
  const merged = own ? [own, ...childQueries] : childQueries;
  const seen = new Set();
  return merged.filter((query) => {
    const key = resourceQueryKey(query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
