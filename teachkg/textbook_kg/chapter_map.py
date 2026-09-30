"""讲次 / 文本 → 教材章节映射（课程无关：基于目录标题与文本重合打分）。"""

from __future__ import annotations

import re
from typing import Any, Iterable

from teachkg.textbook_kg.alias import clean_text


def _zh(name: str) -> str:
    return (name or "").split("/")[0].strip()


def chapter_keywords(chapter_title: str) -> list[str]:
    """从「第N章 标题」抽出可匹配关键词。"""
    title = (chapter_title or "").strip()
    title = re.sub(r"^第\s*\d+\s*章\s*", "", title).strip()
    parts = re.split(r"[与和及、,，/\s]+", title)
    keys = []
    for p in parts:
        p = p.strip()
        if len(p) >= 2:
            keys.append(p)
    if title and title not in keys:
        keys.insert(0, title)
    return keys


def score_chapter_against_text(chapter_title: str, text: str) -> float:
    """目录章标题 vs 文本重合分（短标题降权，避免「函数/集合/关系」误触发）。"""
    blob = clean_text(text)
    if not blob:
        return 0.0
    score = 0.0
    bare = re.sub(r"^第\s*\d+\s*章\s*", "", chapter_title).strip()
    bare_c = clean_text(bare)
    if bare_c and bare_c in blob:
        # 短章名（≤2 字）弱证据；长标题强证据
        score += 1.2 if len(bare_c) <= 2 else 5.0
    for kw in chapter_keywords(chapter_title):
        kc = clean_text(kw)
        if not kc or kc not in blob:
            continue
        if len(kc) <= 2:
            score += 0.35
        else:
            score += 1.0 + 0.2 * min(len(kc), 12)
    m = re.search(r"第\s*(\d+)\s*章", chapter_title)
    if m and f"第{m.group(1)}章" in text:
        score += 8.0
    return score


def rank_chapters(
    text: str,
    chapter_order: list[str],
) -> list[tuple[str, float]]:
    """返回 [(章名, 分)] 降序。"""
    scored = [(ch, score_chapter_against_text(ch, text)) for ch in chapter_order]
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored


def select_top_chapters(
    ranked: list[tuple[str, float]],
    *,
    top_k: int = 2,
    min_score: float = 2.0,
    min_ratio: float = 0.35,
) -> list[tuple[str, float]]:
    """通用多章选取：保留 top_k，且相对最高分不低于 min_ratio。"""
    if not ranked:
        return []
    best = ranked[0][1]
    if best < min_score:
        return []
    picked: list[tuple[str, float]] = []
    for ch, s in ranked[: max(1, top_k)]:
        if s < min_score and picked:
            break
        if picked and best > 0 and s / best < min_ratio:
            break
        picked.append((ch, s))
    total = sum(max(0.0, s) for _, s in picked) or 1.0
    return [(ch, s / total) for ch, s in picked]


def _parse_map_value(value: Any) -> list[str]:
    """yaml 映射值：str | list[str] | 'a|b'。"""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    text = str(value).strip()
    if not text:
        return []
    if "|" in text:
        return [p.strip() for p in text.split("|") if p.strip()]
    return [text]


def _lecture_blob(
    lecture_id: str,
    cues: list[dict[str, Any]] | None,
    triplets: list[dict[str, Any]] | None,
) -> str:
    lid = str(lecture_id or "").strip()
    parts: list[str] = []
    if cues:
        for c in cues:
            if lid and str(c.get("lecture_id", "")) not in {lid, f"lecture_{lid}"}:
                continue
            parts.append(str(c.get("asr_text") or c.get("text") or ""))
    if triplets:
        for t in triplets:
            if lid and str(t.get("lecture_id", "")) not in {lid, f"lecture_{lid}"}:
                continue
            for k in ("subject", "object", "head", "tail", "context", "description"):
                v = t.get(k)
                if v:
                    parts.append(
                        _zh(str(v)) if k in {"subject", "object", "head", "tail"} else str(v)
                    )
    return " ".join(parts)


def infer_chapter_from_text(
    text: str,
    chapter_order: list[str],
    *,
    min_score: float = 2.0,
) -> str | None:
    ranked = rank_chapters(text, chapter_order)
    if not ranked or ranked[0][1] < min_score:
        return None
    return ranked[0][0]


def infer_chapter_from_triplets(
    triplets: Iterable[dict[str, Any]],
    chapter_order: list[str],
    *,
    min_score: float = 3.0,
) -> str | None:
    parts: list[str] = []
    for t in triplets:
        for k in ("subject", "object", "head", "tail", "context", "description"):
            v = t.get(k)
            if v:
                parts.append(_zh(str(v)) if k in {"subject", "object", "head", "tail"} else str(v))
    return infer_chapter_from_text(" ".join(parts), chapter_order, min_score=min_score)


def resolve_lecture_chapters(
    lecture_id: str | int | None,
    *,
    chapter_order: list[str],
    lecture_chapter_map: dict[str, Any] | None = None,
    cues: list[dict[str, Any]] | None = None,
    triplets: list[dict[str, Any]] | None = None,
    top_k: int = 2,
    min_score: float = 2.0,
    min_ratio: float = 0.45,
    map_boost: float = 20.0,
) -> list[tuple[str, float]]:
    """通用：文本打分 + 可选 yaml 加权 → 多章权重（和为 1）。

    次章必须有足够「纯文本分」（不含 map_boost），避免短章名蹭分。
    """
    lid = str(lecture_id or "").strip()
    blob = _lecture_blob(lid, cues, triplets)
    text_ranked = rank_chapters(blob, chapter_order) if blob else []
    text_scores = {ch: s for ch, s in text_ranked}

    mapping = {str(k): v for k, v in (lecture_chapter_map or {}).items()}
    raw_keys: list[str] = []
    if lid in mapping:
        raw_keys = _parse_map_value(mapping[lid])
    elif lid.startswith("lecture_"):
        short = lid.replace("lecture_", "", 1)
        if short in mapping:
            raw_keys = _parse_map_value(mapping[short])

    mapped_chapters: list[str] = []
    for key in raw_keys:
        ch = _match_chapter_key(key, chapter_order) or key
        mapped_chapters.append(ch)

    combined = dict(text_scores)
    for ch in mapped_chapters:
        combined[ch] = combined.get(ch, 0.0) + map_boost

    ranked = sorted(combined.items(), key=lambda x: x[1], reverse=True)
    if not ranked:
        return []

    # 有 yaml 映射时：主章固定为映射首项（课程表优先于 ASR 噪声）
    if mapped_chapters:
        primary = mapped_chapters[0]
        primary_s = combined.get(primary, map_boost)
        picked: list[tuple[str, float]] = [(primary, primary_s)]
        # 映射中的其余章按 yaml 顺序填满 top_k（不再只取一个次章）
        for ch in mapped_chapters[1:]:
            if ch == primary or any(ch == p for p, _ in picked):
                continue
            picked.append((ch, combined.get(ch, map_boost * 0.5)))
            if len(picked) >= top_k:
                break
        if len(picked) < top_k:
            primary_text = text_scores.get(primary, 0.0)
            for ch, s in ranked:
                if ch == primary or any(ch == p for p, _ in picked):
                    continue
                text_s = text_scores.get(ch, 0.0)
                if text_s < max(min_score, 2.5):
                    continue
                ref = max(primary_text, 1e-6)
                if primary_text > 0 and text_s / ref < min_ratio:
                    continue
                # 拒绝过短章名作为「推断」次章（映射显式列出的除外）
                bare = re.sub(r"^第\s*\d+\s*章\s*", "", ch).strip()
                if len(clean_text(bare)) <= 2:
                    continue
                picked.append((ch, s))
                break
    else:
        primary, primary_s = ranked[0]
        if primary_s < min_score:
            return []
        picked = [(primary, primary_s)]
        if top_k >= 2:
            primary_text = text_scores.get(primary, 0.0)
            for ch, s in ranked[1:]:
                text_s = text_scores.get(ch, 0.0)
                if text_s < max(min_score, 2.5):
                    continue
                ref = max(primary_text, 1e-6)
                if text_s / ref < min_ratio:
                    continue
                bare = re.sub(r"^第\s*\d+\s*章\s*", "", ch).strip()
                if len(clean_text(bare)) <= 2:
                    continue
                picked.append((ch, s))
                break

    total = sum(max(0.0, s) for _, s in picked) or 1.0
    weights = [(ch, s / total) for ch, s in picked[:top_k]]
    # yaml 主章权重保底，避免次章文本分虚高反超
    if mapped_chapters and len(weights) >= 2 and weights[0][0] == mapped_chapters[0]:
        if weights[0][1] < 0.55:
            rest = 1.0 - 0.6
            other = weights[1:]
            other_sum = sum(w for _, w in other) or 1.0
            weights = [(weights[0][0], 0.6)] + [
                (c, rest * (w / other_sum)) for c, w in other
            ]
    return weights


def resolve_lecture_chapter(
    lecture_id: str | int | None,
    *,
    chapter_order: list[str],
    lecture_chapter_map: dict[str, Any] | None = None,
    cues: list[dict[str, Any]] | None = None,
    triplets: list[dict[str, Any]] | None = None,
) -> str | None:
    """兼容旧接口：返回权重最高的单章。"""
    chapters = resolve_lecture_chapters(
        lecture_id,
        chapter_order=chapter_order,
        lecture_chapter_map=lecture_chapter_map,
        cues=cues,
        triplets=triplets,
        top_k=1,
    )
    return chapters[0][0] if chapters else None


def _match_chapter_key(key: str, chapter_order: list[str]) -> str | None:
    key = (key or "").strip()
    if not key:
        return None
    if key in chapter_order:
        return key
    for ch in chapter_order:
        if key in ch or ch in key:
            return ch
    m = re.search(r"第\s*(\d+)\s*章", key)
    if m:
        for ch in chapter_order:
            if re.search(rf"第\s*{m.group(1)}\s*章", ch):
                return ch
    return None


def blend_global_and_chapter(
    global_scores: dict[str, float],
    chapter_scores: dict[str, float] | None,
    *,
    chapter_mix: float = 0.7,
) -> dict[str, float]:
    m = min(1.0, max(0.0, float(chapter_mix)))
    if not chapter_scores:
        return dict(global_scores)
    names = set(global_scores) | set(chapter_scores)
    out: dict[str, float] = {}
    for n in names:
        g = float(global_scores.get(n, 0.0))
        c = float(chapter_scores.get(n, 0.0))
        out[n] = (1.0 - m) * g + m * c
    return out


def blend_multi_chapter_scores(
    scores_by_chapter: dict[str, dict[str, float]],
    chapter_weights: list[tuple[str, float]],
) -> dict[str, float]:
    """按章权重混合多章重要性表。"""
    if not chapter_weights:
        return {}
    out: dict[str, float] = {}
    for ch, w in chapter_weights:
        table = scores_by_chapter.get(ch) or {}
        for n, s in table.items():
            out[n] = out.get(n, 0.0) + float(w) * float(s)
    return out


def entity_matches_chapters(name: str, chapters: list[str]) -> bool:
    """实体中文名是否命中任一章标题关键词。"""
    zh = _zh(name)
    if not zh or not chapters:
        return False
    zh_c = clean_text(zh)
    for ch in chapters:
        for kw in chapter_keywords(ch):
            kc = clean_text(kw)
            if kc and (kc in zh_c or zh_c in kc):
                return True
        bare = re.sub(r"^第\s*\d+\s*章\s*", "", ch).strip()
        bc = clean_text(bare)
        if bc and (bc in zh_c or zh_c in bc):
            return True
    return False


def entity_chapter_affinity(name: str, chapter_title: str) -> float:
    """实体与单章标题的亲和度（越长关键词命中分越高；课程无关）。"""
    zh_c = clean_text(_zh(name))
    if not zh_c or not chapter_title:
        return 0.0
    best = 0.0
    for kw in chapter_keywords(chapter_title):
        kc = clean_text(kw)
        if not kc:
            continue
        if zh_c == kc:
            best = max(best, 20.0 + len(kc))
        elif kc in zh_c or zh_c in kc:
            best = max(best, float(len(min(zh_c, kc, key=len))))
    return best


def entity_prefers_other_chapter(
    name: str,
    primary_chapter: str,
    chapter_order: list[str],
    *,
    margin: float = 1.0,
) -> bool:
    """若实体明显更贴合目录中另一章，则视为章外（抑制跨章 hub）。

    短实体（≤2 字）多为跨章基础词（如「集合」「关系」），不做他章偏好判定。
    """
    if not primary_chapter or not chapter_order:
        return False
    zh_c = clean_text(_zh(name))
    if not zh_c or len(zh_c) <= 2:
        return False
    primary_score = entity_chapter_affinity(name, primary_chapter)
    for ch in chapter_order:
        if ch == primary_chapter:
            continue
        other = entity_chapter_affinity(name, ch)
        if other > primary_score + margin:
            return True
    return False


def suggest_lecture_chapter_map(
    lecture_ids: list[str],
    *,
    chapter_order: list[str],
    cues_by_lecture: dict[str, list[dict[str, Any]]],
    triplets_by_lecture: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """批量为讲次建议章节（可含多章）。"""
    out: dict[str, Any] = {}
    trips = triplets_by_lecture or {}
    for lid in lecture_ids:
        chapters = resolve_lecture_chapters(
            lid,
            chapter_order=chapter_order,
            cues=cues_by_lecture.get(lid, []),
            triplets=trips.get(lid, []),
        )
        if not chapters:
            continue
        if len(chapters) == 1:
            out[lid] = chapters[0][0]
        else:
            out[lid] = [ch for ch, _ in chapters]
    return out
