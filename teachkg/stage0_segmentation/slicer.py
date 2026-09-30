"""
视频语义切片编排器。

前提：课堂录屏 + PPT 录屏成对。
ASR：VAD → Qwen3 → OCR+LLM 校对 → corrected_cues。
切片：以 PPT 语义段（corrected_cues）为单元切 clip，供 KG 与视频检索。
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from pathlib import Path
from typing import Any

from teachkg.config import TeachKGConfig
from teachkg.schemas import BoundaryType, SubtitleCue, VideoSegment
from teachkg.stage0_segmentation.asr_pipeline import HighAccuracyASRPipeline
from teachkg.stage0_segmentation.cue_merge import CueMergeSettings, merge_adjacent_cues, settings_from_config
from teachkg.stage0_segmentation.ppt_page_utils import build_ppt_pages
from teachkg.utils.io import save_jsonl
from teachkg.utils.time import parse_time_nodes_file

logger = logging.getLogger(__name__)

_TRIVIAL_TEXT = re.compile(r"^[\s\-—–·.…,，、]+$")
VIDEO_SUFFIXES = {".mp4", ".avi", ".mov", ".mkv", ".flv"}


class VideoSlicer:
    def __init__(self, config: TeachKGConfig) -> None:
        self.config = config
        s0 = config.get("stage0", default={})
        self.asr_pipeline = HighAccuracyASRPipeline(config)

        slicer_cfg = s0.get("slicer", {})
        self.min_duration = slicer_cfg.get("min_duration_sec", 3.0)
        self.min_text_chars = slicer_cfg.get("min_text_chars", 2)
        self.extract_clips = slicer_cfg.get("extract_clips", True)
        self.clip_subdir = slicer_cfg.get("clip_subdir", "cues")
        self.cleanup_orphan_clips = slicer_cfg.get("cleanup_orphan_clips", True)
        self.cue_merge_settings: CueMergeSettings = settings_from_config(s0.get("cue_merge", {}))

        corr_cfg = s0.get("asr_pipeline", {}).get("correction", {})
        self.min_page_duration_sec = float(corr_cfg.get("min_page_duration_sec", 1.0))

        tf = s0.get("time_filter", {})
        self.time_filter_enabled = tf.get("enabled", False)
        self.time_min = tf.get("min_sec", 0)
        self.time_max = tf.get("max_sec")

    def discover_lectures(self, workspace: Path) -> list[dict]:
        class_dir = workspace / "video" / "class"
        ppt_dir = workspace / "video" / "ppt"
        if not class_dir.exists():
            raise FileNotFoundError(f"Class video dir not found: {class_dir}")
        if not ppt_dir.exists():
            raise FileNotFoundError(f"PPT video dir not found: {ppt_dir}")

        lectures: list[dict] = []
        skipped: list[dict[str, str]] = []
        for class_video in sorted(class_dir.glob("*_0.*")):
            if class_video.suffix.lower() not in VIDEO_SUFFIXES:
                continue
            stem = class_video.stem
            lecture_id = stem[:-2] if stem.endswith("_0") else stem
            ppt_video = None
            for ext in sorted(VIDEO_SUFFIXES):
                candidate = ppt_dir / f"{lecture_id}_1{ext}"
                if candidate.exists():
                    ppt_video = candidate
                    break
            if ppt_video is None:
                skipped.append(
                    {
                        "lecture_id": lecture_id,
                        "reason": "missing_ppt",
                        "class_video": str(class_video),
                    }
                )
                logger.warning(
                    "Skip lecture %s: PPT video missing (expected %s)",
                    lecture_id,
                    ppt_dir / f"{lecture_id}_1.mp4",
                )
                continue
            lectures.append(
                {
                    "lecture_id": lecture_id,
                    "class_video": class_video,
                    "ppt_video": ppt_video,
                }
            )

        if skipped:
            logger.info("Skipped %d lecture(s) due to missing paired video", len(skipped))

        if not lectures:
            raise FileNotFoundError(f"No complete lecture pairs found in {class_dir}")
        return lectures

    def lecture_inventory(self, workspace: Path) -> dict[str, Any]:
        """扫描 workspace，返回可用/跳过/缺号讲次清单。"""
        class_dir = workspace / "video" / "class"
        ppt_dir = workspace / "video" / "ppt"
        class_ids: set[str] = set()
        ppt_ids: set[str] = set()
        if class_dir.is_dir():
            for p in class_dir.glob("*_0.*"):
                if p.suffix.lower() not in VIDEO_SUFFIXES:
                    continue
                stem = p.stem
                class_ids.add(stem[:-2] if stem.endswith("_0") else stem)
        if ppt_dir.is_dir():
            for p in ppt_dir.glob("*_1.*"):
                if p.suffix.lower() not in VIDEO_SUFFIXES:
                    continue
                stem = p.stem
                ppt_ids.add(stem[:-2] if stem.endswith("_1") else stem)

        available = sorted(class_ids & ppt_ids, key=lambda x: int(x) if x.isdigit() else x)
        only_class = sorted(class_ids - ppt_ids, key=lambda x: int(x) if x.isdigit() else x)
        only_ppt = sorted(ppt_ids - class_ids, key=lambda x: int(x) if x.isdigit() else x)

        gaps: list[str] = []
        if available:
            numeric = [int(x) for x in available if x.isdigit()]
            if numeric:
                lo, hi = min(numeric), max(numeric)
                gaps = [str(i) for i in range(lo, hi + 1) if str(i) not in available]

        return {
            "available": available,
            "skipped_incomplete": {
                "class_only": only_class,
                "ppt_only": only_ppt,
            },
            "gaps_in_range": gaps,
            "available_count": len(available),
        }

    def _filter_cues(self, cues: list[SubtitleCue]) -> list[SubtitleCue]:
        if not self.time_filter_enabled:
            return cues
        return [
            c
            for c in cues
            if c.start_sec >= self.time_min
            and (self.time_max is None or c.end_sec <= self.time_max)
        ]

    @staticmethod
    def _is_trivial_text(text: str) -> bool:
        cleaned = text.strip()
        if len(cleaned) < 2:
            return True
        return bool(_TRIVIAL_TEXT.match(cleaned))

    def _prepare_cues(
        self,
        cues: list[SubtitleCue],
        ppt_boundaries: list[float] | None = None,
        video_duration: float | None = None,
    ) -> list[SubtitleCue]:
        # 先按 PPT 主页合并 + 短口语段并入邻段，再按时长/字数过滤
        working = list(cues)
        if self.cue_merge_settings.enabled and len(working) >= 2:
            pages = None
            if ppt_boundaries is not None:
                dur = float(video_duration or 0.0)
                if dur <= 0 and working:
                    dur = max(c.end_sec for c in working)
                if dur > 0:
                    pages = build_ppt_pages(
                        ppt_boundaries,
                        dur,
                        min_page_duration_sec=self.min_page_duration_sec,
                    )
            working = merge_adjacent_cues(
                working,
                settings=self.cue_merge_settings,
                ppt_boundaries=ppt_boundaries,
                ppt_pages=pages,
            )

        final: list[SubtitleCue] = []
        for cue in working:
            text = cue.text.strip()
            if self._is_trivial_text(text):
                continue
            if len(text) < self.min_text_chars:
                continue
            if cue.end_sec - cue.start_sec < self.min_duration:
                continue
            final.append(SubtitleCue(start_sec=cue.start_sec, end_sec=cue.end_sec, text=text))

        logger.info("Cue prep: %d corrected → %d final", len(cues), len(final))
        return final

    @staticmethod
    def _make_cue_id(course_id: str, lecture_id: str, start_sec: float, end_sec: float) -> str:
        return f"{course_id}_{lecture_id}_{int(start_sec * 1000)}_{int(end_sec * 1000)}"

    def _extract_clip(self, source: Path, start_sec: float, end_sec: float, output: Path) -> str:
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists():
            return str(output)

        # -ss/-to 放在 -i 之后：按解码时间裁切，比 input-seek + copy 更贴近 cue 边界
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel", "error",
            "-y",
            "-i", str(source),
            "-ss", str(start_sec),
            "-to", str(end_sec),
            "-c", "copy",
            str(output),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True)
        except (subprocess.CalledProcessError, FileNotFoundError) as exc:
            logger.warning("ffmpeg clip extraction failed: %s", exc)
            return ""
        return str(output)

    def _cleanup_orphan_clips(self, clip_dir: Path, segments: list[VideoSegment]) -> int:
        if not clip_dir.is_dir():
            return 0

        active = {seg.segment_id for seg in segments}
        removed = 0
        for clip_file in clip_dir.glob("*.mp4"):
            if clip_file.stem in active:
                continue
            try:
                clip_file.unlink()
                removed += 1
            except OSError as exc:
                logger.warning("Failed to remove orphan clip %s: %s", clip_file, exc)

        if removed:
            logger.info("Cleaned %d orphan clip(s) from %s", removed, clip_dir)
        return removed

    def slice_lecture(
        self,
        course_id: str,
        lecture_id: str,
        class_video: Path,
        ppt_video: Path,
        output_dir: Path,
        course_context: str = "",
    ) -> list[VideoSegment]:
        output_dir.mkdir(parents=True, exist_ok=True)
        clip_dir = output_dir / self.clip_subdir

        cues = self.asr_pipeline.run(
            class_video=class_video,
            ppt_video=ppt_video,
            output_dir=output_dir,
            lecture_id=lecture_id,
            course_context=course_context,
        )
        seg_txt = output_dir / "ppt_change" / f"{lecture_id}_seg.txt"
        ppt_boundaries = parse_time_nodes_file(str(seg_txt)) if seg_txt.exists() else None
        video_duration = max((c.end_sec for c in cues), default=0.0)
        cues = self._prepare_cues(
            self._filter_cues(cues),
            ppt_boundaries=ppt_boundaries,
            video_duration=video_duration,
        )

        rel_srt = f"asr/{lecture_id}_0.srt"
        rel_corrected = f"asr_work/{lecture_id}/corrected_cues.json"
        segment_extra = {
            "text_source": "corrected_cues",
            "subtitle_srt": rel_srt,
            "corrected_cues_path": rel_corrected,
        }

        segments: list[VideoSegment] = []
        for cue in cues:
            cue_id = self._make_cue_id(course_id, lecture_id, cue.start_sec, cue.end_sec)
            clip_path = ""
            if self.extract_clips:
                clip_path = self._extract_clip(
                    class_video, cue.start_sec, cue.end_sec, clip_dir / f"{cue_id}.mp4"
                )
            segments.append(
                VideoSegment(
                    segment_id=cue_id,
                    course_id=course_id,
                    lecture_id=lecture_id,
                    source_video=str(class_video),
                    ppt_video=str(ppt_video),
                    start_sec=cue.start_sec,
                    end_sec=cue.end_sec,
                    boundary_type=BoundaryType.MERGED,
                    asr_text=cue.text,
                    clip_path=clip_path,
                    extra=dict(segment_extra),
                )
            )

        logger.info("Lecture %s: %d cue segments (corrected)", lecture_id, len(segments))
        return segments

    def run_workspace(
        self,
        workspace: Path,
        course_id: str | None = None,
        *,
        lecture_ids: list[str] | None = None,
    ) -> Path:
        workspace = Path(workspace)
        course_id = course_id or workspace.name
        output_dir = self.config.segments_dir / course_id
        course_context = HighAccuracyASRPipeline.load_course_context(workspace)

        all_segments: list[VideoSegment] = []
        lectures = self.discover_lectures(workspace)
        if lecture_ids:
            wanted = {str(x) for x in lecture_ids}
            lectures = [item for item in lectures if item["lecture_id"] in wanted]
            if not lectures:
                raise ValueError(f"No lectures matched lecture_ids={lecture_ids}")

        # 增量模式：保留未重跑讲次的已有 cues
        existing: list[VideoSegment] = []
        out_path = output_dir / "cues.jsonl"
        if lecture_ids and out_path.is_file():
            from teachkg.utils.io import load_jsonl

            rerun = {item["lecture_id"] for item in lectures}
            for row in load_jsonl(out_path):
                seg = VideoSegment.from_dict(row)
                if seg.lecture_id not in rerun:
                    existing.append(seg)
            if existing:
                logger.info("Keeping %d cues from other lectures", len(existing))

        for item in lectures:
            segs = self.slice_lecture(
                course_id=course_id,
                lecture_id=item["lecture_id"],
                class_video=item["class_video"],
                ppt_video=item["ppt_video"],
                output_dir=output_dir,
                course_context=course_context,
            )
            all_segments.extend(segs)

        all_segments = existing + all_segments
        save_jsonl(out_path, (s.to_dict() for s in all_segments))
        logger.info("Saved %d cues to %s", len(all_segments), out_path)

        lecture_ids_in_output = sorted({s.lecture_id for s in all_segments})
        manifest = {
            "course_id": course_id,
            "video_segments_path": str(out_path.name),
            "segment_count": len(all_segments),
            "text_source": "corrected_cues",
            "per_lecture": {
                lid: {
                    "corrected_cues": f"asr_work/{lid}/corrected_cues.json",
                    "subtitle_srt": f"asr/{lid}_0.srt",
                }
                for lid in lecture_ids_in_output
            },
        }
        manifest_path = output_dir / "stage0_manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("Wrote stage0 manifest: %s", manifest_path)

        if self.cleanup_orphan_clips and self.extract_clips:
            self._cleanup_orphan_clips(output_dir / self.clip_subdir, all_segments)

        return out_path
