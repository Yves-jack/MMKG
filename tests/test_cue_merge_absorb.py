"""短口语段并入邻段。"""

from __future__ import annotations

from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.cue_merge import (
    CueMergeSettings,
    absorb_subthreshold_cues,
    merge_adjacent_cues,
)


def _cue(start: float, end: float, text: str) -> SubtitleCue:
    return SubtitleCue(start_sec=start, end_sec=end, text=text)


def test_absorb_short_asr_into_prev_neighbor():
    settings = CueMergeSettings(
        enabled=True,
        absorb_short_chars=20,
        absorb_max_gap_sec=3.0,
        absorb_short_duration_sec=3.0,
        max_gap_sec=3.0,
        fragment_score_threshold=0.99,  # 关掉启发式，只测 absorb
    )
    cues = [
        _cue(0.0, 20.0, "全称肯定命题是逻辑学中的基本概念，记作 A。"),
        _cue(20.2, 23.5, "很容易证明。"),
        _cue(24.0, 50.0, "接下来讨论特称否定命题及其推理规则，以及相关符号约定。"),
    ]
    out = absorb_subthreshold_cues(cues, settings, boundaries=[20.0])
    assert len(out) == 2
    assert "很容易证明" in out[0].text
    assert out[0].end_sec == 23.5


def test_absorb_short_asr_across_page_with_absorb_gap():
    """跨 PPT 页时启发式 gap=0.5，短口语段仍可用 absorb_max_gap 并入。"""
    settings = CueMergeSettings(
        enabled=True,
        absorb_short_chars=20,
        absorb_max_gap_sec=3.0,
        cross_page_max_gap_sec=0.5,
        max_gap_sec=3.0,
        fragment_score_threshold=0.99,
    )
    cues = [
        _cue(0.0, 10.0, "前一页讲完全称量词的定义与符号约定，以及基本推理形式。"),
        _cue(11.5, 14.0, "很容易证明。"),  # gap=1.5 > 0.5，跨页启发式不会并；absorb 应并
        _cue(15.0, 40.0, "后一页开始讲存在量词及其基本推理形式，并给出一般结论。"),
    ]
    boundaries = [11.0]
    out = merge_adjacent_cues(cues, settings, ppt_boundaries=boundaries)
    assert len(out) == 2
    assert any("很容易证明" in c.text for c in out)


def test_long_cues_not_force_absorbed():
    settings = CueMergeSettings(
        enabled=True,
        absorb_short_chars=20,
        absorb_max_gap_sec=3.0,
        fragment_score_threshold=0.99,
    )
    cues = [
        _cue(0.0, 30.0, "甲" * 80),
        _cue(30.5, 60.0, "乙" * 80),
    ]
    out = absorb_subthreshold_cues(cues, settings)
    assert len(out) == 2
