"""Bridge video-chunk ingest → teachkg orchestrate_from_chunks (lecture-level)."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

Graph = dict[str, Any]


def _repo_root() -> Path:
    env = os.environ.get("MMKG_REPO_ROOT", "").strip()
    if env:
        return Path(env)
    # service/mmkg_api/chunk_pipeline.py → parents[2] = MMKG-runtime
    return Path(__file__).resolve().parents[2]


def ensure_sys_path() -> Path:
    """Prefer /app (repo root) over WORKDIR /app/service, which also has a scripts/ dir."""
    root = _repo_root()
    root_s = str(root)
    # Drop empty cwd entry and any prior root so service/scripts cannot shadow app/scripts.
    cleaned = [p for p in sys.path if p not in ("", root_s)]
    sys.path[:] = [root_s, *cleaned]
    return root


def resolve_logical_course(canvas_course_id: str) -> str:
    ensure_sys_path()
    from scripts.teaching.course_map import resolve_course_name

    return resolve_course_name(canvas_course_id)


def lecture_ids_from_chunks(chunks: list[Graph]) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for chunk in chunks:
        lid = str(chunk.get("lesson_id") or chunk.get("lecture_id") or "").strip()
        if not lid or lid in seen:
            continue
        seen.add(lid)
        ids.append(lid)
    return ids


def lecture_input_hash(chunks: list[Graph], lecture_id: str) -> str:
    rows = [
        {
            "segment_id": c.get("segment_id"),
            "asr_text": c.get("asr_text"),
            "text": c.get("text"),
            "start_sec": c.get("start_sec"),
            "end_sec": c.get("end_sec"),
            "link": c.get("link"),
        }
        for c in chunks
        if str(c.get("lesson_id") or c.get("lecture_id") or "") == str(lecture_id)
    ]
    rows.sort(key=lambda x: str(x.get("segment_id") or ""))
    raw = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def run_lecture_pipeline(
    *,
    canvas_course_id: str,
    lecture_id: str,
    progress_cb=None,
) -> dict[str, Any]:
    """Run full Stage1+ showcase pipeline for one lecture. Raises on hard failure."""
    root = ensure_sys_path()
    from scripts.teaching.orchestrate_from_chunks import orchestrate

    course_id = resolve_logical_course(canvas_course_id)

    def _progress(stage: str, pct: int, message: str) -> None:
        if progress_cb:
            progress_cb(stage, pct, message)

    return orchestrate(
        course_id=course_id,
        lecture_id=str(lecture_id),
        canvas_course_id=str(canvas_course_id),
        config=root / "configs" / "teaching_lisan.yaml",
        skip_stage3=os.environ.get("MMKG_PIPELINE_WITH_STAGE3", "").strip() not in {"1", "true", "yes"},
        skip_property_merge=os.environ.get("MMKG_PIPELINE_PROPERTY_MERGE", "").strip()
        not in {"1", "true", "yes"},
        skip_assets=os.environ.get("MMKG_PIPELINE_SKIP_ASSETS", "").strip() in {"1", "true", "yes"},
        skip_sync=os.environ.get("MMKG_PIPELINE_SKIP_SYNC", "").strip() in {"1", "true", "yes"},
        progress=_progress,
    )
