/** 快速冒烟：层次规则 + 分阶段实体合并 */
import assert from "node:assert/strict";

function primaryZh(name) {
  return (name || "").split("/")[0].trim();
}

function foldLatinCase(s) {
  return (s || "").replace(/[A-Za-z]+/g, (w) => w.toLowerCase());
}

function pickCanonical(names, textbook) {
  const list = [...new Set(names)];
  const score = (n) => {
    let s = 0;
    if (textbook?.has(n)) s += 100;
    const en = n.includes("/") ? n.split("/").slice(1).join("/") : "";
    if (en) s += 20;
    if (en && en === en.toLowerCase()) s += 8;
    return s;
  };
  return list.slice().sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

/** 与 lectureKgProcess.buildStagedEntityMergeMap 同序：大小写→整体→局部 */
function buildStagedMergeMap(entityNames, textbookNames) {
  const names = [...new Set(entityNames.map((n) => n.trim()).filter(Boolean))];
  const parent = new Map(names.map((n) => [n, n]));
  const find = (x) => {
    const p = parent.get(x) || x;
    if (p !== x) {
      const r = find(p);
      parent.set(x, r);
      return r;
    }
    return x;
  };
  const uniteGroup = (group) => {
    const roots = [...new Set(group.map(find))];
    if (roots.length < 2) return;
    const canon = pickCanonical(roots, textbookNames);
    const keep = find(canon);
    for (const r of roots) {
      const rr = find(r);
      if (rr !== keep) parent.set(rr, keep);
    }
  };
  const bucket = (keyFn) => {
    const m = new Map();
    for (const r of new Set(names.map(find))) {
      const k = keyFn(r);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    for (const g of m.values()) uniteGroup(g);
  };
  // 1 case
  bucket((n) => foldLatinCase(n));
  // 2 whole
  bucket((n) => {
    const zh = primaryZh(n);
    const en = n.includes("/") ? n.split("/").slice(1).join("/").trim() : "";
    if (zh && en) return `W\t${zh}\t${foldLatinCase(en)}`;
    if (zh) return `W\t${zh}\t`;
    return `W\t\t${foldLatinCase(en || n)}`;
  });
  // 3 local zh
  bucket((n) => {
    const zh = primaryZh(n);
    return zh.length >= 2 ? `Z\t${zh}` : "";
  });
  const map = new Map();
  for (const n of names) {
    const r = find(n);
    if (r !== n) map.set(n, r);
  }
  return map;
}

function pruneHierarchy(edges) {
  const belong = new Map();
  const partOf = new Map();
  for (const e of edges) {
    const r = e.relation;
    if (r === "belong_to") {
      if (!belong.has(e.from)) belong.set(e.from, new Set());
      belong.get(e.from).add(e.to);
    } else if (r === "part_of") {
      if (!partOf.has(e.from)) partOf.set(e.from, new Set());
      partOf.get(e.from).add(e.to);
    }
  }
  return edges.filter((e) => {
    if (e.relation !== "part_of") return true;
    const parents = belong.get(e.from);
    if (!parents) return true;
    for (const p of parents) {
      if (partOf.get(p)?.has(e.to)) return false;
    }
    return true;
  });
}

const edges = [
  { from: "子", to: "父", relation: "belong_to" },
  { from: "父", to: "祖", relation: "part_of" },
  { from: "子", to: "祖", relation: "part_of" },
  { from: "A", to: "B", relation: "related_with" },
];
const kept = pruneHierarchy(edges);
assert.equal(kept.length, 3);
assert.ok(!kept.some((e) => e.from === "子" && e.to === "祖" && e.relation === "part_of"));

const textbook = new Set(["量词/quantifier", "谓词逻辑/Predicate Logic"]);
const mmap = buildStagedMergeMap(
  [
    "量词/Quantifier",
    "量词/quantifier",
    "命题逻辑/Propositional Logic",
    "命题逻辑/propositional logic",
    "多元谓词/multiary predicate",
    "多元谓词/n-ary predicate",
    "谓词/predicate",
  ],
  textbook
);
// 大小写：Quantifier → quantifier（教材优先）
assert.equal(mmap.get("量词/Quantifier"), "量词/quantifier");
assert.equal(mmap.get("命题逻辑/Propositional Logic"), "命题逻辑/propositional logic");
// 局部：同中文主名不同英文
assert.ok(
  mmap.get("多元谓词/n-ary predicate") === "多元谓词/multiary predicate" ||
    mmap.get("多元谓词/multiary predicate") === "多元谓词/n-ary predicate" ||
    (!mmap.has("多元谓词/n-ary predicate") && !mmap.has("多元谓词/multiary predicate"))
);
// 二者应进同一代表元
const a = mmap.get("多元谓词/n-ary predicate") || "多元谓词/n-ary predicate";
const b = mmap.get("多元谓词/multiary predicate") || "多元谓词/multiary predicate";
assert.equal(a, b);

console.log("smoke-lecture-kg-process: ok");
