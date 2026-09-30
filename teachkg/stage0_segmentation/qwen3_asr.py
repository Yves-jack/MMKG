"""
Qwen3-ASR-Flash 客户端：薄封装 API 转写。

音视频预处理（抽音 / VAD / 切段）统一走 ``AudioPreprocessor``，
本模块只负责调用模型；``transcribe_video`` 为兼容旧入口的便捷封装。
"""

from __future__ import annotations

import logging
import os
import tempfile
import threading
from pathlib import Path

from teachkg.models.qwen3_asr_flash import Qwen3ASRFlashModel
from teachkg.stage0_segmentation.audio_preprocess import AudioPreprocessor

logger = logging.getLogger(__name__)


class Qwen3ASRClient:
    """对课堂音频做 API 转写；可选便捷视频入口复用 AudioPreprocessor。"""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str = "qwen3-asr-flash",
        max_local_file_mb: int = 10,
        chunk_duration_sec: int = 120,
        language: str = "zh",
        enable_itn: bool = True,
        *,
        overlap_sec: float = 0.0,
    ) -> None:
        self.api_key = api_key or os.environ.get("DASHSCOPE_API_KEY")
        if not self.api_key:
            raise ValueError("未提供 api_key，且环境变量 DASHSCOPE_API_KEY 未设置")
        self.base_url = base_url or os.environ.get(
            "DASHSCOPE_BASE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
        self.model_name = model
        self.max_local_file_mb = max(1, int(max_local_file_mb))
        # 仅供 transcribe_video 传给 AudioPreprocessor.max_segment_sec / 切段重叠
        self.chunk_duration_sec = max(1, int(chunk_duration_sec))
        self.language = language
        self.enable_itn = enable_itn
        self.overlap_sec = max(0.0, float(overlap_sec))
        self._model: Qwen3ASRFlashModel | None = None
        self._lock = threading.Lock()

    def _get_model(self) -> Qwen3ASRFlashModel:
        if self._model is None:
            with self._lock:
                if self._model is None:
                    self._model = Qwen3ASRFlashModel(
                        api_key=self.api_key,
                        base_url=self.base_url,
                        model=self.model_name,
                        max_local_file_mb=self.max_local_file_mb,
                    )
        return self._model

    def transcribe_audio(self, audio_path: str | Path, context: str = "") -> str:
        """转写单个音频文件，返回纯文本。主路径（asr_primary）只调用本方法。"""
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
        """兼容旧入口：抽音 + VAD 切段后逐段转写（预处理复用 AudioPreprocessor）。"""

        video_path = Path(video_path)
        if not video_path.is_file():
            raise FileNotFoundError(f"视频不存在: {video_path}")

        preprocessor = AudioPreprocessor(
            sample_rate=sample_rate,
            max_segment_sec=float(self.chunk_duration_sec),
            vad_split_overlap_sec=self.overlap_sec,
        )

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            full_wav = tmp_dir / "full.wav"
            preprocessor.extract_from_video(video_path, full_wav)
            segments = preprocessor.detect_speech(full_wav)

            cues: list[tuple[float, float, str]] = []
            for idx, seg in enumerate(segments, 1):
                chunk_path = tmp_dir / f"vad_{idx:04d}.wav"
                preprocessor.cut_segment(full_wav, seg, chunk_path)
                text = self.transcribe_audio(chunk_path, context=context)
                if text:
                    cues.append((seg.start_sec, seg.end_sec, text))
                    logger.info(
                        "ASR chunk %d [%.2f-%.2fs]: %d chars",
                        idx, seg.start_sec, seg.end_sec, len(text),
                    )
                else:
                    logger.debug(
                        "ASR chunk %d [%.2f-%.2fs] 为空",
                        idx, seg.start_sec, seg.end_sec,
                    )

            return cues
