"""
PPT 翻页检测（改编自 AI-Teaching SlideSegmenter.py）。

流程：
1. 粗间隔 SSIM 扫描 → 定位「有变化」的时间窗
2. 仅在变点窗内按细间隔加密 SSIM → 精确定位翻页点
3. 短间隔去抖 + 最短页时长过滤
4. 标题聚类 + 上半区域确认 → 合并动画假翻页

当 coarse_interval_sec 未启用或 ≤ sample_interval_sec 时，退化为均匀细扫（旧行为）。
"""

from __future__ import annotations

import logging
import math
import time
from pathlib import Path

from teachkg.stage0_segmentation.ppt_page_utils import filter_short_page_boundaries
from teachkg.stage0_segmentation.ppt_title_cluster import refine_animation_false_flips

logger = logging.getLogger(__name__)

SUPPORTED_SUFFIXES = {".mp4", ".avi", ".mov", ".mkv", ".flv"}  # 与 slicer.VIDEO_SUFFIXES 对齐


class PPTDetector:
    def __init__(
        self,
        sample_interval_sec: float = 1.0,
        ssim_threshold: float = 0.3,
        min_gap_sec: float = 3.0,
        min_page_sec: float = 5.0,
        resize: tuple[int, int] = (320, 180),
        title_cluster_enabled: bool = True,
        title_similarity_threshold: float = 0.82,
        upper_half_similarity_threshold: float = 0.78,
        title_crop: tuple[float, float, float, float] = (0.0, 0.0, 0.65, 0.14),
        upper_half_crop: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 0.5),
        *,
        coarse_interval_sec: float | None = 5.0,
    ) -> None:
        if sample_interval_sec <= 0:
            raise ValueError("sample_interval_sec 必须为正")
        if coarse_interval_sec is not None and coarse_interval_sec <= 0:
            raise ValueError("coarse_interval_sec 必须为正或 None")
        if not 0 < ssim_threshold <= 1:
            raise ValueError("ssim_threshold 必须在 (0, 1]")
        if min_gap_sec < 0 or min_page_sec < 0:
            raise ValueError("min_gap_sec / min_page_sec 不能为负")
        if resize[0] <= 0 or resize[1] <= 0:
            raise ValueError("resize 必须为正")
        for name, crop in (("title_crop", title_crop), ("upper_half_crop", upper_half_crop)):
            if len(crop) != 4:
                raise ValueError(f"{name} 必须为 4 元组 (x0,y0,x1,y1)")
            x0, y0, x1, y1 = (float(v) for v in crop)
            if not (0.0 <= x0 < x1 <= 1.0 and 0.0 <= y0 < y1 <= 1.0):
                raise ValueError(f"{name} 坐标须满足 0≤x0<x1≤1 且 0≤y0<y1≤1，收到 {crop}")

        self.sample_interval_sec = float(sample_interval_sec)
        self.coarse_interval_sec = (
            None if coarse_interval_sec is None else float(coarse_interval_sec)
        )
        self.ssim_threshold = float(ssim_threshold)
        self.min_gap_sec = float(min_gap_sec)
        self.min_page_sec = float(min_page_sec)
        self.resize = resize
        self.title_cluster_enabled = title_cluster_enabled
        self.title_similarity_threshold = title_similarity_threshold
        self.upper_half_similarity_threshold = upper_half_similarity_threshold
        self.title_crop = title_crop
        self.upper_half_crop = upper_half_crop

    @property
    def use_coarse_refine(self) -> bool:
        """粗扫+加密是否启用。"""
        return (
            self.coarse_interval_sec is not None
            and self.coarse_interval_sec > self.sample_interval_sec
        )

    @staticmethod
    def _merge_nearby(timestamps: list[float], min_gap_sec: float) -> list[float]:
        if not timestamps:
            return []
        merged = [timestamps[0]]
        for ts in timestamps[1:]:
            if ts - merged[-1] >= min_gap_sec:
                merged.append(ts)
        return merged

    @staticmethod
    def _merge_windows(
        windows: list[tuple[float, float]],
        *,
        join_gap_sec: float = 0.0,
    ) -> list[tuple[float, float]]:
        """合并重叠或间隙 ≤ join_gap_sec 的时间窗。"""
        if not windows:
            return []
        ordered = sorted(windows, key=lambda w: (w[0], w[1]))
        merged: list[tuple[float, float]] = [ordered[0]]
        for start, end in ordered[1:]:
            prev_start, prev_end = merged[-1]
            if start <= prev_end + join_gap_sec:
                merged[-1] = (prev_start, max(prev_end, end))
            else:
                merged.append((start, end))
        return merged

    @staticmethod
    def _refine_frame_indices(
        windows: list[tuple[float, float]],
        fps: float,
        refine_interval_sec: float,
        total_frames: int,
    ) -> dict[int, int]:
        """
        生成加密采样帧号 → 所属窗下标。

        每个窗从起点起按 refine 步进，并始终包含终点帧。
        """
        if total_frames <= 0:
            total_frames = 10**12  # 未知总帧时不截断，由读取循环自然结束
        step = max(int(round(fps * refine_interval_sec)), 1)
        index_to_window: dict[int, int] = {}
        last_idx = max(total_frames - 1, 0) if total_frames < 10**12 else None

        for w_idx, (t0, t1) in enumerate(windows):
            i0 = max(int(round(t0 * fps)), 0)
            i1 = max(int(round(t1 * fps)), i0)
            if last_idx is not None:
                i0 = min(i0, last_idx)
                i1 = min(i1, last_idx)
            for i in range(i0, i1 + 1, step):
                index_to_window.setdefault(i, w_idx)
            index_to_window.setdefault(i1, w_idx)
        return index_to_window

    @staticmethod
    def _to_gray(frame, resize: tuple[int, int]):
        import cv2

        gray = cv2.resize(frame, resize)
        return cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)

    def _is_change(self, prev, curr, structural_similarity) -> bool:
        score = structural_similarity(prev, curr)
        return (1.0 - score) > self.ssim_threshold

    def _scan_uniform(
        self,
        cap,
        fps: float,
        total_frames: int,
        sample_interval_sec: float,
        structural_similarity,
    ) -> tuple[list[float], bool, int]:
        """均匀间隔扫描，返回 (命中时间, 是否 EOF, 解码帧数)。"""
        frame_interval = max(int(round(fps * sample_interval_sec)), 1)
        timestamps: list[float] = []
        prev_frame = None
        reached_eof = False
        decoded = 0
        frame_idx = 0

        while True:
            if frame_idx % frame_interval != 0:
                if not cap.grab():
                    reached_eof = True
                    break
                frame_idx += 1
                if total_frames > 0 and frame_idx >= total_frames:
                    break
                continue

            ok = cap.grab()
            if not ok:
                reached_eof = True
                break
            ret, frame = cap.retrieve()
            if not ret or frame is None:
                reached_eof = True
                break

            curr = self._to_gray(frame, self.resize)
            decoded += 1
            if prev_frame is not None and self._is_change(prev_frame, curr, structural_similarity):
                timestamps.append(frame_idx / fps)
            prev_frame = curr
            frame_idx += 1
            if total_frames > 0 and frame_idx >= total_frames:
                break

        return timestamps, reached_eof, decoded

    def _scan_coarse_windows(
        self,
        cap,
        fps: float,
        total_frames: int,
        structural_similarity,
    ) -> tuple[list[tuple[float, float]], bool, int]:
        """粗扫：返回发生变化的 (prev_ts, curr_ts) 窗口。"""
        assert self.coarse_interval_sec is not None
        frame_interval = max(int(round(fps * self.coarse_interval_sec)), 1)
        windows: list[tuple[float, float]] = []
        prev_frame = None
        prev_ts = 0.0
        reached_eof = False
        decoded = 0
        frame_idx = 0

        while True:
            if frame_idx % frame_interval != 0:
                if not cap.grab():
                    reached_eof = True
                    break
                frame_idx += 1
                if total_frames > 0 and frame_idx >= total_frames:
                    break
                continue

            ok = cap.grab()
            if not ok:
                reached_eof = True
                break
            ret, frame = cap.retrieve()
            if not ret or frame is None:
                reached_eof = True
                break

            curr = self._to_gray(frame, self.resize)
            curr_ts = frame_idx / fps
            decoded += 1
            if prev_frame is not None and self._is_change(prev_frame, curr, structural_similarity):
                windows.append((prev_ts, curr_ts))
            prev_frame = curr
            prev_ts = curr_ts
            frame_idx += 1
            if total_frames > 0 and frame_idx >= total_frames:
                break

        return windows, reached_eof, decoded

    def _scan_refine_windows(
        self,
        cap,
        fps: float,
        total_frames: int,
        windows: list[tuple[float, float]],
        structural_similarity,
    ) -> tuple[list[float], bool, int]:
        """在变点窗内细扫；顺序 grab，仅对加密帧 decode。"""
        if not windows:
            return [], False, 0

        index_to_window = self._refine_frame_indices(
            windows, fps, self.sample_interval_sec, total_frames
        )
        target_indices = set(index_to_window)
        if not target_indices:
            return [], False, 0

        max_target = max(target_indices)
        timestamps: list[float] = []
        window_hits: dict[int, int] = {i: 0 for i in range(len(windows))}
        prev_frame = None
        prev_window: int | None = None
        reached_eof = False
        decoded = 0
        frame_idx = 0

        while True:
            need_decode = frame_idx in target_indices
            if not need_decode:
                if not cap.grab():
                    reached_eof = True
                    break
                frame_idx += 1
                if total_frames > 0 and frame_idx >= total_frames:
                    break
                if frame_idx > max_target:
                    break
                continue

            ok = cap.grab()
            if not ok:
                reached_eof = True
                break
            ret, frame = cap.retrieve()
            if not ret or frame is None:
                reached_eof = True
                break

            w_idx = index_to_window[frame_idx]
            curr = self._to_gray(frame, self.resize)
            decoded += 1

            if prev_window != w_idx:
                # 新窗口：当前帧作基线，不记命中
                prev_frame = curr
                prev_window = w_idx
            elif prev_frame is not None and self._is_change(
                prev_frame, curr, structural_similarity
            ):
                timestamps.append(frame_idx / fps)
                window_hits[w_idx] += 1
                prev_frame = curr
            else:
                prev_frame = curr

            frame_idx += 1
            if total_frames > 0 and frame_idx >= total_frames:
                break
            if frame_idx > max_target:
                break

        # 粗扫有变但细扫未命中时，回退到窗终点，保召回
        for w_idx, (_t0, t1) in enumerate(windows):
            if window_hits.get(w_idx, 0) == 0:
                timestamps.append(t1)

        timestamps.sort()
        return timestamps, reached_eof, decoded

    def detect(self, video_path: str | Path) -> list[float]:
        """返回翻页时间点列表（秒）。"""
        import cv2
        from skimage.metrics import structural_similarity

        video_path = Path(video_path)
        if not video_path.is_file():
            raise FileNotFoundError(f"PPT video 不存在: {video_path}")

        t0 = time.perf_counter()
        mode = "coarse+refine" if self.use_coarse_refine else "uniform"
        decoded_total = 0
        reached_eof = False
        coarse_windows = 0

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError(f"无法打开 PPT video: {video_path}")

        try:
            fps = cap.get(cv2.CAP_PROP_FPS)
            if not fps or fps <= 0 or math.isnan(fps):
                fps = 25.0

            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            if total_frames <= 0:
                logger.warning("无法获取总帧数，尝试顺序读取: %s", video_path.name)

            if self.use_coarse_refine:
                windows, eof1, dec1 = self._scan_coarse_windows(
                    cap, fps, total_frames, structural_similarity
                )
                reached_eof = eof1
                decoded_total += dec1
                windows = self._merge_windows(windows)
                coarse_windows = len(windows)
            else:
                timestamps, eof1, dec1 = self._scan_uniform(
                    cap,
                    fps,
                    total_frames,
                    self.sample_interval_sec,
                    structural_similarity,
                )
                reached_eof = eof1
                decoded_total += dec1
                windows = []
        finally:
            cap.release()

        if self.use_coarse_refine:
            if windows:
                cap2 = cv2.VideoCapture(str(video_path))
                if not cap2.isOpened():
                    raise RuntimeError(f"无法打开 PPT video: {video_path}")
                try:
                    timestamps, eof2, dec2 = self._scan_refine_windows(
                        cap2, fps, total_frames, windows, structural_similarity
                    )
                    reached_eof = reached_eof or eof2
                    decoded_total += dec2
                finally:
                    cap2.release()
            else:
                timestamps = []

        video_duration = (total_frames / fps) if (total_frames > 0 and fps) else 0.0
        if video_duration <= 0 and timestamps:
            video_duration = timestamps[-1]

        ssim_hits = len(timestamps)
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
            "PPT detector: %d boundaries in %s "
            "(mode=%s, coarse_windows=%d, ssim_hits=%d, decoded=%d, "
            "animation_merged=%d, eof=%s, %.1fs)",
            len(timestamps),
            video_path.name,
            mode,
            coarse_windows,
            ssim_hits,
            decoded_total,
            animation_merged,
            reached_eof,
            time.perf_counter() - t0,
        )
        return timestamps

    def detect_and_save(self, video_path: str | Path, output_txt: str | Path) -> list[float]:
        timestamps = self.detect(video_path)
        output_txt = Path(output_txt)
        output_txt.parent.mkdir(parents=True, exist_ok=True)
        lines = [f"{int(ts // 60):02d}:{ts % 60:05.2f}" for ts in timestamps]
        output_txt.write_text("\n".join(lines), encoding="utf-8")
        return timestamps

    @staticmethod
    def process_directory(slide_dir: Path, output_dir: Path, **kwargs) -> dict[str, list[float]]:
        """批量处理 PPT 目录（*_1.mp4）。"""
        detector = PPTDetector(**kwargs)
        output_dir.mkdir(parents=True, exist_ok=True)
        results: dict[str, list[float]] = {}

        for video_path in sorted(slide_dir.glob("*_1.*")):
            if video_path.suffix.lower() not in SUPPORTED_SUFFIXES:
                continue

            stem = video_path.stem
            lecture_id = stem[:-2] if stem.endswith("_1") else stem
            txt_path = output_dir / f"{lecture_id}_seg.txt"

            if txt_path.exists():
                from teachkg.utils.time import parse_time_nodes_file

                try:
                    results[lecture_id] = parse_time_nodes_file(txt_path)
                    continue
                except Exception as exc:  # noqa: BLE001
                    logger.warning("解析已有 seg 失败，将重新检测: %s (%s)", txt_path, exc)

            results[lecture_id] = detector.detect_and_save(video_path, txt_path)

        return results
        