"""
PPT 翻页检测（改编自 AI-Teaching SlideSegmenter.py）。

流程：
1. SSIM 帧差 → 初始翻页点
2. 短间隔去抖 + 最短页时长过滤
3. 标题聚类 + 上半区域确认 → 合并动画假翻页
"""

from __future__ import annotations

import logging
from pathlib import Path

from teachkg.stage0_segmentation.ppt_page_utils import filter_short_page_boundaries
from teachkg.stage0_segmentation.ppt_title_cluster import refine_animation_false_flips

logger = logging.getLogger(__name__)


class PPTDetector:
    def __init__(
        self,
        sample_interval_sec: float = 5.0,
        ssim_threshold: float = 0.3,
        min_gap_sec: float = 3.0,
        min_page_sec: float = 5.0,
        resize: tuple[int, int] = (320, 180),
        title_cluster_enabled: bool = True,
        title_similarity_threshold: float = 0.82,
        upper_half_similarity_threshold: float = 0.78,
        title_crop: tuple[float, float, float, float] = (0.0, 0.0, 0.65, 0.14),
        upper_half_crop: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 0.5),
    ) -> None:
        self.sample_interval_sec = sample_interval_sec
        self.ssim_threshold = ssim_threshold
        self.min_gap_sec = min_gap_sec
        self.min_page_sec = min_page_sec
        self.resize = resize
        self.title_cluster_enabled = title_cluster_enabled
        self.title_similarity_threshold = title_similarity_threshold
        self.upper_half_similarity_threshold = upper_half_similarity_threshold
        self.title_crop = title_crop
        self.upper_half_crop = upper_half_crop

    @staticmethod
    def _merge_nearby(timestamps: list[float], min_gap_sec: float) -> list[float]:
        if not timestamps:
            return []
        merged = [timestamps[0]]
        for ts in timestamps[1:]:
            if ts - merged[-1] >= min_gap_sec:
                merged.append(ts)
        return merged

    def detect(self, video_path: str | Path) -> list[float]:
        """返回翻页时间点列表（秒）。"""
        import cv2
        from skimage.metrics import structural_similarity

        video_path = Path(video_path)
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise FileNotFoundError(f"Cannot open PPT video: {video_path}")

        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        frame_interval = max(int(fps * self.sample_interval_sec), 1)

        timestamps: list[float] = []
        prev_frame = None

        for frame_count in range(0, total_frames, frame_interval):
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_count)
            ret, frame = cap.read()
            if not ret:
                continue

            curr = cv2.resize(frame, self.resize)
            curr = cv2.cvtColor(curr, cv2.COLOR_BGR2GRAY)

            if prev_frame is not None:
                score, _ = structural_similarity(prev_frame, curr, full=True)
                if (1.0 - score) > self.ssim_threshold:
                    timestamps.append(frame_count / fps)

            prev_frame = curr

        cap.release()
        video_duration = total_frames / fps if fps else 0.0
        raw_count = len(timestamps)
        timestamps = self._merge_nearby(timestamps, self.min_gap_sec)
        timestamps = filter_short_page_boundaries(timestamps, self.min_page_sec)
        if self.title_cluster_enabled and video_duration > 0:
            before_refine = len(timestamps)
            timestamps = refine_animation_false_flips(
                timestamps,
                video_path,
                video_duration,
                title_similarity_threshold=self.title_similarity_threshold,
                upper_half_similarity_threshold=self.upper_half_similarity_threshold,
                title_crop=self.title_crop,
                upper_half_crop=self.upper_half_crop,
            )
            animation_merged = before_refine - len(timestamps)
        else:
            animation_merged = 0
        logger.info(
            "PPT detector: %d boundaries in %s (ssim_raw=%d, animation_merged=%d)",
            len(timestamps),
            video_path.name,
            raw_count,
            animation_merged,
        )
        return timestamps

    def detect_and_save(self, video_path: str | Path, output_txt: str | Path) -> list[float]:
        timestamps = self.detect(video_path)
        output_txt = Path(output_txt)
        output_txt.parent.mkdir(parents=True, exist_ok=True)
        lines = [f"{int(ts // 60):02d}:{int(ts % 60):02d}" for ts in timestamps]
        output_txt.write_text("\n".join(lines), encoding="utf-8")
        return timestamps

    @staticmethod
    def process_directory(slide_dir: Path, output_dir: Path, **kwargs) -> dict[str, list[float]]:
        """批量处理 PPT 目录（*_1.mp4）。"""
        detector = PPTDetector(**kwargs)
        output_dir.mkdir(parents=True, exist_ok=True)
        results: dict[str, list[float]] = {}

        for video_path in sorted(slide_dir.glob("*_1.*")):
            if video_path.suffix.lower() not in {".mp4", ".avi", ".mov", ".mkv", ".flv"}:
                continue
            lecture_id = video_path.stem.replace("_1", "")
            txt_path = output_dir / f"{lecture_id}_seg.txt"
            if txt_path.exists():
                from teachkg.utils.time import parse_time_nodes_file

                results[lecture_id] = parse_time_nodes_file(txt_path)
                continue
            results[lecture_id] = detector.detect_and_save(video_path, txt_path)

        return results
