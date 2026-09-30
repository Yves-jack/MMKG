"""
相邻 ASR cue 的通用合并启发式。

不依赖课程/语言特定的正则，基于相对统计、时长间隔、符号密度、
句末完整性、文本包含关系；支持 PPT 翻页边界约束与多轮收敛合并。
"""

from __future__ import annotations

import logging
import re
import statistics
from dataclasses import dataclass

from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.ppt_page_utils import PptPage, primary_page_for_cue

logger = logging.getLogger(__name__)

_TERMINAL_PUNCT = frozenset(".。!！?？;；:：)]}」』\"'")

_SYMBOL_CHAR = re.compile(
    r"[^\w"
    r"\u4e00-\u9fff"
    r"\u3400-\u4dbf"
    r"\uf900-\ufaff"
    r"]",
    re.UNICODE,
)


@dataclass
class CueMergeSettings:
    enabled: bool = True
    max_gap_sec: float = 3.0
    cross_page_max_gap_sec: float = 0.5
    max_merged_duration_sec: float = 120.0
    min_merged_chars: int = 25
    fragment_score_threshold: float = 0.42
    neighbor_len_ratio: float = 0.45
    neighbor_dur_ratio: float = 0.55
    symbol_ratio_weight: float = 0.35
    incomplete_sentence_weight: float = 0.25
    max_passes: int = 3
    absorb_short_duration_sec: float = 3.0
    absorb_short_chars: int = 20
    # 短口语段吸收邻段时允许的最大间隔（不按 PPT 跨页收紧）
    absorb_max_gap_sec: float = 3.0
    # 同一主归属 PPT 页的 cue 合并为一段（与截图大致一一对应）
    merge_by_ppt_page: bool = True


@dataclass
class _CueStats:
    median_chars: float
    median_duration: float


def settings_from_config(cfg: dict) -> CueMergeSettings:
    return CueMergeSettings(
        enabled=cfg.get("enabled", True),
        max_gap_sec=cfg.get("max_gap_sec", 3.0),
        cross_page_max_gap_sec=cfg.get("cross_page_max_gap_sec", 0.5),
        max_merged_duration_sec=cfg.get("max_merged_duration_sec", 120.0),
        min_merged_chars=cfg.get("min_merged_chars", 25),
        fragment_score_threshold=cfg.get("fragment_score_threshold", 0.42),
        neighbor_len_ratio=cfg.get("neighbor_len_ratio", 0.45),
        neighbor_dur_ratio=cfg.get("neighbor_dur_ratio", 0.55),
        symbol_ratio_weight=cfg.get("symbol_ratio_weight", 0.35),
        incomplete_sentence_weight=cfg.get("incomplete_sentence_weight", 0.25),
        max_passes=cfg.get("max_passes", 3),
        absorb_short_duration_sec=cfg.get("absorb_short_duration_sec", 3.0),
        absorb_short_chars=cfg.get("absorb_short_chars", 20),
        absorb_max_gap_sec=cfg.get("absorb_max_gap_sec", 3.0),
        merge_by_ppt_page=cfg.get("merge_by_ppt_page", True),
    )


def _duration(cue: SubtitleCue) -> float:
    return max(cue.end_sec - cue.start_sec, 0.0)


def _mid_sec(cue: SubtitleCue) -> float:
    return (cue.start_sec + cue.end_sec) / 2.0


def _symbol_ratio(text: str) -> float:
    stripped = text.strip()
    if not stripped:
        return 1.0
    symbols = len(_SYMBOL_CHAR.findall(stripped))
    return symbols / len(stripped)


def _is_sentence_complete(text: str) -> bool:
    stripped = text.rstrip()
    if not stripped:
        return False
    return stripped[-1] in _TERMINAL_PUNCT


def _compute_stats(cues: list[SubtitleCue]) -> _CueStats:
    if not cues:
        return _CueStats(median_chars=30.0, median_duration=10.0)
    chars = [len(c.text.strip()) for c in cues]
    durs = [_duration(c) for c in cues]
    return _CueStats(
        median_chars=statistics.median(chars),
        median_duration=statistics.median(durs),
    )


def _page_index(ts: float, boundaries: list[float]) -> int:
    points = sorted(boundaries)
    idx = 0
    for boundary in points:
        if ts >= boundary:
            idx += 1
        else:
            break
    return idx


def _same_ppt_page(
    left: SubtitleCue,
    right: SubtitleCue,
    boundaries: list[float] | None,
) -> bool:
    if not boundaries:
        return True
    return _page_index(_mid_sec(left), boundaries) == _page_index(_mid_sec(right), boundaries)


def _effective_max_gap(
    left: SubtitleCue,
    right: SubtitleCue,
    settings: CueMergeSettings,
    boundaries: list[float] | None,
) -> float:
    if _same_ppt_page(left, right, boundaries):
        return settings.max_gap_sec
    return settings.cross_page_max_gap_sec


def fragment_score(cue: SubtitleCue, stats: _CueStats, settings: CueMergeSettings) -> float:
    text = cue.text.strip()
    if not text:
        return 1.0

    char_len = len(text)
    dur = _duration(cue)
    parts: list[float] = []

    if stats.median_chars > 0:
        ratio = char_len / stats.median_chars
        if ratio < settings.neighbor_len_ratio:
            parts.append(1.0 - ratio / settings.neighbor_len_ratio)

    if stats.median_duration > 0:
        dr = dur / stats.median_duration
        if dr < settings.neighbor_dur_ratio:
            parts.append(1.0 - dr / settings.neighbor_dur_ratio)

    sym = _symbol_ratio(text)
    if sym > 0:
        parts.append(min(sym / max(settings.symbol_ratio_weight, 0.01), 1.0))

    if not _is_sentence_complete(text) and char_len < stats.median_chars:
        parts.append(settings.incomplete_sentence_weight)

    if not parts:
        return 0.0
    return min(sum(parts) / len(parts), 1.0)


def _text_contained_in(shorter: str, longer: str) -> bool:
    a, b = shorter.strip(), longer.strip()
    if not a or not b or len(a) >= len(b):
        return False
    return a in b


def _gap_sec(left: SubtitleCue, right: SubtitleCue) -> float:
    return right.start_sec - left.end_sec


def _combine(left: SubtitleCue, right: SubtitleCue) -> SubtitleCue:
    left_text = left.text.strip()
    right_text = right.text.strip()
    if _text_contained_in(left_text, right_text):
        text = right_text
    elif _text_contained_in(right_text, left_text):
        text = left_text
    else:
        sep = "\n" if ("\n" in left_text or "\n" in right_text or right_text.startswith("-")) else " "
        text = f"{left_text}{sep}{right_text}".strip()
    return SubtitleCue(
        start_sec=min(left.start_sec, right.start_sec),
        end_sec=max(left.end_sec, right.end_sec),
        text=text,
    )


def _is_subthreshold(cue: SubtitleCue, settings: CueMergeSettings) -> bool:
    return (
        _duration(cue) < settings.absorb_short_duration_sec
        or len(cue.text.strip()) < settings.absorb_short_chars
    )


def _should_merge_pair(
    left: SubtitleCue,
    right: SubtitleCue,
    stats: _CueStats,
    settings: CueMergeSettings,
    boundaries: list[float] | None,
) -> bool:
    gap = _gap_sec(left, right)
    max_gap = _effective_max_gap(left, right, settings, boundaries)
    if gap > max_gap:
        return False

    merged_dur = max(left.end_sec, right.end_sec) - min(left.start_sec, right.start_sec)
    if merged_dur > settings.max_merged_duration_sec:
        return False

    left_score = fragment_score(left, stats, settings)
    right_score = fragment_score(right, stats, settings)
    combined_len = len(left.text.strip()) + len(right.text.strip())

    if gap < 0:
        return True

    if _is_subthreshold(left, settings) or _is_subthreshold(right, settings):
        return True

    if left_score >= settings.fragment_score_threshold or right_score >= settings.fragment_score_threshold:
        return True

    if _text_contained_in(left.text, right.text) or _text_contained_in(right.text, left.text):
        return True

    if combined_len < settings.min_merged_chars and (
        left_score >= settings.fragment_score_threshold * 0.55
        or right_score >= settings.fragment_score_threshold * 0.55
    ):
        return True

    return False


def _single_pass_merge(
    cues: list[SubtitleCue],
    settings: CueMergeSettings,
    boundaries: list[float] | None,
) -> list[SubtitleCue]:
    if len(cues) < 2:
        return list(cues)

    stats = _compute_stats(cues)
    merged: list[SubtitleCue] = [cues[0]]
    for cue in cues[1:]:
        prev = merged[-1]
        if _should_merge_pair(prev, cue, stats, settings, boundaries):
            merged[-1] = _combine(prev, cue)
        else:
            merged.append(cue)
    return merged


def absorb_subthreshold_cues(
    cues: list[SubtitleCue],
    settings: CueMergeSettings,
    boundaries: list[float] | None = None,
) -> list[SubtitleCue]:
    """将仍过短的孤立 cue 并入间隔最近的邻段。"""
    if len(cues) < 2:
        return list(cues)

    result = list(cues)
    changed = True
    while changed:
        changed = False
        for idx, cue in enumerate(list(result)):
            if not _is_subthreshold(cue, settings):
                continue

            best_neighbor = -1
            best_gap = float("inf")
            # 短口语段：用 absorb_max_gap，不因跨 PPT 页把间隔压到 0.5s
            max_gap = float(settings.absorb_max_gap_sec)
            for neighbor_idx in (idx - 1, idx + 1):
                if neighbor_idx < 0 or neighbor_idx >= len(result):
                    continue
                neighbor = result[neighbor_idx]
                if neighbor_idx < idx:
                    left, right = neighbor, cue
                else:
                    left, right = cue, neighbor
                gap = _gap_sec(left, right)
                if gap <= max_gap and gap < best_gap:
                    best_gap = gap
                    best_neighbor = neighbor_idx

            if best_neighbor < 0:
                continue

            if best_neighbor < idx:
                result[best_neighbor] = _combine(result[best_neighbor], cue)
                result.pop(idx)
            else:
                result[idx] = _combine(cue, result[best_neighbor])
                result.pop(best_neighbor)
            changed = True
            break

    return result


def merge_overlapping_cues(
    cues: list[SubtitleCue],
    overlap_sec: float,
    text_ratio: float,
) -> list[SubtitleCue]:
    """时间重叠且文本相近的 cue 合并为一条（而非简单丢弃）。

    注意：当前主流水线使用 merge_adjacent_cues；本函数保留供实验/兼容，默认未接线。
    """
    if len(cues) < 2:
        return list(cues)

    sorted_cues = sorted(cues, key=lambda c: (c.start_sec, -len(c.text)))
    kept: list[SubtitleCue] = []

    for cue in sorted_cues:
        merged_into = False
        for idx, prev in enumerate(kept):
            start = max(prev.start_sec, cue.start_sec)
            end = min(prev.end_sec, cue.end_sec)
            overlap = max(end - start, 0.0)
            if overlap < overlap_sec:
                continue

            a, b = prev.text.strip(), cue.text.strip()
            similar = (
                a == b
                or a in b
                or b in a
                or (
                    len(set(a) & set(b)) / len(set(a) | set(b)) >= text_ratio
                    if a and b
                    else False
                )
            )
            if not similar:
                continue

            kept[idx] = _combine(prev, cue)
            merged_into = True
            break

        if not merged_into:
            kept.append(cue)

    return sorted(kept, key=lambda c: c.start_sec)


def merge_cues_by_primary_page(
    cues: list[SubtitleCue],
    pages: list[PptPage],
) -> list[SubtitleCue]:
    """将主归属同一 PPT 页的 cue 合并为一段，使片段与截图大致一一对应。"""
    if not pages or len(cues) < 2:
        return list(cues)

    buckets: dict[int, list[SubtitleCue]] = {}
    for cue in sorted(cues, key=lambda c: (c.start_sec, c.end_sec)):
        page = primary_page_for_cue(cue, pages)
        if page is None:
            continue
        buckets.setdefault(page.index, []).append(cue)

    merged: list[SubtitleCue] = []
    for page_idx in sorted(buckets):
        group = buckets[page_idx]
        combined = group[0]
        for nxt in group[1:]:
            combined = _combine(combined, nxt)
        merged.append(combined)

    logger.info(
        "PPT-page merge: %d cues → %d (pages with speech=%d / %d)",
        len(cues),
        len(merged),
        len(merged),
        len(pages),
    )
    return merged


def merge_adjacent_cues(
    cues: list[SubtitleCue],
    settings: CueMergeSettings | None = None,
    ppt_boundaries: list[float] | None = None,
    ppt_pages: list[PptPage] | None = None,
) -> list[SubtitleCue]:
    settings = settings or CueMergeSettings()
    if not settings.enabled or len(cues) < 2:
        return list(cues)

    sorted_cues = sorted(cues, key=lambda c: c.start_sec)
    current = sorted_cues

    if settings.merge_by_ppt_page and ppt_pages:
        current = merge_cues_by_primary_page(current, ppt_pages)

    for _ in range(max(settings.max_passes, 1)):
        nxt = _single_pass_merge(current, settings, ppt_boundaries)
        if len(nxt) == len(current):
            break
        current = nxt

    current = absorb_subthreshold_cues(current, settings, ppt_boundaries)

    if len(current) >= 2:
        last, prev = current[-1], current[-2]
        stats = _compute_stats(current)
        if fragment_score(last, stats, settings) >= settings.fragment_score_threshold:
            if _gap_sec(prev, last) <= _effective_max_gap(prev, last, settings, ppt_boundaries):
                current[-2] = _combine(prev, last)
                current.pop()

    logger.info(
        "Cue merge: %d → %d (median_chars=%.0f, median_dur=%.1fs)",
        len(sorted_cues),
        len(current),
        _compute_stats(current).median_chars,
        _compute_stats(current).median_duration,
    )
    return current
