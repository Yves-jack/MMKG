"""原文重叠度：用于资产 evidence ↔ 实体相关文本 关联。"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Iterable


_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[，。！？、；：\"\"''（）()\[\]【】《》<>·•…\-—_/\\|,.!?;:\"']+")


def normalize_text(text: str) -> str:
    t = (text or "").strip().lower()
    t = _WS_RE.sub("", t)
    t = _PUNCT_RE.sub("", t)
    return t


def char_ngrams(text: str, n: int = 2) -> set[str]:
    s = normalize_text(text)
    if len(s) < n:
        return {s} if s else set()
    return {s[i : i + n] for i in range(len(s) - n + 1)}


def overlap_ratio(a: str, b: str, *, n: int = 2) -> float:
    """字符 n-gram Jaccard；范围 [0,1]。"""
    A, B = char_ngrams(a, n=n), char_ngrams(b, n=n)
    if not A or not B:
        return 0.0
    inter = len(A & B)
    if not inter:
        return 0.0
    return inter / len(A | B)


def containment_ratio(needle: str, haystack: str) -> float:
    """needle 的 bigram 有多少落在 haystack 中（偏 evidence⊆实体语料）。"""
    N, H = char_ngrams(needle), char_ngrams(haystack)
    if not N:
        return 0.0
    return len(N & H) / len(N)


def primary_zh(name: str) -> str:
    return (name or "").split("/", 1)[0].strip()


def score_evidence_to_entity(
    evidence: str,
    entity_name: str,
    entity_texts: Iterable[str],
    *,
    name_boost: float = 0.35,
) -> float:
    """综合：名称命中加分 + evidence 与实体语料重叠 / 包含度。"""
    ev = (evidence or "").strip()
    if not ev:
        return 0.0
    zh = primary_zh(entity_name)
    score = 0.0
    if zh and zh in ev:
        score += name_boost
    corpus = "。".join(
        t for t in [entity_name, zh, *[str(x or "").strip() for x in entity_texts]] if t
    )
    if not corpus.strip():
        return score
    # 取 Jaccard 与 containment 的较大者，避免短 evidence 被稀释
    j = overlap_ratio(ev, corpus)
    c = containment_ratio(ev, corpus)
    score += max(j, c * 0.85)
    return min(score, 1.0)


def build_entity_text_index(
    entities: list[dict],
    edges: list[dict],
) -> dict[str, list[str]]:
    """entity 全名 → 相关原文片段（边 context / description / provenance）。"""
    names: set[str] = set()
    for ent in entities:
        name = str(ent.get("name") or ent.get("id") or "").strip()
        if name:
            names.add(name)
    index: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        sub = str(e.get("subject") or e.get("from") or "").strip()
        obj = str(e.get("object") or e.get("to") or "").strip()
        texts: list[str] = []
        for key in ("description", "natural_statement", "context"):
            v = str(e.get(key) or "").strip()
            if v:
                texts.append(v)
        for prov in e.get("provenance") or []:
            if not isinstance(prov, dict):
                continue
            for key in ("context", "source_text"):
                v = str(prov.get(key) or "").strip()
                if v:
                    # source_text 可能很长，截断参与重叠
                    texts.append(v if len(v) <= 240 else v[:240])
        for endpoint in (sub, obj):
            if endpoint in names or endpoint:
                if endpoint not in names and endpoint:
                    names.add(endpoint)
                index[endpoint].extend(texts)
    # 去重保序
    return {k: list(dict.fromkeys(v)) for k, v in index.items()}


def link_entities_by_overlap(
    evidence: str,
    entity_texts: dict[str, list[str]],
    *,
    min_score: float = 0.12,
    top_k: int = 4,
) -> list[tuple[str, float]]:
    """返回 (entity, score) 降序。"""
    scored: list[tuple[str, float]] = []
    for name, texts in entity_texts.items():
        s = score_evidence_to_entity(evidence, name, texts)
        if s >= min_score:
            scored.append((name, s))
    scored.sort(key=lambda x: (-x[1], x[0]))
    return scored[:top_k]
