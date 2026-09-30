/**
 * 从课内释义中抽取可动画实例（频率、子句、小图描述等）。
 */

export type FreqTable = Record<string, number>;

/** 解析「A:5 B:2」或「a→3, b→1」类频率表 */
export function parseFrequencyTable(context: string): FreqTable | null {
  const text = String(context || "");
  const out: FreqTable = {};
  const re =
    /([A-Za-z\u4e00-\u9fff])\s*[：:=\-→]\s*(\d{1,3})|([A-Za-z\u4e00-\u9fff])\((\d{1,3})\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const k = (m[1] || m[3] || "").toUpperCase();
    const v = Number(m[2] || m[4]);
    if (k && Number.isFinite(v) && v > 0) out[k] = v;
  }
  const keys = Object.keys(out);
  if (keys.length >= 3 && keys.length <= 8) return out;
  return null;
}

/** 解析 CNF 风格子句： (p∨q), (¬p∨r) */
export function parseClauses(context: string): string[] | null {
  const text = String(context || "");
  const found = text.match(/[（(][^）)]{1,24}[）)]/g) || [];
  const clauses = found
    .map((s) => s.replace(/^[（(]|[）)]$/g, "").trim())
    .filter((s) => /[∨v]|¬|~|\/\\/.test(s) || /[pqrstuvwxyz]/i.test(s));
  if (clauses.length >= 3) return [...new Set(clauses)].slice(0, 6);
  return null;
}

/** 取课内一句可用作「定义对照」的短句 */
export function pickCourseQuote(context: string, fallback: string): string {
  const bits = String(context || "")
    .replace(/\s+/g, " ")
    .split(/[。；;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 80);
  if (bits[0]) return bits[0];
  return fallback;
}

export function defaultHuffmanFreq(): FreqTable {
  return { A: 5, B: 2, C: 3, D: 1 };
}

export function defaultClauses(): string[] {
  return ["p∨q", "¬p∨r", "¬q∨r", "¬r"];
}
