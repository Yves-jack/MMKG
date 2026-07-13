"""Stage 3a：SciMKG 式多模态证据挂接（clip / PPT / 文本）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from teachkg.provenance import enrich_with_cue_index, primary_provenance


def _dedupe_dicts(items: list[dict[str, Any]], key_fields: tuple[str, ...]) -> list[dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    out: list[dict[str, Any]] = []
    for item in items:
        key = tuple(item.get(f) for f in key_fields)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def build_cue_index(triplets: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """cue_id → 多模态元数据（同 cue 多条三元组共享）。"""
    index: dict[str, dict[str, Any]] = {}
    for row in triplets:
        cue_id = str(row.get("cue_id", "")).strip()
        if not cue_id:
            continue
        if cue_id not in index:
            ppt = str(row.get("ppt_frame_path") or row.get("evidence_ppt_frame_path") or "").strip()
            page = row.get("ppt_page_index")
            if page is None:
                page = row.get("evidence_ppt_page_index")
            index[cue_id] = {
                "cue_id": cue_id,
                "lecture_id": row.get("lecture_id", ""),
                "start_sec": row.get("start_sec"),
                "end_sec": row.get("end_sec"),
                "clip_path": row.get("clip_path", ""),
                "ppt_frame_path": ppt,
                "ppt_page_index": page,
                "source_text": row.get("source_text", ""),
            }
        else:
            src = str(row.get("source_text") or "")
            if len(src) > len(str(index[cue_id].get("source_text") or "")):
                index[cue_id]["source_text"] = src
    return index


def _text_evidence_from_triplets(
    entity_id: str,
    triplets: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    texts: list[dict[str, Any]] = []
    for row in triplets:
        sub = str(row.get("subject", "")).strip()
        obj = str(row.get("object", "")).strip()
        if entity_id not in {sub, obj}:
            continue
        texts.append(
            {
                "cue_id": row.get("cue_id", ""),
                "context": row.get("context", ""),
                "source_text": row.get("source_text", ""),
                "role": "subject" if sub == entity_id else "object",
            }
        )
    return _dedupe_dicts(texts, ("cue_id", "context", "role"))


def _clip_evidence(cue_ids: list[str], cue_index: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    clips: list[dict[str, Any]] = []
    for cue_id in cue_ids:
        meta = cue_index.get(cue_id)
        if not meta or not meta.get("clip_path"):
            continue
        clips.append(
            {
                "cue_id": cue_id,
                "clip_path": meta["clip_path"],
                "start_sec": meta.get("start_sec"),
                "end_sec": meta.get("end_sec"),
                "modality": "video_audio",
            }
        )
    return _dedupe_dicts(clips, ("cue_id", "clip_path"))


def _image_evidence(cue_ids: list[str], cue_index: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    for cue_id in cue_ids:
        meta = cue_index.get(cue_id)
        if not meta or not meta.get("ppt_frame_path"):
            continue
        images.append(
            {
                "cue_id": cue_id,
                "ppt_frame_path": meta["ppt_frame_path"],
                "ppt_page_index": meta.get("ppt_page_index"),
            }
        )
    return _dedupe_dicts(images, ("cue_id", "ppt_frame_path"))


def _modal_links(
    texts: list[dict[str, Any]],
    clips: list[dict[str, Any]],
    images: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    links: list[dict[str, Any]] = []
    for t in texts:
        links.append({"relation": "hasText", "target": {"type": "text", **t}})
    for c in clips:
        links.append({"relation": "hasVideo", "target": {"type": "clip", **c}})
        links.append({"relation": "hasAudio", "target": {"type": "clip", **c}})
    for img in images:
        links.append({"relation": "hasImage", "target": {"type": "ppt_frame", **img}})
    return links


def enrich_provenance(
    provenance: list[dict[str, Any]],
    cue_index: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    return enrich_with_cue_index(provenance, cue_index)


def attach_edge_grounding(
    edge: dict[str, Any],
    cue_index: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    provenance = enrich_provenance(edge.get("provenance") or [], cue_index)
    primary = primary_provenance(provenance)
    grounding = {
        "clip_path": primary.get("clip_path", ""),
        "ppt_frame_path": primary.get("ppt_frame_path", ""),
        "cue_id": primary.get("cue_id", ""),
        "lecture_id": primary.get("lecture_id"),
        "start_sec": primary.get("start_sec"),
        "end_sec": primary.get("end_sec"),
        "ppt_page_index": primary.get("ppt_page_index"),
        "natural_statement": edge.get("natural_statement", ""),
        "context": primary.get("context", ""),
        "source_text": str(primary.get("source_text", ""))[:500],
        "extract_source": primary.get("extract_source", ""),
    }
    out = dict(edge)
    out["provenance"] = provenance
    out["grounding"] = grounding
    out["modal_links"] = []
    for prov in provenance:
        cue_id = prov.get("cue_id", "")
        if prov.get("clip_path"):
            out["modal_links"].append(
                {
                    "relation": "groundedByClip",
                    "target": {"type": "clip", "cue_id": cue_id, "clip_path": prov["clip_path"]},
                }
            )
        if prov.get("ppt_frame_path"):
            out["modal_links"].append(
                {
                    "relation": "groundedBySlide",
                    "target": {
                        "type": "ppt_frame",
                        "cue_id": cue_id,
                        "ppt_frame_path": prov["ppt_frame_path"],
                        "ppt_page_index": prov.get("ppt_page_index"),
                    },
                }
            )
    return out


@dataclass
class EvidenceAttachResult:
    entities: list[dict[str, Any]]
    edges: list[dict[str, Any]]
    stats: dict[str, Any] = field(default_factory=dict)


def attach_multimodal_evidence(
    kg: dict[str, Any],
    triplets: list[dict[str, Any]],
) -> EvidenceAttachResult:
    """将 triplets 中的 clip / PPT / 文本证据挂接到 Stage 2 图谱。"""
    cue_index = build_cue_index(triplets)
    entities_out: list[dict[str, Any]] = []
    clip_count = 0
    image_count = 0

    for ent in kg.get("entities") or []:
        entity_id = ent.get("id") or ent.get("name", "")
        cue_ids = list(ent.get("cue_ids") or [])
        texts = _text_evidence_from_triplets(entity_id, triplets)
        clips = _clip_evidence(cue_ids, cue_index)
        images = _image_evidence(cue_ids, cue_index)
        clip_count += len(clips)
        image_count += len(images)

        item = dict(ent)
        item["modal_evidence"] = {
            "texts": texts,
            "clips": clips,
            "images": images,
        }
        item["modal_links"] = _modal_links(texts, clips, images)
        if not item.get("description"):
            item["description"] = ""
        entities_out.append(item)

    edges_out = [
        attach_edge_grounding(edge, cue_index)
        for edge in (kg.get("edges") or [])
    ]

    stats = {
        "cue_count": len(cue_index),
        "entity_clip_refs": clip_count,
        "entity_image_refs": image_count,
        "edges_with_clip": sum(1 for e in edges_out if e.get("grounding", {}).get("clip_path")),
        "edges_with_slide": sum(1 for e in edges_out if e.get("grounding", {}).get("ppt_frame_path")),
        "edges_with_source_text": sum(
            1 for e in edges_out if (e.get("grounding") or {}).get("source_text")
        ),
        "edges_with_context": sum(
            1 for e in edges_out if any(p.get("context") for p in (e.get("provenance") or []))
        ),
    }
    return EvidenceAttachResult(entities=entities_out, edges=edges_out, stats=stats)
