"""Stage 1 媒体提取工具。"""

from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import numpy as np


def resolve_path(path: str | Path, project_root: Path | None = None) -> Path:
    path = Path(path)
    if path.is_file():
        return path.resolve()
    if project_root and not path.is_absolute():
        candidate = project_root / path
        if candidate.is_file():
            return candidate.resolve()
    return path.resolve()


def extract_audio_from_video(video_path: Path, output_wav: Path, sample_rate: int = 48000) -> Path:
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-vn", "-ac", "1", "-ar", str(sample_rate),
        "-acodec", "pcm_s16le", str(output_wav),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return output_wav


def sample_video_frames(video_path: Path, num_frames: int = 3) -> list[np.ndarray]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return []

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    if total <= 0:
        cap.release()
        return []

    if num_frames <= 1:
        indices = [total // 2]
    else:
        indices = [int(total * i / (num_frames - 1)) for i in range(num_frames)]
        indices = [min(max(i, 0), total - 1) for i in indices]

    frames: list[np.ndarray] = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if ok:
            frames.append(frame)
    cap.release()
    return frames


def extract_ppt_frame(ppt_video: Path, timestamp_sec: float) -> np.ndarray | None:
    cap = cv2.VideoCapture(str(ppt_video))
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(timestamp_sec * fps))
    ok, frame = cap.read()
    cap.release()
    return frame if ok else None
