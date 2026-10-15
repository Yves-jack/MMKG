/** Shared geometry for mastery badges, fold controls and learning-path anchors. */
export function mindmapMarkerPositions(node) {
  const middleY = node.height / 2;
  if (node.compact)
    return {
      start: 0,
      end: 0,
      middleY,
      badgeX: node.side === -1 ? node.width - 32 : 32,
      toggleX: node.side === -1 ? 20 : node.width - 20,
    };
  const start = node.side === -1 && node.depth > 0 ? node.extra + 12 : 12;
  const end = start + node.textWidth;
  return {
    start,
    end,
    middleY,
    badgeX: node.side === -1 ? start - 34 : end + 34,
    toggleX:
      node.depth === 0 ? end + 24 : node.side === -1 ? start - 80 : end + 80,
  };
}
