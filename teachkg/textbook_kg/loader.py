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
    """教材侧原文/描述上下文。"""
    classroom_evidence: str = ""
    """边筛后附着的课堂原文依据；有则优先写入三元组 context。"""


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
    importance_by_chapter: dict[str, dict[str, float]] = field(default_factory=dict)
    chapter_order: list[str] = field(default_factory=list)

    def importance_for(
        self,
        chapter: str | None = None,
        chapters: list[str] | list[tuple[str, float]] | None = None,
    ) -> dict[str, float]:
        """返回全局、单章或多章加权重要性。"""
        weights: list[tuple[str, float]] = []
        if chapters:
            for item in chapters:
                if isinstance(item, (list, tuple)) and len(item) >= 2:
                    weights.append((str(item[0]), float(item[1])))
                else:
                    weights.append((str(item), 1.0))
            total = sum(w for _, w in weights) or 1.0
            weights = [(c, w / total) for c, w in weights]
        elif chapter:
            weights = [(chapter, 1.0)]
        else:
            return self.importance

        if not self.importance_by_chapter:
            return self.importance

        out: dict[str, float] = {}
        for ch, w in weights:
            table = None
            if ch in self.importance_by_chapter:
                table = self.importance_by_chapter[ch]
            else:
                key = ch.strip()
                for name, scores in self.importance_by_chapter.items():
                    if key in name or name in key:
                        table = scores
                        break
            if not table:
                continue
            for n, s in table.items():
                out[n] = out.get(n, 0.0) + w * float(s)
        return out or self.importance

    @classmethod
    def load(
        cls,
        base_path: Path,
        *,
        entity_file: str = "entity_final.json",
        relations_file: str = "relations_final.json",
        importance_file: str = "entity_sorted.json",
        importance_bundle_file: str = "importance_bundle.json",
        chapter: str | None = None,
    ) -> TextbookKG:
        base_path = Path(base_path)
        entity_path = base_path / entity_file
        relations_path = base_path / relations_file
        importance_path = base_path / importance_file
        bundle_path = base_path / importance_bundle_file

        if not entity_path.is_file():
            raise FileNotFoundError(f"Textbook entity file not found: {entity_path}")
        if not relations_path.is_file():
            raise FileNotFoundError(f"Textbook relations file not found: {relations_path}")

        raw_entities = json.loads(entity_path.read_text(encoding="utf-8"))
        raw_relations = json.loads(relations_path.read_text(encoding="utf-8"))

        importance: dict[str, float] = {}
        importance_by_chapter: dict[str, dict[str, float]] = {}
        chapter_order: list[str] = []

        if bundle_path.is_file():
            bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
            chapter_order = list(bundle.get("chapter_order") or [])
            for item in bundle.get("global") or []:
                if isinstance(item, list) and len(item) >= 2:
                    importance[str(item[0])] = float(item[1])
            for ch, rows in (bundle.get("by_chapter") or {}).items():
                ch_map: dict[str, float] = {}
                for item in rows:
                    if isinstance(item, list) and len(item) >= 2:
                        ch_map[str(item[0])] = float(item[1])
                importance_by_chapter[str(ch)] = ch_map
        elif importance_path.is_file():
            raw_scores = json.loads(importance_path.read_text(encoding="utf-8"))
            for item in raw_scores:
                if isinstance(item, list) and len(item) >= 2:
                    importance[str(item[0])] = float(item[1])
                elif isinstance(item, dict):
                    name = item.get("node") or item.get("name")
                    score = item.get("score")
                    if name is not None and score is not None:
                        importance[str(name)] = float(score)

        active_importance = importance
        if chapter and importance_by_chapter:
            # 临时选章；构造后再可通过 importance_for 切换
            key = chapter.strip()
            if key in importance_by_chapter:
                active_importance = importance_by_chapter[key]
            else:
                for ch, scores in importance_by_chapter.items():
                    if key in ch or ch in key:
                        active_importance = scores
                        break

        entities: dict[str, TextbookEntity] = {}
        for row in raw_entities:
            name = str(row.get("name", "")).strip()
            if not name:
                continue
            entities[name] = TextbookEntity(
                name=name,
                definition=str(row.get("definition", "")).strip(),
                importance=active_importance.get(name, float(row.get("importance", 0) or 0)),
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
            "Loaded textbook KG %s: %d entities, %d relations, chapters=%d",
            textbook_id,
            len(entities),
            len(relations),
            len(importance_by_chapter),
        )
        return cls(
            textbook_id=textbook_id,
            entities=entities,
            relations=relations,
            entity_names=entity_names,
            alias_map=alias_map,
            importance=active_importance if chapter else importance,
            adjacency_out=adjacency_out,
            adjacency_in=adjacency_in,
            importance_by_chapter=importance_by_chapter,
            chapter_order=chapter_order,
        )
