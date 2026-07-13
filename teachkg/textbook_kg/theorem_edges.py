"""将教材 entity.themorems[] 展开为 belong_to 边，供子图检索与 alias 匹配。"""

from __future__ import annotations

import re

from teachkg.textbook_kg.loader import TextbookEntity, TextbookKG, TextbookRelation

_THEOREM_NAME_RE = re.compile(r"^(.+?)(?:定理|定理\d+|Theorem)?$", re.IGNORECASE)


def theorem_entity_name(theorem_name: str, parent_entity: TextbookEntity) -> str:
    """构造规范定理实体名：中文/English。"""
    raw = theorem_name.strip()
    if not raw:
        return ""
    if "/" in raw:
        return raw
    parent_en = parent_entity.name.split("/", 1)[1].strip() if "/" in parent_entity.name else "theorem"
    zh = raw if re.search(r"[\u4e00-\u9fff]", raw) else raw
    en_slug = re.sub(r"[^\w]+", " ", raw).strip().replace(" ", "_").lower() or "theorem"
    return f"{zh}/{en_slug}"


def expand_theorem_relations(kg: TextbookKG) -> list[TextbookRelation]:
    """为每个嵌套定理生成「定理 belong_to 所属概念」边。"""
    relations: list[TextbookRelation] = []
    seen: set[tuple[str, str, str]] = set()

    for entity in kg.entities.values():
        for item in entity.theorems:
            if not isinstance(item, dict):
                continue
            th_name = str(item.get("name", "")).strip()
            if not th_name:
                continue
            th_entity = theorem_entity_name(th_name, entity)
            if not th_entity:
                continue
            content = str(item.get("content", "")).strip()
            key = (th_entity, "belong_to", entity.name)
            if key in seen:
                continue
            seen.add(key)
            description = content or f"{th_name}是{entity.name.split('/')[0]}中的定理。"
            relations.append(
                TextbookRelation(
                    subject=th_entity,
                    predicate="belong_to",
                    object=entity.name,
                    description=description,
                    context=f"教材定理：{th_name}",
                )
            )
    return relations


def augment_textbook_kg(kg: TextbookKG) -> TextbookKG:
    """将定理边并入教材 KG（adjacency + alias）。"""
    from teachkg.textbook_kg.alias import build_alias_map

    extra = expand_theorem_relations(kg)
    if not extra:
        return kg

    relations = list(kg.relations) + extra
    adjacency_out = dict(kg.adjacency_out)
    adjacency_in = dict(kg.adjacency_in)
    entities = dict(kg.entities)

    for rel in extra:
        adjacency_out.setdefault(rel.subject, []).append(rel)
        adjacency_in.setdefault(rel.object, []).append(rel)
        if rel.subject not in entities:
            entities[rel.subject] = TextbookEntity(name=rel.subject, definition=rel.description)

    entity_names = sorted(entities.keys())
    alias_map = build_alias_map(entity_names)

    return TextbookKG(
        textbook_id=kg.textbook_id,
        entities=entities,
        relations=relations,
        entity_names=entity_names,
        alias_map=alias_map,
        importance=kg.importance,
        adjacency_out=adjacency_out,
        adjacency_in=adjacency_in,
    )
