#!/usr/bin/env python
"""将 triplets_review.jsonl 中 reject 条目从三元组中移除。"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.quality.apply_review import apply_review_files


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--course-id", required=True)
    p.add_argument("--review-file", default=None)
    p.add_argument("--rebuild-kg", action="store_true", help="回写后重跑 Stage 2 课程级 KG")
    p.add_argument("--python", default=sys.executable)
    args = p.parse_args()

    kg_dir = ROOT / "data" / "kg" / args.course_id
    triplets = kg_dir / "triplets.jsonl"
    review = Path(args.review_file) if args.review_file else kg_dir / "triplets_review.jsonl"
    if not review.is_file():
        raise SystemExit(f"Review file not found: {review}")

    stats = apply_review_files(triplets, review, triplets)
    print(f"Applied review: {stats}")

    if args.rebuild_kg:
        subprocess.run(
            [args.python, "scripts/teaching/run_stage2_kg.py", "--course-id", args.course_id, "--force"],
            cwd=ROOT,
            check=True,
        )
        subprocess.run(
            [args.python, "scripts/teaching/run_course_pipeline.py", "--course-id", args.course_id, "--from-stage", "3", "--force"],
            cwd=ROOT,
            check=True,
        )


if __name__ == "__main__":
    main()
