/** 跨页概念焦点（本地存储）；顶栏「正在学」展示已移除，此处仅保留读写供其它页衔接 */

export type FocusConcept = {
  courseId: string;
  lectureId: string;
  entityId: string;
  zh: string;
  at?: number;
};

function storageKey(courseId: string) {
  return `teachkg-focus:${courseId}`;
}

export function loadFocus(courseId: string): FocusConcept | null {
  try {
    const raw = localStorage.getItem(storageKey(courseId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FocusConcept;
    if (!parsed?.entityId || !parsed?.zh) return null;
    return { ...parsed, courseId };
  } catch {
    return null;
  }
}

export function saveFocus(
  courseId: string,
  state: { lectureId: string; entityId: string; zh: string }
) {
  const next: FocusConcept = {
    courseId,
    lectureId: state.lectureId,
    entityId: state.entityId,
    zh: state.zh,
    at: Date.now(),
  };
  try {
    localStorage.setItem(storageKey(courseId), JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("teachkg-focus", { detail: next }));
  } catch {
    /* ignore quota */
  }
}

export function clearFocus(courseId: string) {
  try {
    localStorage.removeItem(storageKey(courseId));
    window.dispatchEvent(new CustomEvent("teachkg-focus", { detail: null }));
  } catch {
    /* ignore */
  }
}
