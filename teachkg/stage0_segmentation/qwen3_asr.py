"""
Qwen3-ASR-Flash 客户端：分块转写课堂音频。
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import wave
from pathlib import Path

from teachkg.models.qwen3_asr_flash import Qwen3ASRFlashModel

logger = logging.getLogger(__name__)


class Qwen3ASRClient:
    """对课堂音频做分块转写，返回带时间偏移的字幕 cue。"""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str = "qwen3-asr-flash",
        max_local_file_mb: int = 10,
        chunk_duration_sec: int = 120,
        language: str = "zh",
        enable_itn: bool = True,
    ) -> None:
        self.api_key = api_key or os.environ.get("DASHSCOPE_API_KEY")
        self.base_url = base_url or os.environ.get(
            "DASHSCOPE_BASE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
        self.model_name = model
        self.max_local_file_mb = max_local_file_mb
        self.chunk_duration_sec = chunk_duration_sec
        self.language = language
        self.enable_itn = enable_itn
        self._model: Qwen3ASRFlashModel | None = None

    def _get_model(self) -> Qwen3ASRFlashModel:
        if self._model is None:
            self._model = Qwen3ASRFlashModel(
                api_key=self.api_key,
                base_url=self.base_url,
                model=self.model_name,
                max_local_file_mb=self.max_local_file_mb,
            )
        return self._model

    def transcribe_audio(
        self,
        audio_path: str | Path,
        context: str = "",
    ) -> str:
        result = self._get_model().transcribe(
            audio_path=audio_path,
            context=context,
            language=self.language,
            enable_itn=self.enable_itn,
        )
        return (result.transcript or "").strip()

    def transcribe_video(
        self,
        video_path: str | Path,
        context: str = "",
        sample_rate: int = 16000,
    ) -> list[tuple[float, float, str]]:
        video_path = Path(video_path)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            full_wav = tmp_dir / "full.wav"
            self._extract_audio(video_path, full_wav, sample_rate)

            chunks = self._split_wav(full_wav, sample_rate)
            cues: list[tuple[float, float, str]] = []

            for idx, (chunk_path, start_sec, end_sec) in enumerate(chunks, 1):
                text = self.transcribe_audio(chunk_path, context=context)
                if text:
                    cues.append((start_sec, end_sec, text))
                    logger.info("ASR chunk %d [%s-%ss]: %d chars", idx, start_sec, end_sec, len(text))

            return cues

    @staticmethod
    def _extract_audio(video_path: Path, output_wav: Path, sample_rate: int) -> None:
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            str(output_wav),
        ]
        subprocess.run(cmd, check=True, capture_output=True)

    def _split_wav(
        self,
        wav_path: Path,
        sample_rate: int,
    ) -> list[tuple[Path, float, float]]:
        max_bytes = self.max_local_file_mb * 1024 * 1024
        max_samples_by_size = max_bytes // 2
        max_samples_by_duration = self.chunk_duration_sec * sample_rate
        chunk_samples = min(max_samples_by_size, max_samples_by_duration)

        chunks: list[tuple[Path, float, float]] = []
        with wave.open(str(wav_path), "rb") as wf:
            n_channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            framerate = wf.getframerate()
            if n_channels != 1 or sampwidth != 2:
                raise ValueError(f"Expected mono 16-bit WAV, got ch={n_channels} width={sampwidth}")

            total_frames = wf.getnframes()
            cursor = 0
            part = 0
            while cursor < total_frames:
                frames = min(chunk_samples, total_frames - cursor)
                wf.setpos(cursor)
                data = wf.readframes(frames)
                start_sec = cursor / framerate
                end_sec = (cursor + frames) / framerate
                part += 1
                chunk_path = wav_path.parent / f"chunk_{part:04d}.wav"
                with wave.open(str(chunk_path), "wb") as out:
                    out.setnchannels(1)
                    out.setsampwidth(2)
                    out.setframerate(framerate)
                    out.writeframes(data)
                chunks.append((chunk_path, start_sec, end_sec))
                cursor += frames

        return chunks
