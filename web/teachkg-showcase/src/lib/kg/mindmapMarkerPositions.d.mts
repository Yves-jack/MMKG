export function mindmapMarkerPositions(node: {
  height: number;
  width: number;
  side: -1 | 1;
  depth: number;
  extra: number;
  textWidth: number;
  compact?: boolean;
  free?: boolean;
}): {
  start: number;
  end: number;
  middleY: number;
  badgeX: number;
  toggleX: number;
};
