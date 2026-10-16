import test from "node:test";
import assert from "node:assert/strict";
import {knowledgeResourceIdentity, isStructuralMindmapNode} from "./mindmapResourceIdentity.mjs";
test("imported sections and topics query resources by canonical identity or explicit label",()=>{
 for (const prefix of ["__section__/", "__topic__/", "__salvage__/"]) {
  const node={id:prefix+"图的定义",zh:"图的定义"};
  assert.equal(isStructuralMindmapNode(node),false);
  assert.equal(knowledgeResourceIdentity(node,"uuid"),"uuid");
  assert.equal(knowledgeResourceIdentity(node,null),"图的定义");
 }
});
test("course/part/chapter wrappers never issue concept resource queries",()=>{
 for(const prefix of ["__course__/","__part__/","__chapter__/","__lecture__/","chapter:","part:"]) assert.equal(knowledgeResourceIdentity({id:prefix+"集合",zh:"集合"},null),null);
 assert.equal(knowledgeResourceIdentity(null,null),null);
});
