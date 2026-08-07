"""边 LLM 筛选解析单测（不调用真实 LLM）。"""

from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class _Rel:
    subject: str
    predicate: str
    object: str
    description: str = ""
    context: str = ""
    classroom_evidence: str = ""


def _load_edge_filter():
    if "teachkg.textbook_kg.loader" not in sys.modules:
        fake = type(sys)("teachkg.textbook_kg.loader")
        fake.TextbookRelation = _Rel  # type: ignore[attr-defined]
        sys.modules["teachkg.textbook_kg.loader"] = fake

    # dataclasses.replace 需要真正的 dataclass；用本地 _Rel
    name = "edge_filter_under_test_v2"
    if name in sys.modules:
        del sys.modules[name]
    path = ROOT / "teachkg" / "textbook_kg" / "edge_filter.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _rel(s: str, p: str, o: str, description: str = ""):
    return _Rel(subject=s, predicate=p, object=o, description=description)


def test_parse_keep_edges_by_index():
    ef = _load_edge_filter()
    cands = [
        _rel("A/a", "belong_to", "B/b"),
        _rel("C/c", "part_of", "D/d"),
        _rel("E/e", "depend_on", "F/f"),
    ]
    raw = '{"keep": [1, 3], "note": "ok"}'
    kept = ef.parse_keep_edges(raw, cands)
    assert [(r.subject, r.predicate, r.object) for r in kept] == [
        ("A/a", "belong_to", "B/b"),
        ("E/e", "depend_on", "F/f"),
    ]


def test_parse_keep_edges_rejects_unknown_index():
    ef = _load_edge_filter()
    cands = [_rel("A/a", "belong_to", "B/b")]
    raw = '{"keep": [1, 9]}'
    kept = ef.parse_keep_edges(raw, cands)
    assert len(kept) == 1


def test_format_candidate_edges_includes_clipped_description():
    ef = _load_edge_filter()
    long_desc = "甲" * 80
    text = ef.format_candidate_edges(
        [
            _rel("谓词/predicate", "part_of", "谓词逻辑/Predicate Logic", long_desc),
            _rel("A/a", "belong_to", "B/b", ""),
        ],
        description_max_chars=60,
    )
    assert "1. 谓词/predicate —[part_of]→ 谓词逻辑/Predicate Logic" in text
    assert "描述:" in text
    assert "…" in text
    assert "2. A/a —[belong_to]→ B/b" in text
    assert text.count("描述:") == 1
    assert ef._clip_text("  a   b  ", 10) == "a b"


def test_require_evidence_drops_index_only():
    ef = _load_edge_filter()
    cands = [
        _rel("A/a", "belong_to", "B/b"),
        _rel("C/c", "part_of", "D/d"),
    ]
    src = "全称肯定命题属于 AEIO 命题的一种。"
    raw = '{"keep": [1, 2], "note": "no evidence"}'
    kept = ef.parse_keep_edges(
        raw,
        cands,
        extract_text=src,
        require_classroom_evidence=True,
    )
    assert kept == []


def test_require_evidence_keeps_valid_quote():
    ef = _load_edge_filter()
    cands = [
        _rel("全称肯定命题/x", "belong_to", "AEIO命题/y"),
        _rel("C/c", "part_of", "D/d"),
    ]
    src = "接下来介绍四种标准翻译形式，称为AEIO命题。A：全称肯定命题。"
    raw = json_dumps_keep(
        [{"i": 1, "evidence": "称为AEIO命题。A：全称肯定命题"}]
    )
    kept = ef.parse_keep_edges(
        raw,
        cands,
        extract_text=src,
        require_classroom_evidence=True,
    )
    assert len(kept) == 1
    assert kept[0].subject.startswith("全称肯定")
    assert "AEIO" in kept[0].classroom_evidence
    assert kept[0].context == kept[0].classroom_evidence


def test_require_evidence_rejects_fabricated_quote():
    ef = _load_edge_filter()
    cands = [_rel("A/a", "belong_to", "B/b")]
    src = "课堂上讲了合取与析取。"
    raw = '{"keep": [{"i": 1, "evidence": "这是编造的依据不在原文"}]}'
    kept = ef.parse_keep_edges(
        raw,
        cands,
        extract_text=src,
        require_classroom_evidence=True,
    )
    assert kept == []


def json_dumps_keep(items):
    import json

    return json.dumps({"keep": items, "note": "ok"}, ensure_ascii=False)
