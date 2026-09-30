"""经课堂核实后的教材子图视图：供 hybrid 增量抽取作基座。

典型来源：``run_textbook_correct_pilot.py`` 写入
``filtered_cues.jsonl`` 中 ``stage1.textbook_correction``；
Stage1 在 ``use_corrected_textbook=true`` 时挂载后调用本模块。
"""

from __future__ import annotations

import json
from typing import Any

from teachkg.stage1_alignment.triplet_extract import Triplet


def triplets_from_corrected_rows(rows: list[dict[str, Any]] | None) -> list[Triplet]:
    """将 ``corrected_triples`` 行列表转为 ``Triplet``（``extract_source=textbook``）。

    Args:
        rows: 修正后的三元组字典列表；允许 ``None`` 或非 dict 元素（跳过）。

    Returns:
        去重后的 ``Triplet`` 列表（按 ``dedupe_key``）。
    """
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
    """从三元组集合收集主客体实体名。

    Args:
        triplets: 三元组列表。

    Returns:
        非空 ``subject`` / ``object`` 名称集合。
    """
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
    """把修正后教材边压成 hybrid prompt 用的子图 JSON 字符串。

    Args:
        triplets: 修正后的教材边。
        seed_entities: 种子实体；缺省则用三元组中全部实体。
        max_relations: 写入 prompt 的最大边数（截断前缀）。

    Returns:
        缩进 JSON 字符串（含 ``seed_entities`` / ``entities`` / ``relations``）。
    """
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
    """从 cue 的 ``stage1`` 块提取修正教材基座。

    Args:
        stage1: cue 字典中的 ``stage1`` 字段（可含 ``textbook_correction`` /
            ``textbook_subgraph``）。

    Returns:
        ``(triplets, subgraph_json, entity_names)``；
        无可用修正、或 ``skipped=true``、或缺 ``corrected_triples`` 键时返回 ``None``。

    Note:
        ``corrected_triples`` 键存在且为空列表表示「全部 drop」，
        仍视为合法空基座，调用方不应回退到未修正的检索子图。
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
