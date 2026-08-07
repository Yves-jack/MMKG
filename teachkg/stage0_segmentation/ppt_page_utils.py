"""PPT 翻页区间与 cue 页归属判定。"""

from __future__ import annotations

from dataclasses import dataclass

from teachkg.schemas import SubtitleCue


@dataclass(frozen=True)
class PptPage:
    index: int
    start_sec: float
    end_sec: float

    @property
    def duration_sec(self) -> float:
        return max(self.end_sec - self.start_sec, 0.0)


def filter_short_page_boundaries(
    boundaries: list[float],
    min_page_sec: float = 5.0,
) -> list[float]:
    """
    去掉会产生过短页区间的翻页点。

    课堂 PPT 的逐条动画会在几秒内多次触发 SSIM 突变，但并非真翻页；
    若相邻翻页点间隔 < min_page_sec，则丢弃前一个点，把短段并入后续页。
    """
    if not boundaries or min_page_sec <= 0:
        return sorted(boundaries)

    kept: list[float] = []
    for ts in sorted(boundaries):
        anchor = kept[-1] if kept else 0.0
        if ts - anchor < min_page_sec:
            continue
        kept.append(ts)
    return kept


def build_ppt_pages(
    boundaries: list[float],
    video_duration: float,
    min_page_duration_sec: float = 1.0,
) -> list[PptPage]:
    points = [0.0] + sorted(boundaries) + [video_duration]
    pages: list[PptPage] = []
    for idx in range(len(points) - 1):
        start, end = points[idx], points[idx + 1]
        if end - start < min_page_duration_sec:
            continue
        pages.append(PptPage(index=len(pages), start_sec=start, end_sec=end))
    return pages


def overlap_sec(cue_start: float, cue_end: float, page_start: float, page_end: float) -> float:
    return max(0.0, min(cue_end, page_end) - max(cue_start, page_start))


def segment_sample_timestamp(
    start_sec: float,
    end_sec: float,
    *,
    margin_before_end_sec: float = 3.0,
    settle_after_start_sec: float = 2.0,
    short_segment_ratio: float = 0.85,
    min_buffer_sec: float = 0.5,
) -> float:
    """
    为时间段（PPT 页或 cue 片段）选取靠后截帧时刻。

    课堂录屏里幻灯片常有逐条动画，完整内容往往在段末才展示完；
    因此优先在结束前截帧，并避开段首动画区间。
    """
    duration = max(end_sec - start_sec, 0.0)
    if duration <= 0:
        return start_sec

    ts = end_sec - margin_before_end_sec
    ts = max(ts, start_sec + settle_after_start_sec)

    if ts <= start_sec + min_buffer_sec:
        ts = start_sec + duration * short_segment_ratio

    ts = min(ts, end_sec - min_buffer_sec)
    return max(start_sec, ts)


def ocr_timestamp_for_page(
    page: PptPage,
    *,
    margin_before_flip_sec: float = 3.0,
    settle_after_flip_sec: float = 2.0,
    short_page_ratio: float = 0.85,
    min_buffer_sec: float = 0.5,
) -> float:
    """为 PPT OCR 选取截帧时刻（页区间）。"""
    return segment_sample_timestamp(
        page.start_sec,
        page.end_sec,
        margin_before_end_sec=margin_before_flip_sec,
        settle_after_start_sec=settle_after_flip_sec,
        short_segment_ratio=short_page_ratio,
        min_buffer_sec=min_buffer_sec,
    )


def select_pages_for_cue(
    cue: SubtitleCue,
    pages: list[PptPage],
    overlap_ratio: float = 1.0 / 3.0,
) -> list[PptPage]:
    """
    取能完整盖住 cue 时间窗的最小连续 PPT 页区间。

    - 先找与 cue 有任意重叠的页，再取「最左重叠页 … 最右重叠页」闭区间；
    - 若 cue 落在页缝/无重叠，则回退到时间中点最近的一页。

    ``overlap_ratio`` 保留兼容旧调用，已不再参与筛选。
    """
    del overlap_ratio  # 兼容旧签名
    if not pages:
        return []

    overlapping = [
        page
        for page in pages
        if overlap_sec(cue.start_sec, cue.end_sec, page.start_sec, page.end_sec) > 0
    ]
    if overlapping:
        lo = min(p.index for p in overlapping)
        hi = max(p.index for p in overlapping)
        by_index = {p.index: p for p in pages}
        return [by_index[i] for i in range(lo, hi + 1) if i in by_index]

    mid = (cue.start_sec + cue.end_sec) / 2.0
    fallback = min(pages, key=lambda p: abs((p.start_sec + p.end_sec) / 2.0 - mid))
    return [fallback]


def primary_page_for_cue(cue: SubtitleCue, pages: list[PptPage]) -> PptPage | None:
    """cue 的主归属页：与 cue 时间重叠最长的 PPT 页；无重叠则取中点最近页。"""
    if not pages:
        return None

    best: PptPage | None = None
    best_ov = -1.0
    for page in pages:
        ov = overlap_sec(cue.start_sec, cue.end_sec, page.start_sec, page.end_sec)
        if ov > best_ov:
            best_ov = ov
            best = page
    if best is not None and best_ov > 0:
        return best

    mid = (cue.start_sec + cue.end_sec) / 2.0
    return min(pages, key=lambda p: abs((p.start_sec + p.end_sec) / 2.0 - mid))

