/** 规范化：折叠空白，便于模糊对齐 */
export function normalizeForLocate(s: string): { norm: string; map: number[] } {
  const map: number[] = [];
  let norm = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      if (norm.length && norm[norm.length - 1] !== " ") {
        map.push(i);
        norm += " ";
      }
    } else {
      map.push(i);
      norm += ch;
    }
  }
  return { norm: norm.trimEnd(), map };
}

function contentOnly(norm: string): { core: string; map: number[] } {
  const map: number[] = [];
  let core = "";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i]!;
    if (/[0-9A-Za-z\u3400-\u9fff々〆〇∧∨¬→↔∀∃∈⊆⊂∪∩×·∅]/.test(ch)) {
      map.push(i);
      core += ch;
    }
  }
  return { core, map };
}

function longestCommonSubstring(
  a: string,
  b: string
): { ai: number; bi: number; len: number } {
  let best = { ai: 0, bi: 0, len: 0 };
  if (!a || !b) return best;
  let prev = new Array(b.length + 1).fill(0);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best.len) {
          best = { ai: i - cur[j], bi: j - cur[j], len: cur[j] };
        }
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return best;
}

function fuzzyLocateInNorm(
  nb: string,
  nc: string
): { ni: number; nlen: number } | null {
  if (!nc || nc.length < 4 || !nb) return null;

  let ni = nb.indexOf(nc);
  if (ni >= 0) return { ni, nlen: nc.length };

  const minLen = Math.max(6, Math.floor(nc.length * 0.4));
  for (let len = nc.length - 1; len >= minLen; len--) {
    const mid = Math.max(0, Math.floor((nc.length - len) / 2));
    const candidates = [
      nc.slice(0, len),
      nc.slice(nc.length - len),
      nc.slice(mid, mid + len),
    ];
    for (const sub of candidates) {
      const j = nb.indexOf(sub);
      if (j >= 0) return { ni: j, nlen: len };
    }
    const step = Math.max(1, Math.floor(len / 8));
    for (let i0 = 1; i0 + len <= nc.length; i0 += step) {
      const j = nb.indexOf(nc.slice(i0, i0 + len));
      if (j >= 0) return { ni: j, nlen: len };
    }
  }

  const { core: cb, map: cbMap } = contentOnly(nb);
  const { core: cc } = contentOnly(nc);
  if (cc.length >= 4 && cb.length) {
    let ci = cb.indexOf(cc);
    let clen = cc.length;
    if (ci < 0) {
      const cMin = Math.max(6, Math.floor(cc.length * 0.4));
      outer: for (let len = cc.length - 1; len >= cMin; len--) {
        const step = Math.max(1, Math.floor(len / 6));
        for (let i0 = 0; i0 + len <= cc.length; i0 += step) {
          const j = cb.indexOf(cc.slice(i0, i0 + len));
          if (j >= 0) {
            ci = j;
            clen = len;
            break outer;
          }
        }
      }
    }
    if (ci >= 0 && clen > 0) {
      const nStart = cbMap[ci]!;
      const nEnd = cbMap[Math.min(ci + clen - 1, cbMap.length - 1)]!;
      return { ni: nStart, nlen: nEnd - nStart + 1 };
    }
  }

  const lcs = longestCommonSubstring(nc, nb);
  const lcsMin = Math.max(8, Math.floor(nc.length * 0.35));
  if (lcs.len >= lcsMin) {
    return { ni: lcs.bi, nlen: lcs.len };
  }
  return null;
}

function normSpanToRaw(
  map: number[],
  ni: number,
  nlen: number
): { start: number; end: number } | null {
  if (ni < 0 || nlen <= 0 || !map.length) return null;
  const start = map[ni];
  const endIdx = Math.min(ni + nlen - 1, map.length - 1);
  const end = map[endIdx]! + 1;
  if (start == null || end <= start) return null;
  return { start, end };
}

/** 在原文中定位引用片段，返回 [start, end) */
export function locateQuoteInText(
  text: string,
  quote: string
): { start: number; end: number } | null {
  const q = (quote || "").trim();
  if (!text || !q || q.length < 4) return null;

  const exact = text.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };

  const { norm: nb, map } = normalizeForLocate(text);
  const { norm: nc } = normalizeForLocate(q);
  const hit = fuzzyLocateInNorm(nb, nc);
  if (!hit) return null;
  return normSpanToRaw(map, hit.ni, hit.nlen);
}

export function quotesEqual(a: string, b: string): boolean {
  const na = contentOnly(normalizeForLocate(a || "").norm).core;
  const nb = contentOnly(normalizeForLocate(b || "").norm).core;
  if (!na || !nb) return false;
  return na === nb;
}
