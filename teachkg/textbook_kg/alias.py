"""实体别名匹配（移植 AutoEduKG process_ppt.py）。

默认全匹配：文本中出现的长短别名对应实体均保留为种子，
不再因长串覆盖而丢弃短实体。
"""

from __future__ import annotations

import re

# 极易误触发的泛化/单义模糊别名（不应单独作为子图种子）
# 核心术语如「命题/集合/函数」保留；噪声主要来自口语短词与元话语
_WEAK_ALIASES = frozenset(
    {
        "上",
        "真",
        "假",
        "点",
        "势",
        "域",
        "核",
        "补",
        "象",
        "迹",
        "逆",
        "链",
        "项",
        "计算",
        "证明",
        "定义",
        "概念",
        "方法",
        "数学",
        "解释",
        "前提",
        "不确定",
        "ON",
        "on",
    }
)


def clean_text(text: str) -> str:
    if not text:
        return ""
    lowered = text.lower()
    parts = re.findall(r"[\u4e00-\u9fa5a-z0-9]+", lowered)
    return "".join(parts)


def is_weak_alias(alias: str) -> bool:
    """短串或泛化别名：匹配噪声高，不适合单独锚定种子。"""
    if not alias:
        return True
    if len(alias) < 2:
        return True
    if alias in _WEAK_ALIASES:
        return True
    if len(alias) <= 2 and re.fullmatch(r"[a-z0-9]+", alias):
        return True
    return False


def build_alias_map(entity_names: list[str]) -> dict[str, list[str]]:
    """Cleaned alias -> canonical entity names."""
    alias_map: dict[str, list[str]] = {}
    for node in entity_names:
        for part in node.split("/"):
            clean_p = clean_text(part)
            if not clean_p:
                continue
            if clean_p.isdigit():
                continue
            # 丢弃单字与极短 ASCII，降低「上/真/点」类误命中
            if len(clean_p) < 2:
                continue
            if len(clean_p) < 2 and re.match(r"^[a-z0-9]+$", clean_p):
                continue
            alias_map.setdefault(clean_p, [])
            if node not in alias_map[clean_p]:
                alias_map[clean_p].append(node)

        full_clean = clean_text(node)
        if full_clean and len(full_clean) >= 2:
            alias_map.setdefault(full_clean, [])
            if node not in alias_map[full_clean]:
                alias_map[full_clean].append(node)
    return alias_map


# 清洗后文本里，这些短语中的短别名属于口语而非术语（如「没关系」含「关系」）
_FALSE_POSITIVE_SPANS = (
    "没关系",
    "有关系",
    "没关系吧",
    "真的假的",
    "对吧",
    "好的",
)


def _mask_false_positive_spans(clean_target: str) -> str:
    masked = clean_target
    for span in _FALSE_POSITIVE_SPANS:
        token = clean_text(span)
        if token:
            masked = masked.replace(token, "")
    return masked


def extract_entity_matches(
    text: str,
    alias_map: dict[str, list[str]],
    *,
    allow_weak: bool = False,
    prefer_longest_only: bool = False,
) -> dict[str, int]:
    """返回实体 -> 命中的最长 alias 长度；默认忽略弱别名。

    prefer_longest_only=False（默认）：长短别名全保留。
    prefer_longest_only=True：短别名若被更长已选别名包含则丢弃。
    """
    clean_target = _mask_false_positive_spans(clean_text(text))
    if not clean_target:
        return {}

    candidates = [alias for alias in alias_map if alias in clean_target]
    candidates.sort(key=len, reverse=True)

    final_aliases: set[str] = set()
    for cand in candidates:
        if prefer_longest_only and any(cand in accepted for accepted in final_aliases):
            continue
        final_aliases.add(cand)

    if not allow_weak:
        strong = {a for a in final_aliases if not is_weak_alias(a)}
        # 质量优先：无强别名则空，避免泛化词拖出大子图
        final_aliases = strong

    best: dict[str, int] = {}
    for alias in final_aliases:
        for name in alias_map.get(alias, []):
            prev = best.get(name, 0)
            if len(alias) > prev:
                best[name] = len(alias)
    return best


def extract_entities_from_text(
    text: str,
    alias_map: dict[str, list[str]],
    *,
    allow_weak: bool = False,
    prefer_longest_only: bool = False,
) -> set[str]:
    """在文本中找所有 KG 实体；默认长短别名全保留。"""
    return set(
        extract_entity_matches(
            text,
            alias_map,
            allow_weak=allow_weak,
            prefer_longest_only=prefer_longest_only,
        )
    )
