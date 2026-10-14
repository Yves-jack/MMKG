import { courseDataUrl } from "@/lib/course";
import {
  KG_PROCESSED_SCHEMA_VERSION,
  kgProcessedFileStem,
  type KgProcessedArtifact,
  type KgProcessedScope,
} from "@/lib/kg/kgProcessedArtifact";

export async function tryLoadKgProcessed(
  courseId: string,
  scope: KgProcessedScope,
  opts: { lectureId?: string; sessionPair?: [string, string] | null } = {}
): Promise<KgProcessedArtifact | null> {
  const stem = kgProcessedFileStem(scope, opts);
  const url = `${courseDataUrl(courseId, `pipeline/${stem}.json`)}?t=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as KgProcessedArtifact;
    if (data?.schema_version !== KG_PROCESSED_SCHEMA_VERSION) return null;
    if (!Array.isArray(data.nodes) || !Array.isArray(data.kept_edges)) return null;
    return data;
  } catch {
    return null;
  }
}
