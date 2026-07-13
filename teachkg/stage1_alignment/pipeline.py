"""
Stage 1：cue 后处理 + 知识子图抽取。

输入：Stage 0 的 cues.jsonl
输出：
  - filtered_cues.jsonl（规则校验 + PPT 帧 + 三元组）
  - data/kg/{course_id}/triplets.jsonl（扁平三元组，带溯源）
"""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from teachkg.config import TeachKGConfig
from teachkg.schemas import VideoSegment
from teachkg.stage1_alignment.media_utils import resolve_path
from teachkg.stage1_alignment.stage0_frame import (
    load_ppt_pages,
    page_index_for_cue,
    resolve_stage0_ppt_frame,
)
from teachkg.stage1_alignment.text_preprocess import CueTextPreprocessor
from teachkg.stage1_alignment.triplet_extract import (
    Triplet,
    TripletExtractor,
    build_flat_triplet_records,
    load_course_context,
)
from teachkg.utils.io import load_jsonl, save_jsonl
from teachkg.utils.llm_client import LLMClient

logger = logging.getLogger(__name__)


@dataclass
class CueCheckResult:
    passed: bool = True
    reject_reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"passed": self.passed, "reject_reason": self.reject_reason}


@dataclass
class PreparedCue:
    cue: VideoSegment
    check: CueCheckResult = field(default_factory=CueCheckResult)
    ppt_frame_path: str = ""
    ppt_page_index: int | None = None
    extract_text: str = ""
    triplets: list[Triplet] = field(default_factory=list)
    triplet_error: str = ""
    triplet_validation: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = self.cue.to_dict()
        stage1: dict[str, Any] = {
            **self.check.to_dict(),
            "triplet_count": len(self.triplets),
        }
        if self.extract_text and self.extract_text != self.cue.asr_text.strip():
            stage1["extract_text"] = self.extract_text
        if self.triplet_error:
            stage1["triplet_error"] = self.triplet_error
        if self.triplet_validation:
            stage1["triplet_validation"] = self.triplet_validation
        data["stage1"] = stage1
        if self.triplets:
            data["triplets"] = [t.to_dict() for t in self.triplets]
        if self.ppt_frame_path:
            data.setdefault("extra", {})["ppt_frame_path"] = self.ppt_frame_path
        if self.ppt_page_index is not None:
            data.setdefault("extra", {})["ppt_page_index"] = self.ppt_page_index
        return data


class Stage1PreparePipeline:
    """规则校验 + Stage 0 OCR 帧 + LLM 三元组抽取。"""

    def __init__(
        self,
        config: TeachKGConfig,
        project_root: Path | None = None,
        mock: bool = False,
    ) -> None:
        self.config = config
        self.project_root = project_root or Path(__file__).resolve().parents[2]
        self.mock = mock
        s1 = config.get("stage1", default={})

        self.use_existing = s1.get("use_existing_artifacts", True)
        self.input_filename = s1.get("input_filename", "cues.jsonl")
        self.output_filename = s1.get("output_filename", "filtered_cues.jsonl")
        self.rejected_filename = s1.get("rejected_filename", "rejected_cues.jsonl")
        self.triplets_filename = s1.get("triplets_filename", "triplets.jsonl")
        llm_only_cfg = s1.get("llm_only", {})
        self.llm_only_enabled = llm_only_cfg.get("enabled", True)
        self.llm_only_triplets_filename = llm_only_cfg.get(
            "triplets_filename", "llm_only/triplets.jsonl"
        )
        self.sync_active_triplets = llm_only_cfg.get("sync_active_triplets", True)

        rules = s1.get("rules", {})
        self.require_clip = rules.get("require_clip", True)
        self.min_text_chars = rules.get("min_text_chars", 5)

        ppt_cfg = s1.get("ppt_frame", {})
        self.ppt_frame_enabled = ppt_cfg.get("enabled", True)
        self.ppt_frame_source = ppt_cfg.get("source", "stage0_ocr")
        self.legacy_ppt_frame_subdir = ppt_cfg.get("output_subdir", "ppt_frames")
        self.min_page_duration_sec = ppt_cfg.get("min_page_duration_sec", 1.0)

        self.llm_cfg = config.get("llm", default={})
        triplet_cfg = s1.get("triplet_extract", {})
        self.triplet_enabled = triplet_cfg.get("enabled", True)
        validate_cfg = triplet_cfg.get("validate", {})
        retry_cfg = validate_cfg.get("retry", {})
        preprocess_cfg = s1.get("text_preprocess", {})

        extract_client = self._make_llm_client(
            api_key=triplet_cfg.get("api_key"),
            base_url=triplet_cfg.get("base_url"),
            model=triplet_cfg.get("llm_model"),
        )
        validate_client = (
            self._make_llm_client(model=validate_cfg.get("llm_model"))
            if validate_cfg.get("llm_model")
            else extract_client
        )
        preprocess_client = self._make_llm_client(
            api_key=preprocess_cfg.get("llm", {}).get("api_key"),
            base_url=preprocess_cfg.get("llm", {}).get("base_url"),
            model=preprocess_cfg.get("llm", {}).get("llm_model"),
        )

        self.text_preprocessor = CueTextPreprocessor(
            enabled=preprocess_cfg.get("enabled", True),
            rule_options=preprocess_cfg.get("rules", {}),
            llm_enabled=preprocess_cfg.get("llm", {}).get("enabled", False),
            llm_prompt=preprocess_cfg.get("llm", {}).get("prompt", "teaching/cue_text_preprocess.txt"),
            llm_client=preprocess_client,
            temperature=preprocess_cfg.get("llm", {}).get("temperature", 0.1),
            mock=mock,
        )
        self.triplet_extractor: TripletExtractor | None = None
        if self.triplet_enabled:
            self.triplet_extractor = TripletExtractor(
                llm_client=extract_client,
                validate_client=validate_client,
                prompt_name=triplet_cfg.get("prompt", "teaching/subgraph_extract.txt"),
                temperature=triplet_cfg.get("temperature", 0.1),
                max_triplets_per_cue=triplet_cfg.get("max_triplets_per_cue", 30),
                mock=mock,
                validate_enabled=validate_cfg.get("enabled", True),
                validate_prompt=validate_cfg.get("prompt", "teaching/triplet_validate.txt"),
                retry_validate_prompt=validate_cfg.get("retry_prompt"),
                validate_temperature=validate_cfg.get("temperature", 0.0),
                retry_enabled=retry_cfg.get("enabled", True),
                retry_fix_enabled=retry_cfg.get("fix_enabled", True),
                retry_reextract_enabled=retry_cfg.get("reextract_enabled", True),
                retry_fix_fallback_reextract=retry_cfg.get("fix_fallback_reextract", True),
                max_fix_attempts=retry_cfg.get("max_fix_attempts", 3),
                max_reextract_attempts=retry_cfg.get("max_reextract_attempts", 3),
                fix_prompt=retry_cfg.get("fix_prompt", "teaching/triplet_fix.txt"),
                reextract_prompt=retry_cfg.get("reextract_prompt", "teaching/triplet_reextract.txt"),
            )

    def _make_llm_client(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ) -> LLMClient:
        from teachkg.utils.llm_client import llm_settings_from_config

        settings = llm_settings_from_config(
            self.llm_cfg,
            api_key=api_key,
            base_url=base_url,
            model=model,
        )
        return LLMClient(**settings)

    @property
    def kg_dir(self) -> Path:
        return Path(self.config.get("project", "kg_dir", default="data/kg"))

    @staticmethod
    def _load_triplets_excluding_lectures(
        path: Path,
        exclude_lectures: set[str] | None,
    ) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        if not exclude_lectures:
            return load_jsonl(path)
        return [
            r
            for r in load_jsonl(path)
            if str(r.get("lecture_id", "")) not in exclude_lectures
        ]

    @staticmethod
    def _tag_llm_only_triplets(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        tagged: list[dict[str, Any]] = []
        for row in records:
            item = dict(row)
            item["extract_source"] = "llm_only"
            tagged.append(item)
        return tagged

    def _check_rules(self, cue: VideoSegment) -> CueCheckResult:
        text = cue.asr_text.strip()
        if len(text) < self.min_text_chars:
            return CueCheckResult(passed=False, reject_reason="text_too_short")

        if self.require_clip:
            clip = resolve_path(cue.clip_path, self.project_root) if cue.clip_path else None
            if not clip or not clip.is_file():
                return CueCheckResult(passed=False, reject_reason="clip_missing")
        return CueCheckResult(passed=True)

    def _prepare_cue(
        self,
        cue: VideoSegment,
        course_id: str,
        pages_by_lecture: dict[str, list],
    ) -> PreparedCue:
        check = self._check_rules(cue)
        ppt_frame_path = ""
        ppt_page_index: int | None = None

        if self.ppt_frame_enabled and check.passed and self.ppt_frame_source == "stage0_ocr":
            pages = pages_by_lecture.get(cue.lecture_id, [])
            ppt_page_index = page_index_for_cue(cue, pages)
            ppt_frame_path = resolve_stage0_ppt_frame(
                self.config.segments_dir,
                course_id,
                cue,
                pages,
                self.project_root,
            )
            if ppt_page_index is not None and not ppt_frame_path:
                logger.warning(
                    "Stage 0 OCR frame missing for cue %s (page %d)",
                    cue.cue_id,
                    ppt_page_index,
                )

        return PreparedCue(
            cue=cue,
            check=check,
            ppt_frame_path=ppt_frame_path,
            ppt_page_index=ppt_page_index,
        )

    def _extract_triplets(
        self,
        prepared: PreparedCue,
        course_id: str,
        course_context: str,
    ) -> None:
        if not self.triplet_enabled or not self.triplet_extractor or not prepared.check.passed:
            return

        prepared.extract_text = self.text_preprocessor.process(
            prepared.cue.asr_text,
            course_context,
        )
        if not prepared.extract_text:
            prepared.triplet_error = "empty_text_after_preprocess"
            logger.warning("Empty text after preprocess for cue %s", prepared.cue.cue_id)
            return

        result = self.triplet_extractor.extract(prepared.extract_text, course_context)
        prepared.triplets = result.triplets
        prepared.triplet_error = result.error
        if result.validation:
            prepared.triplet_validation = result.validation.to_dict()
        if result.ok:
            logger.info(
                "Extracted %d triplets for cue %s",
                len(prepared.triplets),
                prepared.cue.cue_id,
            )
        else:
            logger.warning(
                "Triplet extraction failed for cue %s: %s",
                prepared.cue.cue_id,
                result.error,
            )

    @staticmethod
    def _cleanup_legacy_ppt_frames(frame_dir: Path) -> None:
        if frame_dir.is_dir():
            shutil.rmtree(frame_dir)
            logger.info("Removed legacy ppt_frames dir: %s", frame_dir)

    def _should_skip(self, output_path: Path, rejected_path: Path, triplets_path: Path) -> bool:
        if not self.use_existing:
            return False
        if not output_path.exists() or not rejected_path.exists():
            return False
        if self.triplet_enabled and not triplets_path.exists():
            return False
        return True

    def run(self, course_id: str, lecture_ids: list[str] | None = None) -> Path:
        input_path = self.config.segments_dir / course_id / self.input_filename
        output_dir = self.config.processed_dir / course_id
        output_path = output_dir / self.output_filename
        rejected_path = output_dir / self.rejected_filename
        report_path = output_dir / "stage1_report.json"
        triplets_path = self.kg_dir / course_id / self.triplets_filename
        llm_only_path = self.kg_dir / course_id / self.llm_only_triplets_filename
        rerun_lectures = {str(x) for x in lecture_ids} if lecture_ids else None

        if not input_path.exists():
            raise FileNotFoundError(f"Stage 0 cues not found: {input_path}")

        if self._should_skip(output_path, rejected_path, triplets_path) and not rerun_lectures:
            logger.info("Reuse existing Stage 1 output: %s", output_path)
            return output_path

        raw = load_jsonl(input_path)
        cues = [VideoSegment.from_dict(row) for row in raw]
        if rerun_lectures:
            cues = [c for c in cues if c.lecture_id in rerun_lectures]
            if not cues:
                raise ValueError(f"No cues matched lecture_ids={lecture_ids}")
            logger.info(
                "Stage 1 incremental: processing %d cues for lecture(s) %s",
                len(cues),
                sorted(rerun_lectures),
            )

        logger.info("Stage 1: preparing %d cues from %s", len(cues), input_path)

        pages_by_lecture: dict[str, list] = {}
        for lecture_id in {c.lecture_id for c in cues}:
            lecture_cues = [c for c in cues if c.lecture_id == lecture_id]
            duration = max((c.end_sec for c in lecture_cues), default=0.0)
            pages_by_lecture[lecture_id] = load_ppt_pages(
                self.config.segments_dir,
                course_id,
                lecture_id,
                duration,
                min_page_duration_sec=self.min_page_duration_sec,
            )

        course_context = load_course_context(
            self.config.workspace_dir,
            course_id,
            cue=cues[0] if cues else None,
        )

        prepared = [self._prepare_cue(cue, course_id, pages_by_lecture) for cue in cues]
        for item in prepared:
            self._extract_triplets(item, course_id, course_context)

        passed = [p for p in prepared if p.check.passed]
        rejected = [p for p in prepared if not p.check.passed]

        def _lecture_of_row(row: dict[str, Any]) -> str:
            return str(row.get("lecture_id", ""))

        existing_passed: list[dict[str, Any]] = []
        existing_rejected: list[dict[str, Any]] = []
        existing_triplets: list[dict[str, Any]] = []
        existing_llm_only: list[dict[str, Any]] = []
        if rerun_lectures:
            if output_path.is_file():
                existing_passed = [
                    r for r in load_jsonl(output_path) if _lecture_of_row(r) not in rerun_lectures
                ]
            if rejected_path.is_file():
                existing_rejected = [
                    r for r in load_jsonl(rejected_path) if _lecture_of_row(r) not in rerun_lectures
                ]
            if self.sync_active_triplets:
                existing_triplets = self._load_triplets_excluding_lectures(
                    triplets_path, rerun_lectures
                )
            if self.llm_only_enabled:
                existing_llm_only = self._load_triplets_excluding_lectures(
                    llm_only_path, rerun_lectures
                )

        output_dir.mkdir(parents=True, exist_ok=True)
        merged_passed = existing_passed + [p.to_dict() for p in passed]
        merged_rejected = existing_rejected + [p.to_dict() for p in rejected]
        save_jsonl(output_path, merged_passed)
        save_jsonl(rejected_path, merged_rejected)

        new_triplets: list[dict[str, Any]] = []
        for p in passed:
            new_triplets.extend(
                build_flat_triplet_records(
                    p.cue,
                    p.triplets,
                    course_id=course_id,
                    ppt_frame_path=p.ppt_frame_path,
                    ppt_page_index=p.ppt_page_index,
                )
            )

        if self.llm_only_enabled:
            llm_only_triplets = self._tag_llm_only_triplets(
                list(existing_llm_only if rerun_lectures else []) + new_triplets
            )
            llm_only_path.parent.mkdir(parents=True, exist_ok=True)
            save_jsonl(llm_only_path, llm_only_triplets)
            flat_triplets = llm_only_triplets
        else:
            flat_triplets = list(existing_triplets) + new_triplets

        if self.sync_active_triplets and not rerun_lectures:
            triplets_path.parent.mkdir(parents=True, exist_ok=True)
            save_jsonl(triplets_path, flat_triplets)
        elif self.sync_active_triplets and rerun_lectures:
            active_triplets = list(existing_triplets) + self._tag_llm_only_triplets(new_triplets)
            triplets_path.parent.mkdir(parents=True, exist_ok=True)
            save_jsonl(triplets_path, active_triplets)
            flat_triplets = active_triplets

        total_triplets = sum(len(p.triplets) for p in passed)
        triplet_validation_totals = {"pass": 0, "revise": 0, "discard": 0}
        for p in passed:
            counts = (p.triplet_validation or {}).get("counts", {})
            for key in triplet_validation_totals:
                triplet_validation_totals[key] += int(counts.get(key, 0))
        triplet_errors = [
            {"cue_id": p.cue.cue_id, "error": p.triplet_error}
            for p in passed
            if p.triplet_error
        ]

        prev_report: dict[str, Any] = {}
        if report_path.is_file():
            try:
                prev_report = json.loads(report_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                prev_report = {}

        report = {
            "course_id": course_id,
            "input_count": len(merged_passed) + len(merged_rejected),
            "passed_count": len(merged_passed),
            "rejected_count": len(merged_rejected),
            "ppt_frame_source": self.ppt_frame_source if self.ppt_frame_enabled else "disabled",
            "triplet_extract_enabled": self.triplet_enabled,
            "triplet_count": len(flat_triplets),
            "triplet_validation": triplet_validation_totals,
            "triplet_errors": triplet_errors,
            "filtered_cues_path": str(output_path),
            "rejected_cues_path": str(rejected_path),
            "triplets_path": str(triplets_path),
            "llm_only_triplets_path": str(llm_only_path) if self.llm_only_enabled else None,
            "extract_source_active": "llm_only" if self.sync_active_triplets else None,
            "incremental_lectures": sorted(rerun_lectures) if rerun_lectures else None,
            "rejected": [
                {"cue_id": p.cue.cue_id, "reason": p.check.reject_reason}
                for p in rejected
            ],
        }
        if rerun_lectures and prev_report:
            report["last_incremental"] = {
                "lectures": sorted(rerun_lectures),
                "new_triplets": total_triplets,
            }
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

        if self.ppt_frame_enabled and self.ppt_frame_source == "stage0_ocr":
            self._cleanup_legacy_ppt_frames(output_dir / self.legacy_ppt_frame_subdir)

        logger.info(
            "Stage 1 done: %d passed → %s, %d triplets (total %d) → %s, %d rejected → %s",
            len(merged_passed),
            output_path,
            total_triplets,
            len(flat_triplets),
            triplets_path,
            len(merged_rejected),
            rejected_path,
        )
        return output_path


Stage1AlignmentPipeline = Stage1PreparePipeline
