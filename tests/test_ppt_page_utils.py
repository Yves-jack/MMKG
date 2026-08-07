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


def test_select_pages_minimal_cover_range():
    pages = build_ppt_pages([100.0, 200.0], video_duration=300.0)
    # cue 80-120：横跨 page0 末与 page1 初 → 最小覆盖为 [0, 1]
    cue = SubtitleCue(start_sec=80, end_sec=120, text="x")
    selected = select_pages_for_cue(cue, pages)
    assert [p.index for p in selected] == [0, 1]

    # cue 全在 page0 内 → 仅 page0
    cue2 = SubtitleCue(start_sec=10, end_sec=50, text="y")
    selected2 = select_pages_for_cue(cue2, pages)
    assert [p.index for p in selected2] == [0]

    # cue 主要在 page1，但起点仍落在 page0 → 覆盖 [0, 1]
    cue3 = SubtitleCue(start_sec=90, end_sec=180, text="z")
    selected3 = select_pages_for_cue(cue3, pages)
    assert [p.index for p in selected3] == [0, 1]

    # 三页：cue 只盖住 page0 末到 page2 初，中间页一并纳入
    pages3 = build_ppt_pages([100.0, 200.0, 300.0], video_duration=400.0)
    cue4 = SubtitleCue(start_sec=95, end_sec=210, text="w")
    selected4 = select_pages_for_cue(cue4, pages3)
    assert [p.index for p in selected4] == [0, 1, 2]


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
