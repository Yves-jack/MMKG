import assert from "node:assert/strict";
import test from "node:test";

import { studentMasteryMiddleware } from "./studentMastery.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function request({
  url = "/api/student-mastery?course_id=92311",
  method = "GET",
  token = "signed-student-token",
  env = { AI_TEACHING_API_URL: "http://ai-teaching:5001/" },
  fetchImpl = async () => response({ course_id: "92311", mastery: { 集合: 3.25 } }),
} = {}) {
  const headers = {};
  let body;
  let nextCalled = false;
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(value) { body = value; },
  };
  await studentMasteryMiddleware(env, fetchImpl)(
    { url, method, headers: token == null ? {} : { "x-kg-token": token } },
    res,
    () => { nextCalled = true; },
  );
  return { status: res.statusCode, headers, body: body && JSON.parse(body), nextCalled };
}

test("requires a signed KG token and rejects caller-supplied student IDs", async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; throw new Error("unexpected fetch"); };
  const missing = await request({ token: null, fetchImpl });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers["cache-control"], "no-store");

  const forged = await request({
    url: "/api/student-mastery?course_id=92311&studentId=another-student",
    fetchImpl,
  });
  assert.equal(forged.status, 400);
  assert.equal(fetches, 0);
});

test("returns 503 without the AI-Teaching API base", async () => {
  const result = await request({ env: {} });
  assert.equal(result.status, 503);
  assert.equal(result.headers["cache-control"], "no-store");
});

test("forwards only the course and token, returning validated 0–5 mastery", async () => {
  const calls = [];
  const result = await request({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({ course_id: "92311", mastery: { 集合: 3.25, 图论: 0 } });
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    course_id: "92311",
    mastery: { 集合: 3.25, 图论: 0 },
  });
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(calls[0].url, "http://ai-teaching:5001/api/knowledge-links/courses/92311/mastery");
  assert.equal(calls[0].init.headers["X-KG-Token"], "signed-student-token");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /signed-student-token/);
});

test("preserves upstream authorization errors and converts server failures", async () => {
  const forbidden = await request({ fetchImpl: async () => response({ detail: "forbidden" }, 403) });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.upstream_status, 403);

  const failed = await request({ fetchImpl: async () => response({ detail: "internal" }, 500) });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.upstream_status, 500);
  assert.equal(failed.headers["cache-control"], "no-store");
});

test("rejects invalid success payloads and handles transport failures", async () => {
  const invalid = await request({
    fetchImpl: async () => response({ course_id: "92311", mastery: { 集合: 6 } }),
  });
  assert.equal(invalid.status, 502);

  const network = await request({ fetchImpl: async () => { throw new Error("secret token"); } });
  assert.equal(network.status, 502);
  assert.doesNotMatch(JSON.stringify(network.body), /secret token/);
});

test("ignores unrelated routes and rejects writes", async () => {
  const unrelated = await request({ url: "/api/other" });
  assert.equal(unrelated.nextCalled, true);
  const write = await request({ method: "POST" });
  assert.equal(write.status, 405);
  assert.equal(write.headers.allow, "GET");
});


test("preserves validated identity and anonymous class metadata", async () => {
  const result = await request({fetchImpl: async () => response({course_id:"92311", mastery:{uuid:0}, scope:"class_average", learner_count:8, missing_records:"zero", knowledge_points:[{id:"uuid",name:"集合",mastery:0,studentId:"must-not-leak"}]})});
  assert.equal(result.status,200);
  assert.equal(result.body.scope,"class_average");
  assert.equal(result.body.learner_count,8);
  assert.deepEqual(result.body.knowledge_points,[{id:"uuid",name:"集合",mastery:0}]);
  assert.doesNotMatch(JSON.stringify(result.body), /must-not-leak/);
});
