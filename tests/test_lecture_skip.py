"""Tests for empty / exam lecture skip handling."""
from __future__ import annotations

import json
from pathlib import Path

from teachkg.lecture_skip import (
    count_triplets,
    detect_empty_knowledge,
    is_skipped,
    list_skipped,
    write_skip_marker,
)


def test_write_and_list_skip(tmp_path: Path):
    course = "demo_course"
    p = write_skip_marker(
        course,
        "17",
        reason="no_knowledge_content",
        detail="exam",
        source="auto",
        root=tmp_path,
    )
    assert p.is_file()
    assert is_skipped(course, "17", root=tmp_path)
    assert list_skipped(course, root=tmp_path) == {"17"}
    assert not is_skipped(course, "16", root=tmp_path)


def test_detect_empty_from_filtered_zero_trips(tmp_path: Path):
    course = "demo_course"
    proc = tmp_path / "data" / "processed" / course
    proc.mkdir(parents=True)
    kg = tmp_path / "data" / "kg" / course
    kg.mkdir(parents=True)
    (kg / "triplets.jsonl").write_text("", encoding="utf-8")
    rows = [
        {
            "lecture_id": "17",
            "cue_id": "demo_17_1",
            "stage1": {"triplet_count": 0, "passed": True},
        },
        {
            "lecture_id": "16",
            "cue_id": "demo_16_1",
            "stage1": {"triplet_count": 3, "passed": True},
        },
    ]
    (proc / "filtered_cues.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8",
    )
    empty = detect_empty_knowledge(course, "17", root=tmp_path)
    assert empty is not None
    assert empty.reason == "no_knowledge_content"
    assert detect_empty_knowledge(course, "16", root=tmp_path) is None


def test_detect_not_before_stage1(tmp_path: Path):
    course = "demo_course"
    (tmp_path / "data" / "processed" / course).mkdir(parents=True)
    (tmp_path / "data" / "kg" / course).mkdir(parents=True)
    assert detect_empty_knowledge(course, "17", root=tmp_path) is None


def test_count_triplets(tmp_path: Path):
    course = "demo_course"
    kg = tmp_path / "data" / "kg" / course
    kg.mkdir(parents=True)
    lines = [
        json.dumps({"lecture_id": "1", "subject": "a"}),
        json.dumps({"lecture_id": "17", "subject": "b"}),
        json.dumps({"lecture_id": "1", "subject": "c"}),
    ]
    (kg / "triplets.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert count_triplets(course, "1", root=tmp_path) == 2
    assert count_triplets(course, "17", root=tmp_path) == 1
    assert count_triplets(course, "99", root=tmp_path) == 0
