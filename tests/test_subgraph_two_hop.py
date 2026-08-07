"""Regression: 两跳中间点不限，落点须在筛后种子。"""

from __future__ import annotations

from teachkg.textbook_kg.loader import TextbookEntity, TextbookKG, TextbookRelation
from teachkg.textbook_kg.subgraph import TextbookSubgraphRetriever


def _rel(a: str, b: str, pred: str = "related_with") -> TextbookRelation:
    return TextbookRelation(subject=a, predicate=pred, object=b)


def test_two_hop_landing_must_be_kept_seed():
    """seed_a → mid(任意) → seed_b(筛后)：保留；落到仅候选池节点则不保留。"""
    seed_a, seed_b, mid = "A/seed", "B/seed", "M/mid"
    pool_only = "P/pool_only"
    relations = [
        _rel(seed_a, mid),
        _rel(mid, seed_b),
        _rel(mid, pool_only),  # 落点仅在候选池、非筛后种子 → 不保留
        _rel(seed_a, seed_b),  # 一跳两端在池 → 保留
    ]
    names = [seed_a, seed_b, mid, pool_only]
    entities = {n: TextbookEntity(name=n) for n in names}
    adjacency_out: dict[str, list[TextbookRelation]] = {}
    adjacency_in: dict[str, list[TextbookRelation]] = {}
    for rel in relations:
        adjacency_out.setdefault(rel.subject, []).append(rel)
        adjacency_in.setdefault(rel.object, []).append(rel)

    kg = TextbookKG(
        textbook_id="t",
        entities=entities,
        relations=relations,
        entity_names=names,
        alias_map={n: [n] for n in names},
        importance={n: 0.1 for n in names},
        adjacency_out=adjacency_out,
        adjacency_in=adjacency_in,
    )

    ret = TextbookSubgraphRetriever(
        kg,
        max_hops=1,
        max_edges_per_cue=None,
        require_both_ends_in_candidate_seeds=True,
        embedding_link_enabled=False,
        score_prune_edges=False,
    )
    kept = {seed_a, seed_b}
    pool = {seed_a, seed_b, pool_only}
    result = ret.retrieve_from_seeds(kept, "text", candidate_seed_pool=pool)
    keys = {(r.subject, r.object) for r in result.relations}

    assert (seed_a, seed_b) in keys  # 一跳
    assert (seed_a, mid) in keys  # 桥接
    assert (mid, seed_b) in keys  # 两跳落点=筛后种子
    assert (mid, pool_only) not in keys  # 落点非筛后种子
