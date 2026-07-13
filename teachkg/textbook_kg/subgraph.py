"""按 cue 文本从教材母图检索局部子图。"""

from __future__ import annotations

from pathlib import Path

import logging
from dataclasses import dataclass, field

from teachkg.textbook_kg.alias import clean_text, extract_entities_from_text
from teachkg.textbook_kg.embedding_cache import build_entity_texts, load_entity_embeddings
from teachkg.textbook_kg.loader import TextbookKG, TextbookRelation

RELATION_WEIGHTS: dict[str, float] = {
    "part_of": 3.0,
    "belong_to": 3.0,
    "depend_on": 2.0,
    "property_of": 1.5,
    "synonym_of": 1.2,
    "related_with": 1.0,
}


@dataclass
class SubgraphResult:
    seed_entities: set[str] = field(default_factory=set)
    entities: set[str] = field(default_factory=set)
    relations: list[TextbookRelation] = field(default_factory=list)

    @property
    def edge_count(self) -> int:
        return len(self.relations)

    @property
    def entity_count(self) -> int:
        return len(self.entities)

    def to_dict(self) -> dict[str, int]:
        return {
            "seed_entities": len(self.seed_entities),
            "entities": len(self.entities),
            "relations": len(self.relations),
        }


class TextbookSubgraphRetriever:
    def __init__(
        self,
        kg: TextbookKG,
        *,
        max_hops: int = 2,
        max_edges_per_cue: int = 18,
        max_edges_per_lecture: int = 60,
        max_seed_entities: int = 20,
        lecture_min_relation_score: float = 3.0,
        lecture_dynamic_cap: bool = True,
        lecture_edges_per_cue_cap: float = 7.0,
        lecture_embedding_link_min_score: float | None = None,
        embedding_link_enabled: bool = False,
        embedding_link_top_k: int = 5,
        embedding_link_min_score: float = 0.82,
        embedder_model: str = "shibing624/text2vec-base-multilingual",
        embedding_cache_enabled: bool = True,
        textbook_base_path: Path | None = None,
    ) -> None:
        self.kg = kg
        self.max_hops = max(0, max_hops)
        self.max_edges_per_cue = max(1, max_edges_per_cue)
        self.max_edges_per_lecture = max(1, max_edges_per_lecture)
        self.max_seed_entities = max(1, max_seed_entities)
        self.lecture_min_relation_score = lecture_min_relation_score
        self.lecture_dynamic_cap = lecture_dynamic_cap
        self.lecture_edges_per_cue_cap = max(1.0, lecture_edges_per_cue_cap)
        self.lecture_embedding_link_min_score = lecture_embedding_link_min_score
        self.embedding_link_enabled = embedding_link_enabled
        self.embedding_link_top_k = embedding_link_top_k
        self.embedding_link_min_score = embedding_link_min_score
        self.embedder_model = embedder_model
        self.embedding_cache_enabled = embedding_cache_enabled
        self.textbook_base_path = Path(textbook_base_path) if textbook_base_path else None
        self._embedder = None
        self._entity_embeddings = None

    def retrieve(self, cue_text: str, *, max_edges: int | None = None) -> SubgraphResult:
        if not cue_text.strip():
            return SubgraphResult()

        seeds = self._find_seed_entities(cue_text)
        if not seeds:
            return SubgraphResult()

        limit = max_edges if max_edges is not None else self.max_edges_per_cue
        return self.retrieve_from_seeds(seeds, cue_text, max_edges=limit)

    def retrieve_from_seeds(
        self,
        seeds: set[str],
        rank_text: str,
        *,
        max_edges: int | None = None,
    ) -> SubgraphResult:
        if not seeds:
            return SubgraphResult()

        if len(seeds) > self.max_seed_entities:
            seeds = set(
                sorted(
                    seeds,
                    key=lambda name: self.kg.importance.get(name, 0.0),
                    reverse=True,
                )[: self.max_seed_entities]
            )

        entities, candidate_relations = self._expand_subgraph(seeds)
        ranked = self._rank_relations(candidate_relations, rank_text, seeds)
        limit = max_edges if max_edges is not None else self.max_edges_per_cue
        selected = ranked[:limit]
        for rel in selected:
            entities.add(rel.subject)
            entities.add(rel.object)

        return SubgraphResult(seed_entities=seeds, entities=entities, relations=selected)

    def _find_seed_entities(self, cue_text: str) -> set[str]:
        seeds = extract_entities_from_text(cue_text, self.kg.alias_map)
        if self.embedding_link_enabled:
            seeds |= self._embedding_link(cue_text, exclude=seeds)
        return seeds

    def _expand_subgraph(
        self,
        seeds: set[str],
    ) -> tuple[set[str], list[TextbookRelation]]:
        entities = set(seeds)
        frontier = set(seeds)
        seen_rel_keys: set[tuple[str, str, str]] = set()
        candidate_relations: list[TextbookRelation] = []

        for _hop in range(self.max_hops + 1):
            if not frontier:
                break
            next_frontier: set[str] = set()
            for node in frontier:
                for rel in self.kg.adjacency_out.get(node, []):
                    key = (rel.subject, rel.predicate, rel.object)
                    if key in seen_rel_keys:
                        continue
                    seen_rel_keys.add(key)
                    candidate_relations.append(rel)
                    if rel.object not in entities:
                        entities.add(rel.object)
                        next_frontier.add(rel.object)
                for rel in self.kg.adjacency_in.get(node, []):
                    key = (rel.subject, rel.predicate, rel.object)
                    if key in seen_rel_keys:
                        continue
                    seen_rel_keys.add(key)
                    candidate_relations.append(rel)
                    if rel.subject not in entities:
                        entities.add(rel.subject)
                        next_frontier.add(rel.subject)
            frontier = next_frontier

        return entities, candidate_relations

    def _rank_relations(
        self,
        relations: list[TextbookRelation],
        cue_text: str,
        seeds: set[str],
    ) -> list[TextbookRelation]:
        cue_clean = clean_text(cue_text)

        def score(rel: TextbookRelation) -> float:
            weight = RELATION_WEIGHTS.get(rel.predicate, 1.0)
            seed_bonus = 0.0
            if rel.subject in seeds:
                seed_bonus += 3.0
            if rel.object in seeds:
                seed_bonus += 3.0
            text_bonus = 0.0
            for part in (rel.subject, rel.object, rel.context, rel.description):
                part_clean = clean_text(part)
                if part_clean and part_clean in cue_clean:
                    text_bonus += 2.0
            imp_bonus = (
                self.kg.importance.get(rel.subject, 0.0)
                + self.kg.importance.get(rel.object, 0.0)
            ) * 50.0
            return weight + seed_bonus + text_bonus + imp_bonus

        return sorted(relations, key=score, reverse=True)

    def rank_relations_scored(
        self,
        relations: list[TextbookRelation],
        rank_text: str,
        seeds: set[str],
    ) -> list[tuple[TextbookRelation, float]]:
        cue_clean = clean_text(rank_text)

        def score(rel: TextbookRelation) -> float:
            weight = RELATION_WEIGHTS.get(rel.predicate, 1.0)
            seed_bonus = 0.0
            if rel.subject in seeds:
                seed_bonus += 3.0
            if rel.object in seeds:
                seed_bonus += 3.0
            text_bonus = 0.0
            for part in (rel.subject, rel.object, rel.context, rel.description):
                part_clean = clean_text(part)
                if part_clean and part_clean in cue_clean:
                    text_bonus += 2.0
            imp_bonus = (
                self.kg.importance.get(rel.subject, 0.0)
                + self.kg.importance.get(rel.object, 0.0)
            ) * 50.0
            return weight + seed_bonus + text_bonus + imp_bonus

        return sorted(((rel, score(rel)) for rel in relations), key=lambda x: x[1], reverse=True)

    def _embedding_link(
        self,
        cue_text: str,
        *,
        exclude: set[str],
        min_score: float | None = None,
    ) -> set[str]:
        try:
            from teachkg.stage3_mmkg.text_embedder import TextEmbedder
            import numpy as np
        except ImportError:
            return set()

        if self._embedder is None:
            self._embedder = TextEmbedder(model_name=self.embedder_model)

        if self._entity_embeddings is None:
            if self.embedding_cache_enabled and self.textbook_base_path:
                names, texts = build_entity_texts(self.kg)
                _, matrix = load_entity_embeddings(
                    self.textbook_base_path,
                    entity_names=names,
                    entity_texts=texts,
                    embedder_model=self.embedder_model,
                )
                self._entity_embeddings = (names, matrix)
            else:
                texts = []
                names = []
                for name in self.kg.entity_names:
                    ent = self.kg.entities.get(name)
                    text = name
                    if ent and ent.definition:
                        text = f"{name}。{ent.definition[:300]}"
                    texts.append(text)
                    names.append(name)
                matrix = self._embedder.embed(texts)
                self._entity_embeddings = (names, matrix)

        names, matrix = self._entity_embeddings
        query = self._embedder.embed_one(cue_text)
        scores = matrix @ query
        top_idx = np.argsort(scores)[::-1][: self.embedding_link_top_k]

        linked: set[str] = set()
        threshold = self.embedding_link_min_score if min_score is None else min_score
        for idx in top_idx:
            if float(scores[idx]) < threshold:
                continue
            name = names[int(idx)]
            if name not in exclude:
                linked.add(name)
        return linked
