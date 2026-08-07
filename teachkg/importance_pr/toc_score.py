"""目录 TOC → 节点偏置分（移植自 AutoEduKG process_textbook.py，并增加紧匹配版本）。"""

from __future__ import annotations

import re
from typing import Any

from teachkg.textbook_kg.alias import build_alias_map, clean_text, extract_entities_from_text


def clean_toc_line(line: str) -> tuple[str, int, str]:
    """返回 (去编号标题, markdown层级, 原始标题含第N章/节号)。"""
    pattern = re.compile(r"^(#{1,6})\s+(.+)")
    match = re.match(pattern, line)
    if match:
        level = len(match.group(1))
        raw_content = match.group(2).strip()
    else:
        level = 0
        raw_content = line.strip()

    content = re.sub(r"^(?:第\d+章|[\d\.]+)\s*", "", raw_content).strip()
    return content, level, raw_content


def load_toc_structure(md_text: str) -> list[dict[str, Any]]:
    """解析 markdown 目录。level<=2 → major(20)，level>=3 → sub(10)。"""
    toc_items: list[dict[str, Any]] = []
    current_chapter = ""
    for line in md_text.splitlines():
        line = line.strip()
        if not line.startswith("#"):
            continue
        content, level, raw_title = clean_toc_line(line)
        if not content and not raw_title:
            continue
        # 匹配用去编号标题；分章 key 保留「第N章 …」
        match_text = content or raw_title
        if level <= 2:
            item_type = "major"
            score = 20
            current_chapter = raw_title
            chapter_key = raw_title
        elif level >= 3:
            item_type = "sub"
            score = 10
            chapter_key = current_chapter or raw_title
        else:
            continue
        toc_items.append(
            {
                "text": match_text,
                "raw_title": raw_title,
                "cleaned": clean_text(match_text),
                "type": item_type,
                "score": score,
                "level": level,
                "chapter": chapter_key,
            }
        )
    return toc_items


def load_kg_nodes_from_relations(relations: list[dict]) -> list[str]:
    nodes: set[str] = set()
    for item in relations:
        if item.get("subject"):
            nodes.add(str(item["subject"]))
        if item.get("object"):
            nodes.add(str(item["object"]))
    return list(nodes)


def score_nodes_baseline(
    nodes: list[str],
    toc_items: list[dict[str, Any]],
    *,
    threshold: float = 10,
) -> dict[str, float]:
    """原版：实体名分段清洗后，若是 TOC 文案子串则累加分。"""
    node_scores: dict[str, float] = {}
    node_matchers: dict[str, list[str]] = {}
    for node in nodes:
        parts = node.split("/")
        cleaned_parts = [clean_text(p) for p in parts if clean_text(p)]
        node_matchers[node] = cleaned_parts

    for node, match_parts in node_matchers.items():
        if not match_parts:
            continue
        current_score = 0.0
        for item in toc_items:
            toc_clean = item["cleaned"]
            if not toc_clean:
                continue
            matched = False
            for part in match_parts:
                if part.isdigit():
                    continue
                if part in toc_clean:
                    matched = True
                    break
            if matched:
                current_score += float(item["score"])
        if current_score >= threshold:
            node_scores[node] = current_score
    return node_scores


def score_nodes_improved(
    nodes: list[str],
    toc_items: list[dict[str, Any]],
    *,
    threshold: float = 10,
    min_alias_len: int = 2,
) -> dict[str, float]:
    """改进：别名最长/精确匹配 TOC 文本；过滤过短别名；避免纯子串误伤。"""
    alias_map = build_alias_map(nodes)
    # 去掉过短 key，减少噪声
    pruned = {k: v for k, v in alias_map.items() if len(k) >= min_alias_len}
    node_scores: dict[str, float] = {}
    for item in toc_items:
        matched = extract_entities_from_text(item["text"], pruned)
        # 额外：清洗后全等命中
        toc_clean = item["cleaned"]
        if toc_clean and toc_clean in pruned:
            for n in pruned[toc_clean]:
                matched.add(n)
        for node in matched:
            node_scores[node] = node_scores.get(node, 0.0) + float(item["score"])
    return {k: v for k, v in node_scores.items() if v >= threshold}


def chapter_seed_maps(
    nodes: list[str],
    toc_items: list[dict[str, Any]],
    *,
    improved: bool = True,
    threshold: float = 10,
) -> dict[str, dict[str, float]]:
    """按章聚合种子分：key=章节标题。"""
    by_chapter: dict[str, list[dict[str, Any]]] = {}
    for item in toc_items:
        ch = item.get("chapter") or item["text"]
        by_chapter.setdefault(ch, []).append(item)

    result: dict[str, dict[str, float]] = {}
    for ch, items in by_chapter.items():
        if improved:
            scores = score_nodes_improved(nodes, items, threshold=threshold)
        else:
            scores = score_nodes_baseline(nodes, items, threshold=threshold)
        if scores:
            result[ch] = scores
    return result
