import { courseDataUrl, encodeCourseId } from "@/lib/course";
import { withBase } from "@/lib/withBase";
import {
  KG_PROCESSED_SCHEMA_VERSION,
  kgProcessedFileStem,
  type KgProcessedArtifact,
  type KgProcessedScope,
} from "@/lib/kg/kgProcessedArtifact";

async function fetchKgProcessed(url: string): Promise<KgProcessedArtifact | null> {
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

export async function tryLoadKgProcessed(
  courseId: string,
  scope: KgProcessedScope,
  opts: { lectureId?: string; sessionPair?: [string, string] | null } = {}
): Promise<KgProcessedArtifact | null> {
  const stem = kgProcessedFileStem(scope, opts);
  const bust = `t=${Date.now()}`;
  // 1) 课内 pipeline（sync-data 目标路径）
  const primary = await fetchKgProcessed(
    `${courseDataUrl(courseId, `pipeline/${stem}.json`)}?${bust}`,
  );
  if (primary) return primary;
  // 2) 回退仓库 viz 挂载（staging 上常见：viz 有、pipeline 未同步）
  const vizSeg = encodeCourseId(courseId);
  return fetchKgProcessed(
    withBase(`/repo-data/viz/${vizSeg}/${stem}.json?${bust}`),
  );
}
