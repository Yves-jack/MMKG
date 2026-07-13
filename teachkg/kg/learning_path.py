"""学习路径：按 cue 顺序与图谱依赖排序实体。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _load_cues(cues_path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not cues_path.is_file():
        return rows
    for line in cues_path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    rows.sort(key=lambda c: (c.get("lecture_id", 0), c.get("start_sec", 0)))
    return rows


def build_learning_path(
    mmkg: dict[str, Any],
    cues_path: Path | None = None,
    *,
    lecture_id: int | str | None = None,
) -> list[dict[str, Any]]:
    """返回按教学顺序排列的节点列表。"""
    entities = {e.get("id") or e.get("name"): e for e in (mmkg.get("entities") or [])}
    edges = mmkg.get("edges") or []

    cue_order: dict[str, int] = {}
    if cues_path and cues_path.is_file():
        for i, cue in enumerate(_load_cues(cues_path)):
            if lecture_id is not None and str(cue.get("lecture_id")) != str(lecture_id):
                continue
            cue_order[str(cue.get("cue_id", ""))] = i

    def entity_rank(eid: str) -> tuple[int, str]:
        ent = entities.get(eid, {})
        grounding = ent.get("grounding") or {}
        cid = str(grounding.get("cue_id") or "")
        return (cue_order.get(cid, 9999), eid)

    prereq: dict[str, set[str]] = {eid: set() for eid in entities}
    for edge in edges:
        rel = edge.get("abstract_relation", "")
        sub, obj = edge.get("subject", ""), edge.get("object", "")
        if rel in ("is_a", "part_of", "prerequisite_of") and sub and obj:
            prereq.setdefault(obj, set()).add(sub)

    ordered: list[str] = []
    seen: set[str] = set()
    visiting: set[str] = set()

    def visit(eid: str) -> None:
        if eid in seen or eid not in entities:
            return
        if eid in visiting:
            return
        visiting.add(eid)
        for p in sorted(prereq.get(eid, []), key=entity_rank):
            visit(p)
        visiting.remove(eid)
        seen.add(eid)
        ordered.append(eid)

    for eid in sorted(entities.keys(), key=entity_rank):
        visit(eid)

    path: list[dict[str, Any]] = []
    for eid in ordered:
        ent = entities[eid]
        path.append(
            {
                "entity_id": eid,
                "name": ent.get("name", eid),
                "description": ent.get("description", ""),
                "grounding": ent.get("grounding"),
            }
        )
    return path
