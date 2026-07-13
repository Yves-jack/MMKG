#!/usr/bin/env python
"""批量对多讲运行教材 hybrid Stage 1，并可选更新课程级 Stage 2 / MMKG 索引。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch hybrid extraction for lectures")
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument(
        "--lecture-id",
        action="append",
        dest="lecture_ids",
        help="指定讲次；省略则处理全部未 hybrid 讲次",
    )
    parser.add_argument(
        "--skip-hybrid-done",
        action="store_true",
        default=True,
        help="跳过已有 hybrid 标记的讲次（默认开启）",
    )
    parser.add_argument("--force", action="store_true", help="强制重跑 Stage 1")
    parser.add_argument(
        "--no-post-course",
        action="store_true",
        help="不更新课程级 Stage2 / MMKG",
    )
    parser.add_argument(
        "--compare",
        action="store_true",
        default=True,
        help="每讲完成后生成 hybrid vs llm 对比报告",
    )
    return parser.parse_args()


def hybrid_lectures(course_id: str) -> set[str]:
    """从 triplets 中检测已含 textbook 边的讲次。"""
    path = ROOT / "data" / "kg" / course_id / "triplets.jsonl"
    if not path.is_file():
        return set()
    done: set[str] = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("extract_source") == "textbook":
            done.add(str(row.get("lecture_id", "")))
    return {x for x in done if x}


def all_lectures(course_id: str) -> list[str]:
    cues = ROOT / "data" / "segments" / course_id / "cues.jsonl"
    if not cues.is_file():
        return []
    lecs: set[str] = set()
    for line in cues.read_text(encoding="utf-8").splitlines():
        if line.strip():
            lecs.add(str(json.loads(line).get("lecture_id", "")))
    return sorted(lec for lec in lecs if lec)


def run_cmd(cmd: list[str]) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True)


def main() -> None:
    args = parse_args()
    py = args.python

    if args.lecture_ids:
        targets = [str(x) for x in args.lecture_ids]
    else:
        targets = all_lectures(args.course_id)
        if args.skip_hybrid_done:
            done = hybrid_lectures(args.course_id)
            targets = [lec for lec in targets if lec not in done]

    if not targets:
        print("No lectures to process.")
        return

    print(f"Hybrid batch: {len(targets)} lecture(s) → {targets}")
    force = ["--force"] if args.force else []

    for lec in targets:
        run_cmd(
            [
                py,
                "scripts/teaching/run_stage1_filter.py",
                "--course-id",
                args.course_id,
                "--lecture-id",
                lec,
                "--hybrid",
                *force,
            ]
        )
        run_cmd(
            [
                py,
                "scripts/teaching/run_stage2_kg.py",
                "--course-id",
                args.course_id,
                "--lecture-id",
                lec,
                "--force",
            ]
        )
        if args.compare:
            run_cmd(
                [
                    py,
                    "scripts/teaching/compare_hybrid_lecture.py",
                    "--course-id",
                    args.course_id,
                    "--lecture-id",
                    lec,
                ]
            )

    if not args.no_post_course:
        run_cmd(
            [py, "scripts/teaching/run_stage2_kg.py", "--course-id", args.course_id, "--force"]
        )
        for step in ("evidence", "index"):
            run_cmd(
                [
                    py,
                    "scripts/teaching/run_stage3_mmkg.py",
                    "--course-id",
                    args.course_id,
                    "--step",
                    step,
                    "--force",
                ]
            )

    print("Hybrid batch finished.")


if __name__ == "__main__":
    main()
