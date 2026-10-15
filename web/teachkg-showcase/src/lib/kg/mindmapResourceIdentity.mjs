/** Section/topic identifiers are imported knowledge points, not structural wrappers. */
export function isStructuralMindmapNode(node) {
  const id = String(node?.id || "");
  return ["__course__/", "__part__/", "__chapter__/", "__lecture__/", "chapter:", "part:"].some(prefix => id.startsWith(prefix));
}
export function knowledgeResourceIdentity(node, canonicalId) {
  if (!node || isStructuralMindmapNode(node)) return null;
  return canonicalId || String(node.zh || "").trim() || (String(node.id || "").startsWith("__") ? null : node.id);
}
