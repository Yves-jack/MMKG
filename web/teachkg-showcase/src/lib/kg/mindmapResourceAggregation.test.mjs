import test from "node:test";
import assert from "node:assert/strict";

import { aggregateMindmapResourceQueries } from "./mindmapResourceAggregation.mjs";

const query = (node) =>
  node.resource
    ? { entityId: node.resource, entityAliases: [], matchMode: "concept" }
    : null;

test("从叶节点开始逐层汇总至父节点和根节点", () => {
  const leaf = { id: "leaf", resource: "leaf-resource", children: [] };
  const parent = {
    id: "parent",
    resource: "parent-resource",
    children: [leaf],
  };
  const root = {
    id: "root",
    resource: "root-resource",
    children: [parent],
  };

  assert.deepEqual(
    aggregateMindmapResourceQueries(leaf, query).map((item) => item.entityId),
    ["leaf-resource"]
  );
  assert.deepEqual(
    aggregateMindmapResourceQueries(parent, query).map((item) => item.entityId),
    ["parent-resource", "leaf-resource"]
  );
  assert.deepEqual(
    aggregateMindmapResourceQueries(root, query).map((item) => item.entityId),
    ["root-resource", "parent-resource", "leaf-resource"]
  );
});

test("直接子节点的已汇总结果合并时会去重", () => {
  const root = {
    id: "root",
    resource: "shared-resource",
    children: [
      { id: "left", resource: "shared-resource", children: [] },
      { id: "right", resource: "right-resource", children: [] },
    ],
  };

  assert.deepEqual(
    aggregateMindmapResourceQueries(root, query).map((item) => item.entityId),
    ["shared-resource", "right-resource"]
  );
});
