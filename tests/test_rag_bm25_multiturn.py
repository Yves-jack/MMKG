"""RAG 扩展：BM25 持久化与多轮检索改写测试。"""

import json
from pathlib import Path

import pytest

from teachkg.rag.bm25 import BM25Index, tokenize_for_bm25
from teachkg.rag.multi_turn import (
    analyze_multi_turn_retrieval,
    build_retrieval_query,
    is_followup_question,
)
from teachkg.stage3_mmkg.index_builder import MMKGIndex, build_index_records


HISTORY = [("什么是论域？", "论域是所有个体构成的集合，也称为个体域。")]


def test_bm25_bigram_tokenize():
    tokens = tokenize_for_bm25("个体变项")
    assert "个体" in tokens
    assert "体变" in tokens
    assert "变项" in tokens


def test_bm25_inverted_search_matches_full_score():
    docs = ["命题逻辑是研究命题的", "谓词逻辑扩展命题逻辑", "全称量词表示全部对象"]
    idx = BM25Index(docs)
    full_scores = idx.score("命题逻辑")
    inv_hits = dict(idx.search("命题逻辑", top_k=3))
    for doc_idx, score in inv_hits.items():
        assert score == pytest.approx(full_scores[doc_idx])


def test_bm25_save_load_roundtrip(tmp_path: Path):
    docs = ["论域也称为个体域", "个体变项的变化范围是论域"]
    idx = BM25Index(docs)
    path = tmp_path / "bm25.json"
    idx.save(path)
    loaded = BM25Index.load(path)
    assert loaded.search("论域 个体变项", top_k=2)
    assert loaded.n == 2


def test_mmkg_index_builds_bm25():
    mmkg = {
        "course_id": "c",
        "entities": [{"id": "论域/domain", "name": "论域/domain", "description": "所有个体的集合"}],
        "edges": [
            {
                "subject": "论域/domain",
                "object": "个体变项/individual variable",
                "abstract_relation": "related_with",
                "natural_statement": "论域是个体变项的变化范围",
            }
        ],
    }

    class _HashEmbedder:
        backend = "hash"
        model_name = "hash"
        dim = 8

        def embed(self, texts):
            import numpy as np

            return np.zeros((len(texts), 8), dtype=np.float32)

        def embed_one(self, text):
            import numpy as np

            return np.zeros(8, dtype=np.float32)

    index = MMKGIndex(embedder=_HashEmbedder())
    index.build(mmkg)
    assert index.bm25 is not None
    hits = index.bm25.search("论域", top_k=2)
    assert hits


def test_followup_detection():
    assert is_followup_question("它和个体变项有什么关系？")
    assert is_followup_question("那全称量词呢")


def test_analyze_pronoun_followup():
    a = analyze_multi_turn_retrieval("它和个体变项有什么关系？", HISTORY)
    assert a.use_multi_turn_retrieval is True
    assert "contains_pronoun_or_reference" in a.signals
    assert "论域" in a.retrieval_query


def test_analyze_standalone_no_rewrite():
    a = analyze_multi_turn_retrieval("什么是命题逻辑？", HISTORY)
    assert a.use_multi_turn_retrieval is False
    assert a.retrieval_query == "什么是命题逻辑？"


def test_analyze_explicit_new_topic_no_rewrite():
    a = analyze_multi_turn_retrieval("全称量词和存在量词分别表示什么？", HISTORY)
    assert a.use_multi_turn_retrieval is False
    assert a.score < 2.0


def test_analyze_short_opener_rewrite():
    a = analyze_multi_turn_retrieval("那存在量词呢", HISTORY)
    assert a.use_multi_turn_retrieval is True


def test_analyze_no_history():
    a = analyze_multi_turn_retrieval("什么是论域？", [])
    assert a.use_multi_turn_retrieval is False
    assert "no_history" in a.signals


def test_build_retrieval_query_rewrite():
    q, meta = build_retrieval_query("它和个体变项有什么关系？", HISTORY)
    assert meta["rewritten"] is True
    assert "论域" in q


def test_build_retrieval_query_standalone():
    q, meta = build_retrieval_query("什么是命题逻辑？", [])
    assert q == "什么是命题逻辑？"
    assert meta["rewritten"] is False
