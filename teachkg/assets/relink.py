"""把公式 / 例子挂回讲次抽象层：名称优先，拒绝占位实体与同讲误挂。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from teachkg.assets.overlap import (
    build_entity_text_index,
    primary_zh,
    score_evidence_to_entity,
)
from teachkg.assets.schema import AssetCard, AssetConceptLink, AssetEdgeLink
from teachkg.stage1_alignment.triplet_extract import is_placeholder_entity
from teachkg.textbook_kg.importance_feedback import is_invalid_entity

# 课程/学科 hub：仅当名称里直接出现才保留
_HUB = frozenset(
    {
        "图论",
        "理论",
        "化学",
        "陆地",
        "方法性强",
        "算法",
        "离散数学",
        "数理逻辑",
        "集合论",
        "Graph Theory",
    }
)
_SKIP_PIECE = frozenset({"的例子", "示例", "应用", "表示", "公式", "约定", "记号", "条件", "基本形式"})
_TREE_REL = frozenset({"belong_to", "part_of", "depend_on"})


def _haystack(card: AssetCard) -> str:
    return " ".join(
        x
        for x in (
            primary_zh(card.name),
            card.name,
            card.summary,
            card.latex,
            card.statement,
        )
        if x
    )


def _role(card: AssetCard) -> str:
    if card.kind == "example":
        return "illustrates"
    zh = primary_zh(card.name)
    if re.search(r"(记号|约定)", zh):
        return "notation_of"
    return "about"


def _drop_subsumed(ranked: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """有「一元谓词」时丢掉更泛的「谓词」。"""
    keep: list[tuple[str, float]] = []
    zhs = [(primary_zh(n), n, s) for n, s in ranked]
    for i, (za, na, sa) in enumerate(zhs):
        if any(
            za
            and zb != za
            and za in zb
            and len(za) >= 2
            for j, (zb, _nb, _sb) in enumerate(zhs)
            if i != j
        ):
            continue
        keep.append((na, sa))
    return keep


def score_card_entity(
    card: AssetCard,
    entity_name: str,
    entity_texts: list[str],
) -> float:
    if is_placeholder_entity(entity_name) or is_invalid_entity(entity_name):
        return 0.0
    zh = primary_zh(entity_name)
    if not zh or len(zh) < 2:
        return 0.0
    hay = _haystack(card)
    card_zh = primary_zh(card.name)
    name_hit = zh in hay
    if not name_hit:
        for run in re.findall(r"[\u4e00-\u9fff]{3,}", card_zh):
            hit = False
            for length in range(min(6, len(run)), 2, -1):
                for i in range(0, len(run) - length + 1):
                    piece = run[i : i + length]
                    if piece in _SKIP_PIECE:
                        continue
                    if length == 3 and piece.endswith("谓词"):
                        continue
                    if piece in zh:
                        name_hit = True
                        hit = True
                        break
                if hit:
                    break
            if name_hit:
                break
    if not name_hit:
        return 0.0
    score = 0.85 if zh in primary_zh(card.name) else 0.55
    ov = score_evidence_to_entity(card.evidence or hay, entity_name, entity_texts)
    score += min(0.15, ov * 0.25)
    if zh in _HUB and zh not in primary_zh(card.name):
        score *= 0.4
    return score


def relink_cards(
    cards: list[AssetCard],
    entities: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    *,
    top_k: int = 2,
    min_score: float = 0.45,
) -> int:
    """就地改 concepts / edges。返回成功挂上概念的卡片数。"""
    names = [
        str(e.get("id") or e.get("name") or "").strip()
        for e in entities
        if str(e.get("id") or e.get("name") or "").strip()
    ]
    texts = build_entity_text_index(entities, edges)
    pair_rel: dict[tuple[str, str], str] = {}
    for e in edges:
        rel = str(e.get("abstract_relation") or e.get("relation") or "").strip()
        if rel not in _TREE_REL:
            continue
        s = str(e.get("subject") or e.get("from") or "").strip()
        o = str(e.get("object") or e.get("to") or "").strip()
        if s and o:
            pair_rel[(s, o)] = rel

    linked = 0
    for card in cards:
        if card.kind not in {"formula", "example"}:
            continue
        scored: list[tuple[str, float]] = []
        for name in names:
            s = score_card_entity(card, name, texts.get(name) or [])
            if s >= min_score:
                scored.append((name, s))
        scored.sort(key=lambda x: (-x[1], x[0]))
        ranked = _drop_subsumed(scored)[:top_k]
        role = _role(card)
        card.concepts = [AssetConceptLink(entity=n, role=role) for n, _ in ranked]
        spo: list[AssetEdgeLink] = []
        ents = [c.entity for c in card.concepts]
        for a in ents:
            for b in ents:
                if a == b:
                    continue
                rel = pair_rel.get((a, b))
                if rel:
                    spo.append(
                        AssetEdgeLink(
                            subject=a,
                            predicate=rel,
                            object=b,
                            role=role,
                        )
                    )
        card.edges = spo[:3]
        if card.concepts:
            linked += 1
    return linked


def relink_library_cards(
    cards: list[AssetCard],
    kg_dir: Path,
    course_id: str,
) -> int:
    """按 grounding.lecture_id 分组，用对应讲次 kg.json 重挂。"""
    from collections import defaultdict

    groups: dict[str, list[AssetCard]] = defaultdict(list)
    for card in cards:
        if card.kind not in {"formula", "example"}:
            continue
        lid = ""
        if card.grounding and card.grounding.lecture_id:
            lid = str(card.grounding.lecture_id)
        if lid:
            groups[lid].append(card)
    n = 0
    for lid, group in groups.items():
        path = Path(kg_dir) / course_id / f"lecture_{lid}" / "kg.json"
        if not path.is_file():
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        ents = [e for e in (raw.get("entities") or []) if isinstance(e, dict)]
        edges = [e for e in (raw.get("edges") or []) if isinstance(e, dict)]
        n += relink_cards(group, ents, edges)
    return n
