import assert from "node:assert/strict";
import test from "node:test";

import { loadKnowledgeResources } from "./knowledgeResources.mjs";

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("combines AI-Teaching resources with KG-owned video relations", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/jxb_login")) return response({ access_token: "kg-access" });
    if (String(url).includes("video-segments")) return response({ segment_ids: ["seg-1"] });
    return response({
      resources: [
        {
          resource_type: "exercise",
          resource_id: "q-1",
          title: "集合练习",
        },
      ],
    });
  };

  const result = await loadKnowledgeResources(
    { courseId: "92311", knowledgePointId: "集合/set", kgToken: "launch-token" },
    {
      AI_TEACHING_API_URL: "http://ai:5001",
      KNOWLEDGE_GRAPH_API_URL: "http://kg:8000/api",
    },
    fetchImpl,
  );

  assert.deepEqual(
    result.resources.map((item) => [item.resource_type, item.resource_id]),
    [["exercise", "q-1"], ["video", "seg-1"]],
  );
  assert.equal(result.warnings.length, 0);
  assert.match(calls[0].url, /knowledge-points\/%E9%9B%86%E5%90%88%2Fset\/resources$/);
  assert.equal(calls[0].init.headers["X-KG-Token"], "launch-token");
  assert.equal(JSON.parse(calls[1].init.body).kg_token, "launch-token");
  assert.equal(calls[2].init.headers.Authorization, "Bearer kg-access");
});

test("returns partial results and warnings when one dependency fails", async () => {
  const result = await loadKnowledgeResources(
    { courseId: "92311", knowledgePointId: "kp-1", kgToken: "launch-token" },
    {
      AI_TEACHING_API_URL: "http://ai:5001",
      KNOWLEDGE_GRAPH_API_URL: "http://kg:8000/api",
    },
    async (url) => {
      if (String(url).startsWith("http://ai")) return response({}, 503);
      if (String(url).endsWith("/jxb_login")) return response({ access_token: "kg-token" });
      return response({ segment_ids: ["seg-2"] });
    },
  );

  assert.deepEqual(result.resources.map((item) => item.resource_id), ["seg-2"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /AI-Teaching resources HTTP 503/);
});
