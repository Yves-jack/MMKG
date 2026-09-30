"""PPTDetector 粗扫+加密辅助逻辑单测。"""

from teachkg.stage0_segmentation.ppt_detector import PPTDetector


def test_merge_windows_overlaps_and_gap():
    windows = [(0.0, 5.0), (4.0, 9.0), (12.0, 15.0), (15.5, 18.0)]
    assert PPTDetector._merge_windows(windows) == [(0.0, 9.0), (12.0, 15.0), (15.5, 18.0)]
    assert PPTDetector._merge_windows(windows, join_gap_sec=0.5) == [
        (0.0, 9.0),
        (12.0, 18.0),
    ]


def test_refine_frame_indices_includes_endpoints():
    # 25fps, refine=1s → step=25；窗 [10,15] → 250..375
    mapping = PPTDetector._refine_frame_indices(
        [(10.0, 15.0)],
        fps=25.0,
        refine_interval_sec=1.0,
        total_frames=10000,
    )
    assert 250 in mapping
    assert 375 in mapping
    assert mapping[250] == 0
    # 步进采样
    assert 275 in mapping
    assert 274 not in mapping


def test_use_coarse_refine_gate():
    assert PPTDetector(sample_interval_sec=1, coarse_interval_sec=5).use_coarse_refine
    assert not PPTDetector(sample_interval_sec=1, coarse_interval_sec=1).use_coarse_refine
    assert not PPTDetector(sample_interval_sec=1, coarse_interval_sec=None).use_coarse_refine
