import json
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from teachkg.config import TeachKGConfig
from teachkg.rag.bm25 import BM25Index
from teachkg.rag.graph_retrieval import expand_from_entities, seed_entities_from_hits
from teachkg.rag.hybrid_retriever import hybrid_search
from teachkg.rag.answer_checker import extract_evidence_citations
from teachkg.rag.mmkg_rag import MMKGRAG
from teachkg.stage3_mmkg.index_builder import MMKGIndex, build_index_records


def _sample_mmkg():
    return {
        "course_id": "test_course",
        "entities": [
            {"id": "A/a", "name": "A/a", "description": "实体A"},
            {"id": "B/b", "name": "B/b", "description": "实体B"},
        ],
        "edges": [
            {
                "subject": "A/a",
                "object": "B/b",
                "abstract_relation": "depend_on",
                "natural_statement": "A依赖B",
                "grounding": {"cue_id": "c1", "lecture_id": 1, "ppt_page_index": 2},
            }
        ],
    }


class _FixedEmbedder:
    backend = "hash"
    model_name = "test-fixed"
    dim = 384

    def embed_one(self, text: str) -> np.ndarray:
        vec = np.zeros(self.dim, dtype=np.float32)
        if "A" in text or "实体A" in text:
            vec[0] = 1.0
        elif "B" in text:
            vec[1] = 1.0
        else:
            vec[2] = 1.0
        return vec


def _build_index():
    mmkg = _sample_mmkg()
    index = MMKGIndex(embedder=_FixedEmbedder())
    index.records = build_index_records(mmkg)
    index.vectors = np.array(
        [[1.0] + [0.0] * 383, [0.0, 1.0] + [0.0] * 382, [0.5, 0.5] + [0.0] * 382],
        dtype=np.float32,
    )
    index._build_faiss()
    return index, mmkg


def test_bm25_search():
    bm25 = BM25Index(["命题逻辑是研究命题的", "谓词逻辑扩展命题逻辑"])
    hits = bm25.search("命题逻辑", top_k=2)
    assert hits
    assert hits[0][1] > 0


def test_hybrid_search_with_graph():
    index, mmkg = _build_index()
    hits = hybrid_search(index, "实体A", top_k=3, graph_hops=1, mmkg=mmkg)
    assert hits
    sources = {h.get("source") for h in hits}
    assert "hybrid" in sources or any(h.get("type") == "entity" for h in hits)


def test_extract_citations():
    hits = [
        {
            "type": "edge",
            "id": "e1",
            "payload": {
                "natural_statement": "A依赖B",
                "grounding": {"cue_id": "cue_1", "lecture_id": 1, "ppt_page_index": 3},
            },
        }
    ]
    cites = extract_evidence_citations(hits)
    assert cites[0]["cue_id"] == "cue_1"
    assert cites[0]["ppt_page"] == 3


def test_mmkg_rag_history_and_reset(tmp_path: Path):
    config = TeachKGConfig(
        {
            "project": {
                "kg_dir": str(tmp_path / "kg"),
                "index_dir": str(tmp_path / "index"),
                "workspace_dir": str(tmp_path / "raw"),
            },
            "stage4": {
                "rag": {
                    "top_k": 3,
                    "min_score": 0.0,
                    "hybrid_enabled": False,
                    "graph_hops": 0,
                }
            },
            "llm": {"model": "mock-model"},
        }
    )
    mmkg = _sample_mmkg()
    kg_base = tmp_path / "kg" / "test_course"
    kg_base.mkdir(parents=True)
    (kg_base / "mmkg.json").write_text(json.dumps(mmkg, ensure_ascii=False), encoding="utf-8")

    idx_dir = tmp_path / "index" / "test_course" / "course" / "mmkg_index"
    index, _ = _build_index()
    index.save(idx_dir)

    rag = MMKGRAG(config, mock=True)
    with patch("teachkg.rag.mmkg_rag.MMKGRAG._index_path", return_value=idx_dir), patch(
        "teachkg.stage3_mmkg.index_builder.MMKGIndex.load", return_value=index
    ):
        r1 = rag.answer("什么是A？", "test_course", use_history=True)
        assert r1["citations"] is not None
        assert len(rag._history) == 1
        assert rag._history[0].question == "什么是A？"
        rag.reset_history()
        assert len(rag._history) == 0
        r2 = rag.answer("什么是B？", "test_course", use_history=False)
        assert len(rag._history) == 0
        assert r2["answer"]


def test_graph_expand():
    mmkg = _sample_mmkg()
    seeds = ["A/a"]
    extra = expand_from_entities(mmkg, seeds, max_hops=1, max_edges=5)
    assert extra
    assert any(h.get("type") == "edge" for h in extra)


def test_seed_entities_from_hits():
    hits = [{"type": "entity", "payload": {"entity_id": "A/a"}}]
    assert seed_entities_from_hits(hits) == ["A/a"]
