/**
 * 导图 Phase A/B/C 回归。
 * 运行：npx vite-node scripts/check-mindmap-phase-a.mts
 */
import {
  applyMindmapAntiPatterns,
  assignMindmapForest,
  buildMindmapFromForest,
  collectMindmapTreeEdges,
  hierarchyEdgeScore,
  mindmapNodeImportance,
  mindmapQualityStats,
  parseCueLabelSec,
  withUpdatedImportance,
} from "../src/lib/kg/mindmapFromProcessedGraph";
import type { PipelineEdge, PipelineNode } from "../src/lib/pipeline/types";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("OK:", msg);
  }
}

// --- A: unit ---
assert(mindmapNodeImportance({ importance: 0.72 }) === 0.72, "读 importance");
assert(
  mindmapNodeImportance({ importance: null as unknown as number }) === 0,
  "无 importance 不回退"
);
assert(parseCueLabelSec("片段 3 · 1363s") === 1363, "解析 cue_label");

const scoreGood = hierarchyEdgeScore({
  rel: "belong_to",
  parentImp: 0.7,
  childImp: 0.2,
});
const scoreBad = hierarchyEdgeScore({
  rel: "belong_to",
  parentImp: 0.24,
  childImp: 0.72,
});
assert(scoreGood > scoreBad, `倒挂惩罚 ${scoreGood.toFixed(3)} > ${scoreBad.toFixed(3)}`);

// --- A: 挂父选课堂修正高分父 ---
const nodes: PipelineNode[] = [
  { id: "命题逻辑", label: "命题逻辑", importance: 0.72 },
  { id: "谓词逻辑", label: "谓词逻辑", importance: 0.24 },
  { id: "逻辑基础", label: "逻辑基础", importance: 0.8 },
  { id: "原子命题", label: "原子命题", importance: 0.3 },
  { id: "复合命题", label: "复合命题", importance: 0.25 },
  { id: "联结词", label: "联结词", importance: 0.2 },
];
const edges: PipelineEdge[] = [
  { id: "e1", from: "命题逻辑", to: "谓词逻辑", relation: "belong_to", cue_label: "片段 · 100s" },
  { id: "e2", from: "命题逻辑", to: "逻辑基础", relation: "belong_to", cue_label: "片段 · 50s" },
  { id: "e3", from: "原子命题", to: "命题逻辑", relation: "part_of", cue_label: "片段 · 200s" },
  { id: "e4", from: "复合命题", to: "命题逻辑", relation: "part_of", cue_label: "片段 · 220s" },
  { id: "e5", from: "联结词", to: "命题逻辑", relation: "part_of", cue_label: "片段 · 240s" },
  { id: "e6", from: "谓词逻辑", to: "逻辑基础", relation: "belong_to", cue_label: "片段 · 300s" },
];
let forest = withUpdatedImportance(assignMindmapForest(nodes, edges), nodes);
assert(
  forest.parentOf.get("命题逻辑")?.parent === "逻辑基础",
  `命题逻辑→逻辑基础，实际=${forest.parentOf.get("命题逻辑")?.parent}`
);

// --- C: 反模式翻转 ---
const flipNodes: PipelineNode[] = [
  { id: "命题逻辑", label: "命题逻辑", importance: 0.7 },
  { id: "谓词逻辑", label: "谓词逻辑", importance: 0.5 },
  { id: "量词", label: "量词", importance: 0.4 },
  { id: "全称量词", label: "全称量词", importance: 0.2 },
  { id: "存在量词", label: "存在量词", importance: 0.2 },
  { id: "原子", label: "原子", importance: 0.15 },
  { id: "复合", label: "复合", importance: 0.15 },
];
const flipSet = new Set(flipNodes.map((n) => n.id));
const labels = new Map(flipNodes.map((n) => [n.id, n.label || n.id]));
const flipped = applyMindmapAntiPatterns(
  [
    { id: "f1", from: "命题逻辑", to: "谓词逻辑", relation: "belong_to" },
    { id: "f2", from: "全称量词", to: "谓词逻辑", relation: "belong_to" },
    { id: "f3", from: "存在量词", to: "谓词逻辑", relation: "part_of" },
    { id: "f4", from: "量词", to: "谓词逻辑", relation: "part_of" },
    { id: "f5", from: "原子", to: "命题逻辑", relation: "part_of" },
    { id: "f6", from: "复合", to: "命题逻辑", relation: "part_of" },
  ],
  flipSet,
  labels
);
assert(
  flipped.some((e) => e.from === "谓词逻辑" && e.to === "命题逻辑" && e.relation === "part_of"),
  "命题/谓词 belong 已翻转"
);
assert(
  flipped.filter((e) => e.from === "全称量词").every((e) => e.to === "量词"),
  "全称量词改挂量词"
);

const flipForest = assignMindmapForest(flipNodes, [
  { id: "f1", from: "命题逻辑", to: "谓词逻辑", relation: "belong_to" },
  { id: "f2", from: "全称量词", to: "谓词逻辑", relation: "belong_to" },
  { id: "f3", from: "存在量词", to: "谓词逻辑", relation: "part_of" },
  { id: "f4", from: "量词", to: "谓词逻辑", relation: "part_of" },
  { id: "f5", from: "原子", to: "命题逻辑", relation: "part_of" },
  { id: "f6", from: "复合", to: "命题逻辑", relation: "part_of" },
  { id: "f7", from: "谓词逻辑", to: "命题逻辑", relation: "related_with" },
]);
assert(
  flipForest.parentOf.get("谓词逻辑")?.parent === "命题逻辑",
  `翻转后谓词逻辑父=命题逻辑，实际=${flipForest.parentOf.get("谓词逻辑")?.parent}`
);
assert(
  flipForest.parentOf.get("全称量词")?.parent === "量词",
  `全称量词父=量词，实际=${flipForest.parentOf.get("全称量词")?.parent}`
);

// --- A: 弱父 / 副本 ---
const copyNodes: PipelineNode[] = [
  { id: "谓词", label: "谓词", importance: 0.47 },
  { id: "谓词逻辑", label: "谓词逻辑", importance: 0.6 },
  { id: "简单命题", label: "简单命题", importance: 0.17 },
  { id: "命题", label: "命题", importance: 0.45 },
  { id: "谓词变项", label: "谓词变项", importance: 0.13 },
  { id: "一元谓词", label: "一元谓词", importance: 0.1 },
  { id: "量词", label: "量词", importance: 0.4 },
  { id: "全称量词", label: "全称量词", importance: 0.2 },
];
const copyEdges: PipelineEdge[] = [
  { id: "c1", from: "谓词", to: "谓词逻辑", relation: "part_of" },
  { id: "c2", from: "谓词", to: "简单命题", relation: "belong_to" },
  { id: "c3", from: "命题", to: "谓词", relation: "belong_to" },
  { id: "c4", from: "谓词变项", to: "谓词", relation: "belong_to" },
  { id: "c5", from: "一元谓词", to: "谓词", relation: "belong_to" },
  { id: "c6", from: "量词", to: "谓词逻辑", relation: "part_of" },
  { id: "c7", from: "全称量词", to: "量词", relation: "belong_to" },
  { id: "c8", from: "简单命题", to: "谓词逻辑", relation: "belong_to" },
];
const cf = assignMindmapForest(copyNodes, copyEdges);
assert(cf.parentOf.get("谓词")?.parent === "谓词逻辑", "谓词主父=谓词逻辑");
assert(
  !cf.extraPlacements.some((p) => p.parent === "简单命题"),
  "弱父不挂副本"
);
const doc = buildMindmapFromForest(cf, { lectureId: "test" });
assert(Boolean(doc), "合成导图");
if (doc) {
  const copies: { id: string; kids: number }[] = [];
  const walk = (n: (typeof doc.root)["children"][0]) => {
    if (n.copy) copies.push({ id: n.id, kids: n.children.length });
    for (const c of n.children) walk(c);
  };
  walk(doc.root);
  assert(copies.every((c) => c.kids === 0), "副本无子树");
}

// --- A: firstSeen ---
const orderNodes: PipelineNode[] = [
  { id: "根", label: "根", importance: 0.9 },
  { id: "晚", label: "晚", importance: 0.9 },
  { id: "早", label: "早", importance: 0.1 },
  { id: "中", label: "中", importance: 0.5 },
  { id: "叶1", label: "叶1", importance: 0.05 },
  { id: "叶2", label: "叶2", importance: 0.05 },
];
const orderEdges: PipelineEdge[] = [
  { id: "o1", from: "晚", to: "根", relation: "belong_to", cue_label: "片段 · 900s" },
  { id: "o2", from: "早", to: "根", relation: "belong_to", cue_label: "片段 · 100s" },
  { id: "o3", from: "中", to: "根", relation: "belong_to", cue_label: "片段 · 500s" },
  { id: "o4", from: "叶1", to: "早", relation: "belong_to", cue_label: "片段 · 110s" },
  { id: "o5", from: "叶2", to: "中", relation: "belong_to", cue_label: "片段 · 510s" },
];
const od = buildMindmapFromForest(assignMindmapForest(orderNodes, orderEdges), {
  lectureId: "ord",
});
if (od) {
  const hub = od.root.id === "根" ? od.root : od.root.children.find((c) => c.id === "根")!;
  const ids = hub.children.filter((c) => !c.copy).map((c) => c.id);
  assert(ids[0] === "早" && ids[1] === "中" && ids[2] === "晚", `firstSeen 序 ${ids}`);
}

// --- B: deps 旁路 ---
const depNodes: PipelineNode[] = [
  { id: "归结", label: "归结", importance: 0.55 },
  { id: "范式", label: "范式", importance: 0.5 },
  { id: "前束范式", label: "前束范式", importance: 0.3 },
  { id: "子句", label: "子句", importance: 0.25 },
  { id: "Skolem", label: "Skolem", importance: 0.2 },
];
const depEdges: PipelineEdge[] = [
  { id: "d1", from: "前束范式", to: "范式", relation: "belong_to" },
  { id: "d2", from: "Skolem", to: "范式", relation: "belong_to" },
  { id: "d3", from: "子句", to: "前束范式", relation: "part_of" },
  { id: "d4", from: "归结", to: "范式", relation: "depend_on" },
  { id: "d5", from: "子句", to: "归结", relation: "related_with" },
];
const df = assignMindmapForest(depNodes, depEdges);
assert(
  [...(df.deps.get("归结") || [])].includes("范式"),
  `deps 含范式：${[...(df.deps.get("归结") || [])]}`
);
assert(
  [...(df.related.get("子句") || [])].includes("归结"),
  "related_with 进 related"
);
const dd = buildMindmapFromForest(df, { lectureId: "dep" });
assert(Boolean(dd), "依赖图可生成");
if (dd) {
  const find = (n: typeof dd.root, id: string): typeof dd.root | null => {
    if (n.id === id) return n;
    for (const c of n.children) {
      const h = find(c, id);
      if (h) return h;
    }
    return null;
  };
  // 归结应被回流挂上（高分 + depend_on）
  const gui = find(dd.root, "归结");
  assert(Boolean(gui), "高分 depend_on 实体回流进导图");
  assert(
    Boolean(gui?.deps?.includes("范式") || gui?.salvaged),
    "回流节点带 deps 或 salvaged"
  );
  assert((dd.meta?.attached_orphans || 0) >= 1, "meta.attached_orphans≥1");
}

// --- B: 浅树高分豁免 ---
const shallowNodes: PipelineNode[] = [
  { id: "主题A", label: "主题A", importance: 0.9 },
  { id: "a1", label: "a1", importance: 0.4 },
  { id: "a2", label: "a2", importance: 0.35 },
  { id: "主题B", label: "主题B", importance: 0.2 },
  { id: "b1", label: "b1", importance: 0.05 },
];
const shallowEdges: PipelineEdge[] = [
  { id: "s1", from: "a1", to: "主题A", relation: "belong_to", cue_label: "片段 · 10s" },
  { id: "s2", from: "a2", to: "主题A", relation: "belong_to", cue_label: "片段 · 20s" },
  { id: "s3", from: "b1", to: "主题B", relation: "belong_to", cue_label: "片段 · 30s" },
];
const sd = buildMindmapFromForest(assignMindmapForest(shallowNodes, shallowEdges), {
  lectureId: "sh",
});
assert(Boolean(sd), "浅树高分可保留");
if (sd) {
  const ids: string[] = [];
  const walk = (n: typeof sd.root) => {
    ids.push(n.id);
    for (const c of n.children) walk(c);
  };
  walk(sd.root);
  assert(ids.includes("主题A"), "高分浅主题A保留");
}

if (doc) {
  assert(collectMindmapTreeEdges(doc.root).length > 0, "收集树边");
  const qs = mindmapQualityStats(doc.root);
  assert(typeof qs.salvaged === "number", "quality 含 salvaged");
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll Phase A/B/C checks passed.");
