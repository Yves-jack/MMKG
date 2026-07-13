#!/usr/bin/env python
"""汇总课程质量、对齐、评测指标为 dashboard JSON。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _load_json(path: Path) -> dict:
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def build_report(course_id: str) -> dict:
    proc = ROOT / "data" / "processed" / course_id
    eval_dir = ROOT / "data" / "eval" / course_id
    kg = _load_json(ROOT / "data" / "kg" / course_id / "kg.json")
    mmkg_report = _load_json(proc / "stage3_mmkg_report.json")
    quality = _load_json(proc / "triplet_quality_report.json")
    rag_eval = _load_json(eval_dir / "qa_eval_results.json")
    rag_ab = _load_json(eval_dir / "rag_ab_results.json")

    rel_counts = (quality.get("triplet_stats") or {}).get("by_relation") or kg.get("stats", {}).get(
        "relation_counts", {}
    )
    if not rel_counts and kg.get("edges"):
        from collections import Counter

        rel_counts = dict(Counter(e.get("abstract_relation") for e in kg["edges"]))

    return {
        "course_id": course_id,
        "entity_count": len(kg.get("entities") or []),
        "edge_count": len(kg.get("edges") or []),
        "triplet_total": (quality.get("triplet_stats") or {}).get("total"),
        "related_with_ratio": (quality.get("triplet_stats") or {}).get("related_with_ratio"),
        "validation": quality.get("validation_summary") or {},
        "relation_counts": rel_counts,
        "alignment": mmkg_report.get("alignment_stats") or {},
        "index_records": (mmkg_report.get("index_stats") or {}).get("record_count"),
        "rag_eval": rag_eval.get("summary") or {},
        "rag_ab": rag_ab.get("summary") or {},
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--course-id", required=True)
    p.add_argument("--output", default=None)
    args = p.parse_args()
    report = build_report(args.course_id)
    out = Path(args.output) if args.output else ROOT / "data" / "processed" / args.course_id / "course_dashboard.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nSaved: {out}")


if __name__ == "__main__":
    main()
