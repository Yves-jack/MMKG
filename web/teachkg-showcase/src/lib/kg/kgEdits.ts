/** 课堂图谱编辑补丁：API 客户端 + 叠到 nodes/edges。 */

import type { PipelineEdge, PipelineNode } from "@/lib/pipeline/types";
import { withBase } from "@/lib/withBase";

export const ABSTRACT_RELATIONS = [
  "belong_to",
  "part_of",
  "depend_on",
  "property_of",
  "synonym_of",
  "related_with",
] as const;

export type AbstractRelation = (typeof ABSTRACT_RELATIONS)[number];

export type EdgeEdit = {
  relation?: string;
  label?: string;
  /** 相对「改名后的原始边」是否已对调主客 */
  reversed?: boolean;
};

export type KgEditPatch = {
  courseId: string;
  lectureId: string;
  updatedAt: string | null;
  entityRenames: Record<string, string>;
  edgeEdits: Record<string, EdgeEdit>;
  /** 原始实体 id → true；null 表示撤销删除 */
  deletedEntities: Record<string, true>;
  /** 边 id → true */
  deletedEdges: Record<string, true>;
  /** 多模态 PPT/板书截图 URL → true */
  deletedPptUrls: Record<string, true>;
};

export function emptyKgEditPatch(
  courseId = "",
  lectureId = "course"
): KgEditPatch {
  return {
    courseId,
    lectureId,
    updatedAt: null,
    entityRenames: {},
    edgeEdits: {},
    deletedEntities: {},
    deletedEdges: {},
    deletedPptUrls: {},
  };
}

function asTrueMap(raw: unknown): Record<string, true> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, true> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v) out[k] = true;
  }
  return out;
}

function scopeLectureId(lectureId?: string | null): string {
  const t = String(lectureId || "").trim();
  return t || "course";
}

export async function fetchKgEdits(
  courseId: string,
  lectureId?: string | null
): Promise<KgEditPatch> {
  const lid = scopeLectureId(lectureId);
  const q = new URLSearchParams({
    courseId,
    lectureId: lid,
  });
  const res = await fetch(withBase(`/api/kg-edits?${q}`), { cache: "no-store" });
  if (!res.ok) {
    return emptyKgEditPatch(courseId, lid);
  }
  const data = await res.json();
  return {
    ...emptyKgEditPatch(courseId, lid),
    ...data,
    entityRenames:
      data?.entityRenames && typeof data.entityRenames === "object"
        ? data.entityRenames
        : {},
    edgeEdits:
      data?.edgeEdits && typeof data.edgeEdits === "object" ? data.edgeEdits : {},
    deletedEntities: asTrueMap(data?.deletedEntities),
    deletedEdges: asTrueMap(data?.deletedEdges),
    deletedPptUrls: asTrueMap(data?.deletedPptUrls),
  };
}

/** 合并写入补丁（null 可删除键） */
export async function saveKgEdits(
  courseId: string,
  lectureId: string | null | undefined,
  body: {
    entityRenames?: Record<string, string | null>;
    edgeEdits?: Record<string, EdgeEdit | null>;
    deletedEntities?: Record<string, true | null>;
    deletedEdges?: Record<string, true | null>;
    deletedPptUrls?: Record<string, true | null>;
    replaceEntityRenames?: boolean;
    replaceEdgeEdits?: boolean;
  }
): Promise<KgEditPatch> {
  const lid = scopeLectureId(lectureId);
  const q = new URLSearchParams({ courseId, lectureId: lid });
  const res = await fetch(withBase(`/api/kg-edits?${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseId, lectureId: lid, ...body }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error || `save kg-edits failed: ${res.status}`);
  }
  const data = await res.json();
  return {
    ...emptyKgEditPatch(courseId, lid),
    ...data,
    entityRenames:
      data?.entityRenames && typeof data.entityRenames === "object"
        ? data.entityRenames
        : {},
    edgeEdits:
      data?.edgeEdits && typeof data.edgeEdits === "object" ? data.edgeEdits : {},
    deletedEntities: asTrueMap(data?.deletedEntities),
    deletedEdges: asTrueMap(data?.deletedEdges),
    deletedPptUrls: asTrueMap(data?.deletedPptUrls),
  };
}

/** 当前显示名 → 原始 id（补丁键） */
export function findOriginalEntityId(
  currentId: string,
  renames: Record<string, string>
): string {
  const cur = String(currentId || "").trim();
  if (!cur) return cur;
  if (Object.prototype.hasOwnProperty.call(renames, cur)) return cur;
  // reverse walk: value → key
  const reverse = new Map<string, string>();
  for (const [from, to] of Object.entries(renames)) {
    if (to) reverse.set(String(to), String(from));
  }
  let x = cur;
  const seen = new Set<string>();
  while (reverse.has(x) && !seen.has(x)) {
    seen.add(x);
    x = reverse.get(x)!;
  }
  return x;
}

/** 登记一次改名：扁平化为 original → final */
export function withEntityRename(
  renames: Record<string, string>,
  currentId: string,
  newId: string
): Record<string, string> {
  const from = String(currentId || "").trim();
  const to = String(newId || "").trim();
  if (!from || !to || from === to) return { ...renames };
  const original = findOriginalEntityId(from, renames);
  const next: Record<string, string> = { ...renames };
  for (const [k, v] of Object.entries(next)) {
    if (v === from) next[k] = to;
  }
  next[original] = to;
  // drop identity
  if (next[original] === original) delete next[original];
  return next;
}

/** 由中英文拼规范名：有英文 →「中文/英文」，否则仅中文或英文 */
export function composeCanonicalName(zh: string, en: string): string {
  const z = String(zh || "").trim();
  const e = String(en || "").trim();
  if (z && e) return `${z}/${e}`;
  return z || e;
}

/** 从规范名拆中英文（首段中文，其后为英文） */
export function splitCanonicalName(id: string): { zh: string; en: string } {
  const raw = String(id || "").trim();
  if (!raw) return { zh: "", en: "" };
  const i = raw.indexOf("/");
  if (i < 0) return { zh: raw, en: "" };
  return { zh: raw.slice(0, i).trim(), en: raw.slice(i + 1).trim() };
}

function resolveName(id: string, renames: Record<string, string>): string {
  const k = String(id || "");
  if (Object.prototype.hasOwnProperty.call(renames, k) && renames[k]) {
    return renames[k];
  }
  return k;
}

function isEntityDeleted(
  id: string,
  renames: Record<string, string>,
  deletedEntities: Record<string, true>
): boolean {
  if (!id) return false;
  if (deletedEntities[id]) return true;
  const orig = findOriginalEntityId(id, renames);
  return Boolean(deletedEntities[orig]);
}

export function applyKgEdits(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  patch: KgEditPatch | null | undefined
): { nodes: PipelineNode[]; edges: PipelineEdge[] } {
  const renames = patch?.entityRenames || {};
  const edgeEdits = patch?.edgeEdits || {};
  const deletedEntities = patch?.deletedEntities || {};
  const deletedEdges = patch?.deletedEdges || {};
  const hasRename = Object.keys(renames).length > 0;
  const hasEdge = Object.keys(edgeEdits).length > 0;
  const hasDelEnt = Object.keys(deletedEntities).length > 0;
  const hasDelEdge = Object.keys(deletedEdges).length > 0;
  if (!hasRename && !hasEdge && !hasDelEnt && !hasDelEdge) {
    return { nodes, edges };
  }

  const nodesOut = nodes.map((n) => {
    const id = String(n.id || "");
    const nid = resolveName(id, renames);
    if (nid === id) {
      if (!n.aliases?.length) return n;
      const aliases = n.aliases.map((a) => resolveName(String(a), renames));
      return { ...n, aliases };
    }
    const aliases = (n.aliases || [])
      .map((a) => resolveName(String(a), renames))
      .filter((a) => a && a !== nid);
    return {
      ...n,
      id: nid,
      label: splitCanonicalName(nid).zh || nid,
      title: n.title && n.title === id ? nid : n.title,
      aliases,
    };
  });

  // merge duplicate nodes after rename; drop deleted
  const byId = new Map<string, PipelineNode>();
  for (const n of nodesOut) {
    const id = String(n.id || "");
    if (isEntityDeleted(id, renames, deletedEntities)) continue;
    if (!byId.has(id)) {
      byId.set(id, n);
      continue;
    }
    const prev = byId.get(id)!;
    const aliases = [
      ...new Set([...(prev.aliases || []), ...(n.aliases || [])]),
    ];
    byId.set(id, {
      ...prev,
      ...n,
      aliases,
      properties: [
        ...new Set([...(prev.properties || []), ...(n.properties || [])]),
      ],
    });
  }

  const keepNodeIds = new Set(byId.keys());

  const edgesOut = edges
    .filter((e) => {
      const eid = String(e.id || "");
      if (eid && deletedEdges[eid]) return false;
      return true;
    })
    .map((e) => {
      let from = resolveName(String(e.from || ""), renames);
      let to = resolveName(String(e.to || ""), renames);
      let subject_ref = e.subject_ref
        ? resolveName(String(e.subject_ref), renames)
        : e.subject_ref;
      let object_ref = e.object_ref
        ? resolveName(String(e.object_ref), renames)
        : e.object_ref;

      const edit = edgeEdits[String(e.id || "")];
      let relation = e.relation;
      let label = e.label;
      let statement_direction = e.statement_direction;

      if (edit) {
        if (edit.relation) {
          relation = edit.relation;
          label = edit.label || edit.relation;
        } else if (edit.label) {
          label = edit.label;
          relation = edit.label;
        }
        if (edit.reversed) {
          const tmp = from;
          from = to;
          to = tmp;
          const tmpRef = subject_ref;
          subject_ref = object_ref;
          object_ref = tmpRef;
          statement_direction = "subject_to_object";
        }
      }

      if (
        from === e.from &&
        to === e.to &&
        relation === e.relation &&
        label === e.label &&
        subject_ref === e.subject_ref &&
        object_ref === e.object_ref &&
        statement_direction === e.statement_direction
      ) {
        return e;
      }
      return {
        ...e,
        from,
        to,
        relation,
        label,
        subject_ref,
        object_ref,
        statement_direction,
      };
    })
    .filter((e) => {
      const from = String(e.from || "");
      const to = String(e.to || "");
      if (isEntityDeleted(from, renames, deletedEntities)) return false;
      if (isEntityDeleted(to, renames, deletedEntities)) return false;
      if (hasDelEnt && (!keepNodeIds.has(from) || !keepNodeIds.has(to))) {
        return false;
      }
      return true;
    });

  return { nodes: [...byId.values()], edges: edgesOut };
}
