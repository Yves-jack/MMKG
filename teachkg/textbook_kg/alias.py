"""实体别名最长匹配（移植 AutoEduKG process_ppt.py）。"""

from __future__ import annotations

import re


def clean_text(text: str) -> str:
    if not text:
        return ""
    lowered = text.lower()
    parts = re.findall(r"[\u4e00-\u9fa5a-z0-9]+", lowered)
    return "".join(parts)


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


def extract_entities_from_text(text: str, alias_map: dict[str, list[str]]) -> set[str]:
    """在文本中找所有 KG 实体（最长 alias 优先，避免短串误匹配）。"""
    clean_target = clean_text(text)
    if not clean_target:
        return set()

    candidates = [alias for alias in alias_map if alias in clean_target]
    candidates.sort(key=len, reverse=True)

    final_aliases: set[str] = set()
    for cand in candidates:
        if any(cand in accepted for accepted in final_aliases):
            continue
        final_aliases.add(cand)

    result: set[str] = set()
    for alias in final_aliases:
        result.update(alias_map[alias])
    return result
