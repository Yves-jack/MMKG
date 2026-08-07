import type { KgEdge, KgEntity } from "@/lib/kg/adaptToPipeline";

function spoKey(e: KgEdge): string {
  return `${e.subject || ""}\t${e.abstract_relation || ""}\t${e.object || ""}`;
}

function lectureOf(e: KgEdge): string {
  const lid =
    e.grounding?.lecture_id ??
    e.provenance?.find((p) => p.lecture_id != null)?.lecture_id;
  return lid != null ? String(lid) : "";
}

/** 合并两讲 MMKG：实体并集；同 SPO 边合并并保留双讲 provenance */
export function mergeLectureMmkgs(
  lecA: string,
  dataA: { entities?: KgEntity[]; edges?: KgEdge[] },
  lecB: string,
  dataB: { entities?: KgEntity[]; edges?: KgEdge[] }
): { entities: KgEntity[]; edges: KgEdge[] } {
  const entMap = new Map<string, KgEntity>();
  for (const part of [dataA.entities || [], dataB.entities || []]) {
    for (const ent of part) {
      const id = String(ent.id || ent.name || "").trim();
      if (!id) continue;
      const prev = entMap.get(id);
      if (!prev) {
        entMap.set(id, { ...ent, id });
        continue;
      }
      entMap.set(id, {
        ...prev,
        ...ent,
        id,
        mention_count: Math.max(Number(prev.mention_count) || 0, Number(ent.mention_count) || 0),
        description: prev.description || ent.description,
        cue_ids: [...new Set([...(prev.cue_ids || []), ...(ent.cue_ids || [])])],
      });
    }
  }

  const edgeMap = new Map<string, KgEdge>();
  const ingest = (edges: KgEdge[], fallbackLec: string) => {
    for (const e of edges) {
      if (!e.subject || !e.object) continue;
      const key = spoKey(e);
      const lid = lectureOf(e) || fallbackLec;
      const stamped: KgEdge = {
        ...e,
        grounding: {
          ...(e.grounding || {}),
          lecture_id: e.grounding?.lecture_id ?? fallbackLec,
        },
        provenance: [
          ...(e.provenance || []),
          { lecture_id: lid, cue_id: e.grounding?.cue_id },
        ],
      };
      const prev = edgeMap.get(key);
      if (!prev) {
        edgeMap.set(key, stamped);
        continue;
      }
      const lids = new Set<string>();
      for (const x of [prev, stamped]) {
        const l = lectureOf(x);
        if (l) lids.add(l);
        for (const p of x.provenance || []) {
          if (p?.lecture_id != null) lids.add(String(p.lecture_id));
        }
      }
      edgeMap.set(key, {
        ...prev,
        description: prev.description || stamped.description,
        concrete_relation: prev.concrete_relation || stamped.concrete_relation,
        natural_statement: prev.natural_statement || stamped.natural_statement,
        grounding: {
          ...(prev.grounding || {}),
          ...(stamped.grounding || {}),
          context: prev.grounding?.context || stamped.grounding?.context,
          source_text: prev.grounding?.source_text || stamped.grounding?.source_text,
          // 双讲共有时不钉死单一 lecture_id
          lecture_id: lids.size > 1 ? undefined : lid,
        },
        cue_ids: [...new Set([...(prev.cue_ids || []), ...(stamped.cue_ids || [])])],
        provenance: [
          ...(prev.provenance || []),
          ...(stamped.provenance || []),
          ...[...lids].map((l) => ({ lecture_id: l })),
        ],
      });
    }
  };
  ingest(dataA.edges || [], lecA);
  ingest(dataB.edges || [], lecB);

  return { entities: [...entMap.values()], edges: [...edgeMap.values()] };
}

/** 按讲次拆边，供分段正文使用 */
export function edgesForLecture(edges: KgEdge[], lectureId: string): KgEdge[] {
  const lid = String(lectureId);
  return edges.filter((e) => {
    if (lectureOf(e) === lid) return true;
    return (e.provenance || []).some((p) => String(p?.lecture_id) === lid);
  });
}
