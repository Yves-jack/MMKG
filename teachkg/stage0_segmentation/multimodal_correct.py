"""
阶段 C：PPT 关键帧 OCR + LLM 多模态校对。

按 raw cue 归属 PPT 页（1/3 时长规则），跨页时合并多页 OCR 后统一校对。
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

import cv2

from teachkg.models.qwen_vl_ocr import QwenVLOCRModel
from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.ppt_page_utils import (
    PptPage,
    build_ppt_pages,
    ocr_timestamp_for_page,
    select_pages_for_cue,
)
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)

_OCR_FRAME_FILE_RE = re.compile(r"^ppt_page_(\d{3})(?:_\d+)?\.jpg$")


class MultimodalCorrector:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        llm_model: str | None = None,
        llm_client: LLMClient | None = None,
        ocr_model: str = "qwen-vl-ocr",
        enabled: bool = True,
        page_overlap_ratio: float = 1.0 / 3.0,
        group_consecutive_same_pages: bool = True,
        min_page_duration_sec: float = 1.0,
        ocr_frame_margin_before_flip_sec: float = 3.0,
        ocr_frame_settle_after_flip_sec: float = 2.0,
        ocr_frame_short_page_ratio: float = 0.85,
    ) -> None:
        self.api_key = api_key or os.environ.get("DASHSCOPE_API_KEY") or os.environ.get("ASR_API_KEY")
        self.base_url = base_url or os.environ.get(
            "DASHSCOPE_BASE_URL",
            os.environ.get("ASR_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        )
        if llm_client is not None:
            self.llm_client = llm_client
        else:
            settings = llm_settings_from_config(
                {},
                api_key=api_key,
                base_url=base_url,
                model=llm_model,
            )
            self.llm_client = LLMClient(**settings)
        self.llm_model = self.llm_client.model
        self.ocr_model = ocr_model
        self.enabled = enabled
        self.page_overlap_ratio = page_overlap_ratio
        self.group_consecutive_same_pages = group_consecutive_same_pages
        self.min_page_duration_sec = min_page_duration_sec
        self.ocr_frame_margin_before_flip_sec = ocr_frame_margin_before_flip_sec
        self.ocr_frame_settle_after_flip_sec = ocr_frame_settle_after_flip_sec
        self.ocr_frame_short_page_ratio = ocr_frame_short_page_ratio
        self._llm = None
        self._ocr: QwenVLOCRModel | None = None
        if enabled:
            self._ocr = QwenVLOCRModel(
                api_key=self.api_key,
                base_url=self.base_url,
                model=ocr_model,
            )

    def extract_ppt_frame(self, ppt_video: Path, timestamp_sec: float, output_path: Path) -> Path:
        cap = cv2.VideoCapture(str(ppt_video))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(timestamp_sec * fps))
        ok, frame = cap.read()
        cap.release()
        if not ok:
            raise RuntimeError(f"Cannot read PPT frame at {timestamp_sec}s from {ppt_video}")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(output_path), frame)
        return output_path

    def ocr_frame(self, image_path: Path) -> str:
        if self._ocr is None:
            return ""
        result = self._ocr.extract_text(image_path)
        return (result.text or "").strip()

    def _get_llm(self):
        return self.llm_client

    def correct_text(
        self,
        asr_text: str,
        ocr_text: str,
        course_context: str,
        prev_text: str = "",
    ) -> str:
        if not self.enabled or not asr_text.strip():
            return asr_text

        prompt = format_prompt(
            "asr_correct.txt",
            course_context=course_context or "（无）",
            ocr_text=ocr_text or "（无）",
            asr_text=asr_text,
            prev_text=prev_text or "（无）",
        )
        raw = self.llm_client.chat(prompt, temperature=0.1)
        return raw or asr_text

    def _ocr_frame_path_for_page(self, page: PptPage, work_dir: Path) -> Path:
        return work_dir / "ocr" / f"ppt_page_{page.index:03d}.jpg"

    def extract_page_frame(
        self,
        ppt_video: Path,
        page: PptPage,
        work_dir: Path,
        *,
        overwrite: bool = True,
    ) -> Path:
        """为单页 PPT 截取 OCR 用关键帧（不调用 OCR API）。"""
        frame_path = self._ocr_frame_path_for_page(page, work_dir)
        if overwrite or not frame_path.exists():
            ocr_ts = ocr_timestamp_for_page(
                page,
                margin_before_flip_sec=self.ocr_frame_margin_before_flip_sec,
                settle_after_flip_sec=self.ocr_frame_settle_after_flip_sec,
                short_page_ratio=self.ocr_frame_short_page_ratio,
            )
            self.extract_ppt_frame(ppt_video, ocr_ts, frame_path)
        return frame_path

    def extract_ocr_frames(
        self,
        ppt_video: Path,
        boundaries: list[float],
        video_duration: float,
        work_dir: Path,
        *,
        overwrite: bool = True,
    ) -> list[Path]:
        """按 PPT 页区间批量导出 OCR 截帧，不调用 OCR / LLM。"""
        pages = build_ppt_pages(boundaries, video_duration, self.min_page_duration_sec)
        if not pages:
            logger.warning("No PPT pages built; skip OCR frame export")
            return []

        paths: list[Path] = []
        for page in pages:
            try:
                path = self.extract_page_frame(
                    ppt_video, page, work_dir, overwrite=overwrite
                )
                paths.append(path)
                logger.info(
                    "OCR frame page %d: %.1fs → %s",
                    page.index,
                    ocr_timestamp_for_page(
                        page,
                        margin_before_flip_sec=self.ocr_frame_margin_before_flip_sec,
                        settle_after_flip_sec=self.ocr_frame_settle_after_flip_sec,
                        short_page_ratio=self.ocr_frame_short_page_ratio,
                    ),
                    path.name,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Frame export failed for page %d: %s", page.index, exc)

        logger.info("Exported %d OCR frame(s) to %s", len(paths), work_dir / "ocr")
        removed = self._cleanup_orphan_ocr_frames(work_dir / "ocr", pages)
        if removed:
            logger.info("Removed %d orphan OCR frame(s)", removed)
        return paths

    @staticmethod
    def _cleanup_orphan_ocr_frames(ocr_dir: Path, pages: list[PptPage]) -> int:
        """删除页索引不在当前页列表中的截帧（含超出页数的旧文件）。"""
        if not ocr_dir.is_dir():
            return 0

        active_indices = {page.index for page in pages}
        active_names = {f"ppt_page_{idx:03d}.jpg" for idx in active_indices}
        removed = 0
        for frame_file in ocr_dir.glob("ppt_page_*.jpg"):
            match = _OCR_FRAME_FILE_RE.match(frame_file.name)
            if match:
                page_idx = int(match.group(1))
                if page_idx in active_indices and frame_file.name in active_names:
                    continue
            elif frame_file.name in active_names:
                continue
            try:
                frame_file.unlink()
                removed += 1
                logger.debug("Removed orphan OCR frame: %s", frame_file.name)
            except OSError as exc:
                logger.warning("Failed to remove orphan OCR frame %s: %s", frame_file, exc)
        return removed

    def _ocr_for_page(
        self,
        ppt_video: Path,
        page: PptPage,
        work_dir: Path,
        cache: dict[int, str],
    ) -> str:
        if page.index in cache:
            return cache[page.index]

        ocr_ts = ocr_timestamp_for_page(
            page,
            margin_before_flip_sec=self.ocr_frame_margin_before_flip_sec,
            settle_after_flip_sec=self.ocr_frame_settle_after_flip_sec,
            short_page_ratio=self.ocr_frame_short_page_ratio,
        )
        frame_path = self._ocr_frame_path_for_page(page, work_dir)
        ocr_text = ""
        try:
            self.extract_ppt_frame(ppt_video, ocr_ts, frame_path)
            ocr_text = self.ocr_frame(frame_path)
        except Exception as exc:  # noqa: BLE001
            logger.warning("OCR failed for page %d at %.1fs: %s", page.index, ocr_ts, exc)

        cache[page.index] = ocr_text
        return ocr_text

    def _merge_ocr_for_pages(
        self,
        ppt_video: Path,
        pages: list[PptPage],
        work_dir: Path,
        cache: dict[int, str],
    ) -> str:
        parts: list[str] = []
        for page in sorted(pages, key=lambda p: p.index):
            text = self._ocr_for_page(ppt_video, page, work_dir, cache)
            if text:
                parts.append(text)
        return "\n\n".join(parts)

    def _group_cues_for_correction(
        self,
        cues: list[SubtitleCue],
        pages: list[PptPage],
    ) -> list[tuple[list[SubtitleCue], list[PptPage]]]:
        groups: list[tuple[list[SubtitleCue], list[PptPage]]] = []
        current_cues: list[SubtitleCue] = []
        current_pages: list[PptPage] = []
        current_key: frozenset[int] | None = None

        for cue in cues:
            if not cue.text.strip():
                continue
            selected = select_pages_for_cue(cue, pages, self.page_overlap_ratio)
            page_key = frozenset(p.index for p in selected)

            if (
                self.group_consecutive_same_pages
                and current_cues
                and page_key != current_key
            ):
                groups.append((current_cues, current_pages))
                current_cues = []
                current_pages = []

            current_cues.append(cue)
            current_pages = selected
            current_key = page_key

        if current_cues:
            groups.append((current_cues, current_pages))
        return groups

    def correct_cues_by_ppt_ranges(
        self,
        cues: list[SubtitleCue],
        ppt_video: Path,
        boundaries: list[float],
        video_duration: float,
        work_dir: Path,
        course_context: str = "",
    ) -> list[SubtitleCue]:
        if not cues:
            return []

        pages = build_ppt_pages(boundaries, video_duration, self.min_page_duration_sec)
        if not pages:
            logger.warning("No PPT pages built; returning raw cues unchanged")
            return cues

        ocr_cache: dict[int, str] = {}
        corrected: list[SubtitleCue] = []
        prev_text = ""
        groups = self._group_cues_for_correction(cues, pages)

        for group_cues, group_pages in groups:
            asr_text = " ".join(c.text.strip() for c in group_cues)
            ocr_text = self._merge_ocr_for_pages(ppt_video, group_pages, work_dir, ocr_cache)
            fixed = self.correct_text(asr_text, ocr_text, course_context, prev_text)
            corrected.append(
                SubtitleCue(
                    start_sec=group_cues[0].start_sec,
                    end_sec=group_cues[-1].end_sec,
                    text=fixed,
                )
            )
            prev_text = fixed[-120:] if len(fixed) > 120 else fixed

        logger.info(
            "Multimodal correct: %d raw cues → %d groups → %d corrected",
            len(cues),
            len(groups),
            len(corrected),
        )
        removed = self._cleanup_orphan_ocr_frames(work_dir / "ocr", pages)
        if removed:
            logger.info("Removed %d orphan OCR frame(s) after correction", removed)
        return corrected or cues
