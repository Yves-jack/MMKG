"""Stage 3b：VAT-KG / VaLiK 式跨模态对齐打分（CLAP + Chinese-CLIP）。"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np

from teachkg.utils.cv_io import imread_unicode

logger = logging.getLogger(__name__)


def _resolve_path(path_str: str, project_root: Path | None) -> Path | None:
    if not path_str:
        return None
    p = Path(path_str)
    if p.is_file():
        return p
    if project_root:
        candidate = project_root / path_str
        if candidate.is_file():
            return candidate
    return None


def score_edge_alignment(
    edge: dict[str, Any],
    *,
    project_root: Path | None = None,
    clap_encoder: Any | None = None,
    clip_encoder: Any | None = None,
    video_grounding_enabled: bool = False,
    video_max_frames: int = 4,
) -> dict[str, Any]:
    """为边的 grounding 计算 CLAP / Chinese-CLIP 分数。"""
    grounding = dict(edge.get("grounding") or {})
    statement = (
        grounding.get("natural_statement")
        or edge.get("natural_statement")
        or edge.get("description")
        or ""
    ).strip()
    if not statement:
        grounding["alignment"] = {"skipped": "no_statement"}
        out = dict(edge)
        out["grounding"] = grounding
        return out

    alignment: dict[str, Any] = {}

    clip_path = _resolve_path(str(grounding.get("clip_path", "")), project_root)
    if clip_path and clap_encoder is not None and getattr(clap_encoder, "available", True):
        try:
            alignment["clap_audio_text"] = clap_encoder.score_audio_text(clip_path, statement)
        except Exception as exc:  # noqa: BLE001
            logger.warning("CLAP score failed for %s: %s", clip_path, exc)
            alignment["clap_error"] = str(exc)
    elif clip_path:
        alignment["clap_skipped"] = "encoder_unavailable"

    frame_path = _resolve_path(str(grounding.get("ppt_frame_path", "")), project_root)
    if frame_path and clip_encoder is not None:
        try:
            image = imread_unicode(frame_path)
            if image is not None:
                alignment["clip_image_text"] = clip_encoder.score_image_text(image, statement)
            else:
                alignment["clip_skipped"] = "image_read_failed"
        except Exception as exc:  # noqa: BLE001
            logger.warning("Chinese-CLIP score failed for %s: %s", frame_path, exc)
            alignment["clip_error"] = str(exc)
    elif frame_path:
        alignment["clip_skipped"] = "encoder_unavailable"

    if video_grounding_enabled and clip_encoder is not None:
        video_path = _resolve_path(str(grounding.get("video_path", "")), project_root)
        if not video_path and clip_path and clip_path.suffix.lower() in {".mp4", ".mkv", ".webm"}:
            video_path = clip_path
        if video_path:
            try:
                from teachkg.models.video_grounding import score_video_text

                vscore = score_video_text(
                    video_path,
                    statement,
                    clip_encoder=clip_encoder,
                    max_frames=video_max_frames,
                )
                if vscore is not None:
                    alignment["clip_video_text"] = vscore
            except Exception as exc:  # noqa: BLE001
                logger.debug("Video grounding failed for %s: %s", video_path, exc)
                alignment["video_grounding_error"] = str(exc)

    grounding["alignment"] = alignment
    out = dict(edge)
    out["grounding"] = grounding
    return out


def apply_alignment_scores(
    mmkg: dict[str, Any],
    *,
    project_root: Path | None = None,
    clap_encoder: Any | None = None,
    clip_encoder: Any | None = None,
    clap_min_score: float = 0.0,
    clip_min_score: float = 0.0,
    video_grounding_enabled: bool = False,
    video_max_frames: int = 4,
) -> dict[str, Any]:
    """为所有边打分；分数低于阈值时标记 alignment_ok=false（不删边）。"""
    edges_out: list[dict[str, Any]] = []
    clap_scores: list[float] = []
    clip_scores: list[float] = []
    low_alignment = 0

    for edge in mmkg.get("edges") or []:
        scored = score_edge_alignment(
            edge,
            project_root=project_root,
            clap_encoder=clap_encoder,
            clip_encoder=clip_encoder,
            video_grounding_enabled=video_grounding_enabled,
            video_max_frames=video_max_frames,
        )
        align = scored.get("grounding", {}).get("alignment") or {}
        clap = align.get("clap_audio_text")
        clip = align.get("clip_image_text")
        if isinstance(clap, (int, float)):
            clap_scores.append(float(clap))
        if isinstance(clip, (int, float)):
            clip_scores.append(float(clip))

        ok = True
        if clap_min_score > 0 and clap is not None and float(clap) < clap_min_score:
            ok = False
        if clip_min_score > 0 and clip is not None and float(clip) < clip_min_score:
            ok = False
        if not ok:
            low_alignment += 1
        scored.setdefault("grounding", {})["alignment_ok"] = ok
        edges_out.append(scored)

    stats = dict(mmkg.get("stats") or {})
    stats["alignment"] = {
        "clap_count": len(clap_scores),
        "clip_count": len(clip_scores),
        "clap_mean": float(np.mean(clap_scores)) if clap_scores else None,
        "clip_mean": float(np.mean(clip_scores)) if clip_scores else None,
        "low_alignment_edges": low_alignment,
    }

    out = dict(mmkg)
    out["edges"] = edges_out
    out["stats"] = stats
    return out
