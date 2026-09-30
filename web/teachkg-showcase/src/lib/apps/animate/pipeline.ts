import {
  classifyKpKind,
  loadAllReviewPoints,
  loadImportanceScores,
  zhName,
} from "@/lib/apps/data";
import { generateAnimSpec } from "./engines";
import { isAnimatable, scoreSuitability } from "./suitability";
import type { AnimSpec, SuitabilityHit } from "./types";

export type AnimatePipelineResult = {
  candidates: SuitabilityHit[];
  specs: AnimSpec[];
  skipped: SuitabilityHit[];
  /** 今日最值得看：重要性 × 适合度 */
  todayId: string | null;
};

export async function runAnimatePipeline(
  courseId: string
): Promise<AnimatePipelineResult> {
  const [points, scores] = await Promise.all([
    loadAllReviewPoints(courseId),
    loadImportanceScores(courseId),
  ]);

  const seen = new Set<string>();
  const candidates: SuitabilityHit[] = [];

  for (const { lectureId, point } of points) {
    const title = point.zh || zhName(point.id);
    if (!title || seen.has(title)) continue;
    const kpKind = classifyKpKind(title) || classifyKpKind(point.id);
    if (!kpKind) continue;
    seen.add(title);
    const context = String(point.definition || point.summary || "").trim();
    const scored = scoreSuitability({ title, context, kpKind });
    candidates.push({
      knowledgePoint: title,
      entityId: point.id,
      lectureId,
      kpKind,
      context,
      suitability: scored.suitability,
      tier: scored.tier,
      reason: scored.reason,
      engine: scored.engine,
    });
  }

  candidates.sort((a, b) => {
    const ia = scores[a.entityId] ?? 0;
    const ib = scores[b.entityId] ?? 0;
    const ta = a.tier === "crafted" ? 2 : a.tier === "sketch" ? 1 : 0;
    const tb = b.tier === "crafted" ? 2 : b.tier === "sketch" ? 1 : 0;
    return tb - ta || b.suitability - a.suitability || ib - ia;
  });

  const specs: AnimSpec[] = [];
  const skipped: SuitabilityHit[] = [];
  for (const c of candidates) {
    if (!c.engine || !isAnimatable(c.suitability, c.tier)) {
      skipped.push(c);
      continue;
    }
    specs.push(
      generateAnimSpec({
        knowledgePoint: c.knowledgePoint,
        entityId: c.entityId,
        lectureId: c.lectureId,
        kpKind: c.kpKind,
        context: c.context,
        engine: c.engine,
        suitability: c.suitability,
        reason: c.reason,
      })
    );
  }

  let todayId: string | null = null;
  let best = -1;
  for (const s of specs) {
    if (s.tier !== "crafted") continue;
    const imp = scores[s.entityId || ""] ?? 0.3;
    const score = s.suitability * 0.65 + imp * 0.35;
    if (score > best) {
      best = score;
      todayId = s.id;
    }
  }
  if (!todayId && specs[0]) todayId = specs[0].id;

  return { candidates, specs, skipped, todayId };
}
