import json

import pytest

from teachkg.rag.answer_checker import _parse_check_json, check_answer
from teachkg.viz.kg_html import build_graph_payload, render_html


def test_parse_check_json():
    raw = '{"verdict": "supported", "confidence": 0.9, "supported_claims": ["a"], "unsupported_claims": [], "reason": "ok"}'
    data = _parse_check_json(raw)
    assert data["verdict"] == "supported"
    assert data["confidence"] == 0.9


def test_check_answer_mock():
    result = check_answer(
        question="q",
        answer="a",
        retrieved_context="ctx",
        llm_client=None,  # type: ignore[arg-type]
        mock=True,
    )
    assert result["verdict"] == "supported"


def test_check_answer_empty_context():
    result = check_answer(
        question="q",
        answer="a",
        retrieved_context="",
        llm_client=None,  # type: ignore[arg-type]
        mock=False,
    )
    assert result["verdict"] == "unsupported"


def test_build_graph_payload():
    kg = {
        "course_id": "c",
        "lecture_id": "1",
        "entities": [{"id": "A/a", "name": "A/a", "zh": "A"}],
        "edges": [
            {
                "subject": "A/a",
                "object": "B/b",
                "abstract_relation": "belong_to",
                "natural_statement": "A属于B",
            }
        ],
    }
    payload = build_graph_payload(kg)
    assert payload["entity_count"] >= 2
    assert payload["edge_count"] == 1


def test_render_html_contains_vis():
    html = render_html(
        {
            "course_id": "c",
            "lecture_id": "1",
            "entities": [{"id": "A/a", "name": "A/a"}],
            "edges": [],
        },
        title="test",
    )
    assert "vis-network" in html
    assert "test" in html
