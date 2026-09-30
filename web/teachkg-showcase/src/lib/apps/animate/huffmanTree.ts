/**
 * 哈夫曼：全程树森林演示（见 ANIMATION_DESIGN.md §4）
 */
import type { FreqTable } from "./examples";
import { defaultHuffmanFreq } from "./examples";
import type { AnimEdge, AnimFrame, AnimNode } from "./types";

type HNode = {
  id: string;
  name: string;
  weight: number;
  left?: string;
  right?: string;
  symbol?: string;
};

type ForestState = {
  nodes: Map<string, HNode>;
  roots: string[];
};

function createForest(freq: FreqTable): ForestState {
  const nodes = new Map<string, HNode>();
  const roots: string[] = [];
  for (const [sym, w] of Object.entries(freq)) {
    const id = `L_${sym}`;
    nodes.set(id, { id, name: sym, weight: w, symbol: sym });
    roots.push(id);
  }
  return { nodes, roots };
}

function sortRoots(state: ForestState) {
  state.roots.sort(
    (a, b) =>
      state.nodes.get(a)!.weight - state.nodes.get(b)!.weight ||
      a.localeCompare(b)
  );
}

function forestWeights(state: ForestState): string {
  return [...state.roots]
    .sort(
      (a, b) =>
        state.nodes.get(a)!.weight - state.nodes.get(b)!.weight ||
        a.localeCompare(b)
    )
    .map((r) => {
      const n = state.nodes.get(r)!;
      return `${n.symbol || n.name}(${n.weight})`;
    })
    .join("、");
}

/** 递归布局一棵树，返回占用宽度 */
function layoutOneTree(
  state: ForestState,
  rootId: string,
  leftX: number,
  highlight: { active?: string[]; frontier?: string[]; focusEdge?: string[] }
): { nodes: AnimNode[]; edges: AnimEdge[]; width: number } {
  const levelH = 58;
  const leafW = 44;
  const nodesOut: AnimNode[] = [];
  const edgesOut: AnimEdge[] = [];

  const widthOf = (id: string): number => {
    const n = state.nodes.get(id)!;
    if (!n.left) return leafW;
    return widthOf(n.left) + (n.right ? widthOf(n.right) : leafW);
  };

  const place = (id: string, x0: number, depth: number): number => {
    const n = state.nodes.get(id)!;
    const w = widthOf(id);
    const cx = x0 + w / 2;
    const y = 32 + depth * levelH;
    const active = highlight.active?.includes(id);
    const frontier = highlight.frontier?.includes(id);
    nodesOut.push({
      id,
      label: n.symbol ? `${n.symbol}:${n.weight}` : String(n.weight),
      x: cx,
      y,
      state: active ? "active" : frontier ? "frontier" : "idle",
    });
    if (n.left) {
      const lw = widthOf(n.left);
      place(n.left, x0, depth + 1);
      const eid = `${id}->${n.left}`;
      edgesOut.push({
        id: eid,
        from: id,
        to: n.left,
        label: "0",
        state: highlight.focusEdge?.includes(eid)
          ? "active"
          : active
            ? "active"
            : "idle",
      });
      if (n.right) {
        place(n.right, x0 + lw, depth + 1);
        const eidR = `${id}->${n.right}`;
        edgesOut.push({
          id: eidR,
          from: id,
          to: n.right,
          label: "1",
          state: highlight.focusEdge?.includes(eidR)
            ? "active"
            : active
              ? "active"
              : "idle",
        });
      }
    }
    return w;
  };

  const width = place(rootId, leftX, 0);
  return { nodes: nodesOut, edges: edgesOut, width };
}

function layoutForest(
  state: ForestState,
  highlight: {
    active?: string[];
    frontier?: string[];
    focusEdge?: string[];
  } = {}
): { nodes: AnimNode[]; edges: AnimEdge[] } {
  const gap = 24;
  let x = 16;
  const allN: AnimNode[] = [];
  const allE: AnimEdge[] = [];
  const order = [...state.roots].sort(
    (a, b) =>
      state.nodes.get(a)!.weight - state.nodes.get(b)!.weight ||
      a.localeCompare(b)
  );

  for (const rid of order) {
    const part = layoutOneTree(state, rid, x, highlight);
    allN.push(...part.nodes);
    allE.push(...part.edges);
    x += part.width + gap;
  }

  if (allN.length) {
    const minX = Math.min(...allN.map((n) => n.x));
    const maxX = Math.max(...allN.map((n) => n.x));
    const shift = 200 - (minX + maxX) / 2;
    for (const n of allN) n.x += shift;
    // 若仍越界，整体压缩
    const min2 = Math.min(...allN.map((n) => n.x));
    const max2 = Math.max(...allN.map((n) => n.x));
    if (max2 - min2 > 370) {
      const s = 370 / (max2 - min2);
      const mid = (min2 + max2) / 2;
      for (const n of allN) n.x = 200 + (n.x - mid) * s;
    }
    const minY = Math.min(...allN.map((n) => n.y));
    const maxY = Math.max(...allN.map((n) => n.y));
    if (maxY > 210) {
      const s = (210 - 28) / Math.max(1, maxY - minY);
      for (const n of allN) n.y = 28 + (n.y - minY) * s;
    }
  }
  return { nodes: allN, edges: allE };
}

function collectIds(state: ForestState, id: string, out: string[]) {
  out.push(id);
  const n = state.nodes.get(id);
  if (n?.left) collectIds(state, n.left, out);
  if (n?.right) collectIds(state, n.right, out);
}

function forestHud(state: ForestState, activeIds: string[] = []) {
  const items = forestWeights(state).split("、").filter(Boolean);
  const names = new Set(
    activeIds.map((id) => {
      const n = state.nodes.get(id);
      return n ? `${n.symbol || n.name}(${n.weight})` : "";
    })
  );
  const active = items
    .map((item, i) => (names.has(item) ? i : -1))
    .filter((i) => i >= 0);
  return { label: "森林（按权从小到大）", items, active };
}

function codesFromTree(state: ForestState, rootId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (id: string, pref: string) => {
    const n = state.nodes.get(id)!;
    if (n.symbol) {
      out[n.symbol] = pref || "0";
      return;
    }
    if (n.left) walk(n.left, pref + "0");
    if (n.right) walk(n.right, pref + "1");
  };
  walk(rootId, "");
  return out;
}

export function buildHuffmanTreeFrames(
  freqIn?: FreqTable | null,
  courseQuote?: string
): { frames: AnimFrame[]; usedCourseExample: boolean; exampleNote?: string } {
  const usedCourseExample = !!(freqIn && Object.keys(freqIn).length >= 3);
  const freq = { ...(freqIn || defaultHuffmanFreq()) };
  const exampleNote = usedCourseExample
    ? `课内频率：${Object.entries(freq)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ")}`
    : "示意例 A:5 B:2 C:3 D:1（课内未解析到频率表）";

  const DEF =
    courseQuote ||
    "哈夫曼算法：在森林中反复取出权值最小的两棵树，合并为新树（权=两权之和），直到只剩一棵——即最优前缀码树。";

  const state = createForest(freq);
  let seq = 0;
  const frames: AnimFrame[] = [];

  frames.push({
    caption: "初始：每个符号一棵树",
    detail: `森林 = { ${forestWeights(state)} }`,
    definition: DEF,
    analysis: `每个符号先画成一棵只有根的树，根上的数字是频率。现在 ${state.roots.length} 棵树并排，还没有 0/1 边。接下来每一步只比较这些树根的权。`,
    delta: "符号表 → 树的森林",
    tip: "合并的是整棵子树，不是两个孤立数字",
    hud: forestHud(state),
    ...layoutForest(state),
  });

  while (state.roots.length > 1) {
    sortRoots(state);
    const aId = state.roots[0];
    const bId = state.roots[1];
    const a = state.nodes.get(aId)!;
    const b = state.nodes.get(bId)!;
    const heavy = state.nodes.get(state.roots[state.roots.length - 1])!;

    frames.push({
      caption: `选出最小两棵：${a.name} 与 ${b.name}`,
      detail: `权 ${a.weight} 与 ${b.weight}`,
      definition: DEF,
      analysis: `贪心只看根权：最小的是 ${a.name}(${a.weight}) 与 ${b.name}(${b.weight})。若错选 ${a.name} 和最重的 ${heavy.name}(${heavy.weight})，高频符号往往被压得更深，平均码长变差。`,
      delta: "高亮权最小的两棵树根",
      tip: "不要按字母序选，只按权值",
      hud: forestHud(state, [aId, bId]),
      ...layoutForest(state, {
        active: [aId, bId],
        frontier: (() => {
          const ids: string[] = [];
          collectIds(state, aId, ids);
          collectIds(state, bId, ids);
          return ids;
        })(),
      }),
    });

    const nid = `T${++seq}`;
    state.nodes.set(nid, {
      id: nid,
      name: `${a.name}${b.name}`,
      weight: a.weight + b.weight,
      left: aId,
      right: bId,
    });
    state.roots = [nid, ...state.roots.slice(2)];

    frames.push({
      caption: `合并为新树（根权 ${a.weight + b.weight}）`,
      detail: `新根=${a.weight}+${b.weight}；左 0→${a.name}，右 1→${b.name}`,
      definition: DEF,
      analysis: `新建父结点，左孩子续写 0、右孩子续写 1。父结点的权是两棵子树频率之和。合并后还剩 ${state.roots.length} 棵树，新树要重新进入下一轮比较。`,
      delta: "树的个数减 1，多出一层父子边",
      tip:
        state.roots.length === 1
          ? "只剩一棵：前缀树成形，下一步读编码"
          : "新树权可能不是最小，下一轮重新排序",
      hud: forestHud(state, [nid]),
      ...layoutForest(state, {
        active: [nid],
        frontier: [aId, bId],
        focusEdge: [`${nid}->${aId}`, `${nid}->${bId}`],
      }),
    });
  }

  const rootId = state.roots[0];
  const codes = codesFromTree(state, rootId);
  const codeStr = Object.entries(codes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("，");
  const sample =
    Object.entries(codes).sort((x, y) => x[1].length - y[1].length)[0]?.[0] ||
    Object.keys(codes)[0];
  const sampleCode = codes[sample] || "";

  const pathIds: string[] = [];
  const pathEdges: string[] = [];
  {
    let cur = rootId;
    pathIds.push(cur);
    for (const bit of sampleCode) {
      const n = state.nodes.get(cur)!;
      const next = bit === "0" ? n.left : n.right;
      if (!next) break;
      pathEdges.push(`${cur}->${next}`);
      cur = next;
      pathIds.push(cur);
    }
  }

  const laid = layoutForest(state, { active: pathIds, focusEdge: pathEdges });
  for (const n of laid.nodes) {
    const colon = n.label.indexOf(":");
    if (colon < 0) continue;
    const sym = n.label.slice(0, colon);
    if (codes[sym]) n.label = `${sym} ${codes[sym]}`;
  }

  frames.push({
    caption: "前缀树完成 · 读出编码",
    detail: `编码表：${codeStr}`,
    definition: DEF,
    analysis: `从根走到叶：0 向左、1 向右。例如 ${sample} 沿高亮路径得到 ${sampleCode}。这是前缀码：任一码都不是另一码的前缀，所以可以唯一解码。给定频率时，加权路径长 ∑ 频率×深度 最小。`,
    delta: "任务从合并森林变为在树上读码",
    tip: "作业里 0/1 左右对调时码字可能不同，但各符号码长应一致",
    hud: {
      label: "前缀码",
      items: Object.entries(codes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`),
      active: [Object.keys(codes).sort().indexOf(sample)].filter((i) => i >= 0),
    },
    ...laid,
  });

  return { frames, usedCourseExample, exampleNote };
}
