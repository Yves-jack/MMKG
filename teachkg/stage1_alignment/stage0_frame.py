"""Stage 1 复用 Stage 0 OCR 截帧与页级 OCR 文本。

目录约定（相对 ``segments_dir``）::

    {course_id}/asr_work/{lecture_id}/ocr/ppt_page_XXX.jpg   # 页级截帧
    {course_id}/asr_work/{lecture_id}/ocr/ppt_ocr.json       # 页级 OCR 文本缓存
    {course_id}/ppt_change/{lecture_id}_seg.txt              # PPT 翻页时间点
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from teachkg.schemas import SubtitleCue, VideoSegment
from teachkg.stage0_segmentation.ppt_page_utils import (
    PptPage,
    build_ppt_pages,
    select_pages_for_cue,
)
from teachkg.utils.time import parse_time_nodes_file

logger = logging.getLogger(__name__)


def stage0_ocr_dir(segments_dir: Path, course_id: str, lecture_id: str) -> Path:
    """返回某讲 Stage0 OCR 工作目录路径（不要求目录已存在）。

    Args:
        segments_dir: 分段根目录，通常为 ``data/segments``。
        course_id: 课程 ID。
        lecture_id: 讲次 ID（如 ``"17"``）。

    Returns:
        ``.../asr_work/{lecture_id}/ocr`` 路径。
    """
    return segments_dir / course_id / "asr_work" / lecture_id / "ocr"


def stage0_ocr_frame_path(
    segments_dir: Path,
    course_id: str,
    lecture_id: str,
    page_index: int,
) -> Path:
    """构造指定 PPT 页的截帧文件路径。

    Args:
        segments_dir: 分段根目录。
        course_id: 课程 ID。
        lecture_id: 讲次 ID。
        page_index: 页索引（从 0 起，对应 ``ppt_page_000.jpg``）。

    Returns:
        截帧 jpg 的绝对/相对 Path（由 ``segments_dir`` 决定）。
    """
    return stage0_ocr_dir(segments_dir, course_id, lecture_id) / f"ppt_page_{page_index:03d}.jpg"


def stage0_ppt_ocr_cache_path(
    segments_dir: Path,
    course_id: str,
    lecture_id: str,
) -> Path:
    """构造页级 OCR 文本缓存文件路径（``ppt_ocr.json``）。

    Args:
        segments_dir: 分段根目录。
        course_id: 课程 ID。
        lecture_id: 讲次 ID。

    Returns:
        ``ocr/ppt_ocr.json`` 路径；由 Stage0 多模态校对写入。
    """
    return stage0_ocr_dir(segments_dir, course_id, lecture_id) / "ppt_ocr.json"


def load_ppt_ocr_texts(
    segments_dir: Path,
    course_id: str,
    lecture_id: str,
) -> dict[int, str]:
    """读取 Stage0 持久化的页级 OCR 文本。

    缓存 JSON 格式::

        {"pages": {"0": "第一页文字...", "1": "..."}}

    Args:
        segments_dir: 分段根目录。
        course_id: 课程 ID。
        lecture_id: 讲次 ID。

    Returns:
        ``页索引 → OCR 文本``；文件不存在或损坏时返回空 dict（不抛异常）。
    """
    path = stage0_ppt_ocr_cache_path(segments_dir, course_id, lecture_id)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("PPT OCR cache unreadable (%s): %s", path, exc)
        return {}
    pages = data.get("pages") if isinstance(data, dict) else None
    if not isinstance(pages, dict):
        return {}
    out: dict[int, str] = {}
    for k, v in pages.items():
        try:
            idx = int(k)
        except (TypeError, ValueError):
            continue
        text = str(v or "").strip()
        if text:
            out[idx] = text
    return out


def load_ppt_pages(
    segments_dir: Path,
    course_id: str,
    lecture_id: str,
    video_duration_sec: float,
    *,
    min_page_duration_sec: float = 1.0,
) -> list[PptPage]:
    """根据 Stage0 翻页时间点文件构建本讲 PPT 页列表。

    Args:
        segments_dir: 分段根目录。
        course_id: 课程 ID。
        lecture_id: 讲次 ID。
        video_duration_sec: 视频总时长（秒），用于闭合最后一页的 end。
        min_page_duration_sec: 短于此时长的页会被合并/丢弃（与 Stage0 一致）。

    Returns:
        ``PptPage`` 列表；无 ``*_seg.txt`` 时返回空列表。
    """
    seg_txt = segments_dir / course_id / "ppt_change" / f"{lecture_id}_seg.txt"
    if not seg_txt.is_file():
        return []
    boundaries = parse_time_nodes_file(str(seg_txt))
    return build_ppt_pages(boundaries, video_duration_sec, min_page_duration_sec)


def page_index_for_cue(cue: VideoSegment, pages: list[PptPage]) -> int | None:
    """为 cue 选择主归属 PPT 页索引。

    Args:
        cue: Stage0 产出的视频片段（含起止时间与 ASR 文本）。
        pages: 本讲全部 PPT 页。

    Returns:
        主页 ``index``；无页或时间窗无法命中时返回 ``None``。
    """
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
    """解析 cue 对应的 Stage0 OCR 截帧路径（相对项目根优先）。

    Args:
        segments_dir: 分段根目录。
        course_id: 课程 ID。
        cue: 当前 cue。
        pages: 本讲 PPT 页列表（需事先 ``load_ppt_pages``）。
        project_root: 项目根，用于尽量输出相对路径。

    Returns:
        相对 ``project_root`` 的路径字符串；无页、缺帧或路径无法相对化时
        返回空串或绝对路径字符串。
    """
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
