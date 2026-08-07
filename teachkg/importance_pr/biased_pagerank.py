"""Biased / Personalized PageRank（移植自 AutoEduKG，并提供改进构图与融合）。"""

from __future__ import annotations

from typing import Any

import networkx as nx

RELATION_WEIGHTS = {
    "part_of": 3.0,
    "belong_to": 3.0,
    "depend_on": 2.0,
    "property_of": 1.5,
    "synonym_of": 1.2,
    "related_with": 1.0,
}

# 改进版：弱关系降权
RELATION_WEIGHTS_IMPROVED = {
    "part_of": 3.0,
    "belong_to": 3.0,
    "depend_on": 2.0,
    "property_of": 1.5,
    "synonym_of": 1.2,
    "related_with": 0.25,
}

STRONG_PREDICATES = frozenset({"part_of", "belong_to", "depend_on"})


def load_graph(
    relations: list[dict],
    *,
    relation_weights: dict[str, float] | None = None,
) -> nx.DiGraph:
    """原版构图：边权 = 关系类型权重。"""
    weights = relation_weights or RELATION_WEIGHTS
    G = nx.DiGraph()
    for item in relations:
        subj = item.get("subject")
        obj = item.get("object")
        pred = item.get("predicate", "related_with")
        if not subj or not obj:
            continue
        w = float(weights.get(pred, 1.0))
        if G.has_edge(subj, obj):
            G[subj][obj]["weight"] = max(G[subj][obj].get("weight", 0.0), w)
            G[subj][obj]["predicate"] = pred
        else:
            G.add_edge(subj, obj, weight=w, predicate=pred)
    return G


def load_graph_improved(
    relations: list[dict],
    *,
    relation_weights: dict[str, float] | None = None,
    drop_related_with: bool = False,
    out_degree_beta: float = 0.5,
) -> nx.DiGraph:
    """改进构图：弱关系降权 + 同边取 max + 出度惩罚 w / out^β。"""
    weights = relation_weights or RELATION_WEIGHTS_IMPROVED
    raw = nx.DiGraph()
    for item in relations:
        subj = item.get("subject")
        obj = item.get("object")
        pred = str(item.get("predicate", "related_with"))
        if not subj or not obj:
            continue
        if drop_related_with and pred == "related_with":
            continue
        w = float(weights.get(pred, 0.5))
        conf = item.get("confidence")
        if conf is not None:
            try:
                w *= float(conf)
            except (TypeError, ValueError):
                pass
        if raw.has_edge(subj, obj):
            if w > raw[subj][obj].get("weight", 0.0):
                raw[subj][obj]["weight"] = w
                raw[subj][obj]["predicate"] = pred
        else:
            raw.add_edge(subj, obj, weight=w, predicate=pred)

    G = nx.DiGraph()
    for u, v, data in raw.edges(data=True):
        out_d = max(raw.out_degree(u), 1)
        w = float(data["weight"]) / (out_d**out_degree_beta)
        G.add_edge(u, v, weight=w, predicate=data.get("predicate", "related_with"))
    # 保留孤立点（若 relations 未覆盖）
    G.add_nodes_from(raw.nodes())
    return G


def expand_trust_seeds(
    G: nx.DiGraph,
    seeds: dict[str, float],
    *,
    hops: int = 1,
    decay: float = 0.5,
    strong_only: bool = True,
    direction: str = "out",
) -> dict[str, float]:
    """从 TOC 种子沿强关系扩展（轻量 TrustRank）。

    direction: "out" 仅出边（默认，抑制双向扩散噪声）、"in"、"both"。
    """
    mass = dict(seeds)
    frontier = dict(seeds)
    use_out = direction in {"out", "both"}
    use_in = direction in {"in", "both"}
    for _ in range(max(0, hops)):
        nxt: dict[str, float] = {}
        for u, m in frontier.items():
            if u not in G:
                continue
            if use_out:
                for _, v, data in G.out_edges(u, data=True):
                    pred = data.get("predicate", "")
                    if strong_only and pred not in STRONG_PREDICATES:
                        continue
                    add = m * decay
                    nxt[v] = nxt.get(v, 0.0) + add
                    mass[v] = mass.get(v, 0.0) + add
            if use_in:
                for u2, _, data in G.in_edges(u, data=True):
                    pred = data.get("predicate", "")
                    if strong_only and pred not in STRONG_PREDICATES:
                        continue
                    add = m * decay
                    nxt[u2] = nxt.get(u2, 0.0) + add
                    mass[u2] = mass.get(u2, 0.0) + add
        frontier = nxt
    return mass


def _run_pagerank(
    G: nx.DiGraph,
    scores: dict[str, float],
    *,
    damping: float = 0.85,
) -> dict[str, float]:
    g_nodes = set(G.nodes())
    common = g_nodes.intersection(scores.keys())
    if not common:
        personalization = None
    else:
        personalization = {n: float(scores[n]) for n in common}
    return nx.pagerank(G, alpha=damping, personalization=personalization, weight="weight")


def _fuse_with_kcore(
    G: nx.DiGraph,
    pr_scores: dict[str, float],
    *,
    k_core_weight: float = 0.3,
) -> dict[str, dict[str, float]]:
    g_core = G.copy()
    g_core.remove_edges_from(nx.selfloop_edges(g_core))
    if g_core.number_of_nodes() == 0:
        return {}
    # 无向化做 core，避免有向度定义歧义
    core_numbers = nx.core_number(g_core.to_undirected())
    max_k = max(core_numbers.values()) if core_numbers else 1
    max_pr = max(pr_scores.values()) if pr_scores else 1.0
    pr_w = 1.0 - k_core_weight
    detailed: dict[str, dict[str, float]] = {}
    for node, pr_val in pr_scores.items():
        k_val = float(core_numbers.get(node, 0))
        norm_k = k_val / max_k if max_k > 0 else 0.0
        norm_pr = pr_val / max_pr if max_pr > 0 else 0.0
        final_val = pr_w * norm_pr + k_core_weight * norm_k
        detailed[node] = {
            "final": final_val,
            "pr": pr_val,
            "k_core": k_val,
            "norm_k": norm_k,
            "norm_pr": norm_pr,
        }
    return detailed


def calculate_global_importance(
    G: nx.DiGraph,
    scores: dict[str, float],
    *,
    damping: float = 0.85,
    k_core_weight: float = 0.3,
) -> dict[str, dict[str, float]]:
    """原版：Weighted Biased PageRank + 0.7/0.3 K-Core 融合。"""
    pr_scores = _run_pagerank(G, scores, damping=damping)
    return _fuse_with_kcore(G, pr_scores, k_core_weight=k_core_weight)


def calculate_global_importance_improved(
    G: nx.DiGraph,
    scores: dict[str, float],
    *,
    damping: float = 0.85,
    k_core_weight: float = 0.1,
    trust_hops: int = 1,
    trust_decay: float = 0.5,
    trust_direction: str = "out",
    hub_penalty_gamma: float = 0.15,
) -> dict[str, dict[str, float]]:
    """改进：Trust 扩展种子 + 较低 K-Core 权重 + 轻度 hub 惩罚。"""
    expanded = expand_trust_seeds(
        G,
        scores,
        hops=trust_hops,
        decay=trust_decay,
        direction=trust_direction,
    )
    pr_scores = _run_pagerank(G, expanded, damping=damping)
    detailed = _fuse_with_kcore(G, pr_scores, k_core_weight=k_core_weight)

    if hub_penalty_gamma > 0 and G.number_of_nodes():
        out_degrees = dict(G.out_degree())
        max_out = max(out_degrees.values()) if out_degrees else 1
        max_out = max(max_out, 1)
        for node, data in detailed.items():
            out_n = out_degrees.get(node, 0)
            # related_with 出边占比
            rel_cnt = 0
            total = 0
            for _, _, ed in G.out_edges(node, data=True):
                total += 1
                if ed.get("predicate") == "related_with":
                    rel_cnt += 1
            rel_ratio = (rel_cnt / total) if total else 0.0
            hub = (out_n / max_out) * (0.5 + 0.5 * rel_ratio)
            data["final"] = data["final"] * (1.0 - hub_penalty_gamma * hub)
            data["hub_factor"] = hub
    return detailed


def calculate_chapter_importance(
    G: nx.DiGraph,
    chapter_seeds: dict[str, dict[str, float]],
    *,
    improved: bool = True,
    damping: float = 0.85,
) -> dict[str, dict[str, dict[str, float]]]:
    """分章 Personalized PageRank。"""
    out: dict[str, dict[str, dict[str, float]]] = {}
    for ch, seeds in chapter_seeds.items():
        if improved:
            out[ch] = calculate_global_importance_improved(G, seeds, damping=damping)
        else:
            out[ch] = calculate_global_importance(G, seeds, damping=damping)
    return out


def results_to_sorted_list(detailed: dict[str, dict[str, float]]) -> list[list[Any]]:
    """兼容 entity_sorted.json：[[name, score], ...]。"""
    items = [(n, float(d["final"])) for n, d in detailed.items()]
    items.sort(key=lambda x: x[1], reverse=True)
    return [[n, s] for n, s in items]


# 书名/课程名等跨章元节点：分章展示时降权，避免盖过章内术语
_META_NAME_PREFIXES = (
    "数理逻辑与集合论",
    "离散数学",
    "mathematical logic and set theory",
    "discrete mathematics",
)


def demote_meta_hubs(
    detailed: dict[str, dict[str, float]],
    *,
    factor: float = 0.35,
) -> dict[str, dict[str, float]]:
    """复制并降低书名级 hub 的 final（仅用于分章视图）。"""
    out: dict[str, dict[str, float]] = {}
    for node, data in detailed.items():
        zh = node.split("/")[0].strip().lower()
        full = node.lower()
        is_meta = any(zh == p or full.startswith(p) for p in _META_NAME_PREFIXES)
        if not is_meta:
            # 英文全名匹配
            is_meta = any(p in full for p in _META_NAME_PREFIXES if " " in p)
        row = dict(data)
        if is_meta:
            row["final"] = float(row["final"]) * factor
            row["meta_demoted"] = True
        out[node] = row
    return out
