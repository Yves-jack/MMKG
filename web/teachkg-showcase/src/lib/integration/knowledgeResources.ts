import { withBase } from "@/lib/withBase";

export type LinkedKnowledgeResource = {
  resource_type: "video" | "exercise" | "animation" | "formula";
  resource_id: string;
  course_id?: string;
  title?: string;
  content?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown>;
  start_sec?: number;
  end_sec?: number;
  knowledge_point_ids?: string[];
};

export type LinkedKnowledgeResources = {
  resources: LinkedKnowledgeResource[];
  warnings: string[];
  match?: {
    method?: string;
    matched_knowledge_points?: Array<{ id: string; content?: string; score?: number }>;
  };
};

const MMKG_API_BASE = String(import.meta.env.VITE_MMKG_API_BASE || "/mmkg-api").replace(/\/+$/, "");
let loginCache: { kgToken: string; accessToken: string } | null = null;

export async function mmkgAccessToken(kgToken: string): Promise<string> {
  if (loginCache?.kgToken === kgToken) return loginCache.accessToken;
  const response = await fetch(`${MMKG_API_BASE}/jxb_login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kg_token: kgToken }),
  });
  if (!response.ok) throw new Error(`MMKG login HTTP ${response.status}`);
  const payload = await response.json();
  const accessToken = String(payload.access_token || "");
  if (!accessToken) throw new Error("MMKG login omitted access_token");
  loginCache = { kgToken, accessToken };
  return accessToken;
}

export async function fetchMmkgGraph(
  courseId: string,
  kgToken: string,
  view: "base" | "document" | "fused" | "video" = "fused",
) {
  const accessToken = await mmkgAccessToken(kgToken);
  const response = await fetch(
    `${MMKG_API_BASE}/v1/courses/${encodeURIComponent(courseId)}/graphs/${view}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  if (!response.ok) throw new Error(`MMKG graph HTTP ${response.status}`);
  return response.json() as Promise<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  }>;
}

async function mmkgGraphRequest(
  courseId: string,
  kgToken: string,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const accessToken = await mmkgAccessToken(kgToken);
  const response = await fetch(
    `${MMKG_API_BASE}/graph/${encodeURIComponent(courseId)}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`MMKG mutation HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.status === 204 ? null : response.json();
}

export function updateMmkgNode(
  courseId: string,
  kgToken: string,
  nodeId: string,
  patch: Record<string, unknown>,
) {
  return mmkgGraphRequest(courseId, kgToken, `/node/${encodeURIComponent(nodeId)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export function deleteMmkgNode(courseId: string, kgToken: string, nodeId: string) {
  return mmkgGraphRequest(courseId, kgToken, `/node/${encodeURIComponent(nodeId)}`, {
    method: "DELETE",
  });
}

export function updateMmkgEdge(
  courseId: string,
  kgToken: string,
  edgeId: string,
  patch: Record<string, unknown>,
) {
  return mmkgGraphRequest(courseId, kgToken, `/edge/${encodeURIComponent(edgeId)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export function deleteMmkgEdge(courseId: string, kgToken: string, edgeId: string) {
  return mmkgGraphRequest(courseId, kgToken, `/edge/${encodeURIComponent(edgeId)}`, {
    method: "DELETE",
  });
}

export async function fetchLinkedKnowledgeResources(input: {
  courseId: string;
  knowledgePointId: string;
  kgToken?: string;
  nodeName?: string;
  nodeAliases?: string[];
  nodeContent?: string;
}): Promise<LinkedKnowledgeResources> {
  const query = new URLSearchParams({
    course_id: input.courseId,
    knowledge_point_id: input.knowledgePointId,
  });
  if (input.nodeName) query.set("node_name", input.nodeName);
  for (const alias of input.nodeAliases || []) {
    if (alias) query.append("node_alias", alias);
  }
  if (input.nodeContent) query.set("node_content", input.nodeContent);
  if (!input.kgToken) throw new Error("kg_token is required");
  const accessToken = await mmkgAccessToken(input.kgToken);
  const response = await fetch(withBase(`/api/knowledge-resources?${query}`), {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-KG-Token": input.kgToken,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return {
    resources: Array.isArray(payload.resources) ? payload.resources : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
    match: payload.match && typeof payload.match === "object" ? payload.match : undefined,
  };
}

export function emitKnowledgeResourceOpen(
  resource: LinkedKnowledgeResource,
  targetOrigin: string,
) {
  if (window.parent === window) return false;
  window.parent.postMessage(
    {
      type: "kg:open-resource",
      payload: resource,
    },
    targetOrigin,
  );
  return true;
}
