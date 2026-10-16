export const freeMasteryGeometry: {
  readonly badgeScale: number;
  readonly badgeVisualScale: number;
  readonly badgeY: number;
  readonly labelTop: number;
  readonly fontScale: number;
  readonly leafWidth: number;
  readonly branchWidth: number;
  readonly toggleOffset: number;
};

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
