#!/usr/bin/env python
"""导出课程下所有讲次 + 课程级的 kg/mmkg 交互式 HTML 图谱。"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export all lecture + course KG/MMKG HTML graphs")
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument(
        "--source",
        choices=("kg", "mmkg", "both"),
        default="both",
        help="导出 kg.json、mmkg.json 或两者",
    )
    return parser.parse_args()


def _lecture_ids(course_id: str) -> list[str]:
    kg_root = ROOT / "data" / "kg" / course_id
    ids: list[str] = []
    for d in sorted(kg_root.glob("lecture_*")):
        if d.is_dir():
            ids.append(d.name.replace("lecture_", ""))
    return ids


def main() -> None:
    args = parse_args()
    py = args.python
    sources = ("kg", "mmkg") if args.source == "both" else (args.source,)
    viz_script = ROOT / "scripts" / "teaching" / "run_kg_visualize.py"
    outputs: list[Path] = []

    for source in sources:
        for lid in _lecture_ids(args.course_id):
            kg_file = ROOT / "data" / "kg" / args.course_id / f"lecture_{lid}" / f"{source}.json"
            if not kg_file.is_file():
                print(f"Skip lecture {lid} {source}: {kg_file} not found")
                continue
            subprocess.run(
                [
                    py,
                    str(viz_script),
                    "--course-id",
                    args.course_id,
                    "--lecture-id",
                    lid,
                    "--source",
                    source,
                ],
                cwd=ROOT,
                check=True,
            )
            outputs.append(ROOT / "data" / "viz" / args.course_id / f"lecture_{lid}_{source}.html")

        course_file = ROOT / "data" / "kg" / args.course_id / f"{source}.json"
        if course_file.is_file():
            subprocess.run(
                [
                    py,
                    str(viz_script),
                    "--course-id",
                    args.course_id,
                    "--source",
                    source,
                ],
                cwd=ROOT,
                check=True,
            )
            outputs.append(ROOT / "data" / "viz" / args.course_id / f"course_{source}.html")
        else:
            print(f"Skip course {source}: {course_file} not found")

    print(f"\nExported {len(outputs)} HTML graph(s):")
    for p in outputs:
        print(f"  {p}")


if __name__ == "__main__":
    main()
