"""按主归属 PPT 页合并 cue。"""

from __future__ import annotations

from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.cue_merge import (
    CueMergeSettings,
    merge_adjacent_cues,
    merge_cues_by_primary_page,
)
from teachkg.stage0_segmentation.ppt_page_utils import PptPage, primary_page_for_cue


def _cue(start: float, end: float, text: str) -> SubtitleCue:
    return SubtitleCue(start_sec=start, end_sec=end, text=text)


def test_primary_page_picks_max_overlap():
    pages = [
        PptPage(0, 0.0, 100.0),
        PptPage(1, 100.0, 200.0),
    ]
    cue = _cue(90.0, 130.0, "跨页碎段")
    assert primary_page_for_cue(cue, pages).index == 1  # 30s on page1 vs 10s on page0


def test_merge_same_page_boundary_fragments():
    pages = [
        PptPage(0, 0.0, 100.0),
        PptPage(1, 100.0, 200.0),
        PptPage(2, 200.0, 300.0),
    ]
    cues = [
        _cue(10.0, 80.0, "页0主体内容。"),
        _cue(80.0, 105.0, "页0末尾跨到页1。"),  # primary → 0
        _cue(105.0, 180.0, "页1主体。"),
        _cue(180.0, 210.0, "页1末尾跨页。"),  # primary → 1
        _cue(210.0, 290.0, "页2主体。"),
    ]
    out = merge_cues_by_primary_page(cues, pages)
    assert len(out) == 3
    assert "页0主体" in out[0].text and "页0末尾" in out[0].text
    assert "页1主体" in out[1].text
    assert "页2主体" in out[2].text


def test_merge_adjacent_with_ppt_page_flag():
    pages = [
        PptPage(0, 0.0, 50.0),
        PptPage(1, 50.0, 100.0),
    ]
    cues = [
        _cue(0.0, 40.0, "第一页较长口述内容，包含定义与符号。"),
        _cue(40.0, 48.0, "短收尾。"),
        _cue(52.0, 90.0, "第二页较长口述内容，继续讲解推理。"),
    ]
    settings = CueMergeSettings(
        enabled=True,
        merge_by_ppt_page=True,
        absorb_short_chars=5,
        fragment_score_threshold=0.99,
    )
    out = merge_adjacent_cues(cues, settings, ppt_boundaries=[50.0], ppt_pages=pages)
    assert len(out) == 2
