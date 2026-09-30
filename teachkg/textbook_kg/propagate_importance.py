"""课堂重要性向上传递（与前端 propagateImportance.ts 同源）。

规则（v3）：
- 父边：belong_to / part_of / depend_on（from=子 → to=父）
- 自底向上；子→父贡献 child×RATE/√父数（RATE=0.22）
- 渐近饱和：parent = own + (1-own)·(1-e^(-boost/τ))，τ=0.45
  避免线性累加把枢纽大量顶满到 1.0
"""

from __future__ import annotations

import math
from typing import Any, Iterable

PARENT_RELS = frozenset({"belong_to", "part_of", "depend_on"})

PROPAGATE_RATE = 0.22
PROPAGATE_TAU = 0.45


def _rel(e: dict[str, Any]) -> str:
    return str(
        e.get("abstract_relation") or e.get("relation") or e.get("label") or ""
    ).split("|")[0].strip().lower()


def _ends(e: dict[str, Any]) -> tuple[str, str]:
    frm = str(e.get("from") or e.get("subject") or "").strip()
    to = str(e.get("to") or e.get("object") or "").strip()
    return frm, to


def _merge_boost(own: float, boost: float, tau: float = PROPAGATE_TAU) -> float:
    o = min(1.0, max(0.0, float(own)))
    b = max(0.0, float(boost))
    if b <= 1e-12:
        return o
    t = max(1e-6, float(tau))
    return o + (1.0 - o) * (1.0 - math.exp(-b / t))


def propagate_importance_to_parents(
    scores: dict[str, float],
    edges: Iterable[dict[str, Any]],
    *,
    node_ids: Iterable[str] | None = None,
    rate: float = PROPAGATE_RATE,
    tau: float = PROPAGATE_TAU,
) -> dict[str, float]:
    """以课堂分为初值，自底向上把子节点重要性贡献给父。"""
    ids = set(node_ids) if node_ids is not None else set(scores)
    adj: dict[str, list[str]] = {i: [] for i in ids}
    seen: set[tuple[str, str]] = set()
    for e in edges:
        if _rel(e) not in PARENT_RELS:
            continue
        frm, to = _ends(e)
        if not frm or not to or frm == to:
            continue
        if frm not in ids or to not in ids:
            continue
        key = (frm, to)
        if key in seen:
            continue
        seen.add(key)
        adj[frm].append(to)

    initial = {i: float(scores.get(i) or 0.0) for i in ids}
    if not seen:
        return dict(initial)

    indeg = {i: 0 for i in ids}
    outdeg = {i: len(adj[i]) for i in ids}
    for frm, tos in adj.items():
        for to in tos:
            indeg[to] = indeg.get(to, 0) + 1

    out = dict(initial)
    boost_acc = {i: 0.0 for i in ids}
    remaining = set(ids)
    layer = 0
    r = max(0.0, float(rate))
    while remaining:
        zero = [i for i in remaining if indeg.get(i, 0) == 0]
        if zero:
            seeds = zero
        else:
            min_diff = min((outdeg.get(i, 0) - indeg.get(i, 0)) for i in remaining)
            seeds = [
                i for i in remaining if (outdeg.get(i, 0) - indeg.get(i, 0)) == min_diff
            ]
        if not seeds:
            break

        for i in seeds:
            out[i] = _merge_boost(initial[i], boost_acc[i], tau)

        snap = {i: out[i] for i in seeds}
        for i in seeds:
            imp = snap.get(i) or 0.0
            parents = adj.get(i) or []
            if imp > 0 and r > 0 and parents:
                share = (imp * r) / math.sqrt(len(parents))
                for parent in parents:
                    if parent in ids:
                        boost_acc[parent] = boost_acc.get(parent, 0.0) + share
            remaining.discard(i)
        for i in seeds:
            for parent in adj.get(i) or []:
                if parent in remaining:
                    indeg[parent] = max(0, indeg.get(parent, 0) - 1)
        layer += 1
        if layer > len(ids) + 2:
            break

    for i in ids:
        out[i] = _merge_boost(initial[i], boost_acc[i], tau)

    return {k: min(1.0, max(0.0, float(v))) for k, v in out.items()}
