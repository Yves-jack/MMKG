import json
from pathlib import Path

from teachkg.stage3_mmkg.evidence_attach import attach_multimodal_evidence, build_cue_index
from teachkg.stage3_mmkg.index_builder import MMKGIndex, build_index_records


def _sample_kg():
    return {
        "entities": [
            {
                "id": "命题逻辑/propositional logic",
                "name": "命题逻辑/propositional logic",
                "cue_ids": ["cue_a"],
            }
        ],
        "edges": [
            {
                "subject": "原子命题/atomic proposition",
                "object": "命题逻辑/propositional logic",
                "abstract_relation": "part_of",
                "concrete_relation": "属于",
                "natural_statement": "原子命题属于命题逻辑",
                "provenance": [{"cue_id": "cue_a", "context": "最小单元是原子命题"}],
            }
        ],
    }


def _sample_triplets():
    return [
        {
            "subject": "原子命题/atomic proposition",
            "object": "命题逻辑/propositional logic",
            "context": "最小单元是原子命题",
            "cue_id": "cue_a",
            "lecture_id": "1",
            "start_sec": 1.0,
            "end_sec": 10.0,
            "clip_path": "data/clips/cue_a.mp4",
            "ppt_frame_path": "data/ocr/ppt_page_000.jpg",
            "ppt_page_index": 0,
        }
    ]


def test_build_cue_index():
    idx = build_cue_index(_sample_triplets())
    assert "cue_a" in idx
    assert idx["cue_a"]["clip_path"].endswith("cue_a.mp4")


def test_attach_multimodal_evidence():
    result = attach_multimodal_evidence(_sample_kg(), _sample_triplets())
    ent = result.entities[0]
    assert ent["modal_evidence"]["clips"][0]["clip_path"].endswith("cue_a.mp4")
    assert ent["modal_evidence"]["images"][0]["ppt_page_index"] == 0
    edge = result.edges[0]
    assert edge["grounding"]["clip_path"].endswith("cue_a.mp4")
    assert any(l["relation"] == "hasVideo" for l in ent["modal_links"])


def test_build_index_records_and_search():
    kg = _sample_kg()
    triplets = _sample_triplets()
    attached = attach_multimodal_evidence(kg, triplets)
    mmkg = {
        "course_id": "test",
        "lecture_id": "1",
        "entities": attached.entities,
        "edges": attached.edges,
    }
    records = build_index_records(mmkg)
    assert len(records) >= 2
    index = MMKGIndex()
    index.build(mmkg)
    hits = index.search("propositional logic", top_k=3)
    assert hits
    assert hits[0]["type"] in {"entity", "edge"}
