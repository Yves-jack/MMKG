/** 知识导图 ↔ 知识图谱：同名/同实体选中态与右栏开合共享 */

const ENTITY_KEY = "teachkg-shared-entity-v1";

export type SharedEntitySelection = {
  id: string;
  label?: string;
  updatedAt?: number;
};

/** 右栏折叠状态：导图与图谱共用同一套 key */
export const SHARED_PANEL_KEYS = {
  detail: "shared-panel-detail-v1",
  assets: "shared-panel-assets-v1",
  video: "shared-panel-video-v1",
  exercise: "shared-panel-exercise-v1",
  animation: "shared-panel-animation-v1",
  edges: "shared-panel-edges-v1",
} as const;

export function writeSharedEntitySelection(
  entity: { id?: string | null; label?: string | null } | null,
) {
  if (typeof window === "undefined") return;
  const id = String(entity?.id || "").trim();
  if (!id) {
    try {
      window.sessionStorage.removeItem(ENTITY_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  const payload: SharedEntitySelection = {
    id,
    label: String(entity?.label || "").trim() || undefined,
    updatedAt: Date.now(),
  };
  try {
    window.sessionStorage.setItem(ENTITY_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function readSharedEntitySelection(): SharedEntitySelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SharedEntitySelection;
    const id = String(parsed?.id || "").trim();
    if (!id) return null;
    return {
      id,
      label: String(parsed.label || "").trim() || undefined,
      updatedAt: Number(parsed.updatedAt) || undefined,
    };
  } catch {
    return null;
  }
}
