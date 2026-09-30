#!/usr/bin/env python
"""仅重跑字数窗跨段抽取（不重跑单段 hybrid），写回 triplets / filtered_cues。

示例：
  python scripts/teaching/run_cross_cue_extract.py --lecture-id 1 --lecture-id 2 --write
  python scripts/teaching/run_cross_cue_extract.py --lecture-id 1 --dry-run
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.schemas import VideoSegment
from teachkg.stage1_alignment.pipeline import (
    CueCheckResult,
    PreparedCue,
    Stage1PreparePipeline,
)
from teachkg.stage1_alignment.triplet_extract import (
    Triplet,
    build_flat_triplet_records,
    is_cross_cue_extract_source,
    load_course_context,
)
from teachkg.utils.io import load_jsonl, pretty_json_path, save_json, save_jsonl

logger = logging.getLogger("cross_cue_extract")


def _row_to_triplet(row: dict) -> Triplet | None:
    return Triplet.from_dict(
        {
            "subject": row.get("subject"),
            "object": row.get("object"),
            "abstract_relation": row.get("abstract_relation") or row.get("predicate"),
            "concrete_relation": row.get("concrete_relation") or "相关",
            "statement_direction": row.get("statement_direction") or "subject_to_object",
            "attribute_category": row.get("attribute_category") or "",
            "description": row.get("description") or "",
            "context": row.get("context") or "",
            "extract_source": row.get("extract_source") or "",
            "subject_entity_ref": row.get("subject_entity_ref") or "",
            "object_entity_ref": row.get("object_entity_ref") or "",
        }
    )


def _resolve_extract(cue: dict) -> str:
    s1 = cue.get("stage1") or {}
    status = s1.get("text_preprocess_status") or ""
    if status == "empty_after_preprocess":
        return ""
    return (
        (s1.get("extract_text") or "").strip()
        or (cue.get("extract_text") or "").strip()
        or (cue.get("asr_text") or "").strip()
    )


def _prepared_from_cue(cue_row: dict, trips: list[dict]) -> PreparedCue:
    cue = VideoSegment.from_dict(cue_row)
    s1 = cue_row.get("stage1") or {}
    extract = _resolve_extract(cue_row)
    kept: list[Triplet] = []
    for row in trips:
        if is_cross_cue_extract_source(str(row.get("extract_source") or "")):
            continue
        t = _row_to_triplet(row)
        if t is not None:
            kept.append(t)
    tv = dict(s1.get("triplet_validation") or {})
    # 重跑前清掉旧去重日志，避免叠加
    tv.pop("cross_cue_deduped", None)
    tv.pop("cross_cue_window_logs", None)
    return PreparedCue(
        cue=cue,
        check=CueCheckResult(passed=True),
        ppt_frame_path=str(s1.get("ppt_frame_path") or ""),
        ppt_page_index=s1.get("ppt_page_index"),
        extract_text=extract,
        extract_source_used=str(s1.get("extract_from") or "asr"),
        triplets=kept,
        textbook_subgraph=dict(s1.get("textbook_subgraph") or {}),
        textbook_correction=dict(s1.get("textbook_correction") or {}),
        triplet_validation=tv,
    )


def run_lecture(
    pipeline: Stage1PreparePipeline,
    *,
    course_id: str,
    lecture_id: str,
    cues: list[dict],
    trips_by_cue: dict[str, list[dict]],
    course_context: str,
) -> tuple[list[PreparedCue], list[dict]]:
    items = [
        _prepared_from_cue(c, trips_by_cue.get(str(c.get("cue_id")), []))
        for c in cues
        if str(c.get("lecture_id")) == str(lecture_id)
    ]
    items = [p for p in items if pipeline._text_for_extract(p)]
    if len(items) < 2:
        logger.warning("lecture %s: fewer than 2 extractable cues, skip", lecture_id)
        return items, []

    before = {
        p.cue.cue_id: len(
            [t for t in p.triplets if is_cross_cue_extract_source(t.extract_source)]
        )
        for p in items
    }
    pipeline._extract_cross_cue_lecture(items, course_context)
    flat: list[dict] = []
    added = 0
    for p in items:
        after = len(
            [t for t in p.triplets if is_cross_cue_extract_source(t.extract_source)]
        )
        added += max(0, after - before.get(p.cue.cue_id, 0))
        flat.extend(
            build_flat_triplet_records(
                p.cue,
                [t for t in p.triplets if is_cross_cue_extract_source(t.extract_source)],
                course_id=course_id,
                ppt_frame_path="",
                ppt_page_index=None,
                extract_mode="hybrid",
                ground_textbook=False,
            )
        )
    logger.info(
        "lecture %s: windows done, new_cross_flat=%d (cue_delta_sum=%d)",
        lecture_id,
        len(flat),
        added,
    )
    return items, flat


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    parser.add_argument("--course-id", default="数理逻辑")
    parser.add_argument("--lecture-id", action="append", dest="lecture_ids", required=True)
    parser.add_argument("--write", action="store_true", help="写回磁盘")
    parser.add_argument("--dry-run", action="store_true", help="只跑不写（默认）")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()
    write = bool(args.write) and not bool(args.dry_run)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )

    lectures = [str(x) for x in (args.lecture_ids or [])]
    cfg = TeachKGConfig.from_yaml(args.config)
    cfg.raw.setdefault("stage1", {}).setdefault("textbook_kg", {})["enabled"] = True
    cfg.raw.setdefault("stage1", {}).setdefault("textbook_kg", {}).setdefault(
        "extract", {}
    ).setdefault("cross_cue_extract", {})["enabled"] = True

    pipeline = Stage1PreparePipeline(cfg, project_root=ROOT, mock=False)
    if not pipeline.cross_cue_enabled or not pipeline.triplet_extractor:
        raise SystemExit("cross_cue_extract not enabled or extractor missing")

    cues_path = ROOT / "data" / "processed" / args.course_id / "filtered_cues.jsonl"
    trips_path = pipeline.kg_dir / args.course_id / pipeline.triplets_filename
    all_cues = load_jsonl(cues_path)
    all_trips = load_jsonl(trips_path) if trips_path.is_file() else []

    lecture_set = set(lectures)
    cues = [c for c in all_cues if str(c.get("lecture_id")) in lecture_set]
    cues.sort(key=lambda r: (str(r.get("lecture_id")), float(r.get("start_sec") or 0)))

    trips_by_cue: dict[str, list[dict]] = defaultdict(list)
    for t in all_trips:
        if str(t.get("lecture_id")) in lecture_set:
            trips_by_cue[str(t.get("cue_id"))].append(t)

    course_context = load_course_context(
        cfg.workspace_dir,
        args.course_id,
        cue=VideoSegment.from_dict(cues[0]) if cues else None,
    )

    prepared_by_lec: dict[str, list[PreparedCue]] = {}
    new_cross_flat: list[dict] = []
    for lec in lectures:
        items, flat = run_lecture(
            pipeline,
            course_id=args.course_id,
            lecture_id=lec,
            cues=cues,
            trips_by_cue=trips_by_cue,
            course_context=course_context,
        )
        prepared_by_lec[lec] = items
        new_cross_flat.extend(flat)
        print(f"lecture {lec}: cross_cue_edges={len(flat)}")

    print(f"total_new_cross={len(new_cross_flat)} write={write}")
    if not write:
        for row in new_cross_flat[:20]:
            print(
                f"  {row.get('extract_source')}: "
                f"{row.get('subject')} -[{row.get('abstract_relation')}/{row.get('concrete_relation')}]-> "
                f"{row.get('object')}"
            )
        if len(new_cross_flat) > 20:
            print(f"  ... ({len(new_cross_flat) - 20} more)")
        return

    # 写回 triplets：去掉目标讲次旧跨段边，保留其它边 + 新跨段边
    kept = [
        t
        for t in all_trips
        if not (
            str(t.get("lecture_id")) in lecture_set
            and is_cross_cue_extract_source(str(t.get("extract_source") or ""))
        )
    ]
    merged_trips = kept + new_cross_flat
    trips_path.parent.mkdir(parents=True, exist_ok=True)
    save_jsonl(trips_path, merged_trips)
    save_json(pretty_json_path(trips_path), merged_trips)
    logger.info("wrote %s (%d rows)", trips_path, len(merged_trips))

    # 回写 filtered_cues 内嵌 triplets（去掉旧跨段，并入新跨段）
    cross_by_cue: dict[str, list[dict]] = defaultdict(list)
    for row in new_cross_flat:
        cross_by_cue[str(row.get("cue_id"))].append(row)

    updated: list[dict] = []
    touched = 0
    for row in all_cues:
        lid = str(row.get("lecture_id"))
        if lid not in lecture_set:
            updated.append(row)
            continue
        cid = str(row.get("cue_id"))
        old_trips = list(row.get("triplets") or [])
        kept_local = [
            t
            for t in old_trips
            if isinstance(t, dict)
            and not is_cross_cue_extract_source(str(t.get("extract_source") or ""))
        ]
        # 优先用 PreparedCue 全量（含非跨段 + 新跨段）
        prep = next(
            (p for p in prepared_by_lec.get(lid, []) if p.cue.cue_id == cid),
            None,
        )
        if prep is not None:
            new_local = [t.to_dict() for t in prep.triplets]
            # 保留原教材边上的 correction 等反馈字段
            by_spo = {
                (
                    str(t.get("subject") or ""),
                    str(t.get("abstract_relation") or t.get("predicate") or ""),
                    str(t.get("object") or ""),
                ): t
                for t in kept_local
            }
            merged_local: list[dict] = []
            for d in new_local:
                key = (
                    str(d.get("subject") or ""),
                    str(d.get("abstract_relation") or ""),
                    str(d.get("object") or ""),
                )
                src = by_spo.get(key)
                if src:
                    for k in (
                        "classroom_correction",
                        "correction_action",
                        "correction_reason",
                        "correction_from",
                        "predicate",
                    ):
                        if k in src and src[k] is not None:
                            d[k] = src[k]
                merged_local.append(d)
            row = dict(row)
            row["triplets"] = merged_local
            s1 = dict(row.get("stage1") or {})
            s1["triplet_count"] = len(merged_local)
            tv = dict(s1.get("triplet_validation") or {})
            if prep.triplet_validation:
                tv.update(prep.triplet_validation)
            s1["triplet_validation"] = tv
            row["stage1"] = s1
            touched += 1
        else:
            row = dict(row)
            row["triplets"] = kept_local + cross_by_cue.get(cid, [])
            touched += 1
        updated.append(row)

    save_jsonl(cues_path, updated)
    save_json(pretty_json_path(cues_path), updated)
    logger.info("wrote %s (touched_cues=%d)", cues_path, touched)
    print(f"wrote triplets={trips_path}")
    print(f"wrote cues={cues_path}")


if __name__ == "__main__":
    main()
