"""动画假翻页三步合并单元测试。"""

import numpy as np

from teachkg.stage0_segmentation.ppt_title_cluster import (
    group_animation_false_flips,
    merge_animation_flip_groups,
    refine_animation_false_flips,
    region_similarity,
    segment_title_sample_ts,
)


def test_segment_title_sample_ts():
    assert segment_title_sample_ts(100.0, 200.0, 3.0) == 103.0
    assert segment_title_sample_ts(100.0, 105.0, 3.0) == 100.75


def test_region_similarity_identical():
    sig = np.ones((36, 170), dtype=np.uint8) * 200
    assert region_similarity(sig, sig) > 0.99


def test_group_animation_false_flips():
    same = np.ones((36, 170), dtype=np.uint8) * 180
    different = np.zeros((36, 170), dtype=np.uint8)

    def mock_sig(_path, ts):
        if ts < 250:
            return same
        return different

    groups = group_animation_false_flips(
        [100.0, 200.0, 300.0],
        video_path="dummy.mp4",
        video_duration=400.0,
        title_similarity_threshold=0.82,
        title_signature_fn=mock_sig,
    )
    assert groups == [[100.0, 200.0, 300.0]]


def test_merge_animation_flip_groups_single_boundary():
    merged = merge_animation_flip_groups(
        [200.0],
        [[200.0]],
        video_path="dummy.mp4",
        video_duration=400.0,
        upper_half_signature_fn=lambda _p, _t: np.ones((120, 220), dtype=np.uint8),
    )
    assert merged == []


def test_merge_animation_flip_groups_keeps_last_in_group():
    same = np.ones((120, 220), dtype=np.uint8) * 180

    merged = merge_animation_flip_groups(
        [100.0, 200.0, 300.0],
        [[100.0, 200.0]],
        video_path="dummy.mp4",
        video_duration=400.0,
        upper_half_signature_fn=lambda _p, _t: same,
    )
    assert merged == [200.0, 300.0]


def test_cleanup_orphan_ocr_frames():
    from pathlib import Path

    from teachkg.stage0_segmentation.multimodal_correct import MultimodalCorrector
    from teachkg.stage0_segmentation.ppt_page_utils import PptPage

    ocr_dir = Path("dummy_ocr")
    ocr_dir.mkdir(exist_ok=True)
    pages = [PptPage(index=i, start_sec=i * 10.0, end_sec=(i + 1) * 10.0) for i in range(2)]
    try:
        (ocr_dir / "ppt_page_000.jpg").write_bytes(b"a")
        (ocr_dir / "ppt_page_001.jpg").write_bytes(b"b")
        (ocr_dir / "ppt_page_002.jpg").write_bytes(b"c")
        (ocr_dir / "ppt_page_011_3297.jpg").write_bytes(b"legacy")

        removed = MultimodalCorrector._cleanup_orphan_ocr_frames(ocr_dir, pages)
        assert removed == 2
        assert (ocr_dir / "ppt_page_000.jpg").exists()
        assert (ocr_dir / "ppt_page_001.jpg").exists()
        assert not (ocr_dir / "ppt_page_002.jpg").exists()
        assert not (ocr_dir / "ppt_page_011_3297.jpg").exists()
    finally:
        for f in ocr_dir.glob("*.jpg"):
            f.unlink()
        ocr_dir.rmdir()


def test_refine_animation_false_flips_end_to_end():
    same = np.ones((36, 170), dtype=np.uint8) * 180

    merged = refine_animation_false_flips(
        [100.0, 200.0, 300.0],
        video_path="dummy.mp4",
        video_duration=400.0,
        title_signature_fn=lambda _p, _t: same,
        upper_half_signature_fn=lambda _p, _t: np.ones((120, 220), dtype=np.uint8) * 180,
    )
    assert merged == [300.0]
