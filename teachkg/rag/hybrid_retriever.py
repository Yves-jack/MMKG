"""混合检索：向量 + BM25 + 可选图谱扩展。"""

from __future__ import annotations

from typing import Any

from teachkg.rag.bm25 import BM25Index
from teachkg.rag.graph_retrieval import expand_from_entities, seed_entities_from_hits
from teachkg.stage3_mmkg.index_builder import MMKGIndex


def _normalize_scores(pairs: list[tuple[int, float]]) -> dict[int, float]:
    if not pairs:
        return {}
    scores = [s for _, s in pairs]
    lo, hi = min(scores), max(scores)
    span = hi - lo or 1.0
    return {i: (s - lo) / span for i, s in pairs}


def hybrid_search(
    index: MMKGIndex,
    query: str,
    *,
    top_k: int = 5,
    vector_weight: float = 0.65,
    bm25_weight: float = 0.35,
    mmkg: dict[str, Any] | None = None,
    graph_hops: int = 0,
    graph_max: int = 5,
) -> list[dict[str, Any]]:
    """合并向量检索与 BM25，可选图谱邻域扩展。"""
    records = index.records
    vec_hits = index.search(query, top_k=top_k * 2)
    if index.bm25 is not None:
        bm25_raw = index.bm25.search(query, top_k=top_k * 2)
    else:
        docs = [r.get("text") or "" for r in records]
        bm25_raw = BM25Index(docs).search(query, top_k=top_k * 2)

    id_to_idx = {r.get("id"): i for i, r in enumerate(records)}
    vec_norm: dict[int, float] = {}
    if vec_hits:
        max_v = max(h.get("score", 0.0) for h in vec_hits) or 1.0
        for h in vec_hits:
            idx = id_to_idx.get(h.get("id"))
            if idx is not None:
                vec_norm[idx] = float(h.get("score", 0.0)) / max_v

    bm25_norm = _normalize_scores(bm25_raw)

    combined: dict[int, float] = {}
    all_idx = set(vec_norm) | set(bm25_norm)
    for i in all_idx:
        combined[i] = vector_weight * vec_norm.get(i, 0.0) + bm25_weight * bm25_norm.get(i, 0.0)

    ranked = sorted(combined.items(), key=lambda x: -x[1])[:top_k]
    hits: list[dict[str, Any]] = []
    for idx, score in ranked:
        if idx >= len(records):
            continue
        base = dict(records[idx])
        base["score"] = score
        base["source"] = "hybrid"
        hits.append(base)

    if graph_hops > 0 and mmkg and hits:
        max_primary = max(h.get("score", 0.0) for h in hits) or 1.0
        seeds = seed_entities_from_hits(hits)
        extra = expand_from_entities(mmkg, seeds, max_hops=graph_hops, max_edges=graph_max)
        seen = {h.get("id") for h in hits}
        for e in extra:
            if e.get("id") not in seen:
                e["score"] = min(float(e.get("score", 0.0)) * max_primary * 0.85, max_primary * 0.9)
                hits.append(e)
                seen.add(e.get("id"))

    return hits[: top_k + graph_max]
