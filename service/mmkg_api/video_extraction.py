"""Video-chunk helpers for Canvas video graph + fingerprinting.

Per-chunk LLM extraction is replaced by lecture-level teachkg orchestration
(see chunk_pipeline / JobStore.create_lecture_pipeline).
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from teachkg.stage2_kg_build.entity_merge import merge_triplets_to_kg

Graph = dict[str, Any]


def chunk_fingerprint(chunk: Graph) -> str:
    payload = {
        key: chunk.get(key)
        for key in (
            "segment_id",
            "lesson_id",
            "video_id",
            "asr_text",
            "text",
            "start_sec",
            "end_sec",
            "link",
        )
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def extract_video_chunk(course_id: str, chunk: Graph) -> Graph:
    """Legacy hook: mark chunk deferred; lecture pipeline owns teachkg work."""
    return {
        "segment_id": str(chunk.get("segment_id")),
        "lesson_id": str(chunk.get("lesson_id")),
        "input_hash": chunk_fingerprint(chunk),
        "status": "deferred_to_lecture_pipeline",
        "course_id": str(course_id),
        "triplets": [],
        "message": "use lecture pipeline job instead of per-chunk extraction",
    }


def _anchor(chunk: Graph) -> Graph:
    return {
        key: chunk[key]
        for key in (
            "segment_id",
            "lesson_id",
            "video_id",
            "start_sec",
            "end_sec",
            "link",
        )
        if key in chunk
    }


def build_video_graph(
    course_id: str,
    chunks: list[Graph],
    extractions: list[Graph],
) -> tuple[Graph, list[Graph]]:
    chunk_by_id = {str(row["segment_id"]): row for row in chunks}
    triplets = [
        triplet
        for extraction in extractions
        if extraction.get("status") == "completed"
        for triplet in extraction.get("triplets", [])
        if isinstance(triplet, dict)
    ]
    if not triplets:
        return (
            {
                "courseid": str(course_id),
                "view": "video",
                "nodes": [],
                "edges": [],
                "source_type": "video_chunk_triplets",
                "kg_protocol": "kg-json-v1",
            },
            [],
        )

    merged = merge_triplets_to_kg(triplets)
    nodes: list[Graph] = []
    relations: list[Graph] = []
    for entity in merged.entities.values():
        data = entity.to_dict()
        anchors = [
            _anchor(chunk_by_id[cue_id])
            for cue_id in sorted(entity.cue_ids)
            if cue_id in chunk_by_id
        ]
        node = {
            "id": entity.canonical,
            "name": entity.zh or entity.canonical,
            "zh_name": entity.zh,
            "en_name": entity.en,
            "aliases": data.get("aliases", []),
            "cue_ids": data.get("cue_ids", []),
            "mention_count": data.get("mention_count", 0),
            "video_anchors": anchors,
            "source": "video_chunk_triplets",
        }
        nodes.append(node)
        if anchors:
            relations.append(
                {
                    "knowledge_point_id": entity.canonical,
                    "knowledge_point_name": entity.zh or entity.canonical,
                    "segment_ids": [str(item["segment_id"]) for item in anchors],
                    "source": "video_chunk_triplets",
                }
            )

    edges: list[Graph] = []
    for edge in merged.edges:
        data = edge.to_dict()
        edge_key = "|".join(
            (edge.subject, edge.abstract_relation, edge.concrete_relation, edge.object)
        )
        edges.append(
            {
                **data,
                "id": "video:" + hashlib.sha256(edge_key.encode()).hexdigest()[:24],
                "source": edge.subject,
                "target": edge.object,
                "relation": edge.concrete_relation,
                "source_type": "video_chunk_triplets",
            }
        )

    graph = {
        "courseid": str(course_id),
        "view": "video",
        "nodes": nodes,
        "edges": edges,
        "source_type": "video_chunk_triplets",
        "triplet_count": len(triplets),
        "kg_protocol": "kg-json-v1",
    }
    return graph, relations
