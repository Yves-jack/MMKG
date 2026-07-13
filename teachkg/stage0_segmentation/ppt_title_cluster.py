"""
PPT 翻页后处理：动画假翻页合并。

1. SSIM 初始翻页（见 ppt_detector）
2. 标题区域相似 → 归组可能由动画引起的假翻页
3. 上半区域相似 → 确认后合并（每组仅保留最后一个翻页点）
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

logger = logging.getLogger(__name__)

RegionSignature = np.ndarray
SignatureFn = Callable[[Path, float], RegionSignature | None]


@dataclass(frozen=True)
class BoundaryContext:
    boundary: float
    seg_start: float
    seg_end: float
    next_end: float

    @property
    def end_ts(self) -> float:
        return max(min(self.seg_end - 1.0, self.seg_end - 0.3), self.seg_start + 0.5)

    @property
    def next_start_ts(self) -> float:
        return segment_title_sample_ts(self.seg_end, self.next_end, 3.0)


def segment_title_sample_ts(
    start_sec: float,
    end_sec: float,
    sample_offset_sec: float = 3.0,
) -> float:
    """在页段开头稍后取样，标题通常最先出现。"""
    duration = max(end_sec - start_sec, 0.0)
    if duration <= 0:
        return start_sec
    offset = min(sample_offset_sec, duration * 0.15, max(duration - 0.5, 1.0))
    ts = start_sec + offset
    return min(max(ts, start_sec), end_sec - 0.3)


def extract_region_signature(
    video_path: Path,
    timestamp_sec: float,
    *,
    crop: tuple[float, float, float, float],
    signature_size: tuple[int, int],
) -> RegionSignature | None:
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return None

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(int(timestamp_sec * fps), 0))
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        return None

    h, w = frame.shape[:2]
    x0 = int(w * crop[0])
    y0 = int(h * crop[1])
    x1 = max(int(w * crop[2]), x0 + 1)
    y1 = max(int(h * crop[3]), y0 + 1)
    region = frame[y0:y1, x0:x1]
    if region.size == 0:
        return None

    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    return cv2.resize(gray, signature_size, interpolation=cv2.INTER_AREA)


def extract_title_signature(
    video_path: Path,
    timestamp_sec: float,
    *,
    title_crop: tuple[float, float, float, float] = (0.0, 0.0, 0.65, 0.14),
    signature_size: tuple[int, int] = (170, 36),
) -> RegionSignature | None:
    return extract_region_signature(
        video_path, timestamp_sec, crop=title_crop, signature_size=signature_size
    )


def extract_upper_half_signature(
    video_path: Path,
    timestamp_sec: float,
    *,
    upper_half_crop: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 0.5),
    signature_size: tuple[int, int] = (220, 120),
) -> RegionSignature | None:
    return extract_region_signature(
        video_path, timestamp_sec, crop=upper_half_crop, signature_size=signature_size
    )


def region_similarity(left: RegionSignature, right: RegionSignature) -> float:
    from skimage.metrics import structural_similarity

    if left.shape != right.shape:
        return 0.0
    score, _ = structural_similarity(left, right, full=True)
    return float(score)


def _boundary_contexts(
    boundaries: list[float],
    video_duration: float,
) -> list[BoundaryContext]:
    points = [0.0] + sorted(boundaries) + [video_duration]
    return [
        BoundaryContext(
            boundary=boundaries[bi],
            seg_start=points[bi],
            seg_end=points[bi + 1],
            next_end=points[bi + 2],
        )
        for bi in range(len(boundaries))
    ]


def _similarity_across_boundary(
    video_path: Path,
    ctx: BoundaryContext,
    *,
    crop: tuple[float, float, float, float],
    signature_size: tuple[int, int],
    extract_fn: SignatureFn | None = None,
) -> float | None:
    extract = extract_fn or (
        lambda path, ts: extract_region_signature(
            path, ts, crop=crop, signature_size=signature_size
        )
    )
    left = extract(video_path, ctx.end_ts)
    right = extract(video_path, ctx.next_start_ts)
    if left is None or right is None:
        return None
    return region_similarity(left, right)


def group_animation_false_flips(
    boundaries: list[float],
    video_path: Path,
    video_duration: float,
    *,
    title_similarity_threshold: float = 0.82,
    title_crop: tuple[float, float, float, float] = (0.0, 0.0, 0.65, 0.14),
    title_signature_size: tuple[int, int] = (170, 36),
    title_signature_fn: SignatureFn | None = None,
) -> list[list[float]]:
    """
    步骤 2：将标题区域相似的连续翻页点归为一组（疑似动画假翻页）。
    """
    if not boundaries:
        return []

    video_path = Path(video_path)
    contexts = _boundary_contexts(boundaries, video_duration)
    groups: list[list[float]] = []
    current: list[float] = []

    for ctx in contexts:
        title_sim = _similarity_across_boundary(
            video_path,
            ctx,
            crop=title_crop,
            signature_size=title_signature_size,
            extract_fn=title_signature_fn,
        )
        if title_sim is not None and title_sim >= title_similarity_threshold:
            current.append(ctx.boundary)
            continue
        if current:
            groups.append(current)
        current = []

    if current:
        groups.append(current)
    return groups


def merge_animation_flip_groups(
    boundaries: list[float],
    groups: list[list[float]],
    video_path: Path,
    video_duration: float,
    *,
    upper_half_similarity_threshold: float = 0.78,
    upper_half_crop: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 0.5),
    upper_half_signature_size: tuple[int, int] = (220, 120),
    upper_half_signature_fn: SignatureFn | None = None,
) -> list[float]:
    """
    步骤 3：对疑似假翻页组，用上半区域相似性确认后合并。
    """
    if not boundaries or not groups:
        return sorted(boundaries)

    video_path = Path(video_path)
    ctx_by_boundary = {
        ctx.boundary: ctx for ctx in _boundary_contexts(boundaries, video_duration)
    }
    to_remove: set[float] = set()

    for group in groups:
        upper_ok = True
        for boundary in group:
            ctx = ctx_by_boundary.get(boundary)
            if ctx is None:
                upper_ok = False
                break
            upper_sim = _similarity_across_boundary(
                video_path,
                ctx,
                crop=upper_half_crop,
                signature_size=upper_half_signature_size,
                extract_fn=upper_half_signature_fn,
            )
            if upper_sim is None or upper_sim < upper_half_similarity_threshold:
                upper_ok = False
                break

        if not upper_ok:
            continue

        if len(group) == 1:
            to_remove.add(group[0])
        else:
            to_remove.update(group[:-1])
        logger.debug(
            "Merge animation group %s → keep %s",
            [f"{b:.1f}" for b in group],
            f"{group[-1]:.1f}" if len(group) > 1 else "removed",
        )

    merged = [b for b in sorted(boundaries) if b not in to_remove]
    if len(merged) != len(boundaries):
        logger.info(
            "Animation flip merge: %d → %d boundaries (%d groups validated)",
            len(boundaries),
            len(merged),
            sum(1 for g in groups if g),
        )
    return merged


def refine_animation_false_flips(
    boundaries: list[float],
    video_path: Path,
    video_duration: float,
    *,
    title_similarity_threshold: float = 0.82,
    upper_half_similarity_threshold: float = 0.78,
    title_crop: tuple[float, float, float, float] = (0.0, 0.0, 0.65, 0.14),
    upper_half_crop: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 0.5),
    title_signature_fn: SignatureFn | None = None,
    upper_half_signature_fn: SignatureFn | None = None,
) -> list[float]:
    """步骤 2 + 3：标题聚类后按上半区域确认合并。"""
    groups = group_animation_false_flips(
        boundaries,
        video_path,
        video_duration,
        title_similarity_threshold=title_similarity_threshold,
        title_crop=title_crop,
        title_signature_fn=title_signature_fn,
    )
    if not groups:
        return sorted(boundaries)

    logger.info(
        "Title clustering: %d candidate animation group(s) in %s",
        len(groups),
        Path(video_path).name,
    )
    return merge_animation_flip_groups(
        boundaries,
        groups,
        video_path,
        video_duration,
        upper_half_similarity_threshold=upper_half_similarity_threshold,
        upper_half_crop=upper_half_crop,
        upper_half_signature_fn=upper_half_signature_fn,
    )


# 向后兼容旧调用名
merge_same_title_boundaries = refine_animation_false_flips
