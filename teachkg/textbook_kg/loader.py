"""加载 AutoEduKG 导出的教材知识图谱。"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

from teachkg.textbook_kg.alias import build_alias_map

logger = logging.getLogger(__name__)


@dataclass
class TextbookEntity:
    name: str
    definition: str = ""
    importance: float = 0.0
    theorems: list[dict[str, str]] = field(default_factory=list)


@dataclass
class TextbookRelation:
    subject: str
    predicate: str
    object: str
    description: str = ""
    context: str = ""


@dataclass
class TextbookKG:
    textbook_id: str
    entities: dict[str, TextbookEntity]
    relations: list[TextbookRelation]
    entity_names: list[str]
    alias_map: dict[str, list[str]]
    importance: dict[str, float]
    adjacency_out: dict[str, list[TextbookRelation]]
    adjacency_in: dict[str, list[TextbookRelation]]

    @classmethod
    def load(
        cls,
        base_path: Path,
        *,
        entity_file: str = "entity_final.json",
        relations_file: str = "relations_final.json",
        importance_file: str = "entity_sorted.json",
    ) -> TextbookKG:
        base_path = Path(base_path)
        entity_path = base_path / entity_file
        relations_path = base_path / relations_file
        importance_path = base_path / importance_file

        if not entity_path.is_file():
            raise FileNotFoundError(f"Textbook entity file not found: {entity_path}")
        if not relations_path.is_file():
            raise FileNotFoundError(f"Textbook relations file not found: {relations_path}")

        raw_entities = json.loads(entity_path.read_text(encoding="utf-8"))
        raw_relations = json.loads(relations_path.read_text(encoding="utf-8"))

        importance: dict[str, float] = {}
        if importance_path.is_file():
            raw_scores = json.loads(importance_path.read_text(encoding="utf-8"))
            for item in raw_scores:
                if isinstance(item, list) and len(item) >= 2:
                    importance[str(item[0])] = float(item[1])
                elif isinstance(item, dict):
                    name = item.get("node") or item.get("name")
                    score = item.get("score")
                    if name is not None and score is not None:
                        importance[str(name)] = float(score)

        entities: dict[str, TextbookEntity] = {}
        for row in raw_entities:
            name = str(row.get("name", "")).strip()
            if not name:
                continue
            entities[name] = TextbookEntity(
                name=name,
                definition=str(row.get("definition", "")).strip(),
                importance=importance.get(name, float(row.get("importance", 0) or 0)),
                theorems=list(row.get("theorems") or row.get("themorems") or []),
            )

        relations: list[TextbookRelation] = []
        adjacency_out: dict[str, list[TextbookRelation]] = {}
        adjacency_in: dict[str, list[TextbookRelation]] = {}
        for row in raw_relations:
            subject = str(row.get("subject", "")).strip()
            obj = str(row.get("object", "")).strip()
            predicate = str(row.get("predicate", "related_with")).strip()
            if not subject or not obj:
                continue
            rel = TextbookRelation(
                subject=subject,
                predicate=predicate,
                object=obj,
                description=str(row.get("description", "")).strip(),
                context=str(row.get("context", "")).strip(),
            )
            relations.append(rel)
            adjacency_out.setdefault(subject, []).append(rel)
            adjacency_in.setdefault(obj, []).append(rel)
            entities.setdefault(subject, TextbookEntity(name=subject))
            entities.setdefault(obj, TextbookEntity(name=obj))

        entity_names = sorted(entities.keys())
        alias_map = build_alias_map(entity_names)
        textbook_id = base_path.name

        logger.info(
            "Loaded textbook KG %s: %d entities, %d relations",
            textbook_id,
            len(entities),
            len(relations),
        )
        return cls(
            textbook_id=textbook_id,
            entities=entities,
            relations=relations,
            entity_names=entity_names,
            alias_map=alias_map,
            importance=importance,
            adjacency_out=adjacency_out,
            adjacency_in=adjacency_in,
        )
