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
};

export type LinkedKnowledgeResources = {
  resources: LinkedKnowledgeResource[];
  warnings: string[];
};

export async function fetchLinkedKnowledgeResources(input: {
  courseId: string;
  knowledgePointId: string;
  kgToken?: string;
}): Promise<LinkedKnowledgeResources> {
  const query = new URLSearchParams({
    course_id: input.courseId,
    knowledge_point_id: input.knowledgePointId,
  });
  if (input.kgToken) query.set("kg_token", input.kgToken);
  const response = await fetch(withBase(`/api/knowledge-resources?${query}`), {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return {
    resources: Array.isArray(payload.resources) ? payload.resources : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
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
