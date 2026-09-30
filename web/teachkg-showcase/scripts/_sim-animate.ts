import { generateAnimSpec, regenerateSandbox } from "../src/lib/apps/animate/engines";
import { scoreSuitability } from "../src/lib/apps/animate/suitability";
import { parseFrequencyTable, parseClauses } from "../src/lib/apps/animate/examples";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log("=== 1. 适合性分档 ===");
const cases = [
  { title: "哈夫曼算法", kpKind: "技术" as const },
  { title: "四色定理", kpKind: "定理" as const },
  { title: "同一律", kpKind: "原理" as const },
  { title: "广度优先搜索", kpKind: "技术" as const },
];
for (const c of cases) {
  const s = scoreSuitability(c);
  console.log(c.title, "→", s.tier, s.engine, s.suitability.toFixed(2));
}
assert(scoreSuitability({ title: "同一律", kpKind: "原理" }).tier === "skip", "同一律应 skip");
assert(scoreSuitability({ title: "哈夫曼算法" }).tier === "crafted", "哈夫曼应 crafted");

console.log("\n=== 2. 课内频率解析 ===");
const freq = parseFrequencyTable("字符频率 A:4 B:1 C:2 D:7 用于编码");
console.log(freq);
assert(freq && freq.A === 4 && freq.D === 7, "频率解析失败");

console.log("\n=== 3. 哈夫曼生成（课内例）===");
const huff = generateAnimSpec({
  knowledgePoint: "哈夫曼算法",
  engine: "huffman",
  suitability: 0.97,
  reason: "test",
  context: "哈夫曼编码。频率 A:4 B:1 C:2 D:7。每次合并最小。",
});
console.log({
  tier: huff.tier,
  used: huff.usedCourseExample,
  frames: huff.frames.length,
  eta: huff.etaSec,
  hasDef: huff.frames.every((f) => !!f.definition),
  hasDelta: huff.frames.every((f) => !!f.delta),
  tip: huff.frames.some((f) => /易错/.test(f.tip || "")),
});
assert(huff.usedCourseExample, "应使用课内频率");
assert(huff.frames.every((f) => f.definition && f.delta), "三层叙事不完整");

console.log("\n=== 4. BFS 沙盘换起点 ===");
const bfs = generateAnimSpec({
  knowledgePoint: "BFS",
  engine: "graph-bfs",
  suitability: 0.96,
  reason: "test",
});
const bfsB = regenerateSandbox(bfs, { startId: "B" });
console.log("start A frames", bfs.frames[0].caption);
console.log("start B frames", bfsB.frames[0].caption);
assert(bfs.frames.every((f) => f.hud && f.hud.label.includes("队列")), "BFS 应有队列 HUD");
const expand = bfs.frames.find((f) => /扩展|出队/.test(f.caption));
assert(
  expand && (expand.nodes || []).some((n) => n.state === "frontier"),
  "刚入队的点应是 frontier 而不是 done"
);

console.log("\n=== 5. 随机图 ===");
const rnd = regenerateSandbox(bfs, { randomize: true, seed: 42, startId: "A" });
console.log("random nodes", rnd.startOptions);
assert((rnd.startOptions?.length || 0) >= 4, "随机图节点过少");

console.log("\n=== 6. 着色易错提示 ===");
const color = generateAnimSpec({
  knowledgePoint: "四色定理",
  engine: "graph-coloring",
  suitability: 0.97,
  reason: "test",
});
assert(color.frames.some((f) => /易错|冲突/.test(f.tip || "")), "着色缺少易错提示");
console.log("color frames", color.frames.length, "ok");

console.log("\n=== 7. 子句解析 ===");
const clauses = parseClauses("CNF {(p∨q), (¬p∨r), (¬q∨r), (¬r)} 不可满足");
console.log(clauses);
assert(clauses && clauses.length >= 3, "子句解析失败");

console.log("\n全部模拟通过");
