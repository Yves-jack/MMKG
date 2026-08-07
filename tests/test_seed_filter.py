"""种子 LLM 筛选解析单测（不调用真实 LLM）。"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load():
    path = ROOT / "teachkg" / "textbook_kg" / "seed_filter.py"
    spec = importlib.util.spec_from_file_location("seed_filter_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_sf = _load()
format_candidate_seeds = _sf.format_candidate_seeds
format_embedding_seeds = _sf.format_embedding_seeds
parse_keep_list = _sf.parse_keep_list
SeedLLMFilter = _sf.SeedLLMFilter


def test_format_candidate_seeds_marks_source():
    text = format_candidate_seeds(
        {"命题逻辑/propositional logic"},
        {"谓词逻辑的公理化/axiomatization of predicate logic"},
    )
    assert "[alias] 命题逻辑/propositional logic" in text
    assert "[embedding] 谓词逻辑的公理化/axiomatization of predicate logic" in text


def test_format_embedding_seeds_only():
    text = format_embedding_seeds(
        {"谓词逻辑的公理化/axiomatization of predicate logic", "命题演算"}
    )
    assert "谓词逻辑的公理化/axiomatization of predicate logic" in text
    assert "[alias]" not in text
    assert "[embedding]" not in text


def test_parse_keep_list_exact_and_zh():
    allowed = {
        "命题逻辑/propositional logic",
        "谓词逻辑/Predicate Logic",
    }
    raw = '{"keep": ["命题逻辑/propositional logic", "谓词逻辑"], "note": "ok"}'
    kept = parse_keep_list(raw, allowed)
    assert kept == [
        "命题逻辑/propositional logic",
        "谓词逻辑/Predicate Logic",
    ]


def test_parse_keep_list_rejects_unknown():
    allowed = {"命题逻辑/propositional logic"}
    raw = '{"keep": ["不存在的实体/foo", "命题逻辑/propositional logic"]}'
    kept = parse_keep_list(raw, allowed)
    assert kept == ["命题逻辑/propositional logic"]


def test_filter_joint_alias_and_embedding(monkeypatch):
    filt = SeedLLMFilter(enabled=True, min_candidates=1, fallback_keep_all_on_empty=False)
    monkeypatch.setattr(_sf, "format_prompt", lambda *a, **k: "prompt")
    monkeypatch.setattr(
        filt,
        "_ensure_client",
        lambda: type(
            "C",
            (),
            {
                "chat": staticmethod(
                    lambda *_a, **_k: '{"keep": ["跑题概念C"], "note": "仅留向量"}'
                )
            },
        )(),
    )
    out = filt.filter(
        "课堂讲了别名概念A",
        alias_seeds={"别名概念A"},
        embedding_seeds={"向量概念B", "跑题概念C"},
    )
    # 别名不再直通；仅保留 LLM keep
    assert out == {"跑题概念C"}


def test_filter_empty_keeps_none(monkeypatch):
    filt = SeedLLMFilter(enabled=True, fallback_keep_all_on_empty=False)
    monkeypatch.setattr(_sf, "format_prompt", lambda *a, **k: "prompt")
    monkeypatch.setattr(
        filt,
        "_ensure_client",
        lambda: type(
            "C",
            (),
            {"chat": staticmethod(lambda *_a, **_k: '{"keep": [], "note": "无"}')},
        )(),
    )
    out = filt.filter(
        "文本",
        alias_seeds={"别名A"},
        embedding_seeds={"向量B"},
    )
    assert out == set()


def test_filter_alias_only_still_calls_llm(monkeypatch):
    filt = SeedLLMFilter(enabled=True)
    called = {"n": 0}

    def fake_chat(*_a, **_k):
        called["n"] += 1
        return '{"keep": ["别名A"], "note": "ok"}'

    monkeypatch.setattr(_sf, "format_prompt", lambda *a, **k: "prompt")
    monkeypatch.setattr(
        filt,
        "_ensure_client",
        lambda: type("C", (), {"chat": staticmethod(fake_chat)})(),
    )
    out = filt.filter(
        "文本讲别名A",
        alias_seeds={"别名A", "别名B"},
        embedding_seeds=set(),
    )
    assert called["n"] == 1
    assert out == {"别名A"}


def test_embedding_top_k_dynamic():
    from teachkg.textbook_kg.subgraph import count_text_words, embedding_top_k_for_text

    # 50 个汉字 → 50 词 → top_k=2
    text = "谓" * 50
    assert count_text_words(text) == 50
    assert embedding_top_k_for_text(text, words_per_seed=25) == 2
    assert embedding_top_k_for_text(text, words_per_seed=25, max_k=1) == 1
    assert embedding_top_k_for_text("短", words_per_seed=25) == 0
