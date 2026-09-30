#!/usr/bin/env python
"""仅导出 PPT OCR 截帧（不调用 OCR / LLM）。"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from teachkg.config import TeachKGConfig
from teachkg.stage0_segmentation.multimodal_correct import MultimodalCorrector
from teachkg.stage0_segmentation.ppt_detector import PPTDetector
from teachkg.stage0_segmentation.slicer import VideoSlicer
from teachkg.utils.time import parse_time_nodes_file


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export PPT OCR frames only (no OCR API)")
    parser.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--course-id", default=None)
    parser.add_argument(
        "--redetect-ppt",
        action="store_true",
        help="Force re-run PPT flip detection before exporting frames",
    )
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing jpg files")
    return parser.parse_args()


def _video_duration_sec(video_path: Path) -> float:
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    cap.release()
    return frames / fps if fps else 0.0


def _build_corrector(config: TeachKGConfig) -> MultimodalCorrector:
    s0 = config.get("stage0") or {}
    pipe = s0.get("asr_pipeline", {})
    asr_cfg = pipe.get("primary_asr", s0.get("asr", {}))
    corr_cfg = pipe.get("correction", {})
    return MultimodalCorrector(
        enabled=False,
        api_key=corr_cfg.get("api_key") or asr_cfg.get("api_key"),
        base_url=corr_cfg.get("base_url") or asr_cfg.get("base_url"),
        ocr_frame_margin_before_flip_sec=corr_cfg.get("ocr_frame_margin_before_flip_sec", 3.0),
        ocr_frame_settle_after_flip_sec=corr_cfg.get("ocr_frame_settle_after_flip_sec", 2.0),
        ocr_frame_short_page_ratio=corr_cfg.get("ocr_frame_short_page_ratio", 0.85),
        min_page_duration_sec=corr_cfg.get("min_page_duration_sec", 1.0),
    )


def _build_ppt_detector(config: TeachKGConfig) -> PPTDetector:
    ppt_cfg = (config.get("stage0") or {}).get("ppt_detector", {})
    coarse_raw = ppt_cfg.get("coarse_interval_sec", 5.0)
    coarse_interval = None if coarse_raw in (None, "", False) else float(coarse_raw)
    return PPTDetector(
        sample_interval_sec=ppt_cfg.get("sample_interval_sec", 1),
        coarse_interval_sec=coarse_interval,
        ssim_threshold=ppt_cfg.get("ssim_threshold", 0.15),
        min_gap_sec=ppt_cfg.get("min_gap_sec", 3.0),
        min_page_sec=ppt_cfg.get("min_page_sec", 5.0),
        resize=tuple(ppt_cfg.get("resize", [320, 180])),
        title_cluster_enabled=ppt_cfg.get("title_cluster_enabled", True),
        title_similarity_threshold=ppt_cfg.get("title_similarity_threshold", 0.82),
        upper_half_similarity_threshold=ppt_cfg.get("upper_half_similarity_threshold", 0.78),
        title_crop=tuple(ppt_cfg.get("title_crop", [0.0, 0.0, 0.65, 0.14])),
        upper_half_crop=tuple(ppt_cfg.get("upper_half_crop", [0.0, 0.0, 1.0, 0.5])),
    )


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    logger = logging.getLogger(__name__)

    workspace = Path(args.workspace).resolve()
    course_id = args.course_id or workspace.name
    config = TeachKGConfig.from_yaml(args.config)
    output_dir = config.segments_dir / course_id
    corrector = _build_corrector(config)
    detector = _build_ppt_detector(config)
    slicer = VideoSlicer(config)

    all_paths: list[Path] = []
    for item in slicer.discover_lectures(workspace):
        lecture_id = item["lecture_id"]
        ppt_video = item["ppt_video"]
        work_dir = output_dir / "asr_work" / lecture_id
        seg_txt = output_dir / "ppt_change" / f"{lecture_id}_seg.txt"

        if args.redetect_ppt or not seg_txt.exists():
            logger.info("Detecting PPT boundaries for lecture %s", lecture_id)
            detector.detect_and_save(ppt_video, seg_txt)
        boundaries = parse_time_nodes_file(str(seg_txt))
        duration = _video_duration_sec(ppt_video)
        paths = corrector.extract_ocr_frames(
            ppt_video,
            boundaries,
            duration,
            work_dir,
            overwrite=args.overwrite,
        )
        all_paths.extend(paths)

    print(f"Exported {len(all_paths)} OCR frame(s) under {output_dir}")
    for path in all_paths:
        print(f"  {path}")


if __name__ == "__main__":
    main()
