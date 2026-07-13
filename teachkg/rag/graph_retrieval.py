"""图谱多跳邻域扩展。"""

from __future__ import annotations

from collections import deque
from typing import Any


def build_adjacency(edges: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    adj: dict[str, list[dict[str, Any]]] = {}
    for i, edge in enumerate(edges):
        sub = edge.get("subject", "")
        obj = edge.get("object", "")
        item = {"edge_index": i, "edge": edge, "neighbor": obj}
        adj.setdefault(sub, []).append(item)
        rev = {"edge_index": i, "edge": edge, "neighbor": sub, "reverse": True}
        adj.setdefault(obj, []).append(rev)
    return adj


def expand_from_entities(
    mmkg: dict[str, Any],
    seed_entity_ids: list[str],
    *,
    max_hops: int = 1,
    max_edges: int = 10,
) -> list[dict[str, Any]]:
    """从种子实体 BFS 扩展邻边，返回附加 context 条目。"""
    edges = mmkg.get("edges") or []
    adj = build_adjacency(edges)
    entity_map = {e.get("id") or e.get("name"): e for e in (mmkg.get("entities") or [])}

    seen_edges: set[int] = set()
    hits: list[dict[str, Any]] = []
    queue: deque[tuple[str, int]] = deque((eid, 0) for eid in seed_entity_ids if eid)

    while queue and len(hits) < max_edges:
        node, depth = queue.popleft()
        if depth > max_hops:
            continue
        for item in adj.get(node, []):
            ei = item["edge_index"]
            if ei in seen_edges:
                continue
            seen_edges.add(ei)
            edge = item["edge"]
            hits.append(
                {
                    "type": "edge",
                    "id": f"graph:{ei}:{edge.get('subject')}->{edge.get('object')}",
                    "score": 1.0 / (depth + 1),
                    "source": "graph_expand",
                    "text": edge.get("natural_statement") or "",
                    "payload": {
                        "subject": edge.get("subject"),
                        "object": edge.get("object"),
                        "abstract_relation": edge.get("abstract_relation"),
                        "natural_statement": edge.get("natural_statement"),
                        "grounding": edge.get("grounding"),
                    },
                }
            )
            if depth < max_hops:
                queue.append((item["neighbor"], depth + 1))

        ent = entity_map.get(node)
        if ent and depth == 0:
            hits.append(
                {
                    "type": "entity",
                    "id": f"graph:entity:{node}",
                    "score": 1.0,
                    "source": "graph_expand",
                    "text": ent.get("description") or node,
                    "payload": {
                        "entity_id": node,
                        "description": ent.get("description", ""),
                    },
                }
            )

    return hits[:max_edges]


def seed_entities_from_hits(hits: list[dict[str, Any]]) -> list[str]:
    seeds: list[str] = []
    for h in hits:
        if h.get("type") == "entity":
            eid = (h.get("payload") or {}).get("entity_id") or h.get("entity_id")
            if eid:
                seeds.append(str(eid))
        elif h.get("type") == "edge":
            p = h.get("payload") or {}
            if p.get("subject"):
                seeds.append(str(p["subject"]))
            if p.get("object"):
                seeds.append(str(p["object"]))
    return list(dict.fromkeys(seeds))
