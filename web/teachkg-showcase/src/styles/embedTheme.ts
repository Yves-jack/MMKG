/** AI-Teaching iframe：`?embed=ai-teaching` 时切到交学伴纸面色。 */
export const EMBED_AI_TEACHING = "ai-teaching";

/** 与知识图谱嵌入共用纸面主题的 embed 值 */
const PAPER_EMBED_MODES = new Set([EMBED_AI_TEACHING, "video-search", "review"]);

export function applyEmbedTheme(embed: string) {
  if (typeof document === "undefined") return;
  const next = String(embed || "").trim();
  if (PAPER_EMBED_MODES.has(next)) {
    // 动态图谱与知识图谱共用同一套纸面 token / 节点配色
    document.documentElement.dataset.embed = EMBED_AI_TEACHING;
  } else {
    delete document.documentElement.dataset.embed;
  }
}

export function isPaperEmbedTheme() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.embed === EMBED_AI_TEACHING
  );
}
