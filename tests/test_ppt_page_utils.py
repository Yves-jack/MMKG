"""PPT 页归属规则单元测试。"""

from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.ppt_page_utils import (
    build_ppt_pages,
    filter_short_page_boundaries,
    ocr_timestamp_for_page,
    overlap_sec,
    segment_sample_timestamp,
    select_pages_for_cue,
)


def test_filter_short_page_boundaries_merges_animation_steps():
    raw = [781.0, 785.0, 807.0, 811.0, 893.0]
    assert filter_short_page_boundaries(raw, min_page_sec=20.0) == [781.0, 807.0, 893.0]


def test_overlap_sec():
    assert overlap_sec(10, 20, 15, 25) == 5


def test_ocr_timestamp_prefers_near_page_end():
    pages = build_ppt_pages([100.0, 200.0], video_duration=300.0)
    long_page = pages[0]  # 0-100
    assert ocr_timestamp_for_page(long_page) == 97.0  # end - 3s margin

    tiny = pages[1].__class__(index=9, start_sec=100.0, end_sec=103.0)
    assert ocr_timestamp_for_page(tiny) == 102.0  # settle 2s 后，且距翻页留 0.5s 缓冲


def test_segment_sample_timestamp_for_cue():
    assert segment_sample_timestamp(339.5, 773.0) == 770.0
    assert segment_sample_timestamp(774.0, 807.3) == 804.3


def test_select_pages_by_one_third_rule():
    pages = build_ppt_pages([100.0, 200.0], video_duration=300.0)
    # cue 80-120: page0 (0-100) overlap 20, page1 (100-200) overlap 20
    # page0 dur=100, need >33.3 for page0; page1 dur=100, need >33.3 for page1
    # overlaps 20 each - neither qualifies -> pick max (tie -> one page)
    cue = SubtitleCue(start_sec=80, end_sec=120, text="x")
    selected = select_pages_for_cue(cue, pages, overlap_ratio=1 / 3)
    assert len(selected) == 1

    # cue 10-50 on page0: overlap 40 > 33.3
    cue2 = SubtitleCue(start_sec=10, end_sec=50, text="y")
    selected2 = select_pages_for_cue(cue2, pages, overlap_ratio=1 / 3)
    assert len(selected2) == 1
    assert selected2[0].index == 0

    # cue 90-180 spans page0 end and page1: page0 overlap 10, page1 overlap 80 > 33.3
    cue3 = SubtitleCue(start_sec=90, end_sec=180, text="z")
    selected3 = select_pages_for_cue(cue3, pages, overlap_ratio=1 / 3)
    assert any(p.index == 1 for p in selected3)


def test_grouped_cues_no_time_overlap():
    from teachkg.stage0_segmentation.multimodal_correct import MultimodalCorrector

    pages = build_ppt_pages([100.0, 200.0, 250.0], video_duration=400.0)
    raw = [
        SubtitleCue(10, 30, "a"),
        SubtitleCue(31, 50, "b"),
        SubtitleCue(120, 140, "c"),
    ]
    corrector = MultimodalCorrector(enabled=False)
    groups = corrector._group_cues_for_correction(raw, pages)
    spans = [(g[0][0].start_sec, g[0][-1].end_sec) for g in groups]
    for i in range(len(spans) - 1):
        assert spans[i][1] <= spans[i + 1][0]
