import type { AnimEngineId, AnimTier } from "./types";

type TemplateRule = {
  engine: AnimEngineId;
  weight: number;
  test: RegExp;
  reason: string;
  tier: AnimTier;
};

const RULES: TemplateRule[] = [
  {
    engine: "graph-bfs",
    weight: 0.96,
    tier: "crafted",
    test: /BFS|广度优先|广度优先搜|层次遍历/i,
    reason: "广度优先搜索适合逐步点亮邻接层",
  },
  {
    engine: "graph-dfs",
    weight: 0.96,
    tier: "crafted",
    test: /DFS|深度优先|深度优先搜|回溯搜/i,
    reason: "深度优先搜索适合栈式回溯动画",
  },
  {
    engine: "graph-bfs",
    weight: 0.72,
    tier: "sketch",
    test: /最短路|Dijkstra|迪杰斯特拉|Floyd|Bellman/i,
    reason: "最短路目前只能套用无权 BFS 示意，不是 Dijkstra 松弛过程",
  },
  {
    engine: "graph-dfs",
    weight: 0.88,
    tier: "crafted",
    test: /欧拉|Euler|哈密顿|Hamilton|连通分量|拓扑排序/i,
    reason: "图论路径类问题适合节点/边遍历动画",
  },
  {
    engine: "huffman",
    weight: 0.97,
    tier: "crafted",
    test: /哈夫曼|霍夫曼|Huffman|最优前缀|前缀码/i,
    reason: "哈夫曼编码可演示贪心合并与树生长",
  },
  {
    engine: "graph-coloring",
    weight: 0.97,
    tier: "crafted",
    test: /四色|五色|着色|染色|graph\s*color|地图着色/i,
    reason: "图着色可逐步给顶点上色并标出易错冲突",
  },
  {
    engine: "resolution-trace",
    weight: 0.92,
    tier: "crafted",
    test: /DPLL|归结|消解|resolution|SAT|合取范式|CNF|子句/i,
    reason: "归结/DPLL 可用子句集合收缩过程演示",
  },
  {
    engine: "generic-steps",
    weight: 0.72,
    tier: "sketch",
    test: /算法|方法|technique|algorithm|范式化|Skolem|前束|符号化/i,
    reason: "过程性技术可用分步要点示意（非精制引擎）",
  },
];

export function matchAnimEngine(
  title: string,
  context = ""
): {
  engine: AnimEngineId;
  suitability: number;
  reason: string;
  tier: AnimTier;
} | null {
  const blob = `${title}\n${context}`.slice(0, 600);
  let best: {
    engine: AnimEngineId;
    suitability: number;
    reason: string;
    tier: AnimTier;
  } | null = null;
  for (const rule of RULES) {
    if (!rule.test.test(blob)) continue;
    const hit = {
      engine: rule.engine,
      suitability: rule.weight,
      reason: rule.reason,
      tier: rule.tier,
    };
    if (!best || hit.suitability > best.suitability) best = hit;
  }
  return best;
}

export function isAnimatable(score: number, tier: AnimTier) {
  return tier !== "skip" && score >= 0.7;
}

export function scoreSuitability(input: {
  title: string;
  context?: string;
  kpKind?: string;
}): {
  engine: AnimEngineId | null;
  suitability: number;
  reason: string;
  tier: AnimTier;
} {
  const hit = matchAnimEngine(input.title, input.context || "");
  if (hit) return hit;

  if (input.kpKind === "技术") {
    return {
      engine: "generic-steps",
      suitability: 0.72,
      reason: "技术类可做要点示意（建议优先看精制引擎条目）",
      tier: "sketch",
    };
  }
  if (input.kpKind === "定理" && /图|路|树|网络|着色|证明过程/.test(input.title)) {
    return {
      engine: "generic-steps",
      suitability: 0.7,
      reason: "部分图论定理可做示意步骤",
      tier: "sketch",
    };
  }
  return {
    engine: null,
    suitability: 0.25,
    reason: "偏概念/陈述，缺少可逐步可视化的过程——暂不推荐做成动画",
    tier: "skip",
  };
}

export const TIER_LABEL: Record<AnimTier, string> = {
  crafted: "精制引擎",
  sketch: "示意动画",
  skip: "暂不推荐",
};
