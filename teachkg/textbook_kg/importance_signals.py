# -*- coding: utf-8 -*-
"""重要性课堂信号通道（mention / board / discourse / structure / app）。"""

from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

_EXAMPLE_CTX = re.compile(
    r"(例如|比如|举例|如下例|看一个例子|举个例子|取.+为|设.+为|考虑集合)"
)
_DEFINE_CTX = re.compile(
    r"(定义|称为|叫做|是指|形式化|公理|定理|原理|要点|结论是)"
)
_DOMAIN_EXAMPLE = re.compile(r"^(非零|任意|某个|某一|某个具体)")
_CHANNEL_ORDER = (
    "mention_time",
    "board_ppt",
    "discourse_role",
    "structure_graph",
    "app_feedback",
)

# related_with 为双向弱关联：计入结构度，但权重减半；层次向上传递不使用该关系
RELATED_WITH_STRUCTURE_WEIGHT = 0.5


def default_channel_weights() -> dict[str, float]:
    return {
        "mention_time": 0.45,
        "board_ppt": 0.25,
        "discourse_role": 0.20,
        "structure_graph": 0.10,
        "app_feedback": 0.0,
    }


def default_channel_weights_light() -> dict[str, float]:
    """轻量课堂分：提及 + 结构支撑（板书因几乎全覆盖、区分度弱已关掉）。"""
    return {
        "mention_time": 0.75,
        "structure_graph": 0.25,
        "board_ppt": 0.0,
        "discourse_role": 0.0,
        "app_feedback": 0.0,
    }


def compose_fragment_light_score(
    mention: float,
    structure: float,
    *,
    mention_beta: float | None = None,
    structure_beta: float | None = None,
) -> tuple[float, float, float]:
    """轻量课堂分合成：β·log1p(计数)（未做 minmax；便于对照前端）。

    score = 0.75·log1p(m) + 0.25·log1p(s)
    返回 (score, m_part, s_part)。
    """
    cw = default_channel_weights_light()
    m_beta = float(
        mention_beta if mention_beta is not None else (cw.get("mention_time") or 0.75)
    )
    s_beta = float(
        structure_beta
        if structure_beta is not None
        else (cw.get("structure_graph") or 0.25)
    )
    wsum = m_beta + s_beta
    if wsum > 1e-12:
        m_beta, s_beta = m_beta / wsum, s_beta / wsum
    m_part = m_beta * math.log1p(max(0.0, float(mention)))
    s_part = s_beta * math.log1p(max(0.0, float(structure)))
    return m_part + s_part, m_part, s_part


def _normalize(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    vals = list(scores.values())
    lo, hi = min(vals), max(vals)
    if hi <= lo:
        return {k: 0.5 for k in scores}
    return {k: (v - lo) / (hi - lo) for k, v in scores.items()}


def _zh(name: str) -> str:
    return (name or "").split("/", 1)[0].strip()


def _entity_helpers():
    from teachkg.textbook_kg.importance_feedback import (
        entity_weight_multiplier,
        is_invalid_entity,
    )

    return is_invalid_entity, entity_weight_multiplier


def _entity_weight(name: str, *, enabled: bool = True) -> float:
    if not enabled:
        return 1.0
    _, entity_weight_multiplier = _entity_helpers()
    return entity_weight_multiplier(name)


def _endpoints(t: dict[str, Any]) -> list[str]:
    is_invalid_entity, _ = _entity_helpers()
    out: list[str] = []
    for key in ("subject", "object", "head", "tail"):
        n = t.get(key)
        if not n:
            continue
        s = str(n).strip()
        if s and not is_invalid_entity(s):
            out.append(s)
    return out


def _ctx_of(t: dict[str, Any]) -> str:
    return str(
        t.get("context")
        or t.get("source_text")
        or t.get("natural_statement")
        or t.get("raw_asr_text")
        or ""
    )


def _abstract_rel(t: dict[str, Any]) -> str:
    return str(
        t.get("abstract_relation") or t.get("relation") or t.get("label") or ""
    ).split("|")[0].strip().lower()


def _structure_endpoint_weight(t: dict[str, Any]) -> float:
    """结构度边权：related_with=0.5，其余层次/属性边=1。"""
    if _abstract_rel(t) == "related_with":
        return float(RELATED_WITH_STRUCTURE_WEIGHT)
    return 1.0


def cue_position_multiplier(ctx: str) -> float:
    """定义段抬升、纯例子段压低。"""
    if not ctx:
        return 1.0
    m = 1.0
    if _DEFINE_CTX.search(ctx):
        m *= 1.25
    if _EXAMPLE_CTX.search(ctx):
        m *= 0.72
    return m


def _build_mention_vocab(entity_ids: Iterable[str]) -> list[tuple[str, str]]:
    """(匹配串, 规范实体 id)，按匹配串长度降序，便于最长匹配。"""
    is_invalid_entity, _ = _entity_helpers()
    best: dict[str, str] = {}
    for eid in entity_ids:
        n = str(eid or "").strip()
        if not n or is_invalid_entity(n):
            continue
        zh = _zh(n)
        if len(zh) < 2:
            continue
        prev = best.get(zh)
        if prev is None:
            best[zh] = n
            continue
        # 同中文名：优先带英文尾的完整 id
        if "/" in n and "/" not in prev:
            best[zh] = n
        elif len(n) > len(prev):
            best[zh] = n
    return sorted(best.items(), key=lambda x: (-len(x[0]), x[0]))


def longest_match_mentions(text: str, vocab: list[tuple[str, str]]) -> list[str]:
    """在文本上做贪心最长匹配，返回命中的规范实体 id 列表。

    例：文本含「谓词逻辑」时只计「谓词逻辑」，不计其中的「谓词」。
    """
    if not text or not vocab:
        return []
    hits: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        matched = False
        for surface, eid in vocab:
            L = len(surface)
            if L <= 0 or i + L > n:
                continue
            if text[i : i + L] == surface:
                hits.append(eid)
                i += L
                matched = True
                break
        if not matched:
            i += 1
    return hits


def count_entity_mentions(
    triplets: Iterable[dict[str, Any]],
    *,
    extract_text: str | None = None,
) -> dict[str, int]:
    """提及次数：优先对片段最终清洗文本做最长匹配；否则按唯一语境回退端点次数。"""
    trips = list(triplets)
    endpoint_ids: list[str] = []
    for t in trips:
        endpoint_ids.extend(_endpoints(t))
    vocab = _build_mention_vocab(endpoint_ids)

    counts: dict[str, int] = defaultdict(int)
    text = (extract_text or "").strip()
    if text and vocab:
        for eid in longest_match_mentions(text, vocab):
            counts[eid] += 1
        return {k: int(v) for k, v in counts.items() if v > 0}

    text_keys: dict[str, str] = {}
    for t in trips:
        ctx = _ctx_of(t).strip()
        if not ctx:
            continue
        key = str(t.get("cue_id") or "") + "\n" + ctx
        text_keys[key] = ctx

    if text_keys and vocab:
        for ctx in text_keys.values():
            for eid in longest_match_mentions(ctx, vocab):
                counts[eid] += 1
    else:
        for t in trips:
            for n in _endpoints(t):
                counts[n] += 1
    return {k: int(v) for k, v in counts.items() if v > 0}


def count_entity_structure_degree(
    triplets: Iterable[dict[str, Any]],
) -> dict[str, float]:
    """结构支撑有效度：端点加权度数（related_with 计 0.5）。"""
    deg: dict[str, float] = defaultdict(float)
    for t in triplets:
        w = _structure_endpoint_weight(t)
        if w <= 0:
            continue
        for n in _endpoints(t):
            deg[n] += w
    return {k: float(v) for k, v in deg.items() if v > 1e-12}


def compute_classroom_factor_counts(
    triplets: Iterable[dict[str, Any]],
    *,
    extract_text: str | None = None,
) -> dict[str, dict[str, float]]:
    """流水线展示用：实体 → {mention_time, structure_graph}（结构为加权有效度）。

    提及优先用片段最终清洗文本；结构度仍按给定三元组/融合图边。
    """
    mentions = count_entity_mentions(triplets, extract_text=extract_text)
    degrees = count_entity_structure_degree(triplets)
    names = set(mentions) | set(degrees)
    out: dict[str, dict[str, float]] = {}
    for n in names:
        d = float(degrees.get(n, 0.0))
        out[n] = {
            "mention_time": float(int(mentions.get(n, 0))),
            # 保留一位小数，便于侧栏展示 related_with 半权
            "structure_graph": round(d, 1) if abs(d - round(d)) > 1e-9 else float(int(round(d))),
        }
    return out


def compute_fragment_light_importance(
    triplets: Iterable[dict[str, Any]],
    *,
    extract_text: str | None = None,
) -> tuple[
    dict[str, float],
    dict[str, dict[str, float]],
    dict[str, dict[str, float]],
]:
    """片段级轻量课堂分：最终清洗文本提及 + 本段/融合图结构。

    score = 0.75·log1p(提及) + 0.25·log1p(结构)（未做 minmax）
    返回 (scores, contributions, factor_counts)。
    """
    trips = list(triplets)
    if not trips:
        return {}, {}, {}
    counts = compute_classroom_factor_counts(trips, extract_text=extract_text)
    scores: dict[str, float] = {}
    contributions: dict[str, dict[str, float]] = {}
    for n, fc in counts.items():
        m = float(fc.get("mention_time") or 0.0)
        s = float(fc.get("structure_graph") or 0.0)
        if m <= 0 and s <= 0:
            continue
        score, m_part, s_part = compose_fragment_light_score(m, s)
        if score <= 1e-12:
            continue
        scores[n] = score
        contributions[n] = {
            "mention_time": m_part,
            "structure_graph": s_part,
        }
    return scores, contributions, counts


def signal_mention_time(
    triplets: Iterable[dict[str, Any]],
    *,
    use_log_duration: bool = True,  # 保留参数兼容旧调用；已忽略
    count_bonus: float = 0.25,
    use_entity_weights: bool = True,
) -> dict[str, float]:
    """提及次数通道（不再使用 cue 时长）。

    对每条唯一语境文本做实体最长匹配计数；无可用文本时回退为三元组端点次数。
    分数：平均语境权重 × (1+count_bonus) × log1p(次数)。
    """
    del use_log_duration  # 时长口径不可靠，显式丢弃
    trips = list(triplets)

    endpoint_ids: list[str] = []
    for t in trips:
        endpoint_ids.extend(_endpoints(t))
    vocab = _build_mention_vocab(endpoint_ids)

    # cue_id / 文本 → 语境权重；同一文本只扫一次
    text_weight: dict[str, float] = {}
    for t in trips:
        ctx = _ctx_of(t).strip()
        if not ctx:
            continue
        key = str(t.get("cue_id") or "") + "\n" + ctx
        w = cue_position_multiplier(ctx)
        # 同文本取最大语境权重
        text_weight[key] = max(text_weight.get(key, 0.0), w)

    counts: dict[str, int] = defaultdict(int)
    weight_sum: dict[str, float] = defaultdict(float)
    if text_weight and vocab:
        for key, w in text_weight.items():
            text = key.split("\n", 1)[-1]
            for eid in longest_match_mentions(text, vocab):
                counts[eid] += 1
                weight_sum[eid] += w
    else:
        # 无文本：端点精确计数（已是实体 id，不存在子串误匹配）
        for t in trips:
            w = cue_position_multiplier(_ctx_of(t))
            for n in _endpoints(t):
                counts[n] += 1
                weight_sum[n] += w

    out: dict[str, float] = {}
    for n, c in counts.items():
        if c <= 0:
            continue
        avg_w = weight_sum[n] / c if c else 1.0
        out[n] = (
            avg_w
            * (1.0 + count_bonus)
            * math.log1p(c)
            * _entity_weight(n, enabled=use_entity_weights)
        )
    return out


def signal_board_ppt(
    triplets: Iterable[dict[str, Any]],
    *,
    use_entity_weights: bool = True,
) -> dict[str, float]:
    """板书/PPT 证据：有 ppt 帧的三元组端点按次计分（不含时长）。"""
    scores: dict[str, float] = defaultdict(float)
    for t in triplets:
        has_ppt = bool(
            t.get("evidence_ppt_frame_path")
            or t.get("ppt_frame_path")
            or (t.get("evidence_ppt_page_index") is not None)
        )
        if not has_ppt:
            continue
        base = 1.0
        if t.get("evidence_ppt_page_index") is not None:
            base += 0.25
        for n in _endpoints(t):
            scores[n] += base * _entity_weight(n, enabled=use_entity_weights)
    return dict(scores)


def load_asset_concept_boost(assets_path: Path | None) -> dict[str, float]:
    """资产库 concept → boost（theorem/principle/technique）。"""
    if not assets_path or not Path(assets_path).is_file():
        return {}
    raw = json.loads(Path(assets_path).read_text(encoding="utf-8"))
    cards = raw.get("cards") or []
    # 原理 / 定理 / 公式优先抬升；方法次之；例子不抬升
    kind_w = {
        "principle": 1.30,
        "theorem": 1.25,
        "formula": 1.22,
        "technique": 1.15,
    }
    out: dict[str, float] = {}
    for card in cards:
        kind = str(card.get("kind") or "")
        bw = kind_w.get(kind, 1.0)
        if bw <= 1.0:
            continue
        names = [str(card.get("name") or "")]
        names.extend(str(a) for a in (card.get("aliases") or []))
        for link in card.get("concepts") or []:
            if isinstance(link, dict):
                names.append(str(link.get("entity") or ""))
            else:
                names.append(str(link))
        for name in names:
            n = name.strip()
            if not n:
                continue
            out[n] = max(out.get(n, 1.0), bw)
            zh = _zh(n)
            if zh:
                out[zh] = max(out.get(zh, 1.0), bw)
    return out


def signal_discourse_role(
    triplets: Iterable[dict[str, Any]],
    *,
    asset_boost: dict[str, float] | None = None,
    use_entity_weights: bool = True,
) -> dict[str, float]:
    """话语角色：例子/论域实例降权，定义语境与资产概念抬升（按次，不含时长）。"""
    asset_boost = asset_boost or {}
    scores: dict[str, float] = defaultdict(float)
    as_prop_attr: Counter[str] = Counter()
    deg: Counter[str] = Counter()
    as_prop_owner: Counter[str] = Counter()

    trips = list(triplets)
    for t in trips:
        pred = str(t.get("abstract_relation") or "").split("|")[0]
        sub = str(t.get("subject") or "").strip()
        obj = str(t.get("object") or "").strip()
        if sub:
            deg[sub] += 1
            if pred == "property_of":
                as_prop_attr[sub] += 1
        if obj:
            deg[obj] += 1
            if pred == "property_of":
                as_prop_owner[obj] += 1

    for t in trips:
        ctx = _ctx_of(t)
        exampleish = bool(_EXAMPLE_CTX.search(ctx))
        defineish = bool(_DEFINE_CTX.search(ctx))
        for n in _endpoints(t):
            mult = 1.0
            zh = _zh(n)
            if exampleish:
                mult *= 0.55
            if defineish:
                mult *= 1.35
            if _DOMAIN_EXAMPLE.match(zh):
                mult *= 0.4
            if (
                deg[n] <= 3
                and as_prop_attr[n] >= max(1, deg[n] - as_prop_owner[n])
                and as_prop_owner[n] == 0
            ):
                mult *= 0.5
            ab = asset_boost.get(n) or asset_boost.get(zh) or 1.0
            mult *= float(ab)
            scores[n] += mult * _entity_weight(n, enabled=use_entity_weights)
    return dict(scores)


def signal_structure_graph(
    triplets: Iterable[dict[str, Any]],
    *,
    textbook_names: set[str] | None = None,
    use_entity_weights: bool = True,
) -> dict[str, float]:
    """结构支撑：加权度数 + 是否教材实体。

    related_with 为双向弱关联，端点度贡献为 RELATED_WITH_STRUCTURE_WEIGHT（默认 0.5）；
    belong_to / part_of / depend_on / 其他关系仍计 1。层次向上传递不使用 related_with。
    """
    textbook_names = textbook_names or set()
    tb_zh = {_zh(x) for x in textbook_names}
    deg: dict[str, float] = defaultdict(float)
    for t in triplets:
        w = _structure_endpoint_weight(t)
        if w <= 0:
            continue
        for n in _endpoints(t):
            deg[n] += w
    out: dict[str, float] = {}
    for n, d in deg.items():
        score = math.log1p(d)
        if n in textbook_names or _zh(n) in tb_zh:
            score *= 1.35
        else:
            if d <= 1:
                score *= 0.55
            elif d <= 2:
                score *= 0.75
        out[n] = score * _entity_weight(n, enabled=use_entity_weights)
    return out


def load_app_feedback_events(path: Path | None) -> dict[str, float]:
    """第1期：若存在 JSONL 事件则聚合；否则空。"""
    is_invalid_entity, _ = _entity_helpers()
    if not path or not Path(path).is_file():
        return {}
    scores: dict[str, float] = defaultdict(float)
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        ent = str(ev.get("entity") or "").strip()
        if not ent or is_invalid_entity(ent):
            continue
        kind = str(ev.get("kind") or "pin")
        w = float(ev.get("weight") or 1.0)
        if kind in ("miss", "wrong"):
            w *= 1.2
        elif kind == "pin":
            w *= 1.5
        scores[ent] += w
    return dict(scores)


def compute_channel_signals(
    triplets: list[dict[str, Any]],
    *,
    use_log_duration: bool = True,
    textbook_names: set[str] | None = None,
    asset_boost: dict[str, float] | None = None,
    app_feedback_path: Path | None = None,
    use_entity_weights: bool = True,
) -> dict[str, dict[str, float]]:
    return {
        "mention_time": signal_mention_time(
            triplets,
            use_log_duration=use_log_duration,
            use_entity_weights=use_entity_weights,
        ),
        "board_ppt": signal_board_ppt(
            triplets, use_entity_weights=use_entity_weights
        ),
        "discourse_role": signal_discourse_role(
            triplets,
            asset_boost=asset_boost,
            use_entity_weights=use_entity_weights,
        ),
        "structure_graph": signal_structure_graph(
            triplets,
            textbook_names=textbook_names,
            use_entity_weights=use_entity_weights,
        ),
        "app_feedback": load_app_feedback_events(app_feedback_path),
    }


def blend_channels(
    channels: dict[str, dict[str, float]],
    weights: dict[str, float] | None = None,
) -> tuple[dict[str, float], dict[str, dict[str, float]]]:
    """归一化后按 β 加权；返回 (合信号, 每实体各通道 norm 值)。"""
    w = dict(default_channel_weights())
    if weights:
        w.update({k: float(v) for k, v in weights.items()})
    active = {k: v for k, v in w.items() if v > 1e-9 and k in channels}
    total = sum(active.values()) or 1.0
    active = {k: v / total for k, v in active.items()}

    norms = {k: _normalize(channels.get(k) or {}) for k in _CHANNEL_ORDER}
    names: set[str] = set()
    for d in norms.values():
        names |= set(d)

    blended: dict[str, float] = {}
    per_entity: dict[str, dict[str, float]] = {}
    for n in names:
        parts: dict[str, float] = {}
        s = 0.0
        for k, beta in active.items():
            v = float(norms.get(k, {}).get(n, 0.0))
            parts[k] = v
            s += beta * v
        blended[n] = s
        per_entity[n] = parts
    return blended, per_entity
