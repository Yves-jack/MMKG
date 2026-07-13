import json
from pathlib import Path

import numpy as np
import pytest

from teachkg.quality.triplet_analysis import analyze_triplets, build_quality_report
from teachkg.rag.bm25 import BM25Index
from teachkg.rag.graph_retrieval import expand_from_entities
from teachkg.rag.hybrid_retriever import hybrid_search
from teachkg.rag.mmkg_rag import infer_lecture_hint
from teachkg.stage3_mmkg.index_builder import MMKGIndex, build_index_records
from teachkg.kg.learning_path import build_learning_path


def test_analyze_triplets_stats():
    rows = [
        {"lecture_id": 1, "cue_id": "c1", "subject": "A", "object": "B", "abstract_relation": "is_a"},
        {"lecture_id": 1, "cue_id": "c1", "subject": "B", "object": "C", "abstract_relation": "related_with"},
    ]
    stats = analyze_triplets(rows)
    assert stats["total"] == 2
    assert stats["unique_entities"] == 3
    assert stats["related_with_ratio"] == 0.5


def test_bm25_search():
    idx = BM25Index(["命题逻辑是研究命题及其推理", "谓词逻辑扩展了命题逻辑"])
    hits = idx.search("命题逻辑", top_k=2)
    assert hits
    assert hits[0][1] > 0


def test_graph_expand():
    mmkg = {
        "entities": [{"id": "A"}, {"id": "B"}, {"id": "C"}],
        "edges": [
            {"subject": "A", "object": "B", "abstract_relation": "depend_on", "natural_statement": "A依赖B"},
            {"subject": "B", "object": "C", "abstract_relation": "part_of", "natural_statement": "B属于C"},
        ],
    }
    hits = expand_from_entities(mmkg, ["A"], max_hops=1, max_edges=5)
    assert any(h.get("type") == "edge" for h in hits)


class _FixedEmbedder:
    backend = "hash"
    model_name = "test"
    dim = 8

    def embed_one(self, text: str) -> np.ndarray:
        v = np.zeros(self.dim, dtype=np.float32)
        v[0] = 1.0 if "命题" in text else 0.5
        return v

    def embed(self, texts: list[str]) -> np.ndarray:
        return np.stack([self.embed_one(t) for t in texts])


def test_hybrid_search():
    mmkg = {
        "entities": [{"id": "命题逻辑", "description": "研究命题"}],
        "edges": [{"subject": "命题逻辑", "object": "谓词逻辑", "abstract_relation": "related_with", "natural_statement": "相关"}],
    }
    index = MMKGIndex(embedder=_FixedEmbedder())
    index.records = build_index_records(mmkg)
    index.vectors = np.array([[1, 0, 0, 0, 0, 0, 0, 0], [0.9, 0.1, 0, 0, 0, 0, 0, 0]], dtype=np.float32)
    hits = hybrid_search(index, "命题逻辑", top_k=2, mmkg=mmkg, graph_hops=1)
    assert hits


def test_infer_lecture_hint():
    assert infer_lecture_hint("第2讲讲什么") == "2"
    assert infer_lecture_hint("lecture 1 intro") == "1"


def test_learning_path_order():
    mmkg = {
        "entities": [
            {"id": "B", "name": "B"},
            {"id": "A", "name": "A"},
        ],
        "edges": [{"subject": "A", "object": "B", "abstract_relation": "prerequisite_of", "natural_statement": ""}],
    }
    path = build_learning_path(mmkg)
    ids = [p["entity_id"] for p in path]
    assert ids.index("A") < ids.index("B")
