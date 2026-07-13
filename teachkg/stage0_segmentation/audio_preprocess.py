"""
阶段 A：音频预处理 + Silero VAD 语音活动检测。
"""

from __future__ import annotations

import logging
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class SpeechSegment:
    start_sec: float
    end_sec: float

    @property
    def duration_sec(self) -> float:
        return self.end_sec - self.start_sec


class AudioPreprocessor:
    def __init__(
        self,
        sample_rate: int = 16000,
        denoise: bool = True,
        loudnorm: bool = True,
        vad_threshold: float = 0.5,
        min_speech_sec: float = 0.3,
        min_silence_sec: float = 0.4,
        max_segment_sec: float = 120.0,
    ) -> None:
        self.sample_rate = sample_rate
        self.denoise = denoise
        self.loudnorm = loudnorm
        self.vad_threshold = vad_threshold
        self.min_speech_sec = min_speech_sec
        self.min_silence_sec = min_silence_sec
        self.max_segment_sec = max_segment_sec

    def extract_from_video(self, video_path: Path, output_wav: Path) -> Path:
        """从视频提取音频"""
        output_wav.parent.mkdir(parents=True, exist_ok=True)

        filters: list[str] = []
        if self.denoise:
            filters.append("afftdn") # 自适应FFT降噪滤镜
        if self.loudnorm:
            filters.append("loudnorm") # 响度标准化滤镜

        cmd = ["ffmpeg", "-y", "-i", str(video_path), "-vn", "-ac", "1", "-ar", str(self.sample_rate)]
        # -y：覆盖输出文件
        # -i：输入文件
        # -vn：不提取视频流，只提取音频流
        # -ac：音频通道数
        # -ar：音频采样率
        if filters:
            cmd.extend(["-af", ",".join(filters)]) # 应用滤镜
        cmd.extend(["-acodec", "pcm_s16le", str(output_wav)]) # 输出音频格式
        subprocess.run(cmd, check=True, capture_output=True)
        return output_wav

    def detect_speech(self, wav_path: Path) -> list[SpeechSegment]:
        """语音活动检测（silero_vad 包）"""
        from silero_vad import get_speech_timestamps, load_silero_vad

        model = load_silero_vad(onnx=False)
        wav = self._read_wav_tensor(wav_path)
        timestamps = get_speech_timestamps(
            wav,
            model,
            sampling_rate=self.sample_rate,
            threshold=self.vad_threshold,
            min_speech_duration_ms=int(self.min_speech_sec * 1000),
            min_silence_duration_ms=int(self.min_silence_sec * 1000),
            return_seconds=True,
        )

        segments = [
            SpeechSegment(start_sec=float(ts["start"]), end_sec=float(ts["end"]))
            for ts in timestamps
        ]
        return self._split_long_segments(segments)

    @staticmethod
    def _read_wav_tensor(wav_path: Path):
        """读取单声道 WAV 为 float32 Tensor（Windows 下替代 silero_vad.read_audio）。"""
        import numpy as np
        import torch

        with wave.open(str(wav_path), "rb") as wf:
            frames = wf.readframes(wf.getnframes())
            audio = np.frombuffer(frames, dtype=np.int16).astype("float32") / 32768.0
        return torch.from_numpy(audio).float()

    def _split_long_segments(self, segments: list[SpeechSegment]) -> list[SpeechSegment]:
        result: list[SpeechSegment] = []
        for seg in segments:
            if seg.duration_sec <= self.max_segment_sec:
                result.append(seg)
                continue
            cursor = seg.start_sec
            while cursor < seg.end_sec:
                end = min(cursor + self.max_segment_sec, seg.end_sec)
                result.append(SpeechSegment(start_sec=cursor, end_sec=end))
                cursor = end
        return result

    def cut_segment(self, wav_path: Path, seg: SpeechSegment, output_path: Path) -> Path:
        """按时间切分 WAV，避免为每段 VAD 反复 spawn ffmpeg（Windows 易触发页面文件不足）。"""
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with wave.open(str(wav_path), "rb") as src:
            params = src.getparams()
            framerate = src.getframerate()
            start_frame = max(int(seg.start_sec * framerate), 0)
            end_frame = min(int(seg.end_sec * framerate), src.getnframes())
            if end_frame <= start_frame:
                raise ValueError(f"Invalid segment range: {seg.start_sec}-{seg.end_sec}s")
            src.setpos(start_frame)
            frames = src.readframes(end_frame - start_frame)

        with wave.open(str(output_path), "wb") as dst:
            dst.setparams(params)
            dst.writeframes(frames)
        return output_path
