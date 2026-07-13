"""Stage 1 复用 Stage 0 OCR 截帧。"""

from __future__ import annotations

from pathlib import Path

from teachkg.schemas import SubtitleCue, VideoSegment
from teachkg.stage0_segmentation.ppt_page_utils import (
    PptPage,
    build_ppt_pages,
    select_pages_for_cue,
)
from teachkg.utils.time import parse_time_nodes_file


def stage0_ocr_frame_path(
    segments_dir: Path,
    course_id: str,
    lecture_id: str,
    page_index: int,
) -> Path:
    return (
        segments_dir
        / course_id
        / "asr_work"
        / lecture_id
        / "ocr"
        / f"ppt_page_{page_index:03d}.jpg"
    )


def load_ppt_pages(
    segments_dir: Path,
    course_id: str,
    lecture_id: str,
    video_duration_sec: float,
    *,
    min_page_duration_sec: float = 1.0,
) -> list[PptPage]:
    seg_txt = segments_dir / course_id / "ppt_change" / f"{lecture_id}_seg.txt"
    if not seg_txt.is_file():
        return []
    boundaries = parse_time_nodes_file(str(seg_txt))
    return build_ppt_pages(boundaries, video_duration_sec, min_page_duration_sec)


def page_index_for_cue(cue: VideoSegment, pages: list[PptPage]) -> int | None:
    if not pages:
        return None
    selected = select_pages_for_cue(
        SubtitleCue(start_sec=cue.start_sec, end_sec=cue.end_sec, text=cue.asr_text),
        pages,
    )
    if not selected:
        return None
    return selected[0].index


def resolve_stage0_ppt_frame(
    segments_dir: Path,
    course_id: str,
    cue: VideoSegment,
    pages: list[PptPage],
    project_root: Path,
) -> str:
    page_idx = page_index_for_cue(cue, pages)
    if page_idx is None:
        return ""
    frame_path = stage0_ocr_frame_path(segments_dir, course_id, cue.lecture_id, page_idx)
    if not frame_path.is_file():
        return ""
    try:
        return str(frame_path.relative_to(project_root))
    except ValueError:
        return str(frame_path)
