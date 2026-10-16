/** Shared geometry for mastery badges, fold controls and learning-path anchors. */
export const freeMasteryGeometry = {
  badgeScale: 1.3,
  badgeY: 44,
  labelTop: 92,
  fontScale: 1.12,
  leafWidth: 88,
  branchWidth: 148,
  toggleOffset: 140,
};

export function mindmapMarkerPositions(node) {
  if (node.free)
    return {
      start: (node.width - node.textWidth) / 2,
      end: (node.width + node.textWidth) / 2,
      middleY: node.depth === 0 ? node.height / 2 : freeMasteryGeometry.badgeY,
      badgeX: node.width / 2,
      toggleX:
        node.width / 2 + (node.depth === 0 ? node.textWidth / 2 + 24 : freeMasteryGeometry.toggleOffset),
    };
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
