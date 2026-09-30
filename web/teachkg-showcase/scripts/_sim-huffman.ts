import { buildHuffmanTreeFrames } from "../src/lib/apps/animate/huffmanTree";
import { parseFrequencyTable } from "../src/lib/apps/animate/examples";

function assert(c: unknown, m: string) {
  if (!c) throw new Error(m);
}

const r = buildHuffmanTreeFrames(
  parseFrequencyTable("A:5 B:2 C:3 D:1"),
  undefined
);

console.log("frames", r.frames.length, "used", r.usedCourseExample);
for (const [i, f] of r.frames.entries()) {
  const n = f.nodes?.length || 0;
  const e = f.edges?.length || 0;
  const bars = f.bars?.length || 0;
  console.log(
    `#${i}`,
    f.caption,
    `nodes=${n} edges=${e} bars=${bars}`,
    (f.analysis || "").slice(0, 36) + "…"
  );
  assert(bars === 0, "哈夫曼不应再出现 bars");
  assert(n > 0, "每帧应有树节点");
  assert(f.analysis && f.analysis.length > 40, "analysis 应更详细");
  assert(f.hud, "哈夫曼应有森林 HUD");
}

assert(r.frames[0].edges?.length === 0, "初始森林无边");
assert((r.frames.at(-1)?.edges?.length || 0) >= 3, "最终树应有多条边");
console.log("哈夫曼树分镜验收通过");
