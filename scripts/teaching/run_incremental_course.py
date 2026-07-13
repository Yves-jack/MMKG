#!/usr/bin/env python
"""增量课程流水线：检测新讲次 → followup → 课程级合并。"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _detect_lecture_ids(course_id: str) -> list[str]:
    raw = ROOT / "data" / "raw" / course_id / "video"
    if not raw.is_dir():
        return []
    ids: set[str] = set()
    for p in raw.rglob("*.mp4"):
        m = re.match(r"(\d+)_", p.name)
        if m:
            ids.add(m.group(1))
    return sorted(ids, key=int)


def _processed_lectures(course_id: str) -> set[str]:
    kg = ROOT / "data" / "kg" / course_id
    done: set[str] = set()
    if not kg.is_dir():
        return done
    for d in kg.glob("lecture_*"):
        if (d / "mmkg.json").is_file():
            done.add(d.name.replace("lecture_", ""))
    return done


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Incremental course update")
    p.add_argument("--course-id", required=True)
    p.add_argument("--python", default=sys.executable)
    p.add_argument("--force", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    py = args.python
    all_ids = _detect_lecture_ids(args.course_id)
    done = _processed_lectures(args.course_id)
    pending = [lid for lid in all_ids if lid not in done]
    print(json.dumps({"all_lectures": all_ids, "processed": sorted(done), "pending": pending}, ensure_ascii=False))
    if args.dry_run:
        return
    force = ["--force"] if args.force else []
    for lid in pending:
        subprocess.run(
            [py, "scripts/teaching/run_lecture_followup.py", "--course-id", args.course_id, "--lecture-id", lid, *force],
            cwd=ROOT,
            check=True,
        )
    subprocess.run(
        [py, "scripts/teaching/run_course_pipeline.py", "--course-id", args.course_id, *force],
        cwd=ROOT,
        check=True,
    )
    subprocess.run([py, "scripts/teaching/analyze_triplets.py", "--course-id", args.course_id], cwd=ROOT, check=True)
    print("Incremental course update finished.")


if __name__ == "__main__":
    main()
