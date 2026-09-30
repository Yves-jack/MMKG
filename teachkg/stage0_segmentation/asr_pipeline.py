"""
三阶段高精度 ASR 流水线编排：

A. 音频预处理 + Silero VAD
B. Qwen3-ASR-Flash 主转写
C. PPT OCR + LLM 校对 → corrected_cues（切片、KG、SRT 均以此为源）
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from pathlib import Path
from typing import Any

from teachkg.config import TeachKGConfig
from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.asr_primary import PrimaryASR
from teachkg.stage0_segmentation.audio_preprocess import AudioPreprocessor, SpeechSegment
from teachkg.stage0_segmentation.multimodal_correct import MultimodalCorrector
from teachkg.stage0_segmentation.ppt_detector import PPTDetector
from teachkg.stage0_segmentation.qwen3_asr import Qwen3ASRClient
from teachkg.utils.time import parse_time_nodes_file, sec2hms

logger = logging.getLogger(__name__)

_CUE_FIELDS = frozenset({"start_sec", "end_sec", "text"})


class HighAccuracyASRPipeline:
    def __init__(self, config: TeachKGConfig) -> None:
        self.config = config
        s0 = config.get("stage0", default={})
        pipe = s0.get("asr_pipeline", {})

        # 默认值与 configs/teaching.yaml 对齐，避免缺配置时行为跳变
        pre_cfg = pipe.get("preprocess", {})
        self.pre_cfg = pre_cfg
        self.preprocessor = AudioPreprocessor(
            sample_rate=pre_cfg.get("sample_rate", 16000),
            denoise=pre_cfg.get("denoise", True),
            loudnorm=pre_cfg.get("loudnorm", True),
            vad_threshold=pre_cfg.get("vad_threshold", 0.55),
            min_speech_sec=pre_cfg.get("min_speech_sec", 0.8),
            min_silence_sec=pre_cfg.get("min_silence_sec", 0.8),
            max_segment_sec=pre_cfg.get("max_segment_sec", 120.0),
            vad_split_overlap_sec=float(pre_cfg.get("vad_split_overlap_sec", 0.5)),
            torch_num_threads=pre_cfg.get("torch_num_threads"),
            onnx_intra_op_num_threads=pre_cfg.get("onnx_intra_op_num_threads"),
        )

        asr_cfg = pipe.get("primary_asr", s0.get("asr", {}))
        self.asr_cfg = asr_cfg
        self.qwen_client = Qwen3ASRClient(
            api_key=asr_cfg.get("api_key"),
            base_url=asr_cfg.get("base_url"),
            model=asr_cfg.get("model", "qwen3-asr-flash"),
            max_local_file_mb=asr_cfg.get("max_local_file_mb", 10),
            chunk_duration_sec=asr_cfg.get("chunk_duration_sec", 120),
            language=asr_cfg.get("language", "zh"),
            enable_itn=asr_cfg.get("enable_itn", True),
            overlap_sec=float(asr_cfg.get("overlap_sec", 0.0)),
        )
        llm_cfg = config.get("llm", default={})
        self.primary_asr = PrimaryASR(
            client=self.qwen_client,
            preprocessor=self.preprocessor,
            base_context=asr_cfg.get("context", ""),
            max_retry=int(asr_cfg.get("max_retry", llm_cfg.get("max_retry", 5))),
            retry_pause_sec=float(
                asr_cfg.get("retry_pause_sec", llm_cfg.get("retry_pause_sec", 5))
            ),
            max_retry_pause_sec=float(asr_cfg.get("max_retry_pause_sec", 60.0)),
            retry_jitter=bool(asr_cfg.get("retry_jitter", True)),
            remove_checkpoint_on_success=bool(
                asr_cfg.get("remove_checkpoint_on_success", True)
            ),
            max_workers=int(asr_cfg.get("max_workers", 4)),
        )

        corr_cfg = pipe.get("correction", {})
        self.corr_cfg = corr_cfg
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
        coarse_raw = ppt_cfg.get("coarse_interval_sec", 5.0)
        coarse_interval = None if coarse_raw in (None, "", False) else float(coarse_raw)
        self.ppt_detector = PPTDetector(
            sample_interval_sec=ppt_cfg.get("sample_interval_sec", 1),
            coarse_interval_sec=coarse_interval,
            ssim_threshold=ppt_cfg.get("ssim_threshold", 0.15),
            min_gap_sec=ppt_cfg.get("min_gap_sec", 2.0),
            min_page_sec=ppt_cfg.get("min_page_sec", 5.0),
            resize=tuple(ppt_cfg.get("resize", [320, 180])),
            title_cluster_enabled=ppt_cfg.get("title_cluster_enabled", True),
            title_similarity_threshold=ppt_cfg.get("title_similarity_threshold", 0.82),
            upper_half_similarity_threshold=ppt_cfg.get("upper_half_similarity_threshold", 0.78),
            title_crop=tuple(ppt_cfg.get("title_crop", [0.0, 0.0, 0.65, 0.14])),
            upper_half_crop=tuple(ppt_cfg.get("upper_half_crop", [0.0, 0.0, 1.0, 0.5])),
        )
        self.ppt_use_existing_seg = ppt_cfg.get("use_existing_seg", False)
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

    @staticmethod
    def _video_duration_sec(video_path: Path) -> float:
        import cv2

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            logger.warning("Cannot open video for duration: %s", video_path)
            return 0.0
        try:
            fps = cap.get(cv2.CAP_PROP_FPS)
            if not fps or fps <= 0 or math.isnan(fps):
                fps = 25.0
            frames = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
            return frames / fps if frames > 0 else 0.0
        finally:
            cap.release()

    @staticmethod
    def _file_identity(path: Path) -> dict[str, Any] | None:
        if not path.is_file():
            return None
        st = path.stat()
        return {
            "path": str(path.resolve()),
            "mtime_ns": int(st.st_mtime_ns),
            "size": int(st.st_size),
        }

    @staticmethod
    def _boundaries_fp(boundaries: list[float]) -> str:
        payload = "|".join(f"{b:.3f}" for b in boundaries)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def _meta_matches(saved: dict[str, Any] | None, expected: dict[str, Any]) -> bool:
        if not isinstance(saved, dict):
            return False
        for key, value in expected.items():
            if saved.get(key) != value:
                return False
        return True

    @staticmethod
    def _cue_from_dict(raw: dict[str, Any]) -> SubtitleCue:
        return SubtitleCue(**{k: raw[k] for k in _CUE_FIELDS if k in raw})

    def _context_hash(self, course_context: str) -> str:
        context = "\n".join(
            p for p in [self.asr_cfg.get("context", ""), course_context] if str(p).strip()
        )
        return PrimaryASR._hash_text(context)

    def _stage_a_meta(self, wav_path: Path) -> dict[str, Any]:
        return {
            **PrimaryASR._wav_identity(wav_path),
            "vad_threshold": float(self.preprocessor.vad_threshold),
            "min_speech_sec": float(self.preprocessor.min_speech_sec),
            "min_silence_sec": float(self.preprocessor.min_silence_sec),
            "max_segment_sec": float(self.preprocessor.max_segment_sec),
            "vad_split_overlap_sec": float(self.preprocessor.vad_split_overlap_sec),
            "sample_rate": int(self.preprocessor.sample_rate),
        }

    def _stage_b_meta(
        self,
        wav_path: Path,
        vad_segments: list[SpeechSegment],
        course_context: str,
    ) -> dict[str, Any]:
        return {
            **PrimaryASR._wav_identity(wav_path),
            "segment_count": len(vad_segments),
            "segments_fp": PrimaryASR._segments_fingerprint(vad_segments),
            "context_hash": self._context_hash(course_context),
            "asr_model": self.qwen_client.model_name,
            "asr_language": self.qwen_client.language,
            "asr_enable_itn": bool(self.qwen_client.enable_itn),
        }

    def _stage_c_meta(
        self,
        raw_cues: list[SubtitleCue],
        boundaries: list[float],
        ppt_duration: float,
        course_context: str,
        *,
        ppt_seg_identity: dict[str, Any] | None,
    ) -> dict[str, Any]:
        raw_fp = PrimaryASR._hash_text(
            "|".join(f"{c.start_sec:.3f}-{c.end_sec:.3f}:{c.text}" for c in raw_cues)
        )
        return {
            "raw_cues_fp": raw_fp,
            "raw_cue_count": len(raw_cues),
            "boundaries_fp": self._boundaries_fp(boundaries),
            "ppt_duration_sec": round(float(ppt_duration), 3),
            "correction_enabled": bool(self.corrector.enabled),
            "min_page_duration_sec": float(self.corrector.min_page_duration_sec),
            "group_consecutive_same_pages": bool(self.corrector.group_consecutive_same_pages),
            "context_hash": self._context_hash(course_context),
            "asr_model": self.qwen_client.model_name,
            "ppt_seg": ppt_seg_identity,
        }

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

    def _write_json(
        self,
        path: Path,
        cues: list[SubtitleCue],
        stage: str,
        meta: dict[str, Any] | None = None,
    ) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = {
            "stage": stage,
            "cues": [c.to_dict() for c in cues],
        }
        if meta is not None:
            payload["meta"] = meta
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _load_cues_with_meta(
        self,
        path: Path,
        expected_meta: dict[str, Any],
        *,
        label: str,
    ) -> list[SubtitleCue] | None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("%s unreadable (%s): %s → recompute", label, path, exc)
            return None
        if not self._meta_matches(data.get("meta"), expected_meta):
            logger.warning(
                "%s meta mismatch → discard reuse (%s)",
                label,
                path,
            )
            return None
        return [
            self._cue_from_dict(c)
            for c in data.get("cues", [])
            if isinstance(c, dict)
        ]

    def _load_vad_with_meta(
        self,
        path: Path,
        expected_meta: dict[str, Any],
    ) -> list[SpeechSegment] | None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("VAD artifact unreadable (%s): %s → recompute", path, exc)
            return None

        # 兼容旧格式：纯 list
        if isinstance(data, list):
            logger.warning(
                "VAD artifact missing meta (legacy list) → discard reuse (%s)",
                path,
            )
            return None

        if not self._meta_matches(data.get("meta"), expected_meta):
            logger.warning("VAD artifact meta mismatch → discard reuse (%s)", path)
            return None

        rows = data.get("segments", [])
        return [
            SpeechSegment(start_sec=float(s["start_sec"]), end_sec=float(s["end_sec"]))
            for s in rows
            if isinstance(s, dict)
        ]

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

        ppt_dir = output_dir / "ppt_change"
        seg_txt = ppt_dir / f"{lecture_id}_seg.txt"

        # —— Stage A: wav + VAD ——
        wav_path = work_dir / "preprocessed.wav"
        if self.use_existing and wav_path.exists():
            logger.info("Reuse preprocessed wav: %s", wav_path)
        else:
            self.preprocessor.extract_from_video(class_video, wav_path)

        stage_a_meta = self._stage_a_meta(wav_path)
        vad_path = work_dir / "vad_segments.json"
        vad_segments: list[SpeechSegment] | None = None
        if self.use_existing and vad_path.exists():
            vad_segments = self._load_vad_with_meta(vad_path, stage_a_meta)
        if vad_segments is None:
            vad_segments = self.preprocessor.detect_speech(wav_path)
            vad_path.write_text(
                json.dumps(
                    {
                        "meta": stage_a_meta,
                        "segments": [
                            {"start_sec": s.start_sec, "end_sec": s.end_sec}
                            for s in vad_segments
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        logger.info("Stage A: %d VAD segments", len(vad_segments))
        if not vad_segments:
            logger.warning(
                "Stage A produced 0 VAD segments for lecture %s — downstream will be empty",
                lecture_id,
            )

        # —— Stage B: ASR ——
        stage_b_meta = self._stage_b_meta(wav_path, vad_segments, course_context)
        raw_path = work_dir / "raw_cues.json"
        raw_checkpoint = work_dir / "raw_cues.checkpoint.json"
        raw_cues: list[SubtitleCue] | None = None
        if self.use_existing and raw_path.exists():
            raw_cues = self._load_cues_with_meta(
                raw_path, stage_b_meta, label="raw_cues.json"
            )
        if raw_cues is None:
            raw_cues = self.primary_asr.transcribe_vad_segments(
                wav_path,
                vad_segments,
                work_dir / "chunks",
                extra_context=course_context,
                checkpoint_path=raw_checkpoint,
            )
            self._write_json(raw_path, raw_cues, "primary_asr", meta=stage_b_meta)
        logger.info("Stage B: %d raw cues", len(raw_cues))
        if vad_segments and not raw_cues:
            logger.warning(
                "Stage B: all %d VAD segments yielded empty ASR text",
                len(vad_segments),
            )

        # —— PPT boundaries + duration（用 PPT 视频时长）——
        if self.ppt_use_existing_seg and seg_txt.exists():
            boundaries = parse_time_nodes_file(str(seg_txt))
        else:
            boundaries = self.ppt_detector.detect_and_save(ppt_video, seg_txt)

        ppt_duration = self._video_duration_sec(ppt_video)
        class_duration = self._video_duration_sec(class_video)
        if ppt_duration > 0 and class_duration > 0:
            drift = abs(ppt_duration - class_duration)
            if drift > 2.0:
                logger.warning(
                    "Class/PPT duration mismatch: class=%.1fs ppt=%.1fs drift=%.1fs "
                    "(page timeline uses PPT duration)",
                    class_duration,
                    ppt_duration,
                    drift,
                )
        if ppt_duration <= 0:
            ppt_duration = max((c.end_sec for c in raw_cues), default=class_duration)
            logger.warning(
                "PPT duration unavailable; fallback duration=%.1fs",
                ppt_duration,
            )

        # —— Stage C: multimodal correct ——
        ppt_seg_identity = self._file_identity(seg_txt)
        stage_c_meta = self._stage_c_meta(
            raw_cues,
            boundaries,
            ppt_duration,
            course_context,
            ppt_seg_identity=ppt_seg_identity,
        )
        corrected_cues: list[SubtitleCue] | None = None
        if self.use_existing and corrected_path.exists():
            corrected_cues = self._load_cues_with_meta(
                corrected_path, stage_c_meta, label="corrected_cues.json"
            )
            if corrected_cues is not None:
                logger.info(
                    "Reuse corrected cues: %d segments (%s)",
                    len(corrected_cues),
                    corrected_path,
                )
                return self._finalize(corrected_cues, final_srt)

        corrected_cues = self.corrector.correct_cues_by_ppt_ranges(
            raw_cues,
            ppt_video,
            boundaries,
            ppt_duration,
            work_dir,
            course_context=course_context,
        )
        self._write_json(
            corrected_path, corrected_cues, "multimodal_correct", meta=stage_c_meta
        )
        logger.info("Stage C: %d corrected cues", len(corrected_cues))

        return self._finalize(corrected_cues, final_srt)
