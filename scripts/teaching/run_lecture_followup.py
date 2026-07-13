#!/usr/bin/env python
"""Stage 0 完成后，继续跑 Stage 1 → 2 → 3–5（单讲）。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Wait for Stage 0 cues then run Stage 1-3")
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--lecture-id", required=True)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--poll-sec", type=int, default=60)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def _cues_ready(course_id: str, lecture_id: str) -> bool:
    corrected = ROOT / "data" / "segments" / course_id / "asr_work" / lecture_id / "corrected_cues.json"
    cues_path = ROOT / "data" / "segments" / course_id / "cues.jsonl"
    if not corrected.is_file():
        return False
    data = json.loads(corrected.read_text(encoding="utf-8"))
    if not data.get("cues"):
        return False
    if not cues_path.is_file():
        return False
    count = 0
    for line in cues_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if str(row.get("lecture_id", "")) == str(lecture_id):
            count += 1
    return count > 0


def main() -> None:
    args = parse_args()
    py = args.python
    print(f"Waiting for lecture {args.lecture_id} Stage 0 cues...")
    while not _cues_ready(args.course_id, args.lecture_id):
        ck = ROOT / "data" / "segments" / args.course_id / "asr_work" / args.lecture_id / "raw_cues.checkpoint.json"
        if ck.is_file():
            data = json.loads(ck.read_text(encoding="utf-8"))
            vad = ROOT / "data" / "segments" / args.course_id / "asr_work" / args.lecture_id / "vad_segments.json"
            total = len(json.loads(vad.read_text(encoding="utf-8"))) if vad.is_file() else "?"
            print(f"  … Stage 0 ASR {data.get('next_index', 0)}/{total}", flush=True)
        else:
            print("  … 等待 Stage 0", flush=True)
        time.sleep(args.poll_sec)

    cmds = [
        [py, "scripts/teaching/run_stage1_filter.py", "--course-id", args.course_id]
        + (["--force"] if args.force else []),
        [
            py,
            "scripts/teaching/run_stage2_kg.py",
            "--course-id",
            args.course_id,
            "--lecture-id",
            args.lecture_id,
        ]
        + (["--force"] if args.force else []),
        [
            py,
            "scripts/teaching/run_stage3_mmkg.py",
            "--course-id",
            args.course_id,
            "--lecture-id",
            args.lecture_id,
            "--step",
            "all",
        ]
        + (["--force"] if args.force else []),
        [
            py,
            "scripts/teaching/run_kg_visualize.py",
            "--course-id",
            args.course_id,
            "--lecture-id",
            args.lecture_id,
            "--source",
            "mmkg",
        ],
    ]
    for cmd in cmds:
        print(">>>", " ".join(cmd))
        subprocess.run(cmd, cwd=ROOT, check=True)

    triplets_path = ROOT / "data" / "kg" / args.course_id / "triplets.jsonl"
    triplets_json = ROOT / "data" / "kg" / args.course_id / "triplets.json"
    if triplets_path.is_file():
        rows = [json.loads(line) for line in triplets_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        triplets_json.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Exported {triplets_json}")

    print("Follow-up pipeline finished.")


if __name__ == "__main__":
    main()
