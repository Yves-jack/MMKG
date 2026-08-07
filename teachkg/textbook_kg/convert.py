"""教材关系 → VAT-KG Triplet 及 prompt 格式化。"""

from __future__ import annotations

import json
from typing import Any

from teachkg.stage1_alignment.triplet_extract import (
    Triplet,
    infer_attribute_category,
    infer_statement_direction,
    triplet_to_statement,
)
from teachkg.textbook_kg.loader import TextbookEntity, TextbookKG, TextbookRelation

DEFAULT_CONCRETE_RELATION: dict[str, str] = {
    "part_of": "属于",
    "belong_to": "属于",
    "depend_on": "依赖",
    "synonym_of": "同义于",
    "property_of": "具有属性",
    "related_with": "相关",
}

_DESCRIPTION_VERB_PATTERNS: list[tuple[str, str]] = [
    ("称为", "称为"),
    ("也叫", "称为"),
    ("又称为", "称为"),
    ("等同于", "等同于"),
    ("等价于", "等价于"),
    ("是基础", "是基础"),
    ("依赖于", "依赖"),
    ("依赖", "依赖"),
    ("包含", "包含"),
    ("划分为", "划分为"),
    ("细分为", "细分为"),
    ("属于", "属于"),
    ("具有", "具有"),
    ("表示", "表示"),
    ("推出", "推出"),
    ("扩展", "扩展"),
]


def infer_concrete_from_description(description: str, predicate: str) -> str:
    """从教材 description 推断更细 concrete_relation。"""
    text = (description or "").strip()
    if not text:
        return DEFAULT_CONCRETE_RELATION.get(predicate, "相关")
    if len(text) <= 8 and not any(ch in text for ch in "。；;"):
        return text
    for needle, concrete in _DESCRIPTION_VERB_PATTERNS:
        if needle in text:
            return concrete
    return DEFAULT_CONCRETE_RELATION.get(predicate, "相关")


def relation_to_triplet(rel: TextbookRelation) -> Triplet:
    predicate = rel.predicate if rel.predicate in DEFAULT_CONCRETE_RELATION else "related_with"
    concrete = infer_concrete_from_description(rel.description, predicate)
    direction = infer_statement_direction(predicate)
    context = (rel.classroom_evidence or rel.context or rel.description).strip()
    natural = (rel.description or "").strip()
    if not natural:
        natural = triplet_to_statement(
            Triplet(
                subject=rel.subject,
                object=rel.object,
                abstract_relation=predicate,
                concrete_relation=concrete,
                statement_direction=direction,
            )
        )
    return Triplet(
        subject=rel.subject,
        object=rel.object,
        abstract_relation=predicate,
        concrete_relation=concrete,
        statement_direction=direction,
        attribute_category=infer_attribute_category(predicate),
        description=natural,
        context=context,
        extract_source="textbook",
    )


def relations_to_triplets(relations: list[TextbookRelation]) -> list[Triplet]:
    seen: set[tuple[str, str, str, str]] = set()
    out: list[Triplet] = []
    for rel in relations:
        triplet = relation_to_triplet(rel)
        if triplet.dedupe_key in seen:
            continue
        seen.add(triplet.dedupe_key)
        out.append(triplet)
    return out


def format_entity_brief(entity: TextbookEntity) -> dict[str, Any]:
    data: dict[str, Any] = {"name": entity.name}
    if entity.definition:
        data["definition"] = entity.definition[:400]
    if entity.importance:
        data["importance"] = round(entity.importance, 6)
    return data


def format_subgraph_for_prompt(
    kg: TextbookKG,
    *,
    seed_entities: set[str],
    entities: set[str],
    relations: list[TextbookRelation],
    max_entities: int = 24,
    max_relations: int = 30,
) -> str:
    """压缩子图为 LLM 可读 JSON 文本。"""
    ranked_entities = sorted(
        entities,
        key=lambda name: (
            name in seed_entities,
            kg.importance.get(name, kg.entities.get(name, TextbookEntity(name=name)).importance),
        ),
        reverse=True,
    )[:max_entities]

    entity_payload = [
        format_entity_brief(kg.entities.get(name, TextbookEntity(name=name)))
        for name in ranked_entities
    ]
    relation_payload = [
        {
            "subject": rel.subject,
            "object": rel.object,
            "abstract_relation": rel.predicate,
            "description": rel.description[:200] if rel.description else "",
            "context": rel.context[:200] if rel.context else "",
        }
        for rel in relations[:max_relations]
    ]
    payload = {
        "seed_entities": sorted(seed_entities),
        "entities": entity_payload,
        "relations": relation_payload,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)
