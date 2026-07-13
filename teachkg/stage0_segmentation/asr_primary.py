"""
阶段 B：Qwen3-ASR-Flash 主转写（按 VAD 语音段 + context 偏置）。
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.audio_preprocess import AudioPreprocessor, SpeechSegment
from teachkg.stage0_segmentation.qwen3_asr import Qwen3ASRClient

logger = logging.getLogger(__name__)


class PrimaryASR:
    def __init__(
        self,
        client: Qwen3ASRClient,
        preprocessor: AudioPreprocessor,
        base_context: str = "",
        *,
        max_retry: int = 5,
        retry_pause_sec: float = 5.0,
    ) -> None:
        self.client = client
        self.preprocessor = preprocessor
        self.base_context = base_context
        self.max_retry = max(1, int(max_retry))
        self.retry_pause_sec = float(retry_pause_sec)

    @staticmethod
    def _save_checkpoint(path: Path, cues: list[SubtitleCue], next_index: int) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "next_index": next_index,
            "cues": [c.to_dict() for c in cues],
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def _load_checkpoint(path: Path) -> tuple[list[SubtitleCue], int]:
        data = json.loads(path.read_text(encoding="utf-8"))
        cues = [SubtitleCue(**c) for c in data.get("cues", [])]
        return cues, int(data.get("next_index", len(cues)))

    def transcribe_vad_segments(
        self,
        wav_path: Path,
        segments: list[SpeechSegment],
        work_dir: Path,
        extra_context: str = "",
        checkpoint_path: Path | None = None,
    ) -> list[SubtitleCue]:
        """按 VAD 语音段 + context 偏置转写，支持 checkpoint 断点续跑。"""
        context = "\n".join(p for p in [self.base_context, extra_context] if p.strip())
        cues: list[SubtitleCue] = []
        start_idx = 0

        if checkpoint_path and checkpoint_path.exists():
            cues, start_idx = self._load_checkpoint(checkpoint_path)
            logger.info("Resume primary ASR from segment %d/%d", start_idx + 1, len(segments))

        for idx in range(start_idx, len(segments)):
            seg = segments[idx]
            chunk_path = work_dir / f"vad_{idx + 1:04d}.wav"
            self.preprocessor.cut_segment(wav_path, seg, chunk_path)
            text = ""
            last_exc: Exception | None = None
            for attempt in range(1, self.max_retry + 1):
                try:
                    text = self.client.transcribe_audio(chunk_path, context=context)
                    last_exc = None
                    break
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    logger.warning(
                        "Primary ASR %d/%d attempt %d/%d failed: %s",
                        idx + 1,
                        len(segments),
                        attempt,
                        self.max_retry,
                        exc,
                    )
                    if attempt < self.max_retry:
                        time.sleep(self.retry_pause_sec * attempt)
            if last_exc is not None:
                if checkpoint_path:
                    self._save_checkpoint(checkpoint_path, cues, idx)
                raise last_exc

            try:
                chunk_path.unlink(missing_ok=True)
            except OSError:
                pass

            if text.strip():
                cues.append(
                    SubtitleCue(
                        start_sec=seg.start_sec,
                        end_sec=seg.end_sec,
                        text=text.strip(),
                    )
                )
                logger.info(
                    "Primary ASR %d/%d [%.1f-%.1fs]: %d chars",
                    idx + 1,
                    len(segments),
                    seg.start_sec,
                    seg.end_sec,
                    len(text),
                )

            if checkpoint_path:
                self._save_checkpoint(checkpoint_path, cues, idx + 1)

        if checkpoint_path and checkpoint_path.exists():
            checkpoint_path.unlink(missing_ok=True)

        return cues
