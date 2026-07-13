"""基于文本嵌入的跨实体相似合并（补充字符串规则）。"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

_STRUCTURAL_BLOCK_RELATIONS = frozenset(
    {"part_of", "depend_on", "belong_to", "property_of", "is_a"}
)


def build_entity_embed_texts(
    entity_names: list[str],
    triplets: list[dict[str, Any]] | None = None,
    *,
    max_statements: int = 2,
) -> dict[str, str]:
    """实体名 + 少量 natural_statement 作为嵌入文本。"""
    statements: dict[str, list[str]] = {n: [] for n in entity_names}
    if triplets:
        for row in triplets:
            stmt = str(row.get("natural_statement", "")).strip()
            if not stmt:
                continue
            for key in ("subject", "object"):
                ent = str(row.get(key, "")).strip()
                if ent in statements and len(statements[ent]) < max_statements:
                    if stmt not in statements[ent]:
                        statements[ent].append(stmt)

    texts: dict[str, str] = {}
    for name in entity_names:
        parts = [name]
        parts.extend(statements.get(name, []))
        texts[name] = " ".join(parts)
    return texts


def build_structural_block_pairs(
    triplets: list[dict[str, Any]] | None,
) -> set[frozenset[str]]:
    """图谱中已有结构关系的实体对禁止合并。"""
    blocked: set[frozenset[str]] = set()
    if not triplets:
        return blocked
    for row in triplets:
        rel = str(row.get("abstract_relation", "")).strip()
        if rel not in _STRUCTURAL_BLOCK_RELATIONS:
            continue
        sub = str(row.get("subject", "")).strip()
        obj = str(row.get("object", "")).strip()
        if sub and obj and sub != obj:
            blocked.add(frozenset({sub, obj}))
    return blocked


def merge_map_by_embedding(
    entity_names: list[str],
    *,
    embedder: Any,
    similarity_threshold: float = 0.93,
    triplets: list[dict[str, Any]] | None = None,
    max_statements: int = 2,
    block_structural_pairs: bool = True,
    direct_pairs_only: bool = True,
) -> dict[str, str]:
    """返回 alias → canonical；仅合并高于阈值的相似实体对。

    - 默认不做并查集传递合并（避免「主语」吸收整团实体）
    - 可选屏蔽 triplets 中已有 part_of/depend_on 等结构关系的实体对
    """
    unique = sorted(set(entity_names))
    if len(unique) < 2:
        return {}

    embed_texts = build_entity_embed_texts(
        unique, triplets, max_statements=max_statements
    )
    blocked = build_structural_block_pairs(triplets) if block_structural_pairs else set()

    try:
        texts = [embed_texts[n] for n in unique]
        vecs = embedder.embed(texts)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Embedding merge skipped: %s", exc)
        return {}

    pair_scores: list[tuple[float, int, int]] = []
    for i in range(len(unique)):
        for j in range(i + 1, len(unique)):
            if frozenset({unique[i], unique[j]}) in blocked:
                continue
            sim = float(np.dot(vecs[i], vecs[j]))
            if sim >= similarity_threshold:
                pair_scores.append((sim, i, j))

    pair_scores.sort(reverse=True)
    merge_map: dict[str, str] = {}
    absorbed: set[str] = set()

    for sim, i, j in pair_scores:
        a, b = unique[i], unique[j]
        if a in absorbed or b in absorbed:
            continue
        canonical, alias = (a, b) if len(a) <= len(b) else (b, a)
        if alias in merge_map or canonical in absorbed:
            continue
        merge_map[alias] = canonical
        absorbed.add(alias)
        logger.debug("Embedding merge %.3f: %s -> %s", sim, alias, canonical)

    if not direct_pairs_only:
        logger.warning("direct_pairs_only=False is deprecated; using direct merge only")

    return merge_map
