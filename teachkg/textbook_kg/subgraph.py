"""按 cue 文本从教材母图检索局部子图。"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from teachkg.textbook_kg.alias import (
    clean_text,
    extract_entity_matches,
    extract_entities_from_text,
)
from teachkg.textbook_kg.embedding_cache import build_entity_texts, load_entity_embeddings
from teachkg.textbook_kg.loader import TextbookKG, TextbookRelation

logger = logging.getLogger(__name__)

from teachkg.utils.text import count_text_words  # re-export

RELATION_WEIGHTS: dict[str, float] = {
    "part_of": 3.0,
    "belong_to": 3.0,
    "depend_on": 2.0,
    "property_of": 1.5,
    "synonym_of": 1.2,
    "related_with": 1.0,
}


def embedding_top_k_for_text(
    text: str,
    *,
    words_per_seed: int = 25,
    min_k: int = 0,
    max_k: int | None = None,
) -> int:
    """按文本长度动态计算向量种子上限：每 words_per_seed 词 +1。"""
    if words_per_seed <= 0:
        k = max_k if max_k is not None and max_k > 0 else 0
        return max(min_k, k)
    k = count_text_words(text) // int(words_per_seed)
    k = max(int(min_k), k)
    if max_k is not None and int(max_k) > 0:
        k = min(k, int(max_k))
    return k


@dataclass
class SubgraphResult:
    seed_entities: set[str] = field(default_factory=set)
    alias_seeds: set[str] = field(default_factory=set)
    embedding_seeds: set[str] = field(default_factory=set)
    # LLM 筛前的原始候选（展示「已筛掉」用）
    seed_candidates_alias: set[str] = field(default_factory=set)
    seed_candidates_embedding: set[str] = field(default_factory=set)
    entities: set[str] = field(default_factory=set)
    relations: list[TextbookRelation] = field(default_factory=list)
    # 边筛前的候选（规则硬剪枝后）；filtered = candidate - relations
    candidate_relations: list[TextbookRelation] = field(default_factory=list)
    # 本段知识点（边筛前提取，供展示与边关联）
    knowledge_points: list[str] = field(default_factory=list)

    @property
    def edge_count(self) -> int:
        return len(self.relations)

    @property
    def entity_count(self) -> int:
        return len(self.entities)

    @property
    def filtered_relations(self) -> list[TextbookRelation]:
        kept = {
            (r.subject, r.predicate, r.object)
            for r in self.relations
        }
        return [
            r
            for r in self.candidate_relations
            if (r.subject, r.predicate, r.object) not in kept
        ]

    @staticmethod
    def _relation_brief(rel: TextbookRelation) -> dict[str, Any]:
        data: dict[str, Any] = {
            "subject": rel.subject,
            "object": rel.object,
            "abstract_relation": rel.predicate,
            "description": (rel.description or "")[:300],
            "context": (rel.context or "")[:300],
            "classroom_evidence": (getattr(rel, "classroom_evidence", "") or "")[:300],
        }
        kps = list(getattr(rel, "related_knowledge_points", None) or [])
        if kps:
            data["related_knowledge_points"] = kps
        return data

    def to_dict(self) -> dict[str, Any]:
        filtered = self.filtered_relations
        return {
            "seed_entities": sorted(self.seed_entities),
            "alias_seeds": sorted(self.alias_seeds),
            "embedding_seeds": sorted(self.embedding_seeds),
            "seed_candidates_alias": sorted(self.seed_candidates_alias),
            "seed_candidates_embedding": sorted(
                self.seed_candidates_embedding - self.seed_candidates_alias
            ),
            "entities": sorted(self.entities),
            "relations": len(self.relations),
            "candidate_relations": len(self.candidate_relations),
            "filtered_relations": [self._relation_brief(r) for r in filtered],
            "knowledge_points": list(self.knowledge_points),
            "seed_count": len(self.seed_entities),
            "entity_count": len(self.entities),
            "relation_count": len(self.relations),
            "filtered_count": len(filtered),
        }


class TextbookSubgraphRetriever:
    def __init__(
        self,
        kg: TextbookKG,
        *,
        max_hops: int = 1,
        max_edges_per_cue: int | None = None,
        max_edges_per_lecture: int | None = 60,
        max_seed_entities: int = 40,
        lecture_min_relation_score: float = 3.0,
        cue_min_relation_score: float = 4.0,
        require_text_anchor: bool = False,
        require_both_ends_in_candidate_seeds: bool = True,
        score_prune_edges: bool = False,
        lecture_dynamic_cap: bool = True,
        lecture_edges_per_cue_cap: float = 7.0,
        lecture_embedding_link_min_score: float | None = None,
        embedding_link_enabled: bool = False,
        embedding_link_top_k: int | None = None,
        embedding_link_words_per_seed: int = 25,
        embedding_link_min_score: float = 0.82,
        embedder_model: str = "shibing624/text2vec-base-multilingual",
        embedding_cache_enabled: bool = True,
        textbook_base_path: Path | None = None,
        seed_llm_filter: Any | None = None,
        edge_llm_filter: Any | None = None,
        knowledge_point_extractor: Any | None = None,
    ) -> None:
        self.kg = kg
        self.max_hops = max(0, max_hops)
        # None / <=0：边数不截断（仅靠分数阈值）
        self.max_edges_per_cue = (
            None
            if max_edges_per_cue is None or int(max_edges_per_cue) <= 0
            else int(max_edges_per_cue)
        )
        self.max_edges_per_lecture = (
            None
            if max_edges_per_lecture is None or int(max_edges_per_lecture) <= 0
            else int(max_edges_per_lecture)
        )
        self.max_seed_entities = max(1, max_seed_entities)
        self.lecture_min_relation_score = lecture_min_relation_score
        self.cue_min_relation_score = cue_min_relation_score
        self.require_text_anchor = require_text_anchor
        # True（默认）：一跳两端∈候选种子池（筛后种子—候选种子，控噪声）
        # False：一跳另一端不限（噪声大，仅消融用）
        # 两跳始终为「筛后种子 — 中间点 — 筛后种子」
        self.require_both_ends_in_candidate_seeds = require_both_ends_in_candidate_seeds
        # False：不做分数/文本锚点硬剪枝，语义筛选交给 edge_llm_filter
        self.score_prune_edges = score_prune_edges
        self.lecture_dynamic_cap = lecture_dynamic_cap
        self.lecture_edges_per_cue_cap = max(1.0, lecture_edges_per_cue_cap)
        self.lecture_embedding_link_min_score = lecture_embedding_link_min_score
        self.embedding_link_enabled = embedding_link_enabled
        # None / <=0：不封顶，仅由 words_per_seed 动态决定；>0：动态上限的封顶
        self.embedding_link_top_k = (
            None
            if embedding_link_top_k is None or int(embedding_link_top_k) <= 0
            else int(embedding_link_top_k)
        )
        self.embedding_link_words_per_seed = max(
            0, int(embedding_link_words_per_seed or 0)
        )
        self.embedding_link_min_score = embedding_link_min_score
        self.embedder_model = embedder_model
        self.embedding_cache_enabled = embedding_cache_enabled
        self.textbook_base_path = Path(textbook_base_path) if textbook_base_path else None
        self.seed_llm_filter = seed_llm_filter
        self.edge_llm_filter = edge_llm_filter
        self.knowledge_point_extractor = knowledge_point_extractor
        self._embedder = None
        self._entity_embeddings = None
        # 章条件重要性视图（默认全局）
        self._importance_view: dict[str, float] = dict(kg.importance)
        self._importance_chapters: list[str] = []

    def set_importance_context(
        self,
        chapter: str | None = None,
        chapters: list[str] | list[tuple[str, float]] | None = None,
    ) -> None:
        """切换子图打分用的重要性视图（课程无关：任意章名/多章）。"""
        view = self.kg.importance_for(chapter=chapter, chapters=chapters)
        self._importance_view = view
        if chapters:
            self._importance_chapters = [
                str(c[0]) if isinstance(c, (list, tuple)) else str(c) for c in chapters
            ]
        elif chapter:
            self._importance_chapters = [chapter]
        else:
            self._importance_chapters = []

    def _imp(self, name: str) -> float:
        return float(self._importance_view.get(name, 0.0))

    def resolve_seed_sets(
        self, cue_text: str
    ) -> tuple[set[str], set[str], set[str]]:
        """返回 (扩展用种子, 别名种子, 向量种子)。"""
        alias_seeds, embedding_seeds = self.find_seed_entities_by_source(cue_text)
        seeds = alias_seeds | embedding_seeds
        filt = self.seed_llm_filter
        if filt is not None and getattr(filt, "enabled", False):
            seeds = filt.filter(
                cue_text,
                alias_seeds=alias_seeds,
                embedding_seeds=embedding_seeds,
            )
        return seeds, alias_seeds, embedding_seeds

    def retrieve(self, cue_text: str, *, max_edges: int | None = None) -> SubgraphResult:
        if not cue_text.strip():
            return SubgraphResult()

        seeds, alias_seeds, embedding_seeds = self.resolve_seed_sets(cue_text)
        if not seeds:
            kps: list[str] = []
            kp_ext = self.knowledge_point_extractor
            if kp_ext is not None and getattr(kp_ext, "enabled", False):
                kps = list(kp_ext.extract(cue_text) or [])
            # 筛后为空仍保留筛前候选，供展示「已筛掉」
            return SubgraphResult(
                seed_candidates_alias=set(alias_seeds),
                seed_candidates_embedding=set(embedding_seeds) - set(alias_seeds),
                knowledge_points=kps,
            )

        limit = max_edges if max_edges is not None else self.max_edges_per_cue
        return self.retrieve_from_seeds(
            seeds,
            cue_text,
            max_edges=limit,
            min_score=self.cue_min_relation_score,
            candidate_seed_pool=alias_seeds | embedding_seeds,
            alias_seeds=alias_seeds,
            embedding_seeds=embedding_seeds,
        )

    def retrieve_from_seeds(
        self,
        seeds: set[str],
        rank_text: str,
        *,
        max_edges: int | None = None,
        min_score: float | None = None,
        candidate_seed_pool: set[str] | None = None,
        alias_seeds: set[str] | None = None,
        embedding_seeds: set[str] | None = None,
        knowledge_points: list[str] | None = None,
    ) -> SubgraphResult:
        alias_src = set(alias_seeds) if alias_seeds is not None else set()
        emb_src = set(embedding_seeds) if embedding_seeds is not None else set()
        if not seeds:
            return SubgraphResult(
                seed_candidates_alias=set(alias_src),
                seed_candidates_embedding=set(emb_src) - set(alias_src),
                knowledge_points=list(knowledge_points or []),
            )

        seeds = self._cap_seeds(seeds, rank_text)
        pool = candidate_seed_pool if candidate_seed_pool is not None else set(seeds)
        if alias_seeds is None and embedding_seeds is None:
            # 未传入来源时不做拆分标注
            alias_kept: set[str] = set()
            emb_kept: set[str] = set()
        else:
            alias_kept = seeds & alias_src
            emb_kept = seeds - alias_kept
            # 若调用方只传了 embedding 池，剩余仍归 embedding
            if alias_seeds is not None and embedding_seeds is not None:
                emb_kept = seeds & emb_src
                # 别名优先：同名只算别名
                emb_kept -= alias_kept
                # 截断后既非 alias 源也非 emb 源的极少见，并入 embedding 展示
                unknown = seeds - alias_kept - emb_kept
                emb_kept |= unknown

        kps = [str(x).strip() for x in (knowledge_points or []) if str(x).strip()]
        kp_ext = self.knowledge_point_extractor
        if not kps and kp_ext is not None and getattr(kp_ext, "enabled", False):
            kps = list(kp_ext.extract(rank_text) or [])

        # 一跳从筛后种子出发（默认另一端不限）；两跳为种子—中间—种子
        candidates = self._expand_subgraph(
            seeds, rank_text, unrestricted_intermediate=True
        )
        selected = self._select_relations_for_pool(
            candidates,
            seeds=seeds,
            pool=pool,
            require_both_ends_in_pool=self.require_both_ends_in_candidate_seeds,
        )

        if self.score_prune_edges:
            scored = self._score_relations(
                [(rel, 0) for rel in selected],
                rank_text,
                seeds,
                candidate_seed_pool=pool,
            )
            threshold = self.cue_min_relation_score if min_score is None else min_score
            selected = [rel for rel, score in scored if score >= threshold]

        limit = self.max_edges_per_cue if max_edges is None else max_edges
        if limit is not None and int(limit) > 0:
            selected = selected[: int(limit)]

        candidate_relations = list(selected)
        edge_filt = self.edge_llm_filter
        if edge_filt is not None and getattr(edge_filt, "enabled", False) and selected:
            selected = edge_filt.filter(
                rank_text,
                selected,
                expansion_seeds=seeds,
                knowledge_points=kps,
            )

        entities = set(seeds)
        for rel in selected:
            entities.add(rel.subject)
            entities.add(rel.object)

        return SubgraphResult(
            seed_entities=seeds,
            alias_seeds=alias_kept,
            embedding_seeds=emb_kept,
            seed_candidates_alias=set(alias_src),
            seed_candidates_embedding=set(emb_src) - set(alias_src),
            entities=entities,
            relations=selected,
            candidate_relations=candidate_relations,
            knowledge_points=kps,
        )

    def _cap_seeds(self, seeds: set[str], rank_text: str) -> set[str]:
        if len(seeds) <= self.max_seed_entities:
            return seeds
        match_lens = extract_entity_matches(rank_text, self.kg.alias_map)

        def seed_key(name: str) -> tuple[float, float]:
            return (
                float(match_lens.get(name, 0)),
                self._imp(name),
            )

        return set(sorted(seeds, key=seed_key, reverse=True)[: self.max_seed_entities])

    def find_seed_entities_by_source(
        self, cue_text: str
    ) -> tuple[set[str], set[str]]:
        """返回 (别名种子, 向量种子)。向量种子已排除与别名重复项。"""
        alias_seeds = extract_entities_from_text(
            cue_text, self.kg.alias_map, allow_weak=False
        )
        embedding_seeds: set[str] = set()
        if self.embedding_link_enabled and cue_text.strip():
            embedding_seeds = self._embedding_link(cue_text, exclude=alias_seeds)
        return alias_seeds, embedding_seeds

    def _find_seed_entities(self, cue_text: str) -> set[str]:
        seeds, _, _ = self.resolve_seed_sets(cue_text)
        return seeds

    def apply_seed_llm_filter(
        self,
        cue_text: str,
        seeds: set[str],
        *,
        alias_seeds: set[str] | None = None,
        embedding_seeds: set[str] | None = None,
    ) -> set[str]:
        """对已汇总种子再跑一遍 LLM 筛选（讲次合并场景）。"""
        filt = self.seed_llm_filter
        if filt is None or not getattr(filt, "enabled", False):
            return seeds
        alias = set(alias_seeds) if alias_seeds is not None else set(seeds)
        emb = set(embedding_seeds) if embedding_seeds is not None else set()
        # 未知来源的并入 alias 侧展示；筛选仍只允许 seeds 全集
        unknown = set(seeds) - alias - emb
        alias |= unknown
        emb &= seeds
        alias &= seeds
        return filt.filter(cue_text, alias_seeds=alias, embedding_seeds=emb)

    @staticmethod
    def _entity_mentioned(name: str, cue_clean: str) -> bool:
        if not cue_clean or not name:
            return False
        parts = [clean_text(p) for p in name.split("/")] + [clean_text(name)]
        return any(p and len(p) >= 2 and p in cue_clean for p in parts)

    def _can_expand_through(
        self,
        node: str,
        *,
        expand_through: set[str],
        unrestricted_intermediate: bool,
        cue_clean: str,
    ) -> bool:
        del cue_clean
        if unrestricted_intermediate:
            return True
        return node in expand_through

    def _expand_subgraph(
        self,
        seeds: set[str],
        cue_text: str,
        *,
        expand_through: set[str] | None = None,
        unrestricted_intermediate: bool = False,
    ) -> list[tuple[TextbookRelation, int]]:
        """双向多跳扩展。

        默认仅从筛后种子出发。
        unrestricted_intermediate=True 时：第一跳邻居任意（中间点无要求），
        用于「筛后种子 → 任意中间点 → 筛后种子」的两跳路径。
        """
        cue_clean = clean_text(cue_text)
        through = set(expand_through) if expand_through is not None else set(seeds)
        entities = set(seeds)
        frontier = set(seeds)
        seen_rel_keys: set[tuple[str, str, str]] = set()
        candidates: list[tuple[TextbookRelation, int]] = []

        for hop in range(self.max_hops + 1):
            if not frontier:
                break
            next_frontier: set[str] = set()
            for node in frontier:
                for rel in self.kg.adjacency_out.get(node, []):
                    key = (rel.subject, rel.predicate, rel.object)
                    if key in seen_rel_keys:
                        continue
                    seen_rel_keys.add(key)
                    candidates.append((rel, hop))
                    neighbor = rel.object
                    if neighbor not in entities:
                        entities.add(neighbor)
                        if hop < self.max_hops and self._can_expand_through(
                            neighbor,
                            expand_through=through,
                            unrestricted_intermediate=unrestricted_intermediate,
                            cue_clean=cue_clean,
                        ):
                            next_frontier.add(neighbor)
                for rel in self.kg.adjacency_in.get(node, []):
                    key = (rel.subject, rel.predicate, rel.object)
                    if key in seen_rel_keys:
                        continue
                    seen_rel_keys.add(key)
                    candidates.append((rel, hop))
                    neighbor = rel.subject
                    if neighbor not in entities:
                        entities.add(neighbor)
                        if hop < self.max_hops and self._can_expand_through(
                            neighbor,
                            expand_through=through,
                            unrestricted_intermediate=unrestricted_intermediate,
                            cue_clean=cue_clean,
                        ):
                            next_frontier.add(neighbor)
            frontier = next_frontier

        return candidates

    def _select_relations_for_pool(
        self,
        candidates: list[tuple[TextbookRelation, int]],
        *,
        seeds: set[str],
        pool: set[str],
        require_both_ends_in_pool: bool,
    ) -> list[TextbookRelation]:
        """按跳数/路径筛选边。

        - 一跳：与筛后种子相邻；若 require_both_ends_in_pool，两端须∈候选种子池。
        - 两跳：筛后种子 → 任意中间点 → 筛后种子；保留中间点与筛后种子之间的边
          （不依赖 BFS hop 标签，避免「入边被标成 hop0」漏桥接）
        """
        from collections import defaultdict

        rels = [rel for rel, _hop in candidates]
        undirected: dict[str, list[TextbookRelation]] = defaultdict(list)
        for rel in rels:
            undirected[rel.subject].append(rel)
            undirected[rel.object].append(rel)

        selected: list[TextbookRelation] = []
        seen: set[tuple[str, str, str]] = set()

        def add(rel: TextbookRelation) -> None:
            key = (rel.subject, rel.predicate, rel.object)
            if key in seen:
                return
            seen.add(key)
            selected.append(rel)

        # 一跳：从筛后种子出发；require_both_ends_in_pool 时两端∈候选池
        for rel in rels:
            if rel.subject not in seeds and rel.object not in seeds:
                continue
            if require_both_ends_in_pool and not (
                rel.subject in pool and rel.object in pool
            ):
                continue
            add(rel)

        # 中间点 = 与筛后种子相邻、且自身不是筛后种子的节点
        mids: set[str] = set()
        for rel in rels:
            if rel.subject in seeds and rel.object not in seeds:
                mids.add(rel.object)
            if rel.object in seeds and rel.subject not in seeds:
                mids.add(rel.subject)

        # 两跳：中间点至少连到两个不同筛后种子 → 保留这些边
        for mid in mids:
            seed_links: list[TextbookRelation] = []
            landings: set[str] = set()
            for rel in undirected.get(mid, []):
                other = rel.object if rel.subject == mid else rel.subject
                if other in seeds:
                    seed_links.append(rel)
                    landings.add(other)
            if len(landings) < 2:
                continue
            for rel in seed_links:
                add(rel)

        return selected

    def _score_one(
        self,
        rel: TextbookRelation,
        hop: int,
        cue_clean: str,
        seeds: set[str],
        *,
        candidate_seed_pool: set[str] | None = None,
    ) -> float:
        pool = candidate_seed_pool if candidate_seed_pool is not None else seeds
        # 仅旧行为：一跳两端须在候选池时，分数路径也硬拒池外端点
        if self.require_both_ends_in_candidate_seeds:
            if rel.subject not in pool or rel.object not in pool:
                return -1e9

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

        subj_m = self._entity_mentioned(rel.subject, cue_clean)
        obj_m = self._entity_mentioned(rel.object, cue_clean)
        anchor_bonus = 0.0
        if subj_m and obj_m:
            anchor_bonus += 4.0
        elif subj_m or obj_m:
            anchor_bonus += 2.0

        # importance 降权，避免 hub 实体主导（可用章条件视图）
        imp_bonus = (self._imp(rel.subject) + self._imp(rel.object)) * 10.0
        hop_penalty = 3.0 * hop
        weak_pred_penalty = 0.0
        if hop >= 1 and rel.predicate == "related_with":
            weak_pred_penalty = 2.0

        score = (
            weight
            + seed_bonus
            + text_bonus
            + anchor_bonus
            + imp_bonus
            - hop_penalty
            - weak_pred_penalty
        )

        if self.require_text_anchor:
            seed_touch = rel.subject in seeds or rel.object in seeds
            if not (subj_m or obj_m or (hop == 0 and seed_touch)):
                return -1e9

        return score

    def _score_relations(
        self,
        candidates: list[tuple[TextbookRelation, int]],
        cue_text: str,
        seeds: set[str],
        *,
        candidate_seed_pool: set[str] | None = None,
    ) -> list[tuple[TextbookRelation, float]]:
        cue_clean = clean_text(cue_text)
        scored = [
            (
                rel,
                self._score_one(
                    rel,
                    hop,
                    cue_clean,
                    seeds,
                    candidate_seed_pool=candidate_seed_pool,
                ),
            )
            for rel, hop in candidates
        ]
        return sorted(scored, key=lambda x: x[1], reverse=True)

    def _rank_relations(
        self,
        relations: list[TextbookRelation],
        cue_text: str,
        seeds: set[str],
    ) -> list[TextbookRelation]:
        # 兼容旧调用：无 hop 信息时按 hop=0 计
        scored = self._score_relations([(rel, 0) for rel in relations], cue_text, seeds)
        return [rel for rel, _score in scored]

    def rank_relations_scored(
        self,
        relations: list[TextbookRelation],
        rank_text: str,
        seeds: set[str],
        *,
        hops: dict[tuple[str, str, str], int] | None = None,
    ) -> list[tuple[TextbookRelation, float]]:
        if hops is None:
            candidates = [(rel, 0) for rel in relations]
        else:
            candidates = [
                (rel, hops.get((rel.subject, rel.predicate, rel.object), 0))
                for rel in relations
            ]
        return self._score_relations(candidates, rank_text, seeds)

    def expand_scored(
        self,
        seeds: set[str],
        rank_text: str,
        *,
        candidate_seed_pool: set[str] | None = None,
    ) -> list[tuple[TextbookRelation, float]]:
        """讲次级：扩展；结构剪枝后，分数仅作可选排序。"""
        seeds = self._cap_seeds(seeds, rank_text)
        pool = candidate_seed_pool if candidate_seed_pool is not None else set(seeds)
        candidates = self._expand_subgraph(
            seeds, rank_text, unrestricted_intermediate=True
        )
        selected = self._select_relations_for_pool(
            candidates,
            seeds=seeds,
            pool=pool,
            require_both_ends_in_pool=self.require_both_ends_in_candidate_seeds,
        )
        candidates = [(rel, 0) for rel in selected]
        if self.score_prune_edges:
            return self._score_relations(
                candidates, rank_text, seeds, candidate_seed_pool=pool
            )
        return [(rel, 1.0) for rel, _hop in candidates]

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
        order = np.argsort(scores)[::-1]

        linked: set[str] = set()
        threshold = self.embedding_link_min_score if min_score is None else min_score
        top_k = embedding_top_k_for_text(
            cue_text,
            words_per_seed=self.embedding_link_words_per_seed,
            min_k=0,
            max_k=self.embedding_link_top_k,
        )
        if top_k <= 0:
            return set()
        for idx in order:
            if float(scores[idx]) < threshold:
                break
            name = names[int(idx)]
            if name in exclude:
                continue
            linked.add(name)
            if len(linked) >= top_k:
                break
        return linked
