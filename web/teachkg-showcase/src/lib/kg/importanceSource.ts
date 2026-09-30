/** 课堂图重要性展示来源：原多通道 classroom vs 纯 PageRank 实验。 */

export type ImportanceSource = "classroom" | "pagerank";

const STORAGE_KEY = "kg-importance-source-v2";

/** 默认课堂信号；localStorage 可切到 pagerank 实验 */
export function getImportanceSource(): ImportanceSource {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "classroom" || v === "pagerank") return v;
  } catch {
    /* ignore */
  }
  return "classroom";
}

export function setImportanceSource(source: ImportanceSource) {
  try {
    window.localStorage.setItem(STORAGE_KEY, source);
  } catch {
    /* ignore */
  }
}

export function importanceSourceLabel(source: ImportanceSource): string {
  return source === "pagerank" ? "PR+课堂" : "课堂信号";
}
