/** 课堂图重要性展示来源：原多通道 classroom vs 纯 PageRank 实验。 */

export type ImportanceSource = "classroom" | "pagerank";

const STORAGE_KEY = "kg-importance-source-v2";

/** 展示端统一只用课堂分（忽略历史 localStorage 的 pagerank 实验值）。 */
export function getImportanceSource(): ImportanceSource {
  return "classroom";
}

export function setImportanceSource(_source: ImportanceSource) {
  try {
    window.localStorage.setItem(STORAGE_KEY, "classroom");
  } catch {
    /* ignore */
  }
}

export function importanceSourceLabel(_source: ImportanceSource): string {
  return "课堂信号";
}
