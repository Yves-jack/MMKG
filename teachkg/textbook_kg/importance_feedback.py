"""课堂最终图谱对教材实体重要性的反向反馈。

v2::
  sig = Σ β_k · norm(channel_k)
  I   = (1-α)·norm(prior) + α·sig   （教材实体）
  I   = clip(σ·sig, I_max_new)      （仅课堂新实体）

通道：mention_time / board_ppt / discourse_role / structure_graph / app_feedback(预留)
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from teachkg.textbook_kg.chapter_map import (
    blend_global_and_chapter,
    blend_multi_chapter_scores,
    entity_matches_chapters,
    entity_prefers_other_chapter,
)


def _zh(name: str) -> str:
    return (name or "").split("/")[0].strip()


def _normalize(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    vals = list(scores.values())
    lo, hi = min(vals), max(vals)
    if hi <= lo:
        return {k: 0.5 for k in scores}
    return {k: (v - lo) / (hi - lo) for k, v in scores.items()}


# 默认词表：教学元话语（课程无关）；书名等课程专有项由 yaml 覆盖/追加
_DEFAULT_INVALID = frozenset(
    {
        "未知",
        "unknown",
        "null",
        "none",
        "n/a",
        "na",
        "实体",
        "entity",
        "无",
        "空",
    }
)

# 整词精确匹配降权，避免误伤「合式公式」等复合名
_DEFAULT_GENERIC = frozenset(
    {
        "公式",
        "证明",
        "前提",
        "结论",
        "定义",
        "概念",
        "方法",
        "问题",
        "例子",
        "习题",
        "内容",
        "知识点",
        "主语",
        "语句",
        "句子",
        "解释",
        "计算",
        "未知",
        # 跨课常见元话语（复合名如「实验设计」「排序算法」不受影响）
        "步骤",
        "示例",
        "实验",
        "作业",
        "考试",
        "课件",
        "幻灯片",
        "PPT",
        "ppt",
    }
)

_DEFAULT_META = frozenset()  # 书名 / 课名由配置注入，保持默认课程无关


@dataclass
class EntityWeightPolicy:
    """实体卫生与降权策略（可配置，默认偏教学通用）。"""

    invalid: frozenset[str] = field(default_factory=lambda: frozenset(_DEFAULT_INVALID))
    generic: frozenset[str] = field(default_factory=lambda: frozenset(_DEFAULT_GENERIC))
    meta: frozenset[str] = field(default_factory=lambda: frozenset(_DEFAULT_META))
    generic_weight: float = 0.25
    meta_weight: float = 0.35
    # 极短名软降权（默认关闭：0）；集合/关系等 2 字章主题不宜默认惩罚
    short_name_max_len: int = 0
    short_name_weight: float = 0.55


_POLICY = EntityWeightPolicy()


def get_entity_weight_policy() -> EntityWeightPolicy:
    return _POLICY


def configure_entity_weights(cfg: dict[str, Any] | None = None) -> EntityWeightPolicy:
    """从 importance_feedback 配置段装载策略；缺省保留教学通用默认。"""
    global _POLICY
    raw = cfg or {}

    def _set(key: str, default: frozenset[str]) -> frozenset[str]:
        vals = raw.get(key)
        if vals is None:
            return frozenset(default)
        if not isinstance(vals, (list, tuple, set, frozenset)):
            return frozenset(default)
        cleaned = {str(x).strip().lower() for x in vals if str(x).strip()}
        # 配置为全量替换；空列表表示关闭该类降权
        return frozenset(cleaned)

    # replace_* : true 时用配置替换默认；false/缺省则与默认并集（便于课名追加）
    replace_generic = bool(raw.get("replace_generic_entities", False))
    replace_meta = bool(raw.get("replace_meta_titles", True))  # 书名默认以配置为准
    replace_invalid = bool(raw.get("replace_invalid_entities", False))

    generic_cfg = _set("generic_entities", _DEFAULT_GENERIC)
    meta_cfg = _set("meta_titles", _DEFAULT_META)
    invalid_cfg = _set("invalid_entities", _DEFAULT_INVALID)

    generic = generic_cfg if replace_generic else frozenset(_DEFAULT_GENERIC) | generic_cfg
    meta = meta_cfg if replace_meta else frozenset(_DEFAULT_META) | meta_cfg
    invalid = invalid_cfg if replace_invalid else frozenset(_DEFAULT_INVALID) | invalid_cfg

    # 配置里的原文大小写也保留一份（中文无关）；上面 lower 便于英文
    def _surface(key: str, base: frozenset[str]) -> frozenset[str]:
        vals = raw.get(key)
        if not isinstance(vals, (list, tuple, set, frozenset)):
            return base
        return frozenset({str(x).strip() for x in vals if str(x).strip()}) | base

    generic = _surface("generic_entities", generic)
    meta = _surface("meta_titles", meta)
    invalid = _surface("invalid_entities", invalid)

    _POLICY = EntityWeightPolicy(
        invalid=invalid,
        generic=generic,
        meta=meta,
        generic_weight=float(raw.get("generic_weight", 0.25)),
        meta_weight=float(raw.get("meta_weight", 0.35)),
        short_name_max_len=int(raw.get("short_name_max_len", 0) or 0),
        short_name_weight=float(raw.get("short_name_weight", 0.55)),
    )
    return _POLICY


def is_invalid_entity(name: str) -> bool:
    zh = _zh(name).lower().strip()
    if not zh:
        return True
    if zh in {x.lower() for x in _POLICY.invalid} or _zh(name) in _POLICY.invalid:
        return True
    if re.fullmatch(r"[\?\*_\-\.]+", zh):
        return True
    return False


def entity_weight_multiplier(name: str) -> float:
    """对泛化词 / 书名 hub / 可选短名返回 <1 的乘数。"""
    zh = _zh(name)
    zh_l = zh.lower()
    if zh in _POLICY.generic or zh_l in {x.lower() for x in _POLICY.generic}:
        return float(_POLICY.generic_weight)
    meta_l = {x.lower() for x in _POLICY.meta}
    if zh in _POLICY.meta or zh_l in meta_l:
        return float(_POLICY.meta_weight)
    for m in _POLICY.meta:
        ml = m.lower()
        if len(ml) > 4 and (zh_l == ml or zh_l.startswith(ml) or ml in zh_l):
            return float(_POLICY.meta_weight)
    if _POLICY.short_name_max_len > 0 and len(zh) <= _POLICY.short_name_max_len:
        return float(_POLICY.short_name_weight)
    return 1.0


def apply_entity_weights(scores: dict[str, float]) -> dict[str, float]:
    out: dict[str, float] = {}
    for n, v in scores.items():
        if is_invalid_entity(n):
            continue
        out[n] = float(v) * entity_weight_multiplier(n)
    return out


def boost_chapter_entities(
    prior: dict[str, float],
    chapter: str | None,
    *,
    boost: float = 1.35,
    top_k: int = 80,
) -> dict[str, float]:
    """对章标题关键词命中、以及章先验头部实体加权。"""
    if not chapter or boost <= 1.0:
        return dict(prior)
    out = dict(prior)
    bare = re.sub(r"^第\s*\d+\s*章\s*", "", chapter).strip()
    keys = [bare] if bare else []
    keys.extend(re.split(r"[与和及、,，/\s]+", bare))
    keys = [k for k in keys if len(k) >= 2]

    # 头部实体
    top = {n for n, _ in sorted(prior.items(), key=lambda x: -x[1])[:top_k]}
    for n in list(out.keys()):
        zh = _zh(n)
        hit = n in top
        if not hit:
            for k in keys:
                if k and (k in zh or zh in k):
                    hit = True
                    break
        if hit:
            out[n] = out[n] * boost
    return out


def load_textbook_importance(
    path: Path,
    *,
    chapter: str | None = None,
) -> dict[str, float]:
    """读取重要性：支持 entity_sorted.json / importance_bundle.json。"""
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, float] = {}

    if isinstance(raw, dict) and ("global" in raw or "by_chapter" in raw):
        rows = raw.get("global") or []
        if chapter:
            by_ch = raw.get("by_chapter") or {}
            key = chapter.strip()
            if key in by_ch:
                rows = by_ch[key]
            else:
                for ch, ch_rows in by_ch.items():
                    if key in ch or ch in key:
                        rows = ch_rows
                        break
        for item in rows:
            if isinstance(item, list) and len(item) >= 2:
                out[str(item[0])] = float(item[1])
        return out

    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, list) and len(item) >= 2:
                out[str(item[0])] = float(item[1])
            elif isinstance(item, dict):
                name = str(item.get("name") or item.get("entity") or item.get("node") or "")
                if name:
                    out[name] = float(item.get("importance") or item.get("score") or 0)
    elif isinstance(raw, dict):
        for name, score in raw.items():
            if isinstance(score, (int, float)):
                out[str(name)] = float(score)
    return out


def apply_lecture_idf(
    scores: dict[str, float],
    lecture_df: dict[str, int] | None,
    n_lectures: int,
    *,
    idf_power: float = 1.0,
    protect: set[str] | None = None,
) -> dict[str, float]:
    """跨讲次 IDF：在多讲出现的实体课堂信号被压低（课程无关）。

    主章先验头部 / 章题命中实体跳过 IDF，避免把章主题词（跨讲常见）误压下去。
    """
    if not scores or not lecture_df or n_lectures <= 1 or idf_power <= 0:
        return dict(scores)
    protect = set(protect or ())
    out: dict[str, float] = {}
    for n, v in scores.items():
        if n in protect:
            out[n] = float(v)
            continue
        df = max(1, int(lecture_df.get(n, 1)))
        # smooth IDF
        idf = math.log1p(n_lectures / df)
        out[n] = float(v) * (idf**idf_power)
    return out


def build_lecture_df(triplets: Iterable[dict[str, Any]]) -> tuple[dict[str, int], int]:
    """实体 → 出现过的讲次数；返回 (df, n_lectures)。"""
    lec_ents: dict[str, set[str]] = defaultdict(set)
    for t in triplets:
        lid = str(t.get("lecture_id") or "").strip() or "_none"
        for key in ("subject", "object", "head", "tail"):
            name = t.get(key)
            if name and not is_invalid_entity(str(name)):
                lec_ents[lid].add(str(name))
    df: dict[str, int] = defaultdict(int)
    for ents in lec_ents.values():
        for e in ents:
            df[e] += 1
    return dict(df), max(1, len(lec_ents))


def adaptive_alpha(
    base_alpha: float,
    prior: dict[str, float],
    classroom: dict[str, float],
    *,
    top_k: int = 20,
    alpha_min: float | None = None,
    alpha_max: float | None = None,
    scope_to_classroom: bool = True,
) -> tuple[float, float]:
    """先验 Top 与课堂 Top 的 Jaccard → α；用 sqrt 缓和过低重合。

    默认先把先验限制在「本讲课堂出现过的实体」上再取 Top，
    避免拿全书/整章先验头部去和课堂头部比（论域不同，Jaccard 会系统性偏低）。
    """
    base = min(1.0, max(0.0, float(base_alpha)))
    amin = 0.28 if alpha_min is None else float(alpha_min)
    amax = base if alpha_max is None else float(alpha_max)
    amin, amax = min(amin, amax), max(amin, amax)
    if not prior or not classroom:
        return base, 0.0

    if scope_to_classroom:
        # 同一论域：只在本讲课堂实体上看先验相对排序
        scoped_prior = {n: float(prior.get(n, 0.0)) for n in classroom}
    else:
        scoped_prior = dict(prior)

    k = max(1, min(int(top_k), len(scoped_prior), len(classroom)))
    top_p = {n for n, _ in sorted(scoped_prior.items(), key=lambda x: -x[1])[:k]}
    top_c = {n for n, _ in sorted(classroom.items(), key=lambda x: -x[1])[:k]}
    union = top_p | top_c
    if not union:
        return base, 0.0
    j = len(top_p & top_c) / len(union)
    # 课堂头部有多少落在（同论域）先验头部
    recall = len(top_p & top_c) / max(1, len(top_c))
    mix = 0.5 * j + 0.5 * recall
    soft = math.sqrt(max(0.0, mix))
    alpha = amin + (amax - amin) * soft
    return alpha, j


def apply_off_chapter_penalty(
    scores: dict[str, float],
    chapters: list[str],
    *,
    prior_top: set[str] | None = None,
    primary_chapter_top: set[str] | None = None,
    chapter_order: list[str] | None = None,
    penalty: float = 0.55,
) -> dict[str, float]:
    """章外实体软衰减。

    保护：主章先验头部 ∪ 章标题关键词命中。
    主章先验头部优先于多章混合头部，减少次章污染。
    若实体明显更贴合目录中其他章，则不保护并加重衰减。
    """
    if not chapters or penalty >= 0.999:
        return dict(scores)
    protect = set(primary_chapter_top or ())
    # 章外判定以主章标题为主
    primary = chapters[0] if chapters else ""
    check_chapters = [primary] if primary else chapters
    order = list(chapter_order or [])
    out: dict[str, float] = {}
    for n, v in scores.items():
        prefers_other = bool(
            primary and order and entity_prefers_other_chapter(n, primary, order)
        )
        if prefers_other:
            out[n] = v * min(penalty, 0.35)
            continue
        if n in protect or entity_matches_chapters(n, check_chapters):
            out[n] = v
        else:
            # 若只因次章关键词命中，仍轻罚
            if len(chapters) > 1 and entity_matches_chapters(n, chapters[1:]):
                out[n] = v * min(1.0, penalty + 0.15)
            else:
                out[n] = v * penalty
    return out


def cap_secondary_chapter_weights(
    chapter_weights: list[tuple[str, float]],
    *,
    secondary_cap: float = 0.25,
) -> list[tuple[str, float]]:
    """限制次章权重上限，主章保底（通用，防次章污染）。"""
    if len(chapter_weights) <= 1:
        return list(chapter_weights)
    primary, pw = chapter_weights[0]
    rest = chapter_weights[1:]
    rest_w = sum(w for _, w in rest)
    if rest_w <= secondary_cap + 1e-9:
        # 仍保证主章 >= 1-cap
        total = pw + rest_w
        if total <= 0:
            return [(primary, 1.0)]
        return [(primary, pw / total)] + [(c, w / total) for c, w in rest]
    # 压缩次章总和到 secondary_cap
    scale = secondary_cap / rest_w
    primary_w = 1.0 - secondary_cap
    return [(primary, primary_w)] + [(c, w * scale) for c, w in rest]


def load_importance_prior(
    textbook_dir: Path,
    *,
    importance_file: str = "entity_sorted_ppr.json",
    bundle_file: str = "importance_bundle.json",
    chapter: str | None = None,
    chapters: list[tuple[str, float]] | None = None,
    chapter_mix: float = 0.7,
    chapter_boost: float = 1.35,
) -> tuple[dict[str, float], dict[str, Any]]:
    """加载教材先验：支持单章或多章加权混合。"""
    chapter_weights = list(chapters or [])
    if not chapter_weights and chapter:
        chapter_weights = [(chapter, 1.0)]

    meta: dict[str, Any] = {
        "chapter": chapter_weights[0][0] if chapter_weights else chapter,
        "chapters": [{"name": c, "weight": round(w, 4)} for c, w in chapter_weights],
        "chapter_mix": chapter_mix,
        "chapter_boost": chapter_boost,
        "source": None,
    }
    bundle_path = textbook_dir / bundle_file
    if bundle_path.is_file():
        raw = json.loads(bundle_path.read_text(encoding="utf-8"))
        global_scores = load_textbook_importance(bundle_path)
        by_ch_raw = raw.get("by_chapter") or {}
        scores_by_chapter: dict[str, dict[str, float]] = {}
        for ch_name, _w in chapter_weights:
            table = load_textbook_importance(bundle_path, chapter=ch_name)
            scores_by_chapter[ch_name] = table

        if chapter_weights and any(scores_by_chapter.values()):
            mixed_ch = blend_multi_chapter_scores(scores_by_chapter, chapter_weights)
            prior = blend_global_and_chapter(
                global_scores, mixed_ch, chapter_mix=chapter_mix
            )
            for ch_name, w in chapter_weights:
                prior = boost_chapter_entities(
                    prior, ch_name, boost=1.0 + (chapter_boost - 1.0) * w
                )
            meta["source"] = "importance_bundle+multi_chapter"
        else:
            prior = apply_entity_weights(global_scores)
            meta["source"] = "importance_bundle/global"
        meta["chapter_order"] = list(raw.get("chapter_order") or [])
        prior = apply_entity_weights(prior)
        return prior, meta

    path = textbook_dir / importance_file
    prior = apply_entity_weights(load_textbook_importance(path))
    meta["source"] = importance_file
    return prior, meta


def classroom_signal_from_triplets(
    triplets: Iterable[dict[str, Any]],
    *,
    use_log_duration: bool = True,
    count_bonus: float = 0.25,
) -> dict[str, float]:
    """兼容旧接口：等价于 mention_time 通道。"""
    from teachkg.textbook_kg.importance_signals import signal_mention_time

    return signal_mention_time(
        list(triplets),
        use_log_duration=use_log_duration,
        count_bonus=count_bonus,
    )


@dataclass
class ImportanceFeedbackResult:
    scores: dict[str, float]
    base_norm: dict[str, float]
    classroom_norm: dict[str, float]
    classroom_raw: dict[str, float]
    alpha: float
    meta: dict[str, Any] = field(default_factory=dict)
    # entity → {prior, mention_time, board_ppt, ...} 对最终分的贡献份额
    contributions: dict[str, dict[str, float]] = field(default_factory=dict)
    channel_weights: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        ranked = sorted(self.scores.items(), key=lambda x: x[1], reverse=True)
        entities: dict[str, Any] = {}
        for name, score in ranked:
            contrib = self.contributions.get(name) or {}
            entities[name] = {
                "score": round(score, 6),
                "contributions": {k: round(float(v), 6) for k, v in contrib.items()},
                "base_norm": round(self.base_norm.get(name, 0.0), 6),
                "classroom_norm": round(self.classroom_norm.get(name, 0.0), 6),
            }
        return {
            "version": 2,
            "alpha": self.alpha,
            "meta": self.meta,
            "channel_weights": self.channel_weights,
            "entity_count": len(self.scores),
            "scores": {k: round(v, 6) for k, v in ranked},
            "entities": entities,
            "top": [
                {
                    "name": name,
                    "zh": _zh(name),
                    "importance": round(score, 6),
                    "base_norm": round(self.base_norm.get(name, 0.0), 6),
                    "classroom_norm": round(self.classroom_norm.get(name, 0.0), 6),
                    "classroom_raw": round(self.classroom_raw.get(name, 0.0), 6),
                    "contributions": {
                        k: round(float(v), 6)
                        for k, v in (self.contributions.get(name) or {}).items()
                    },
                }
                for name, score in ranked[:40]
            ],
        }

    def entity_records(self) -> dict[str, dict[str, Any]]:
        """供 by_context 嵌套存储。"""
        out: dict[str, dict[str, Any]] = {}
        for name, score in self.scores.items():
            out[name] = {
                "score": round(float(score), 6),
                "contributions": {
                    k: round(float(v), 6)
                    for k, v in (self.contributions.get(name) or {}).items()
                },
                "alpha": round(float(self.alpha), 4),
                "chapter_ids": list((self.meta or {}).get("chapters") or []),
            }
        return out


def compute_importance_feedback(
    *,
    textbook_importance: dict[str, float],
    triplets: list[dict[str, Any]],
    alpha: float = 0.45,
    include_classroom_only: bool = True,
    use_log_duration: bool = True,
    classroom_hub_penalty: float = 0.15,
    chapters: list[str] | None = None,
    primary_chapter_top: set[str] | None = None,
    chapter_order: list[str] | None = None,
    off_chapter_penalty: float = 0.45,
    adaptive_alpha_enabled: bool = True,
    adaptive_alpha_min: float = 0.28,
    adaptive_alpha_scope_classroom: bool = True,
    lecture_df: dict[str, int] | None = None,
    n_lectures: int = 1,
    idf_power: float = 1.0,
    meta: dict[str, Any] | None = None,
    channel_weights: dict[str, float] | None = None,
    asset_boost: dict[str, float] | None = None,
    app_feedback_path: Path | None = None,
    new_entity_scale: float = 0.88,
    new_entity_max: float = 0.75,
) -> ImportanceFeedbackResult:
    """融合教材先验与多通道课堂信号（IDF / 自适应 α / 章外衰减 / 贡献拆解）。"""
    from teachkg.textbook_kg.importance_signals import (
        blend_channels,
        compute_channel_signals,
        default_channel_weights,
    )

    textbook_importance = apply_entity_weights(
        {k: v for k, v in textbook_importance.items() if not is_invalid_entity(k)}
    )
    channels = compute_channel_signals(
        triplets,
        use_log_duration=use_log_duration,
        textbook_names=set(textbook_importance),
        asset_boost=asset_boost,
        app_feedback_path=app_feedback_path,
    )
    cw = dict(default_channel_weights())
    if channel_weights:
        cw.update({k: float(v) for k, v in channel_weights.items()})
    classroom_raw, channel_norms = blend_channels(channels, cw)

    chapter_list = [c for c in (chapters or []) if c]
    order = list(chapter_order or [])
    protect_top = set(primary_chapter_top or ())
    if not protect_top:
        protect_top = {
            n for n, _ in sorted(textbook_importance.items(), key=lambda x: -x[1])[:60]
        }
    primary = chapter_list[0] if chapter_list else ""
    if primary and order:
        protect_top = {
            n
            for n in protect_top
            if not entity_prefers_other_chapter(n, primary, order)
        }
    if primary:
        for n in list(classroom_raw):
            if entity_prefers_other_chapter(n, primary, order or chapter_list):
                continue
            if entity_matches_chapters(n, [primary]):
                protect_top.add(n)
                classroom_raw[n] = classroom_raw[n] * 1.12

    classroom_raw = apply_lecture_idf(
        classroom_raw,
        lecture_df,
        n_lectures,
        idf_power=idf_power,
        protect=protect_top,
    )

    if chapter_list and off_chapter_penalty < 0.999:
        classroom_raw = apply_off_chapter_penalty(
            classroom_raw,
            chapter_list,
            primary_chapter_top=protect_top,
            chapter_order=order,
            penalty=off_chapter_penalty,
        )

    base_alpha = min(1.0, max(0.0, float(alpha)))
    jaccard = 1.0
    if adaptive_alpha_enabled:
        alpha, jaccard = adaptive_alpha(
            base_alpha,
            textbook_importance,
            classroom_raw,
            alpha_min=adaptive_alpha_min,
            alpha_max=base_alpha,
            scope_to_classroom=adaptive_alpha_scope_classroom,
        )
    else:
        alpha = base_alpha

    names = set(textbook_importance) | set(classroom_raw)
    if not include_classroom_only:
        names &= set(textbook_importance)

    base = {n: float(textbook_importance.get(n, 0.0)) for n in names}
    for n in names:
        if n not in textbook_importance:
            base[n] = 0.0

    base_norm = _normalize(base)
    class_norm = _normalize(classroom_raw) if classroom_raw else {n: 0.0 for n in names}

    if classroom_hub_penalty > 0 and classroom_raw:
        max_raw = max(classroom_raw.values()) or 1.0
        for n in class_norm:
            hub = classroom_raw.get(n, 0.0) / max_raw
            extra = 0.2 if entity_weight_multiplier(n) < 0.5 else 0.0
            class_norm[n] = class_norm[n] * (
                1.0 - (classroom_hub_penalty + extra) * hub
            )

    # 活跃通道权重（归一化后）供贡献拆解
    active_w = {k: float(v) for k, v in cw.items() if float(v) > 1e-9}
    wsum = sum(active_w.values()) or 1.0
    active_w = {k: v / wsum for k, v in active_w.items()}

    scores: dict[str, float] = {}
    contributions: dict[str, dict[str, float]] = {}
    for n in names:
        b = base_norm.get(n, 0.0)
        c = class_norm.get(n, 0.0)
        ch_parts = channel_norms.get(n) or {}
        if n not in textbook_importance:
            score = min(float(new_entity_max), float(new_entity_scale) * c)
            prior_share = 0.0
            sig_share = score
        else:
            score = (1.0 - alpha) * b + alpha * c
            prior_share = (1.0 - alpha) * b
            sig_share = alpha * c
        score *= entity_weight_multiplier(n)
        scores[n] = score

        contrib: dict[str, float] = {"prior": prior_share * entity_weight_multiplier(n)}
        # 把 sig_share 按通道加权份额拆开
        for k, beta in active_w.items():
            raw_k = float(ch_parts.get(k, 0.0))
            contrib[k] = sig_share * beta * raw_k * entity_weight_multiplier(n)
        # 若合通道为 0，均分
        ch_sum = sum(v for k, v in contrib.items() if k != "prior")
        if sig_share > 1e-9 and ch_sum <= 1e-12:
            for k, beta in active_w.items():
                contrib[k] = sig_share * beta * entity_weight_multiplier(n)
        contributions[n] = contrib

    if chapter_list and off_chapter_penalty < 0.999:
        scores = apply_off_chapter_penalty(
            scores,
            chapter_list,
            primary_chapter_top=protect_top,
            penalty=off_chapter_penalty,
        )

    scores = {k: v for k, v in scores.items() if v > 1e-6 and not is_invalid_entity(k)}
    contributions = {k: contributions[k] for k in scores}

    meta_out = dict(meta or {})
    meta_out["alpha_base"] = base_alpha
    meta_out["alpha_used"] = alpha
    meta_out["prior_classroom_jaccard"] = round(jaccard, 4)
    meta_out["adaptive_alpha_scope_classroom"] = bool(adaptive_alpha_scope_classroom)
    meta_out["chapters"] = chapter_list
    meta_out["idf_power"] = idf_power
    meta_out["n_lectures_idf"] = n_lectures
    meta_out["version"] = 2
    meta_out["channels"] = {
        k: len(v) for k, v in channels.items() if isinstance(v, dict)
    }

    return ImportanceFeedbackResult(
        scores=scores,
        base_norm=base_norm,
        classroom_norm=class_norm,
        classroom_raw=classroom_raw,
        alpha=alpha,
        meta=meta_out,
        contributions=contributions,
        channel_weights=cw,
    )


def merge_lecture_feedbacks(
    lecture_results: list[tuple[ImportanceFeedbackResult, float]],
    *,
    alpha: float | None = None,
) -> ImportanceFeedbackResult:
    """按时长（或权重）合并多讲次反馈 → 整课重要性。"""
    if not lecture_results:
        return ImportanceFeedbackResult({}, {}, {}, {}, alpha=alpha or 0.45, meta={})

    total_w = sum(max(0.0, w) for _, w in lecture_results) or 1.0
    acc: dict[str, float] = defaultdict(float)
    base_acc: dict[str, float] = defaultdict(float)
    class_acc: dict[str, float] = defaultdict(float)
    raw_acc: dict[str, float] = defaultdict(float)
    contrib_acc: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    chapters: list[str] = []
    alphas: list[float] = []
    channel_weights: dict[str, float] = {}

    for result, w in lecture_results:
        ww = max(0.0, w) / total_w
        alphas.append(result.alpha)
        if result.channel_weights and not channel_weights:
            channel_weights = dict(result.channel_weights)
        chs = (result.meta or {}).get("chapters") or []
        if isinstance(chs, list):
            for ch in chs:
                if isinstance(ch, str):
                    chapters.append(ch)
                elif isinstance(ch, dict) and ch.get("name"):
                    chapters.append(str(ch["name"]))
        ch = (result.meta or {}).get("resolved_chapter")
        if ch:
            chapters.append(str(ch))
        for n, s in result.scores.items():
            if is_invalid_entity(n):
                continue
            acc[n] += ww * s
            base_acc[n] += ww * result.base_norm.get(n, 0.0)
            class_acc[n] += ww * result.classroom_norm.get(n, 0.0)
            raw_acc[n] += ww * result.classroom_raw.get(n, 0.0)
            for ck, cv in (result.contributions.get(n) or {}).items():
                contrib_acc[n][ck] += ww * float(cv)

    scores = apply_entity_weights(dict(acc))
    use_alpha = float(alpha if alpha is not None else (sum(alphas) / len(alphas)))
    contributions = {n: dict(parts) for n, parts in contrib_acc.items() if n in scores}
    return ImportanceFeedbackResult(
        scores=scores,
        base_norm=dict(base_acc),
        classroom_norm=dict(class_acc),
        classroom_raw=dict(raw_acc),
        alpha=use_alpha,
        meta={
            "source": "merged_lectures",
            "n_lectures": len(lecture_results),
            "chapters": sorted(set(chapters)),
            "merge": "duration_weighted",
            "version": 2,
        },
        contributions=contributions,
        channel_weights=channel_weights,
    )


def pack_feedback_document(
    *,
    course_scores: ImportanceFeedbackResult,
    by_context: dict[str, ImportanceFeedbackResult],
) -> dict[str, Any]:
    """组装 v2 正式产物：顶层 scores=course，附 by_context。"""
    doc = course_scores.to_dict()
    doc["version"] = 2
    ctx_out: dict[str, Any] = {}
    for key, result in by_context.items():
        ctx_out[key] = {
            "alpha": result.alpha,
            "meta": result.meta,
            "entity_count": len(result.scores),
            "scores": {
                k: round(v, 6)
                for k, v in sorted(result.scores.items(), key=lambda x: -x[1])
            },
            "entities": result.entity_records(),
            "top": result.to_dict().get("top", []),
        }
    doc["by_context"] = ctx_out
    return doc


def importance_of(
    doc: dict[str, Any],
    entity: str,
    context: str = "course",
) -> dict[str, Any]:
    """查询 API：返回 score + contributions。"""
    ctx = (doc.get("by_context") or {}).get(context) or {}
    entities = ctx.get("entities") or {}
    if entity in entities:
        return dict(entities[entity])
    # 中文主名回退
    zh = _zh(entity)
    if zh:
        for name, rec in entities.items():
            if _zh(name) == zh:
                return dict(rec)
    # 回退扁平 scores / entities
    score = (doc.get("scores") or {}).get(entity)
    ent = (doc.get("entities") or {}).get(entity) or {}
    if not ent and zh:
        for name, rec in (doc.get("entities") or {}).items():
            if _zh(name) == zh:
                ent = rec
                break
        if score is None:
            for name, s in (doc.get("scores") or {}).items():
                if _zh(name) == zh:
                    score = s
                    break
    if score is None and not ent:
        return {"score": 0.0, "contributions": {}}
    if ent:
        return dict(ent)
    return {"score": float(score or 0.0), "contributions": {}}


def merge_session_feedback(
    result_a: ImportanceFeedbackResult,
    result_b: ImportanceFeedbackResult,
    *,
    weight_a: float = 1.0,
    weight_b: float = 1.0,
) -> ImportanceFeedbackResult:
    """两讲合成 session 上下文。"""
    return merge_lecture_feedbacks(
        [(result_a, weight_a), (result_b, weight_b)]
    )


def importance_to_node_size(
    importance: float,
    *,
    min_size: float = 10.0,
    max_size: float = 36.0,
) -> float:
    """把 [0,1] 重要性映射为 vis-network 节点半径。"""
    x = min(1.0, max(0.0, float(importance)))
    x = math.sqrt(x)
    return min_size + (max_size - min_size) * x


def save_feedback(path: Path, result: ImportanceFeedbackResult) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(result.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def save_feedback_document(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
