"""
三阶段高精度 ASR 流水线编排：

A. 音频预处理 + Silero VAD
B. Qwen3-ASR-Flash 主转写
C. PPT OCR + LLM 校对 → corrected_cues（切片、KG、SRT 均以此为源）
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from teachkg.config import TeachKGConfig
from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.asr_primary import PrimaryASR
from teachkg.stage0_segmentation.audio_preprocess import AudioPreprocessor, SpeechSegment
from teachkg.stage0_segmentation.multimodal_correct import MultimodalCorrector
from teachkg.stage0_segmentation.ppt_detector import PPTDetector
from teachkg.stage0_segmentation.qwen3_asr import Qwen3ASRClient
from teachkg.utils.time import parse_time_nodes_file, sec2hms

logger = logging.getLogger(__name__)


class HighAccuracyASRPipeline:
    def __init__(self, config: TeachKGConfig) -> None:
        self.config = config
        s0 = config.get("stage0", default={})
        pipe = s0.get("asr_pipeline", {})

        pre_cfg = pipe.get("preprocess", {})
        self.preprocessor = AudioPreprocessor(
            sample_rate=pre_cfg.get("sample_rate", 16000),
            denoise=pre_cfg.get("denoise", True),
            loudnorm=pre_cfg.get("loudnorm", True),
            vad_threshold=pre_cfg.get("vad_threshold", 0.5),
            min_speech_sec=pre_cfg.get("min_speech_sec", 0.3),
            min_silence_sec=pre_cfg.get("min_silence_sec", 0.4),
            max_segment_sec=pre_cfg.get("max_segment_sec", 120.0),
        )

        asr_cfg = pipe.get("primary_asr", s0.get("asr", {}))
        self.qwen_client = Qwen3ASRClient(
            api_key=asr_cfg.get("api_key"),
            base_url=asr_cfg.get("base_url"),
            model=asr_cfg.get("model", "qwen3-asr-flash"),
            max_local_file_mb=asr_cfg.get("max_local_file_mb", 10),
            chunk_duration_sec=asr_cfg.get("chunk_duration_sec", 120),
            language=asr_cfg.get("language", "zh"),
            enable_itn=asr_cfg.get("enable_itn", True),
        )
        llm_cfg = config.get("llm", default={})
        self.primary_asr = PrimaryASR(
            client=self.qwen_client,
            preprocessor=self.preprocessor,
            base_context=asr_cfg.get("context", ""),
            max_retry=int(asr_cfg.get("max_retry", llm_cfg.get("max_retry", 5))),
            retry_pause_sec=float(asr_cfg.get("retry_pause_sec", llm_cfg.get("retry_pause_sec", 5))),
        )

        corr_cfg = pipe.get("correction", {})
        llm_cfg = config.get("llm", default={})
        from teachkg.utils.llm_client import LLMClient, llm_settings_from_config

        corr_llm_settings = llm_settings_from_config(
            llm_cfg,
            api_key=corr_cfg.get("api_key"),
            base_url=corr_cfg.get("base_url"),
            model=corr_cfg.get("llm_model"),
        )
        self.corrector = MultimodalCorrector(
            llm_client=LLMClient(**corr_llm_settings),
            ocr_model=corr_cfg.get("ocr_model", "qwen-vl-ocr"),
            enabled=corr_cfg.get("enabled", True),
            page_overlap_ratio=corr_cfg.get("page_overlap_ratio", 1.0 / 3.0),
            group_consecutive_same_pages=corr_cfg.get("group_consecutive_same_pages", True),
            min_page_duration_sec=corr_cfg.get("min_page_duration_sec", 1.0),
            ocr_frame_margin_before_flip_sec=corr_cfg.get("ocr_frame_margin_before_flip_sec", 3.0),
            ocr_frame_settle_after_flip_sec=corr_cfg.get("ocr_frame_settle_after_flip_sec", 2.0),
            ocr_frame_short_page_ratio=corr_cfg.get("ocr_frame_short_page_ratio", 0.85),
            strip_prev_overlap=bool(corr_cfg.get("strip_prev_overlap", True)),
            prev_overlap_min_chars=int(corr_cfg.get("prev_overlap_min_chars", 8) or 8),
            prev_overlap_max_chars=int(corr_cfg.get("prev_overlap_max_chars", 160) or 160),
            prev_overlap_max_ratio=float(corr_cfg.get("prev_overlap_max_ratio", 0.55) or 0.55),
            prev_context_chars=int(corr_cfg.get("prev_context_chars", 120) or 120),
        )

        ppt_cfg = s0.get("ppt_detector", {})
        self.ppt_detector = PPTDetector(
            sample_interval_sec=ppt_cfg.get("sample_interval_sec", 5),
            ssim_threshold=ppt_cfg.get("ssim_threshold", 0.3),
            min_gap_sec=ppt_cfg.get("min_gap_sec", 3.0),
            min_page_sec=ppt_cfg.get("min_page_sec", 5.0),
            resize=tuple(ppt_cfg.get("resize", [320, 180])),
            title_cluster_enabled=ppt_cfg.get("title_cluster_enabled", True),
            title_similarity_threshold=ppt_cfg.get("title_similarity_threshold", 0.82),
            upper_half_similarity_threshold=ppt_cfg.get("upper_half_similarity_threshold", 0.78),
            title_crop=tuple(ppt_cfg.get("title_crop", [0.0, 0.0, 0.65, 0.14])),
            upper_half_crop=tuple(ppt_cfg.get("upper_half_crop", [0.0, 0.0, 1.0, 0.5])),
        )
        self.ppt_use_existing_seg = ppt_cfg.get("use_existing_seg", True)
        self.use_existing = pipe.get("use_existing_artifacts", True)

    @staticmethod
    def load_course_context(workspace: Path) -> str:
        syllabus_dir = workspace / "syllabus"
        if not syllabus_dir.exists():
            return ""
        parts: list[str] = []
        for path in sorted(syllabus_dir.glob("*")):
            if path.suffix.lower() in {".txt", ".md"}:
                parts.append(path.read_text(encoding="utf-8").strip())
            elif path.suffix.lower() == ".json":
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    parts.append(json.dumps(data, ensure_ascii=False))
                elif isinstance(data, list):
                    parts.append("\n".join(str(x) for x in data))
        return "\n\n".join(p for p in parts if p)

    def _write_srt(self, path: Path, cues: list[SubtitleCue]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
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
        path.write_text("\n".join(lines), encoding="utf-8")

    def _write_json(self, path: Path, cues: list[SubtitleCue], stage: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "stage": stage,
            "cues": [c.to_dict() for c in cues],
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _finalize(self, corrected_cues: list[SubtitleCue], final_srt: Path) -> list[SubtitleCue]:
        self._write_srt(final_srt, corrected_cues)
        logger.info(
            "Output: %d corrected segments → SRT %s",
            len(corrected_cues),
            final_srt,
        )
        return corrected_cues

    def run(
        self,
        class_video: Path,
        ppt_video: Path,
        output_dir: Path,
        lecture_id: str,
        course_context: str = "",
    ) -> list[SubtitleCue]:
        output_dir.mkdir(parents=True, exist_ok=True)
        work_dir = output_dir / "asr_work" / lecture_id
        work_dir.mkdir(parents=True, exist_ok=True)
        final_srt = output_dir / "asr" / f"{lecture_id}_0.srt"
        corrected_path = work_dir / "corrected_cues.json"

        if self.use_existing and corrected_path.exists():
            corrected_data = json.loads(corrected_path.read_text(encoding="utf-8"))
            corrected_cues = [SubtitleCue(**c) for c in corrected_data["cues"]]
            self._write_srt(final_srt, corrected_cues)
            logger.info(
                "Reuse corrected cues: %d segments (%s)",
                len(corrected_cues),
                corrected_path,
            )
            return corrected_cues

        wav_path = work_dir / "preprocessed.wav"
        if self.use_existing and wav_path.exists():
            logger.info("Reuse preprocessed wav: %s", wav_path)
        else:
            self.preprocessor.extract_from_video(class_video, wav_path)

        vad_path = work_dir / "vad_segments.json"
        if self.use_existing and vad_path.exists():
            vad_data = json.loads(vad_path.read_text(encoding="utf-8"))
            vad_segments = [SpeechSegment(**s) for s in vad_data]
        else:
            vad_segments = self.preprocessor.detect_speech(wav_path)
            vad_path.write_text(
                json.dumps(
                    [{"start_sec": s.start_sec, "end_sec": s.end_sec} for s in vad_segments],
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        logger.info("Stage A: %d VAD segments", len(vad_segments))

        raw_path = work_dir / "raw_cues.json"
        raw_checkpoint = work_dir / "raw_cues.checkpoint.json"
        if self.use_existing and raw_path.exists():
            raw_data = json.loads(raw_path.read_text(encoding="utf-8"))
            raw_cues = [SubtitleCue(**c) for c in raw_data["cues"]]
        else:
            raw_cues = self.primary_asr.transcribe_vad_segments(
                wav_path,
                vad_segments,
                work_dir / "chunks",
                extra_context=course_context,
                checkpoint_path=raw_checkpoint,
            )
            self._write_json(raw_path, raw_cues, "primary_asr")
        logger.info("Stage B: %d raw cues", len(raw_cues))

        ppt_dir = output_dir / "ppt_change"
        seg_txt = ppt_dir / f"{lecture_id}_seg.txt"
        if self.ppt_use_existing_seg and seg_txt.exists():
            boundaries = parse_time_nodes_file(str(seg_txt))
        else:
            boundaries = self.ppt_detector.detect_and_save(ppt_video, seg_txt)

        import cv2

        cap = cv2.VideoCapture(str(class_video))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        duration = cap.get(cv2.CAP_PROP_FRAME_COUNT) / fps if fps else 0.0
        cap.release()

        if self.use_existing and corrected_path.exists():
            corrected_data = json.loads(corrected_path.read_text(encoding="utf-8"))
            corrected_cues = [SubtitleCue(**c) for c in corrected_data["cues"]]
        else:
            corrected_cues = self.corrector.correct_cues_by_ppt_ranges(
                raw_cues,
                ppt_video,
                boundaries,
                duration,
                work_dir,
                course_context=course_context,
            )
            self._write_json(corrected_path, corrected_cues, "multimodal_correct")
        logger.info("Stage C: %d corrected cues", len(corrected_cues))

        return self._finalize(corrected_cues, final_srt)
