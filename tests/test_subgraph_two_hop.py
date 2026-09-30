"""Regression: 一跳两端∈候选池；两跳中间点不限、落点须在筛后种子。"""

from __future__ import annotations

from teachkg.textbook_kg.loader import TextbookEntity, TextbookKG, TextbookRelation
from teachkg.textbook_kg.subgraph import TextbookSubgraphRetriever


def _rel(a: str, b: str, pred: str = "related_with") -> TextbookRelation:
    return TextbookRelation(subject=a, predicate=pred, object=b)


def _make_kg(relations: list[TextbookRelation]) -> TextbookKG:
    names = sorted({r.subject for r in relations} | {r.object for r in relations})
    entities = {n: TextbookEntity(name=n) for n in names}
    adjacency_out: dict[str, list[TextbookRelation]] = {}
    adjacency_in: dict[str, list[TextbookRelation]] = {}
    for rel in relations:
        adjacency_out.setdefault(rel.subject, []).append(rel)
        adjacency_in.setdefault(rel.object, []).append(rel)
    return TextbookKG(
        textbook_id="t",
        entities=entities,
        relations=relations,
        entity_names=names,
        alias_map={n: [n] for n in names},
        importance={n: 0.1 for n in names},
        adjacency_out=adjacency_out,
        adjacency_in=adjacency_in,
    )


def test_one_hop_requires_both_ends_in_candidate_pool():
    """一跳：两端须∈候选种子池；另一端仅在池外则丢弃。"""
    seed_a = "A/seed"
    outside = "X/outside"
    pool_peer = "P/pool"
    relations = [_rel(seed_a, outside), _rel(seed_a, pool_peer)]
    ret = TextbookSubgraphRetriever(
        _make_kg(relations),
        max_hops=1,
        max_edges_per_cue=None,
        require_both_ends_in_candidate_seeds=True,
        embedding_link_enabled=False,
        score_prune_edges=False,
    )
    result = ret.retrieve_from_seeds(
        {seed_a}, "text", candidate_seed_pool={seed_a, pool_peer}
    )
    keys = {(r.subject, r.object) for r in result.relations}
    assert (seed_a, pool_peer) in keys
    assert (seed_a, outside) not in keys


def test_one_hop_other_end_unrestricted_when_flag_false():
    """消融：require_both_ends=False 时一跳另一端不限。"""
    seed_a = "A/seed"
    outside = "X/outside"
    relations = [_rel(seed_a, outside)]
    ret = TextbookSubgraphRetriever(
        _make_kg(relations),
        max_hops=1,
        max_edges_per_cue=None,
        require_both_ends_in_candidate_seeds=False,
        embedding_link_enabled=False,
        score_prune_edges=False,
    )
    result = ret.retrieve_from_seeds(
        {seed_a}, "text", candidate_seed_pool={seed_a}
    )
    keys = {(r.subject, r.object) for r in result.relations}
    assert (seed_a, outside) in keys


def test_two_hop_landing_must_be_kept_seed():
    """seed_a → mid(任意) → seed_b(筛后)：保留；落到仅候选池节点则不保留。"""
    seed_a, seed_b, mid = "A/seed", "B/seed", "M/mid"
    pool_only = "P/pool_only"
    relations = [
        _rel(seed_a, mid),
        _rel(mid, seed_b),
        _rel(mid, pool_only),  # 落点仅在候选池、非筛后种子 → 不保留
        _rel(seed_a, seed_b),  # 一跳 → 保留
    ]
    ret = TextbookSubgraphRetriever(
        _make_kg(relations),
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

    assert (seed_a, seed_b) in keys  # 一跳（两端∈池）
    assert (seed_a, mid) in keys  # 两跳桥接
    assert (mid, seed_b) in keys  # 两跳落点=筛后种子
    assert (mid, pool_only) not in keys  # 落点非筛后种子
