import test from "node:test";
import assert from "node:assert/strict";
import {
  createMasteryEntityIndex,
  masteryEntityDetails,
} from "./masteryEntityDetails.mjs";
test("imported topic resolves canonical aliases and real definition by exact identity", () => {
  const index = createMasteryEntityIndex(
    [
      {
        id: "子图/Subgraph",
        label: "子图",
        aliases: ["子图", "Subgraph", "部分图"],
      },
    ],
    { 子图: "顶点集和边集分别为原图子集的图。" },
  );
  const result = masteryEntityDetails(
    { id: "__section__/子图", zh: "子图" },
    index,
  );
  assert.equal(result.canonical, "子图/Subgraph");
  assert.deepEqual(result.aliases, ["Subgraph", "部分图"]);
  assert.match(result.definition, /顶点集/);
});
test("owned definition is preferred and metadata is never invented from names or importance blurbs", () => {
  const index = createMasteryEntityIndex(
    [
      { id: "a", label: "甲", description: "实体定义。" },
      { id: "b", label: "乙", description: "反馈后: 0.5" },
    ],
    { a: "后备定义" },
  );
  assert.equal(
    masteryEntityDetails({ id: "a", zh: "甲" }, index).definition,
    "实体定义。",
  );
  assert.equal(
    masteryEntityDetails({ id: "b", zh: "乙" }, index).definition,
    "",
  );
  assert.deepEqual(masteryEntityDetails({ id: "unknown", zh: "未知" }, index), {
    canonical: "未知",
    aliases: [],
    definition: "",
  });
});
test("ambiguous short names do not select a different concept's aliases or definition", () => {
  const index = createMasteryEntityIndex(
    [
      { id: "a", label: "重名", aliases: ["甲"] },
      { id: "b", label: "重名", aliases: ["乙"] },
    ],
    { a: "甲的定义", b: "乙的定义" },
  );
  assert.equal(
    masteryEntityDetails({ id: "__section__/重名", zh: "重名" }, index)
      .definition,
    "",
  );
  assert.equal(
    masteryEntityDetails({ id: "b", zh: "重名" }, index).definition,
    "乙的定义",
  );
});
