/** 轻量字符级 diff（课堂短文本足够）。 */

export type DiffSpan = { kind: "same" | "add" | "change" | "del"; text: string };

type Match = { a: number; b: number; size: number };

function longestMatch(
  a: string,
  b: string,
  a0: number,
  a1: number,
  b0: number,
  b1: number
): Match {
  let best: Match = { a: a0, b: b0, size: 0 };
  const bIndex = new Map<string, number[]>();
  for (let j = b0; j < b1; j++) {
    const ch = b[j]!;
    const arr = bIndex.get(ch);
    if (arr) arr.push(j);
    else bIndex.set(ch, [j]);
  }
  let lengths: Map<number, number> = new Map();
  for (let i = a0; i < a1; i++) {
    const next: Map<number, number> = new Map();
    const positions = bIndex.get(a[i]!) || [];
    for (const j of positions) {
      if (j < b0) continue;
      if (j >= b1) break;
      const prev = lengths.get(j - 1) || 0;
      const size = prev + 1;
      next.set(j, size);
      if (size > best.size) best = { a: i - size + 1, b: j - size + 1, size };
    }
    lengths = next;
  }
  return best;
}

function matchingBlocks(a: string, b: string): Match[] {
  const out: Match[] = [];
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [a0, a1, b0, b1] = queue.pop()!;
    const m = longestMatch(a, b, a0, a1, b0, b1);
    if (m.size < 1) continue;
    if (a0 < m.a && b0 < m.b) queue.push([a0, m.a, b0, m.b]);
    out.push(m);
    if (m.a + m.size < a1 && m.b + m.size < b1) {
      queue.push([m.a + m.size, a1, m.b + m.size, b1]);
    }
  }
  out.sort((x, y) => x.a - y.a || x.b - y.b);
  // merge adjacent
  const merged: Match[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.a + last.size === m.a &&
      last.b + last.size === m.b
    ) {
      last.size += m.size;
    } else {
      merged.push({ ...m });
    }
  }
  merged.push({ a: a.length, b: b.length, size: 0 });
  return merged;
}

export function compareTexts(before: string, after: string): {
  left: DiffSpan[];
  right: DiffSpan[];
  changeChunks: number;
  deletedChars: number;
  addedChars: number;
  identical: boolean;
} {
  const a = before || "";
  const b = after || "";
  if (a === b) {
    return {
      left: a ? [{ kind: "same", text: a }] : [],
      right: b ? [{ kind: "same", text: b }] : [],
      changeChunks: 0,
      deletedChars: 0,
      addedChars: 0,
      identical: true,
    };
  }

  const blocks = matchingBlocks(a, b);
  const left: DiffSpan[] = [];
  const right: DiffSpan[] = [];
  let ia = 0;
  let ib = 0;
  let changeChunks = 0;
  let deletedChars = 0;
  let addedChars = 0;

  const push = (arr: DiffSpan[], kind: DiffSpan["kind"], text: string) => {
    if (!text) return;
    const last = arr[arr.length - 1];
    if (last && last.kind === kind) last.text += text;
    else arr.push({ kind, text });
  };

  for (const m of blocks) {
    const del = a.slice(ia, m.a);
    const add = b.slice(ib, m.b);
    if (del && add) {
      push(left, "del", del);
      push(right, "change", add);
      changeChunks += 1;
      deletedChars += del.length;
      addedChars += add.length;
    } else if (del) {
      push(left, "del", del);
      changeChunks += 1;
      deletedChars += del.length;
    } else if (add) {
      push(right, "add", add);
      changeChunks += 1;
      addedChars += add.length;
    }
    if (m.size > 0) {
      const same = a.slice(m.a, m.a + m.size);
      push(left, "same", same);
      push(right, "same", same);
    }
    ia = m.a + m.size;
    ib = m.b + m.size;
  }

  return {
    left,
    right,
    changeChunks,
    deletedChars,
    addedChars,
    identical: false,
  };
}
