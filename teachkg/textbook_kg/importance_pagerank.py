# -*- coding: utf-8 -*-
"""课堂图谱纯 PageRank 重要性（实验用，不替代 feedback 产物）。

- 构图：讲次三元组 → 有向加权图（关系类型权重，与 importance_pr 一致）
- 算法：经典 nx.pagerank，无个性化 teleport（personalization=None）
- 输出：min-max 归一化到 [0,1]，写入独立 JSON，不改 entity_importance_feedback.json
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

import networkx as nx

from teachkg.importance_pr.biased_pagerank import RELATION_WEIGHTS, load_graph

DEFAULT_DAMPING = 0.85


def _rel(t: dict[str, Any]) -> str:
    return str(
        t.get("abstract_relation")
        or t.get("predicate")
        or t.get("relation")
        or t.get("label")
        or "related_with"
    ).split("|")[0].strip().lower() or "related_with"


def _ends(t: dict[str, Any]) -> tuple[str, str]:
    frm = str(
        t.get("from") or t.get("subject") or t.get("head") or ""
    ).strip()
    to = str(t.get("to") or t.get("object") or t.get("tail") or "").strip()
    return frm, to


def triplets_to_relations(triplets: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """转成 biased_pagerank.load_graph 所需的 relations 列表。"""
    out: list[dict[str, Any]] = []
    for t in triplets:
        frm, to = _ends(t)
        if not frm or not to or frm == to:
            continue
        out.append(
            {
                "subject": frm,
                "object": to,
                "predicate": _rel(t),
            }
        )
    return out


def normalize_scores(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    vals = list(scores.values())
    lo, hi = min(vals), max(vals)
    if hi <= lo:
        return {k: 0.5 for k in scores}
    return {k: (v - lo) / (hi - lo) for k, v in scores.items()}


def classic_pagerank(
    triplets: Iterable[dict[str, Any]],
    *,
    damping: float = DEFAULT_DAMPING,
    relation_weights: dict[str, float] | None = None,
) -> dict[str, float]:
    """在课堂三元组图上跑经典加权 PageRank，返回原始 PR 分（未归一化）。"""
    relations = triplets_to_relations(triplets)
    if not relations:
        return {}
    G = load_graph(relations, relation_weights=relation_weights or RELATION_WEIGHTS)
    if G.number_of_nodes() == 0:
        return {}
    # 纯 PageRank：不传 personalization
    raw = nx.pagerank(G, alpha=float(damping), weight="weight")
    return {str(k): float(v) for k, v in raw.items()}


def classic_pagerank_normalized(
    triplets: Iterable[dict[str, Any]],
    *,
    damping: float = DEFAULT_DAMPING,
) -> dict[str, float]:
    return normalize_scores(classic_pagerank(triplets, damping=damping))


def pack_pagerank_document(
    *,
    course: str,
    by_lecture: dict[str, dict[str, float]],
    course_scores: dict[str, float],
    damping: float = DEFAULT_DAMPING,
    n_triplets_by_lecture: dict[str, int] | None = None,
) -> dict[str, Any]:
    """组装与 feedback 平行的独立产物（classroom 字段填 PR 归一化分，便于前端复用）。"""
    def _ctx(scores: dict[str, float], lid: str | None = None) -> dict[str, Any]:
        top = sorted(scores.items(), key=lambda x: -x[1])[:30]
        return {
            "scores": {k: round(v, 6) for k, v in scores.items()},
            "classroom": {k: round(v, 6) for k, v in scores.items()},
            "pagerank": {k: round(v, 6) for k, v in scores.items()},
            "top": [
                {"name": n, "classroom_norm": round(v, 6), "pagerank": round(v, 6)}
                for n, v in top
            ],
            "meta": {
                "method": "classic_pagerank",
                "damping": damping,
                "lecture_id": lid,
                "n_entities": len(scores),
                "n_triplets": (n_triplets_by_lecture or {}).get(str(lid), None)
                if lid is not None
                else None,
            },
        }

    by_context: dict[str, Any] = {}
    for lid, scores in sorted(
        by_lecture.items(), key=lambda x: int(x[0]) if str(x[0]).isdigit() else 999
    ):
        by_context[f"lecture:{lid}"] = _ctx(scores, lid)
    by_context["course"] = _ctx(course_scores, None)

    rounded_course = {k: round(v, 6) for k, v in course_scores.items()}
    return {
        "version": 1,
        "course": course,
        "method": "classic_pagerank",
        "damping": damping,
        "scores": rounded_course,
        "classroom": rounded_course,
        "pagerank": rounded_course,
        "by_context": by_context,
        "meta": {
            "note": "实验用纯 PageRank；不替代 entity_importance_feedback.json",
            "n_lectures": len(by_lecture),
            "n_entities_course": len(course_scores),
        },
    }


def merge_lecture_scores_max(
    by_lecture: dict[str, dict[str, float]],
) -> dict[str, float]:
    """整课：各讲次归一化分取 max 后再归一化（避免讲次多的实体被简单平均稀释）。"""
    acc: dict[str, float] = defaultdict(float)
    for scores in by_lecture.values():
        for k, v in scores.items():
            acc[k] = max(acc[k], float(v))
    return normalize_scores(dict(acc))
