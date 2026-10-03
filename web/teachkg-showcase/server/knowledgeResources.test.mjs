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
    if (String(url).includes("video-segments")) return response({
      video_refs: [{
        segment_id: "stale-segment-id",
        video_id: "video-1",
        start_sec: 10,
        end_sec: 20,
      }],
    });
    if (String(url).includes("segments/by-video-refs")) return response([{
      id: "segment-1",
      course_id: "92311",
      lesson_id: "2",
      video_id: "video-1",
      summary: "集合的并集与交集",
      start_sec: 10,
      end_sec: 20,
      link: "/media/2.mp4",
    }]);
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
    {
      courseId: "92311",
      knowledgePointId: "集合/set",
      nodeName: "集合",
      nodeAliases: ["set", "集合论"],
      nodeContent: "离散数学中的集合运算",
      kgToken: "launch-token",
      accessToken: "mmkg-access",
    },
    {
      AI_TEACHING_API_URL: "http://ai:5001",
      MMKG_API_URL: "http://mmkg:8000/api",
      VIDEO_SEARCH_API_URL: "http://video:8000",
    },
    fetchImpl,
  );

  assert.deepEqual(
    result.resources.map((item) => [item.resource_type, item.resource_id]),
    [["exercise", "q-1"], ["video", "segment-1"]],
  );
  assert.equal(result.resources[1].title, "第 2 讲");
  assert.equal(result.resources[1].content, "集合的并集与交集");
  assert.equal(
    result.resources[1].path,
    "/video?course_id=92311&video_id=video-1&start_sec=10",
  );
  assert.equal(result.warnings.length, 0);
  assert.match(calls[0].url, /knowledge-points\/%E9%9B%86%E5%90%88%2Fset\/resources\?/);
  assert.match(calls[0].url, /node_name=%E9%9B%86%E5%90%88/);
  assert.match(calls[0].url, /node_alias=set/);
  assert.match(calls[0].url, /node_content=/);
  assert.equal(calls[0].init.headers["X-KG-Token"], "launch-token");
  assert.equal(calls[1].init.headers.Authorization, "Bearer mmkg-access");
  assert.match(calls[1].url, /\?name=%E9%9B%86%E5%90%88$/);
  assert.equal(calls[2].url, "http://video:8000/api/v1/segments/by-video-refs");
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    course_id: "92311",
    refs: [{ video_id: "video-1", start_sec: 10 }],
  });
});

test("returns partial results and warnings when one dependency fails", async () => {
  const result = await loadKnowledgeResources(
    {
      courseId: "92311",
      knowledgePointId: "kp-1",
      kgToken: "launch-token",
      accessToken: "mmkg-access",
    },
    {
      AI_TEACHING_API_URL: "http://ai:5001",
      MMKG_API_URL: "http://mmkg:8000/api",
    },
    async (url) => {
      if (String(url).startsWith("http://ai")) return response({}, 503);
      return response({ video_refs: [] });
    },
  );

  assert.deepEqual(result.resources, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /AI-Teaching resources HTTP 503/);
});

test("drops video relations without the complete course/video/start contract", async () => {
  const result = await loadKnowledgeResources(
    {
      courseId: "92311",
      knowledgePointId: "kp-1",
      kgToken: "launch-token",
      accessToken: "mmkg-access",
    },
    {
      AI_TEACHING_API_URL: "http://ai:5001",
      MMKG_API_URL: "http://mmkg:8000/api",
    },
    async (url) => String(url).includes("video-segments")
      ? response({ video_refs: [{ video_id: "video-2" }] })
      : response({ resources: [] }),
  );

  assert.deepEqual(result.resources, []);
});

test("omits linked videos instead of inventing display content when VideoSearch is unavailable", async () => {
  const result = await loadKnowledgeResources(
    {
      courseId: "92311",
      knowledgePointId: "kp-1",
      kgToken: "launch-token",
      accessToken: "mmkg-access",
    },
    {
      AI_TEACHING_API_URL: "http://ai:5001",
      MMKG_API_URL: "http://mmkg:8000/api",
      VIDEO_SEARCH_API_URL: "http://video:8000",
    },
    async (url) => {
      if (String(url).includes("video-segments")) return response({
        video_refs: [{ segment_id: "segment-1", video_id: "video-1", start_sec: 10, end_sec: 20 }],
      });
      if (String(url).includes("segments/by-video-refs")) return response({}, 503);
      return response({ resources: [] });
    },
  );

  assert.deepEqual(result.resources, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /VideoSearch segment metadata HTTP 503/);
});
