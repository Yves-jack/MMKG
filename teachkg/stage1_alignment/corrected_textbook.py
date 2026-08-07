"""经课堂核实后的教材子图视图：供增量抽取作基座。"""

from __future__ import annotations

import json
from typing import Any

from teachkg.stage1_alignment.triplet_extract import Triplet


def triplets_from_corrected_rows(rows: list[dict[str, Any]] | None) -> list[Triplet]:
    """corrected_triples → Triplet（extract_source=textbook）。"""
    out: list[Triplet] = []
    seen: set[tuple[str, str, str, str]] = set()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        data = {
            "subject": row.get("subject"),
            "object": row.get("object"),
            "abstract_relation": row.get("abstract_relation") or row.get("predicate"),
            "concrete_relation": row.get("concrete_relation") or "相关",
            "statement_direction": row.get("statement_direction") or "subject_to_object",
            "attribute_category": row.get("attribute_category") or "",
            "description": row.get("description") or "",
            "context": row.get("context") or "",
            "extract_source": "textbook",
        }
        trip = Triplet.from_dict(data)
        if trip is None:
            continue
        if trip.dedupe_key in seen:
            continue
        seen.add(trip.dedupe_key)
        out.append(trip)
    return out


def entities_from_triplets(triplets: list[Triplet]) -> set[str]:
    names: set[str] = set()
    for t in triplets:
        if t.subject:
            names.add(t.subject)
        if t.object:
            names.add(t.object)
    return names


def format_corrected_subgraph_for_prompt(
    triplets: list[Triplet],
    *,
    seed_entities: set[str] | None = None,
    max_relations: int = 60,
) -> str:
    """把修正后教材边压成 hybrid prompt 用的子图 JSON。"""
    seeds = set(seed_entities or ())
    ents = entities_from_triplets(triplets)
    if not seeds:
        seeds = set(ents)
    relation_payload = [
        {
            "subject": t.subject,
            "object": t.object,
            "abstract_relation": t.abstract_relation,
            "concrete_relation": t.concrete_relation,
            "statement_direction": t.statement_direction,
            "description": (t.description or "")[:200],
            "context": (t.context or "")[:200],
        }
        for t in triplets[:max_relations]
    ]
    payload = {
        "note": "经课堂核实后的教材子图（已剔除未讲授边；revise 已按课堂表述改正）",
        "seed_entities": sorted(seeds),
        "entities": [{"name": n} for n in sorted(ents)],
        "relations": relation_payload,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def correction_basis_from_stage1(
    stage1: dict[str, Any] | None,
) -> tuple[list[Triplet], str, set[str]] | None:
    """若 cue 已有 textbook_correction.corrected_triples，返回 (triplets, json, entities)。

    corrected_triples 键存在且为空列表 = 全部 drop，仍作为合法空基座（勿回退原教材边）。
    """
    s1 = stage1 or {}
    corr = s1.get("textbook_correction")
    if not isinstance(corr, dict) or corr.get("skipped"):
        return None
    if "corrected_triples" not in corr:
        return None
    rows = list(corr.get("corrected_triples") or [])
    trips = triplets_from_corrected_rows(rows)
    ents = entities_from_triplets(trips)
    sg = s1.get("textbook_subgraph") or {}
    seeds = set(sg.get("seed_entities") or []) | ents
    return trips, format_corrected_subgraph_for_prompt(trips, seed_entities=seeds), ents
