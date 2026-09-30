#!/usr/bin/env python3
"""在已有 textbook_correction 上重抽课堂增量（不重跑子图检索/教材修正）。

原则：
- 保留原教材边 SPO 与 classroom_correction / textbook_correction
- 增量 prompt + SPO 去重 使用 corrected_triples（修正后视图）
- 仅替换 extract_source=lecture_delta 的边

示例：
  python scripts/teaching/run_delta_from_correction.py --lecture-id 1 --write
  python scripts/teaching/run_delta_from_correction.py --lecture-id 1 --cue-id 数理逻辑_1_981600_1224300 --write
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.schemas import VideoSegment
from teachkg.stage1_alignment.corrected_textbook import correction_basis_from_stage1
from teachkg.stage1_alignment.pipeline import Stage1PreparePipeline
from teachkg.stage1_alignment.triplet_extract import (
    Triplet,
    build_flat_triplet_records,
    filter_delta_triplets,
    filter_deltas_against_textbook,
    load_course_context,
)
from teachkg.textbook_kg.entity_registry import format_known_entities_for_prompt
from teachkg.utils.io import load_jsonl, pretty_json_path, save_json, save_jsonl

logger = logging.getLogger("delta_from_correction")


def _resolve_extract(cue: dict) -> str:
    s1 = cue.get("stage1") or {}
    return (
        (s1.get("extract_text") or "").strip()
        or (cue.get("extract_text") or "").strip()
        or (cue.get("asr_text") or "").strip()
    )


def _row_to_triplet(row: dict) -> Triplet | None:
    data = {
        "subject": row.get("subject"),
        "object": row.get("object"),
        "abstract_relation": row.get("abstract_relation") or row.get("predicate"),
        "concrete_relation": row.get("concrete_relation") or "相关",
        "statement_direction": row.get("statement_direction") or "subject_to_object",
        "attribute_category": row.get("attribute_category") or "",
        "description": row.get("description") or "",
        "context": row.get("context") or "",
        "extract_source": row.get("extract_source") or "textbook",
        "subject_entity_ref": row.get("subject_entity_ref") or "",
        "object_entity_ref": row.get("object_entity_ref") or "",
    }
    return Triplet.from_dict(data)


def _keep_non_delta(cue: dict) -> list[Triplet]:
    out: list[Triplet] = []
    for row in cue.get("triplets") or []:
        if not isinstance(row, dict):
            continue
        if (row.get("extract_source") or "") == "lecture_delta":
            continue
        t = _row_to_triplet(row)
        if t is not None:
            # 保留反馈字段到 dict 侧；Triplet 本身不带 classroom_correction
            out.append(t)
    return out


def _reattach_feedback(kept_rows: list[dict], trips: list[Triplet]) -> list[dict]:
    """把原教材边上的 classroom_correction 等反馈按 SPO 贴回。"""
    by_spo: dict[tuple[str, str, str], dict] = {}
    for row in kept_rows:
        if (row.get("extract_source") or "") == "lecture_delta":
            continue
        key = (
            str(row.get("subject") or "").strip(),
            str(row.get("predicate") or row.get("abstract_relation") or "").strip(),
            str(row.get("object") or "").strip(),
        )
        by_spo[key] = row
    out: list[dict] = []
    for t in trips:
        d = t.to_dict()
        key = (t.subject, t.abstract_relation, t.object)
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
            if not d.get("predicate"):
                d["predicate"] = t.abstract_relation
        out.append(d)
    return out


def reextract_cue_delta(
    pipeline: Stage1PreparePipeline,
    cue: dict,
    course_context: str,
) -> dict:
    s1 = dict(cue.get("stage1") or {})
    basis = correction_basis_from_stage1(s1)
    if basis is None:
        logger.info("cue=%s skip: no textbook_correction.corrected_triples", cue.get("cue_id"))
        return cue

    delta_tb, subgraph_json, corr_ents = basis
    src_text = _resolve_extract(cue)
    if not src_text:
        logger.warning("cue=%s empty extract text", cue.get("cue_id"))
        return cue

    known = set(corr_ents)
    sg = s1.get("textbook_subgraph") or {}
    known |= set(sg.get("entities") or [])
    known |= set(sg.get("seed_entities") or [])

    assert pipeline.triplet_extractor is not None
    delta_result = pipeline.triplet_extractor.extract_hybrid(
        src_text,
        course_context,
        textbook_subgraph_json=subgraph_json,
        textbook_triplets=delta_tb,
        dedupe_against_textbook=pipeline.textbook_dedupe_delta,
        known_entities_text=format_known_entities_for_prompt(known),
    )
    delta_triplets = filter_delta_triplets(
        pipeline._link_delta_triplets(
            delta_result.triplets,
            src_text,
            known_entities=known,
        ),
        src_text,
        conceptual_focus=pipeline.textbook_conceptual_focus,
    )
    if pipeline.textbook_dedupe_delta:
        delta_triplets = filter_deltas_against_textbook(
            delta_triplets,
            delta_tb,
            match=pipeline.textbook_dedupe_match,
        )

    kept = _keep_non_delta(cue)
    merged = kept + delta_triplets
    # 写回：教材行保留反馈字段
    old_rows = list(cue.get("triplets") or [])
    cue["triplets"] = _reattach_feedback(old_rows, kept) + [t.to_dict() for t in delta_triplets]

    tv = dict(s1.get("triplet_validation") or {})
    tv.update(
        {
            "delta_textbook_basis": "corrected_textbook",
            "delta_basis_edges": len(delta_tb),
            "lecture_delta_edges": len(delta_triplets),
            "reextract_from_correction": True,
        }
    )
    if delta_result.validation:
        tv.update(delta_result.validation.to_dict())
    if delta_result.error:
        s1["triplet_error"] = delta_result.error
    s1["triplet_validation"] = tv
    s1["triplet_count"] = len(cue["triplets"])
    cue["stage1"] = s1

    logger.info(
        "cue=%s basis=%d delta=%d (kept_non_delta=%d)",
        cue.get("cue_id"),
        len(delta_tb),
        len(delta_triplets),
        len(kept),
    )
    return cue


def _flush_lecture(
    *,
    all_cues: list[dict],
    by_id: dict[str, dict],
    course: str,
    lec: str,
    cues_path: Path,
    trips_path: Path,
) -> int:
    merged = [by_id[str(c.get("cue_id"))] for c in all_cues]
    save_jsonl(cues_path, merged)
    save_json(pretty_json_path(cues_path), merged)
    existing = (
        [r for r in load_jsonl(trips_path) if str(r.get("lecture_id")) != lec]
        if trips_path.is_file()
        else []
    )
    new_trips: list[dict] = []
    for cue in [c for c in merged if str(c.get("lecture_id")) == lec]:
        trips = []
        for row in cue.get("triplets") or []:
            t = _row_to_triplet(row)
            if t is not None:
                trips.append(t)
        extra = cue.get("extra") or {}
        new_trips.extend(
            build_flat_triplet_records(
                VideoSegment.from_dict(cue),
                trips,
                course_id=course,
                ppt_frame_path=str(extra.get("ppt_frame_path") or ""),
                ppt_page_index=extra.get("ppt_page_index"),
                extract_mode="hybrid",
                ground_textbook=False,
            )
        )
    save_jsonl(trips_path, existing + new_trips)
    return len(new_trips)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "configs/teaching.yaml"))
    parser.add_argument("--course-id", default="数理逻辑")
    parser.add_argument("--lecture-id", required=True)
    parser.add_argument("--cue-id", action="append", default=[])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    cfg = TeachKGConfig.from_yaml(args.config)
    cfg.raw.setdefault("stage1", {}).setdefault("textbook_kg", {})["enabled"] = True
    cfg.raw["stage1"].setdefault("textbook_kg", {}).setdefault("extract", {})[
        "use_corrected_textbook"
    ] = True

    pipeline = Stage1PreparePipeline(cfg, project_root=ROOT, mock=False)
    if not pipeline.triplet_extractor:
        raise SystemExit("triplet extractor 未启用")

    course = args.course_id
    lec = str(args.lecture_id)
    cues_path = ROOT / "data/processed" / course / "filtered_cues.jsonl"
    trips_path = ROOT / "data/kg" / course / "triplets.jsonl"
    all_cues = load_jsonl(cues_path)
    targets = [c for c in all_cues if str(c.get("lecture_id")) == lec]
    targets.sort(key=lambda r: float(r.get("start_sec") or 0))
    if args.cue_id:
        want = {str(x) for x in args.cue_id}
        targets = [c for c in targets if str(c.get("cue_id")) in want]
        if not targets:
            raise SystemExit(f"no cues matched --cue-id {sorted(want)}")

    course_context = load_course_context(
        cfg.workspace_dir, course, cue=VideoSegment.from_dict(targets[0])
    )

    by_id = {str(c.get("cue_id")): c for c in all_cues}
    updated: list[dict] = []
    for cue in targets:
        out = reextract_cue_delta(pipeline, cue, course_context)
        by_id[str(out.get("cue_id"))] = out
        updated.append(out)
        if args.write and not args.dry_run:
            n = _flush_lecture(
                all_cues=all_cues,
                by_id=by_id,
                course=course,
                lec=lec,
                cues_path=cues_path,
                trips_path=trips_path,
            )
            logger.info(
                "checkpoint cue=%s lecture_trips=%d",
                out.get("cue_id"),
                n,
            )

    if args.dry_run:
        print(f"dry-run lecture={lec} cues={len(updated)}")
        return
    if not args.write:
        print("未加 --write，结果未落盘。")
        return

    n = _flush_lecture(
        all_cues=all_cues,
        by_id=by_id,
        course=course,
        lec=lec,
        cues_path=cues_path,
        trips_path=trips_path,
    )
    print(f"updated {len(updated)} cues → {cues_path}")
    print(f"triplets lecture {lec}: {n} → {trips_path}")


if __name__ == "__main__":
    main()
