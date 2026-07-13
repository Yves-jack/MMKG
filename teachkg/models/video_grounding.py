"""可选视频帧 grounding（采样 CLIP 打分，ViCLIP 占位）。"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)


def sample_video_frames(video_path: Path, *, max_frames: int = 4) -> list[np.ndarray]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return []
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frames: list[np.ndarray] = []
    indices = np.linspace(0, max(total - 1, 0), num=max_frames, dtype=int) if total > 0 else [0]
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ok, frame = cap.read()
        if ok and frame is not None:
            frames.append(frame)
    cap.release()
    return frames


def score_video_text(
    video_path: Path,
    text: str,
    *,
    clip_encoder: Any,
    max_frames: int = 4,
) -> float | None:
    """对视频均匀采样帧，取 CLIP 文本-图像最高分。"""
    frames = sample_video_frames(video_path, max_frames=max_frames)
    if not frames:
        return None
    scores: list[float] = []
    for frame in frames:
        try:
            scores.append(float(clip_encoder.score_image_text(frame, text)))
        except Exception as exc:  # noqa: BLE001
            logger.debug("Video frame CLIP failed: %s", exc)
    return max(scores) if scores else None
