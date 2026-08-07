from __future__ import annotations

from teachkg.schemas import BoundaryType, VideoSegment
from teachkg.stage1_alignment.pipeline import CueCheckResult, PreparedCue


def _cue(text: str) -> VideoSegment:
    return VideoSegment(
        segment_id="c1",
        course_id="demo",
        lecture_id="1",
        source_video="x.mp4",
        start_sec=0.0,
        end_sec=1.0,
        boundary_type=BoundaryType.MERGED,
        asr_text=text,
    )


def test_to_dict_unchanged_has_status_without_extract_text():
    text = "谓词逻辑将命题细分为主语和谓语。"
    prepared = PreparedCue(
        cue=_cue(text),
        check=CueCheckResult(passed=True),
        extract_text=text,
        triplets=[],
    )
    stage1 = prepared.to_dict()["stage1"]
    assert stage1["text_preprocess_status"] == "unchanged"
    assert "extract_text" not in stage1
    assert "asr_text" in stage1["text_preprocess_note"] or "未改动" in stage1["text_preprocess_note"]


def test_to_dict_changed_writes_extract_text():
    prepared = PreparedCue(
        cue=_cue("上课。谓词逻辑是命题逻辑的扩展。"),
        check=CueCheckResult(passed=True),
        extract_text="谓词逻辑是命题逻辑的扩展。",
        triplets=[],
    )
    stage1 = prepared.to_dict()["stage1"]
    assert stage1["text_preprocess_status"] == "changed"
    assert stage1["extract_text"] == "谓词逻辑是命题逻辑的扩展。"


def test_to_dict_empty_after_preprocess_writes_empty_extract_text():
    prepared = PreparedCue(
        cue=_cue("大家签到一下，休息五分钟。"),
        check=CueCheckResult(passed=True),
        extract_text="",
        triplet_error="empty_text_after_preprocess",
        triplets=[],
    )
    stage1 = prepared.to_dict()["stage1"]
    assert stage1["text_preprocess_status"] == "empty_after_preprocess"
    assert stage1["extract_text"] == ""
    assert "无保留" in stage1["text_preprocess_note"]
