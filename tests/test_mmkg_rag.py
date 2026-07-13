import json
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from teachkg.config import TeachKGConfig
from teachkg.rag.mmkg_rag import MMKGRAG, format_hit_for_context
from teachkg.stage3_mmkg.index_builder import MMKGIndex, build_index_records


def _sample_mmkg():
    return {
        "course_id": "test_course",
        "lecture_id": "1",
        "entities": [
            {
                "id": "谓词逻辑/predicate logic",
                "name": "谓词逻辑/predicate logic",
                "description": "谓词逻辑是命题逻辑的扩展。",
                "zh": "谓词逻辑",
                "en": "predicate logic",
            },
            {
                "id": "量词/quantifier",
                "name": "量词/quantifier",
                "description": "量词包括全称量词和存在量词。",
            },
        ],
        "edges": [
            {
                "subject": "谓词逻辑/predicate logic",
                "object": "命题逻辑/propositional logic",
                "abstract_relation": "depend_on",
                "natural_statement": "谓词逻辑以命题逻辑为基础",
                "grounding": {
                    "natural_statement": "谓词逻辑以命题逻辑为基础",
                    "clip_path": "data/clips/demo.mp4",
                    "ppt_frame_path": "data/ocr/ppt_page_000.jpg",
                    "ppt_page_index": 0,
                    "start_sec": 1.0,
                    "end_sec": 10.0,
                    "alignment": {"clap_audio_text": 0.2, "clip_image_text": 0.45},
                },
            }
        ],
    }


class _FixedEmbedder:
    backend = "hash"
    model_name = "test-fixed"
    dim = 384

    def embed_one(self, text: str) -> np.ndarray:
        vec = np.zeros(self.dim, dtype=np.float32)
        if "谓词" in text:
            vec[0] = 1.0
        elif "量词" in text:
            vec[1] = 1.0
        else:
            vec[2] = 1.0
        return vec


def _build_test_index() -> MMKGIndex:
    mmkg = _sample_mmkg()
    index = MMKGIndex(embedder=_FixedEmbedder())
    index.records = build_index_records(mmkg)
    index.vectors = np.array(
        [
            [1.0] + [0.0] * 383,
            [0.0, 1.0] + [0.0] * 382,
            [0.9, 0.1] + [0.0] * 382,
        ],
        dtype=np.float32,
    )
    index._build_faiss()
    return index


@pytest.fixture
def rag_env(tmp_path: Path):
    config = TeachKGConfig(
        {
            "project": {
                "kg_dir": str(tmp_path / "kg"),
                "index_dir": str(tmp_path / "index"),
                "workspace_dir": str(tmp_path / "raw"),
            },
            "stage3": {"index": {"subdir": "mmkg_index", "embedder_model": "test-fixed"}},
            "stage4": {"rag": {"top_k": 3, "min_score": 0.1}},
            "llm": {"model": "mock-model"},
        }
    )
    kg_base = tmp_path / "kg" / "test_course" / "lecture_1"
    kg_base.mkdir(parents=True)
    (kg_base / "mmkg.json").write_text(json.dumps(_sample_mmkg(), ensure_ascii=False), encoding="utf-8")

    idx_dir = tmp_path / "index" / "test_course" / "lecture_1" / "mmkg_index"
    index = _build_test_index()
    index.save(idx_dir)
    return config, idx_dir


def test_format_hit_for_context_entity_and_edge():
    entity_hit = {
        "type": "entity",
        "score": 0.91,
        "payload": {"entity_id": "量词/quantifier", "description": "全称与存在量词。"},
    }
    edge_hit = {
        "type": "edge",
        "score": 0.88,
        "payload": {
            "natural_statement": "谓词逻辑以命题逻辑为基础",
            "subject": "谓词逻辑/predicate logic",
            "object": "命题逻辑/propositional logic",
            "abstract_relation": "depend_on",
            "grounding": _sample_mmkg()["edges"][0]["grounding"],
        },
    }
    entity_text = format_hit_for_context(entity_hit)
    edge_text = format_hit_for_context(edge_hit)
    assert "量词/quantifier" in entity_text
    assert "全称与存在量词" in entity_text
    assert "depend_on" in edge_text
    assert "音频-文本对齐分" in edge_text


def test_build_index_records_count():
    records = build_index_records(_sample_mmkg())
    assert len(records) == 3


def test_mmkg_rag_retrieve(rag_env):
    config, idx_dir = rag_env
    index = _build_test_index()

    with patch("teachkg.rag.mmkg_rag.MMKGRAG._index_path", return_value=idx_dir), patch(
        "teachkg.stage3_mmkg.index_builder.MMKGIndex.load", return_value=index
    ):
        rag = MMKGRAG(config, mock=True)
        hits = rag.retrieve("谓词逻辑", "test_course", lecture_id="1", top_k=2)
    assert hits
    assert hits[0]["id"].startswith("entity:谓词逻辑")
    assert all(h.get("score", 0) >= rag.min_score for h in hits)


def test_mmkg_rag_answer_mock(rag_env):
    config, idx_dir = rag_env
    index = _build_test_index()

    with patch("teachkg.rag.mmkg_rag.MMKGRAG._index_path", return_value=idx_dir), patch(
        "teachkg.stage3_mmkg.index_builder.MMKGIndex.load", return_value=index
    ):
        rag = MMKGRAG(config, mock=True)
        result = rag.answer("什么是谓词逻辑？", "test_course", lecture_id="1")
    assert result["hits"]
    assert result["answer"].startswith("[mock]")
    assert "question" in result


def test_mmkg_rag_no_hits(rag_env):
    config, idx_dir = rag_env
    index = _build_test_index()

    with patch("teachkg.rag.mmkg_rag.MMKGRAG._index_path", return_value=idx_dir), patch(
        "teachkg.stage3_mmkg.index_builder.MMKGIndex.load", return_value=index
    ):
        rag = MMKGRAG(config, mock=True)
        rag.min_score = 0.99
        result = rag.answer("无关问题", "test_course", lecture_id="1")
    assert result["hits"] == []
    assert "未检索到" in result["answer"]


def test_mmkg_rag_missing_index(rag_env):
    config, _ = rag_env
    rag = MMKGRAG(config, mock=True)
    with pytest.raises(FileNotFoundError):
        rag.retrieve("test", "test_course", lecture_id="99")
