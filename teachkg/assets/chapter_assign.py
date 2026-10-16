"""资产卡 → 章归属：讲次候选章 + 嵌入相似度。"""

from __future__ import annotations

import logging
import re
from typing import Any

import numpy as np

from teachkg.assets.schema import AssetCard
from teachkg.stage3_mmkg.text_embedder import TextEmbedder
from teachkg.textbook_kg.chapter_map import (
    _parse_map_value,
    chapter_keywords,
    resolve_lecture_chapters,
    score_chapter_against_text,
)

logger = logging.getLogger(__name__)


def _card_text(card: AssetCard) -> str:
    parts = [
        card.name or "",
        card.summary or "",
        card.statement or "",
        card.evidence or "",
        card.latex or "",
        " ".join(card.steps or []),
        " ".join(c.entity for c in (card.concepts or [])),
    ]
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def _chapter_profile(
    chapter: str,
    *,
    chapter_entities: dict[str, list[str]] | None = None,
) -> str:
    bare = re.sub(r"^第\s*\d+\s*章\s*", "", chapter).strip()
    keys = chapter_keywords(chapter)
    ents = (chapter_entities or {}).get(chapter) or []
    # 章侧表示：标题 + 关键词 + 章内实体（截断）
    ent_blob = " ".join(ents[:40])
    return f"{chapter}。主题：{bare}。关键词：{' '.join(keys)}。概念：{ent_blob}"


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na < 1e-8 or nb < 1e-8:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _candidate_chapters_for_lecture(
    lecture_id: str | None,
    *,
    chapter_order: list[str],
    lecture_chapter_map: dict[str, Any],
    top_k: int = 3,
) -> list[str]:
    lid = str(lecture_id or "").strip()
    if not lid:
        return list(chapter_order[:top_k]) if chapter_order else []
    mapped = _parse_map_value(lecture_chapter_map.get(lid))
    if not mapped and lid.startswith("lecture_"):
        mapped = _parse_map_value(lecture_chapter_map.get(lid.replace("lecture_", "", 1)))
    out: list[str] = []
    for key in mapped:
        # 精确或模糊对齐 chapter_order
        if key in chapter_order:
            out.append(key)
            continue
        hit = next((c for c in chapter_order if key in c or c in key), None)
        out.append(hit or key)
    if out:
        return out[: max(top_k, len(out))]
    # 无映射时退回文本推断（空 blob → 空）
    ranked = resolve_lecture_chapters(
        lid,
        chapter_order=chapter_order,
        lecture_chapter_map=lecture_chapter_map,
        top_k=top_k,
    )
    return [c for c, _ in ranked] or list(chapter_order[:1])


def assign_card_chapters(
    cards: list[AssetCard],
    *,
    chapter_order: list[str],
    lecture_chapter_map: dict[str, Any],
    embedder: TextEmbedder | None = None,
    chapter_entities: dict[str, list[str]] | None = None,
    top_k: int = 2,
    min_sim: float = 0.28,
    secondary_margin: float = 0.06,
    keyword_blend: float = 0.25,
    model_name: str = "shibing624/text2vec-base-multilingual",
) -> dict[str, Any]:
    """就地写入 card.chapters，返回统计。"""
    if not cards:
        return {"cards": 0, "assigned": 0, "backend": "none"}

    emb = embedder or TextEmbedder(model_name=model_name)
    # 预计算所有候选章向量（课程章全集）
    chapter_texts = {
        ch: _chapter_profile(ch, chapter_entities=chapter_entities) for ch in chapter_order
    }
    ch_list = list(chapter_texts.keys())
    ch_vecs = emb.embed([chapter_texts[c] for c in ch_list]) if ch_list else np.zeros((0, 1))
    ch_index = {c: i for i, c in enumerate(ch_list)}

    card_texts = [_card_text(c) or (c.name or c.asset_id or "asset") for c in cards]
    card_vecs = emb.embed(card_texts)

    assigned = 0
    multi = 0
    for card, vec, text in zip(cards, card_vecs, card_texts):
        lid = card.grounding.lecture_id if card.grounding else None
        cands = _candidate_chapters_for_lecture(
            lid,
            chapter_order=chapter_order,
            lecture_chapter_map=lecture_chapter_map,
            top_k=max(3, top_k + 1),
        )
        if not cands:
            cands = list(chapter_order[:1])
        scored: list[tuple[str, float]] = []
        for ch in cands:
            i = ch_index.get(ch)
            if i is None:
                # 映射章不在 order 里：只靠关键词
                sim = 0.0
            else:
                sim = _cosine(vec, ch_vecs[i])
            kw = score_chapter_against_text(ch, text)
            # 关键词归一到约 0–1，再与嵌入混合
            kw_n = min(1.0, kw / 8.0)
            score = (1.0 - keyword_blend) * sim + keyword_blend * kw_n
            scored.append((ch, score))
        scored.sort(key=lambda x: x[1], reverse=True)
        if not scored:
            card.chapters = []
            continue

        primary, best = scored[0]
        # 映射首项保底：若嵌入分接近，优先 yaml 主章
        mapped = _candidate_chapters_for_lecture(
            lid,
            chapter_order=chapter_order,
            lecture_chapter_map=lecture_chapter_map,
            top_k=1,
        )
        if mapped and mapped[0] != primary:
            map_score = next((s for c, s in scored if c == mapped[0]), 0.0)
            if map_score + 0.04 >= best:
                primary, best = mapped[0], map_score
                scored = [(primary, best)] + [(c, s) for c, s in scored if c != primary]

        picked: list[dict[str, Any]] = []
        if best >= min_sim or mapped:
            picked.append({"name": primary, "weight": float(best), "role": "primary"})
        for ch, s in scored[1:]:
            if len(picked) >= top_k:
                break
            if s < min_sim:
                continue
            if best - s > secondary_margin * 3 and s < best - secondary_margin:
                # 与主章差距过大则不挂次章
                if s < best - 0.12:
                    continue
            if s < best - secondary_margin and len(picked) >= 1:
                # 仍可挂，但要求相对接近
                if s / max(best, 1e-6) < 0.82:
                    continue
            picked.append({"name": ch, "weight": float(s), "role": "secondary"})

        # 权重归一，并保证 primary 权重最高（映射保底时可能略低于次章原文分）
        if picked:
            max_w = max(float(p["weight"]) for p in picked)
            for p in picked:
                if p.get("role") == "primary" and float(p["weight"]) < max_w:
                    p["weight"] = max_w + 1e-3
            total = sum(float(p["weight"]) for p in picked) or 1.0
            for p in picked:
                p["weight"] = round(float(p["weight"]) / total, 4)
            # 按权重重排角色
            picked.sort(key=lambda x: float(x["weight"]), reverse=True)
            for i, p in enumerate(picked):
                p["role"] = "primary" if i == 0 else "secondary"

        card.chapters = picked
        if picked:
            assigned += 1
        if len(picked) > 1:
            multi += 1

    return {
        "cards": len(cards),
        "assigned": assigned,
        "multi_chapter": multi,
        "backend": emb.backend,
        "model": emb.model_name,
    }
