import test from "node:test";
import assert from "node:assert/strict";
import { bindMasteryToMindmap, masteryScore, masteryVisual, collapseMindmap } from "./mindmapMasteryBinding.mjs";

test("binds UUID scores to full Chinese or bilingual labels without losing zero", () => {
  const scores = bindMasteryToMindmap({mastery: {uuid: 0, b: 4.25}, knowledge_points: [{id:"uuid", name:"集合/set", mastery:0}, {id:"b", name:"并集", mastery:4.25}]});
  assert.equal(masteryScore({id:"__topic__/集合",zh:"集合"}, scores),0);
  assert.equal(masteryScore({id:"b",zh:"union"}, scores),4.25);
  assert.equal(masteryScore({id:"unknown",zh:"交集"}, scores),undefined);
});
test("does not guess ambiguous names or fuzzy-match different concepts", () => {
  const scores = bindMasteryToMindmap({mastery:{a:1,b:5}, knowledge_points:[{id:"a",name:"图",mastery:1},{id:"b",name:"图",mastery:5}]});
  assert.equal(masteryScore({id:"x",zh:"图"},scores),undefined);
  assert.equal(masteryScore({id:"x",zh:"图的定义"},scores),undefined);
});
test("higher mastery reduces marker size and changes color; missing differs from zero", () => {
  assert.ok(masteryVisual(0).radius > masteryVisual(5).radius);
  assert.notEqual(masteryVisual(0).color,masteryVisual(5).color);
  assert.equal(masteryVisual(0).status,"unlearned");
  assert.equal(masteryVisual(undefined).status,"unrecorded");
  assert.equal(masteryVisual(4.25).status,"mastered");
});
test("collapse preserves descendants and per-occurrence state across reopen", () => {
  const leaf = {id:"leaf",zh:"叶",children:[],__sourcePath:[0,0,0]};
  const branch = {id:"branch",zh:"章",children:[leaf],__sourcePath:[0,0]};
  const root={id:"root",zh:"课",children:[branch],__sourcePath:[0]};
  const doc={root,roots:[root]};
  const closed=collapseMindmap(doc,1);
  assert.equal(closed.root.children[0].children.length,0);
  assert.equal(closed.root.children[0].__hasChildren,true);
  const open=collapseMindmap(doc,1,{"0.0":true});
  assert.equal(open.root.children[0].children[0].id,"leaf");
  assert.deepEqual(open.root.children[0].children[0].__sourcePath,[0,0,0]);
  assert.equal(doc.root.children[0].children.length,1);
});
