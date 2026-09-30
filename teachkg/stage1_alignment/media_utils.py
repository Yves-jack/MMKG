"""Stage 1 媒体路径解析与抽帧/抽音频辅助工具。

主流水线目前主要使用 :func:`resolve_path`；其余函数供对齐、可视化等旁路复用。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import numpy as np


def resolve_path(path: str | Path, project_root: Path | None = None) -> Path:
    """将配置中的媒体路径解析为存在的文件 Path。

    解析顺序：若 ``path`` 本身已是文件则直接 resolve；否则在 ``project_root``
    下拼接相对路径再试；最后仍返回 resolve 后的 Path（可能尚不存在）。

    Args:
        path: 绝对路径、相对项目根的路径，或已存在的文件路径。
        project_root: 项目根目录；``path`` 为相对路径时用于拼接。

    Returns:
        解析后的 ``Path``（已 ``resolve``）。
    """
    path = Path(path)
    if path.is_file():
        return path.resolve()
    if project_root and not path.is_absolute():
        candidate = project_root / path
        if candidate.is_file():
            return candidate.resolve()
    return path.resolve()


def extract_audio_from_video(
    video_path: Path,
    output_wav: Path,
    sample_rate: int = 48000,
) -> Path:
    """用 ffmpeg 从视频提取单声道 PCM WAV。

    Args:
        video_path: 输入视频路径。
        output_wav: 输出 wav 路径（父目录不存在时会创建）。
        sample_rate: 采样率，默认 48000。

    Returns:
        ``output_wav``。

    Raises:
        subprocess.CalledProcessError: ffmpeg 失败时抛出。
    """
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-vn", "-ac", "1", "-ar", str(sample_rate),
        "-acodec", "pcm_s16le", str(output_wav),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return output_wav


def sample_video_frames(video_path: Path, num_frames: int = 3) -> list[np.ndarray]:
    """在视频时间轴上均匀采样若干帧（BGR ndarray）。

    Args:
        video_path: 视频文件。
        num_frames: 采样帧数；``<=1`` 时取中间帧。

    Returns:
        OpenCV BGR 图像列表；打不开或无帧时返回空列表。
    """
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
    """按时间戳从 PPT/屏幕录制视频中取一帧。

    Args:
        ppt_video: PPT 轨或屏幕视频路径。
        timestamp_sec: 目标时刻（秒）。

    Returns:
        BGR 图像；打开失败或读帧失败返回 ``None``。
    """
    cap = cv2.VideoCapture(str(ppt_video))
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(timestamp_sec * fps))
    ok, frame = cap.read()
    cap.release()
    return frame if ok else None
