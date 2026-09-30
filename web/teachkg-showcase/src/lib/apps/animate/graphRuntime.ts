import type { AnimEdge, AnimFrame, AnimNode, GraphModel } from "./types";

function layoutCircle(ids: string[], cx = 200, cy = 120, r = 90): AnimNode[] {
  const n = ids.length || 1;
  return ids.map((id, i) => {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2;
    return {
      id,
      label: id,
      x: cx + r * Math.cos(ang),
      y: cy + r * Math.sin(ang),
      state: "idle" as const,
    };
  });
}

export function defaultGraph(): GraphModel {
  const nodes = layoutCircle(["A", "B", "C", "D", "E"]);
  // snap to nicer positions close to original demo
  const pos: Record<string, [number, number]> = {
    A: [80, 120],
    B: [200, 40],
    C: [200, 200],
    D: [320, 80],
    E: [320, 180],
  };
  for (const n of nodes) {
    const p = pos[n.id];
    if (p) {
      n.x = p[0];
      n.y = p[1];
    }
  }
  const edges: AnimEdge[] = [
    { id: "e1", from: "A", to: "B", state: "idle" },
    { id: "e2", from: "A", to: "C", state: "idle" },
    { id: "e3", from: "B", to: "D", state: "idle" },
    { id: "e4", from: "C", to: "D", state: "idle" },
    { id: "e5", from: "C", to: "E", state: "idle" },
    { id: "e6", from: "D", to: "E", state: "idle" },
  ];
  return { nodes, edges };
}

/** 随机连通无向图（沙盘用） */
export function randomGraph(seed = Date.now()): GraphModel {
  let s = seed % 2147483647;
  const rnd = () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
  const labels = ["A", "B", "C", "D", "E", "F"].slice(0, 4 + Math.floor(rnd() * 3));
  const nodes = layoutCircle(labels);
  const edges: AnimEdge[] = [];
  let ei = 0;
  // ring for connectivity
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i];
    const b = labels[(i + 1) % labels.length];
    edges.push({ id: `e${ei++}`, from: a, to: b, state: "idle" });
  }
  // random chords
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 2; j < labels.length; j++) {
      if ((i === 0 && j === labels.length - 1) || rnd() > 0.45) continue;
      edges.push({
        id: `e${ei++}`,
        from: labels[i],
        to: labels[j],
        state: "idle",
      });
    }
  }
  return { nodes, edges };
}

function adjList(g: GraphModel): Map<string, { to: string; eid: string }[]> {
  const m = new Map<string, { to: string; eid: string }[]>();
  for (const n of g.nodes) m.set(n.id, []);
  for (const e of g.edges) {
    m.get(e.from)?.push({ to: e.to, eid: e.id });
    m.get(e.to)?.push({ to: e.from, eid: e.id });
  }
  return m;
}

function paint(
  g: GraphModel,
  active: string[],
  done: Set<string>,
  frontier: Set<string>,
  activeE: Set<string>,
  doneE: Set<string>
): Pick<AnimFrame, "nodes" | "edges"> {
  const activeSet = new Set(active);
  return {
    nodes: g.nodes.map((n) => ({
      ...n,
      state: activeSet.has(n.id)
        ? "active"
        : frontier.has(n.id)
          ? "frontier"
          : done.has(n.id)
            ? "done"
            : "idle",
    })),
    edges: g.edges.map((e) => ({
      ...e,
      state: activeE.has(e.id)
        ? "active"
        : doneE.has(e.id)
          ? "done"
          : "idle",
    })),
  };
}

function hudOf(
  label: string,
  items: string[],
  activeItems: string[] = []
): AnimFrame["hud"] {
  const active = activeItems
    .map((id) => items.indexOf(id))
    .filter((i) => i >= 0);
  return { label, items, active };
}

const DEF_BFS =
  "广度优先：先扩展完当前层的所有邻接，再进入下一层（队列）。";
const DEF_DFS =
  "深度优先：沿一条路走到不能再走，再回溯（栈）。";

/** 真正跑 BFS 生成帧（支持任意图与起点） */
export function runBfsFrames(
  g: GraphModel,
  start: string,
  courseQuote?: string
): AnimFrame[] {
  const adj = adjList(g);
  if (!adj.has(start)) start = g.nodes[0]?.id || "A";
  const frames: AnimFrame[] = [];
  const seen = new Set<string>([start]);
  const processed = new Set<string>();
  const treeE = new Set<string>();
  const q: string[] = [start];
  const order: string[] = [];
  let prev = "";

  frames.push({
    caption: `初始化：从 ${start} 出发`,
    detail: `队列头是下一步要扩展的点`,
    definition: courseQuote || DEF_BFS,
    analysis: `BFS 用队列保证「先发现的先扩展」，因此按层推进。起点 ${start} 入队后仍是蓝色（在队中），还没有被处理；灰色才是未发现。`,
    delta: "开始时只有起点在队列里",
    tip: "时间 O(V+E)；无权图上得到的是边数最短路",
    hud: hudOf("队列 Q（左=队头）", [...q], [start]),
    ...paint(g, [start], processed, new Set(q), new Set(), treeE),
  });

  while (q.length) {
    const u = q.shift()!;
    processed.add(u);
    order.push(u);
    const activeE = new Set<string>();
    const discovered: string[] = [];
    for (const { to, eid } of adj.get(u) || []) {
      if (seen.has(to)) continue;
      seen.add(to);
      q.push(to);
      activeE.add(eid);
      treeE.add(eid);
      discovered.push(to);
    }
    const frontier = new Set(q);
    const delta = discovered.length
      ? `新发现 ${discovered.join("、")}，入队`
      : `${u} 无未访邻居`;
    frames.push({
      caption: `出队并扩展 ${u}`,
      detail: discovered.length
        ? `${discovered.join("、")} 进入队尾，属于下一层`
        : `${u} 的邻居都已见过，队列继续往前`,
      definition: DEF_BFS,
      analysis: discovered.length
        ? `处理 ${u}（变绿）时，只把尚未见过的邻居 ${discovered.join("、")} 放到队尾（蓝色）。队头永远是当前层里更早发现的点，所以不会「跳层」。`
        : `${u} 处理完毕。队列里剩下的仍按发现顺序等待，这就是「先广后深」。`,
      delta: prev ? `${delta}（焦点 ${prev} → ${u}）` : delta,
      tip: "对照：若用栈，新发现的点会立刻被拿来扩展，就变成 DFS",
      hud: hudOf("队列 Q（左=队头）", [...q], discovered),
      ...paint(g, [u], processed, frontier, activeE, treeE),
    });
    prev = u;
  }

  frames.push({
    caption: "BFS 完成",
    detail: `处理顺序 ${order.join(" → ")}`,
    definition: DEF_BFS,
    analysis: `绿边是广度优先树：每个点只在第一次被发现时连上。队列已空，所有从 ${start} 可达的点都处理过了。`,
    delta: "队列已空",
    tip: "若图不连通，需对其余分量再选起点",
    hud: hudOf("队列 Q", []),
    ...paint(g, [], processed, new Set(), new Set(), treeE),
  });
  return frames;
}

/** 真正跑 DFS 生成帧 */
export function runDfsFrames(
  g: GraphModel,
  start: string,
  courseQuote?: string
): AnimFrame[] {
  const adj = adjList(g);
  if (!adj.has(start)) start = g.nodes[0]?.id || "A";
  const frames: AnimFrame[] = [];
  const seen = new Set<string>([start]);
  const finished = new Set<string>();
  const treeE = new Set<string>();
  const stack: string[] = [start];

  frames.push({
    caption: `从 ${start} 开始深入`,
    detail: "栈顶是当前所在点；栈里整条路径都还在",
    definition: courseQuote || DEF_DFS,
    analysis: `DFS 用栈（或递归）保证「后发现的先扩展」。${start} 在栈顶（绿色当前点），蓝色是仍在路径上的祖先。下一步会先走一个未访邻居，而不是扫完同层。`,
    delta: "起点压栈",
    tip: "时间同样 O(V+E)；访问形状与 BFS 不同",
    hud: hudOf("栈 S（右=栈顶）", [...stack], [start]),
    ...paint(g, [start], finished, new Set(stack), new Set(), treeE),
  });

  let prev = "";
  while (stack.length) {
    const u = stack[stack.length - 1];
    let next: { to: string; eid: string } | null = null;
    for (const nb of adj.get(u) || []) {
      if (!seen.has(nb.to)) {
        next = nb;
        break;
      }
    }
    if (next) {
      stack.push(next.to);
      seen.add(next.to);
      treeE.add(next.eid);
      const path = new Set(stack);
      frames.push({
        caption: `走向 ${next.to}`,
        detail: `沿边深入；栈顶换成 ${next.to}`,
        definition: DEF_DFS,
        analysis: `从 ${u} 选未访邻居 ${next.to} 立刻压栈。栈从左到右就是从起点到当前点的路径——这与 BFS「先处理完同层」相反。`,
        delta: prev ? "沿边继续前进（不换层）" : "开始第一条深入路径",
        tip: "易错：不会先把所有邻居都看一遍再走",
        hud: hudOf("栈 S（右=栈顶）", [...stack], [next.to]),
        ...paint(
          g,
          [next.to],
          finished,
          path,
          new Set([next.eid]),
          treeE
        ),
      });
      prev = next.to;
    } else {
      stack.pop();
      finished.add(u);
      const top = stack[stack.length - 1];
      const path = new Set(stack);
      frames.push({
        caption: top ? `从 ${u} 回溯到 ${top}` : `${u} 回溯结束`,
        detail: `${u} 已走完，弹出栈顶`,
        definition: DEF_DFS,
        analysis: `${u} 没有未访邻居了，变成已完成（绿）。回溯不是失败，只是回到祖先换一条边；栈里仍保留从起点到 ${top || "空"} 的路径。`,
        delta: "无未访邻居 → 回溯",
        tip: "对照 BFS：广度优先没有「回溯」这一步",
        hud: hudOf("栈 S（右=栈顶）", [...stack], top ? [top] : []),
        ...paint(g, top ? [top] : [], finished, path, new Set(), treeE),
      });
      prev = top || u;
    }
    if (frames.length > 40) break;
  }

  frames.push({
    caption: "DFS 完成",
    detail: `完成序 ${[...finished].join(" → ")}`,
    definition: DEF_DFS,
    analysis: "栈空。绿边是深度优先树：每次深入只连一条新边。可与同一张图的 BFS 对照访问形状。",
    delta: "栈空",
    tip: "同一图、不同访问形状：这就是 BFS / DFS 的差别",
    hud: hudOf("栈 S", []),
    ...paint(g, [], finished, new Set(), new Set(), treeE),
  });
  return frames;
}

export function runColoringFrames(
  g: GraphModel,
  courseQuote?: string
): AnimFrame[] {
  const adj = adjList(g);
  const order = g.nodes.map((n) => n.id);
  const colorOf: Record<string, number> = {};
  const frames: AnimFrame[] = [];
  const DEF =
    courseQuote || "图着色：相邻顶点异色；四色定理说平面图至多 4 色即可。";

  const snap = (focus?: string) => ({
    nodes: g.nodes.map((n) => ({
      ...n,
      colorIndex: colorOf[n.id],
      state: (focus === n.id
        ? "active"
        : colorOf[n.id] != null
          ? "done"
          : "idle") as AnimNode["state"],
      label:
        colorOf[n.id] != null ? `${n.label}·色${colorOf[n.id] + 1}` : n.label,
    })),
    edges: g.edges.map((e) => ({ ...e, state: "idle" as const })),
  });

  frames.push({
    caption: "准备给顶点着色",
    detail: "贪心：按顺序为每个点选最小可用色号",
    definition: DEF,
    analysis:
      "合法着色要求相邻顶点颜色不同。下面用贪心：每个点看邻居已经占用的色，选最小没被占用的编号。这能保证合法，但不保证用色最少。",
    delta: "尚未着色",
    tip: "贪心着色数可能 > 色数 χ(G)，但是好演示",
    ...snap(),
  });

  let prevColors = 0;
  for (const v of order) {
    const used = new Set(
      (adj.get(v) || [])
        .map((x) => colorOf[x.to])
        .filter((c) => c != null) as number[]
    );
    let c = 0;
    while (used.has(c)) c += 1;
    // 错误示范提示：若强行用邻居色会冲突
    const wrong = used.size ? [...used][0] : null;
    colorOf[v] = c;
    const usedN = new Set(Object.values(colorOf)).size;
    frames.push({
      caption: `给 ${v} 着第 ${c + 1} 色`,
      detail: `邻居已用：${
        [...used].map((x) => x + 1).join(", ") || "无"
      } → 选 ${c + 1}`,
      definition: DEF,
      analysis: used.size
        ? `${v} 的邻居已经占用色 ${[...used].map((x) => x + 1).join("、")}，所以最小合法色是 ${c + 1}。若强行用邻居的色 ${wrong != null ? wrong + 1 : "?"}，边会冲突。`
        : `${v} 还没有已着色的邻居，任选色 1 即可。后续点会避开这个色。`,
      delta:
        usedN > prevColors
          ? `色数增加到 ${usedN}`
          : `仍用现有 ${usedN} 色即可`,
      tip:
        wrong != null
          ? `易错：若给 ${v} 误用色 ${wrong + 1}，会与邻居冲突`
          : "第一点可任选色 1",
      hud: {
        label: "已用色",
        items: Array.from({ length: usedN }, (_, i) => `色${i + 1}`),
        active: [c],
      },
      ...snap(v),
    });
    prevColors = usedN;
  }

  frames.push({
    caption: "着色完成",
    detail: `共用 ${new Set(Object.values(colorOf)).size} 种颜色`,
    definition: DEF,
    analysis: `每个顶点都有颜色，且每条边两端不同色，所以这是合法着色。共用 ${new Set(Object.values(colorOf)).size} 色是贪心结果，不是 χ(G) 的证明。`,
    delta: "所有顶点已着色且相邻异色",
    tip: "平面图 → 四色定理保证 ≤4；本演示是贪心示意",
    hud: {
      label: "已用色",
      items: Array.from(
        { length: new Set(Object.values(colorOf)).size },
        (_, i) => `色${i + 1}`
      ),
    },
    ...snap(),
  });
  return frames;
}
