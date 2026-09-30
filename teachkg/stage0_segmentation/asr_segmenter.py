"""
ASR 字幕生成（Qwen3-ASR-Flash）。

长课堂视频：AudioPreprocessor 抽音 + VAD 切段 → API 转写 → SRT。
主流水线请优先用 asr_pipeline / asr_primary；本模块为便捷旧入口。
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.qwen3_asr import Qwen3ASRClient
from teachkg.utils.time import any2sec, sec2hms

logger = logging.getLogger(__name__)


class ASRSegmenter:
    def __init__(
        self,
        backend: str = "qwen3_asr_flash",
        api_key: str | None = None,
        base_url: str | None = None,
        model: str = "qwen3-asr-flash",
        max_local_file_mb: int = 10,
        chunk_duration_sec: int = 120,
        language: str = "zh",
        enable_itn: bool = True,
        context: str = "",
    ) -> None:
        self.backend = backend
        self.context = context
        self.chunk_duration_sec = chunk_duration_sec
        self._client = Qwen3ASRClient(
            api_key=api_key,
            base_url=base_url,
            model=model,
            max_local_file_mb=max_local_file_mb,
            chunk_duration_sec=chunk_duration_sec,
            language=language,
            enable_itn=enable_itn,
        )

    def transcribe_video(self, video_path: str | Path, output_srt: str | Path | None = None) -> list[SubtitleCue]:
        video_path = Path(video_path)
        if self.backend == "srt_file":
            srt_path = output_srt or video_path.with_suffix(".srt")
            return self.parse_srt(srt_path)

        raw_cues = self._client.transcribe_video(video_path, context=self.context)
        cues = [SubtitleCue(start_sec=s, end_sec=e, text=t) for s, e, t in raw_cues]

        if output_srt and cues:
            self._write_srt(Path(output_srt), cues)

        return cues

    @staticmethod
    def _write_srt(srt_path: Path, cues: list[SubtitleCue]) -> None:
        srt_path.parent.mkdir(parents=True, exist_ok=True)
        lines: list[str] = []
        for idx, cue in enumerate(cues, 1):
            lines.extend(
                [
                    str(idx),
                    f"{sec2hms(cue.start_sec)} --> {sec2hms(cue.end_sec)}",
                    cue.text,
                    "",
                ]
            )
        srt_path.write_text("\n".join(lines), encoding="utf-8")
        logger.info("Saved SRT: %s (%d cues)", srt_path, len(cues))

    @staticmethod
    def parse_srt(srt_path: str | Path) -> list[SubtitleCue]:
        srt_path = Path(srt_path)
        if not srt_path.exists():
            raise FileNotFoundError(f"SRT not found: {srt_path}")

        try:
            import pysrt

            subs = pysrt.open(str(srt_path))
            cues: list[SubtitleCue] = []
            for sub in subs:
                start = (
                    sub.start.hours * 3600
                    + sub.start.minutes * 60
                    + sub.start.seconds
                    + sub.start.milliseconds / 1000.0
                )
                end = (
                    sub.end.hours * 3600
                    + sub.end.minutes * 60
                    + sub.end.seconds
                    + sub.end.milliseconds / 1000.0
                )
                cues.append(SubtitleCue(start_sec=start, end_sec=end, text=sub.text.strip()))
            return cues
        except ImportError:
            return ASRSegmenter._parse_srt_regex(srt_path)

    @staticmethod
    def _parse_srt_regex(srt_path: Path) -> list[SubtitleCue]:
        content = srt_path.read_text(encoding="utf-8")
        blocks = re.split(r"\n\s*\n", content.strip())
        cues: list[SubtitleCue] = []
        time_pat = re.compile(
            r"(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})"
        )
        for block in blocks:
            lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
            if len(lines) < 2:
                continue
            m = time_pat.search(block)
            if not m:
                continue
            text_lines = [ln for ln in lines if not ln.isdigit() and "-->" not in ln]
            text = " ".join(text_lines).strip()
            if text:
                cues.append(
                    SubtitleCue(
                        start_sec=any2sec(m.group(1)),
                        end_sec=any2sec(m.group(2)),
                        text=text,
                    )
                )
        return cues

    def process_lecture(
        self,
        class_video: Path,
        srt_dir: Path,
        use_existing: bool = True,
        context: str = "",
    ) -> list[SubtitleCue]:
        srt_path = srt_dir / f"{class_video.stem}.srt"
        if use_existing and srt_path.exists():
            logger.info("Loading existing SRT: %s", srt_path)
            return self.parse_srt(srt_path)

        if context:
            self.context = context
        return self.transcribe_video(class_video, srt_path)
