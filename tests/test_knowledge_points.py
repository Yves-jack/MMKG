"""知识点提取解析单测（不调用真实 LLM）。"""

from __future__ import annotations

from teachkg.stage1_alignment.knowledge_points import (
    format_knowledge_points,
    normalize_related_knowledge_points,
    parse_knowledge_points,
)


def test_parse_knowledge_points_json():
    raw = '{"knowledge_points": ["谓词", "个体", "谓词"], "note": "ok"}'
    assert parse_knowledge_points(raw) == ["谓词", "个体"]


def test_format_knowledge_points():
    assert "1. 谓词" in format_knowledge_points(["谓词", "个体"])
    assert format_knowledge_points([]) == "(无)"


def test_normalize_related_maps_to_allowed():
    allowed = ["谓词逻辑", "个体词"]
    got = normalize_related_knowledge_points(["谓词逻辑", "编造概念", "个体"], allowed)
    assert got == ["谓词逻辑", "个体词"]
