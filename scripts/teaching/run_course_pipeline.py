#!/usr/bin/env python
"""课程级流水线：Stage 2 → 3–5（合并全部讲次）。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build course-level KG + MMKG from all lectures")
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--skip-alignment", action="store_true", help="跳过 CLAP/CLIP（更快）")
    parser.add_argument("--from-stage", choices=["2", "3", "viz", "analyze"], default="2",
                        help="从指定阶段开始（2=KG合并, 3=MMKG, viz=可视化, analyze=质量报告）")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    py = args.python
    force = ["--force"] if args.force else []
    stages = ["2", "3", "viz", "analyze"]
    start = stages.index(args.from_stage)

    if start <= 0:
        subprocess.run(
            [py, "scripts/teaching/run_stage2_kg.py", "--course-id", args.course_id, *force],
            cwd=ROOT,
            check=True,
        )

    if start <= 1:
        step = "all"
        if args.skip_alignment:
            for step_name in ("evidence", "describe", "index"):
                subprocess.run(
                    [
                        py,
                        "scripts/teaching/run_stage3_mmkg.py",
                        "--course-id",
                        args.course_id,
                        "--step",
                        step_name,
                        *force,
                    ],
                    cwd=ROOT,
                    check=True,
                )
        else:
            subprocess.run(
                [
                    py,
                    "scripts/teaching/run_stage3_mmkg.py",
                    "--course-id",
                    args.course_id,
                    "--step",
                    step,
                    *force,
                ],
                cwd=ROOT,
                check=True,
            )

    if start <= 2:
        subprocess.run(
            [
                py,
                "scripts/teaching/run_all_kg_viz.py",
                "--course-id",
                args.course_id,
            ],
            cwd=ROOT,
            check=True,
        )

    triplets_path = ROOT / "data" / "kg" / args.course_id / "triplets.jsonl"
    triplets_json = ROOT / "data" / "kg" / args.course_id / "triplets.json"
    if triplets_path.is_file():
        rows = [json.loads(line) for line in triplets_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        triplets_json.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    if start <= 3:
        subprocess.run(
            [py, "scripts/teaching/analyze_triplets.py", "--course-id", args.course_id],
            cwd=ROOT,
            check=True,
        )
        subprocess.run(
            [py, "scripts/teaching/export_triplet_review.py", "--course-id", args.course_id],
            cwd=ROOT,
            check=True,
        )
        subprocess.run(
            [py, "scripts/teaching/run_graph_export.py", "--course-id", args.course_id],
            cwd=ROOT,
            check=True,
        )
        subprocess.run(
            [py, "scripts/teaching/run_learning_path.py", "--course-id", args.course_id],
            cwd=ROOT,
            check=True,
        )

    print("Course-level pipeline finished.")


if __name__ == "__main__":
    main()
