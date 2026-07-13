#!/usr/bin/env python
"""三元组质量分析报告。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.quality.triplet_analysis import build_quality_report


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Analyze triplet quality")
    p.add_argument("--course-id", required=True)
    p.add_argument("--output", default=None, help="JSON 报告输出路径")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    kg_dir = ROOT / "data" / "kg" / args.course_id
    triplets = kg_dir / "triplets.jsonl"
    if not triplets.is_file():
        triplets = kg_dir / "triplets.json"
    stage1 = ROOT / "data" / "processed" / args.course_id / "stage1_report.json"
    report = build_quality_report(triplets, stage1_report_path=stage1 if stage1.is_file() else None)
    out = Path(args.output) if args.output else ROOT / "data" / "processed" / args.course_id / "triplet_quality_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nSaved: {out}")


if __name__ == "__main__":
    main()
