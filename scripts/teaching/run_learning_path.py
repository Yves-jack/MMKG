#!/usr/bin/env python
"""生成学习路径 JSON。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.kg.learning_path import build_learning_path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--course-id", required=True)
    p.add_argument("--lecture-id", default=None)
    p.add_argument("--output", default=None)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    base = ROOT / "data" / "kg" / args.course_id
    if args.lecture_id:
        mmkg_path = base / f"lecture_{args.lecture_id}" / "mmkg.json"
        tag = f"lecture_{args.lecture_id}"
    else:
        mmkg_path = base / "mmkg.json"
        tag = "course"
    mmkg = json.loads(mmkg_path.read_text(encoding="utf-8"))
    cues = ROOT / "data" / "processed" / args.course_id / "cues.jsonl"
    path = build_learning_path(mmkg, cues if cues.is_file() else None, lecture_id=args.lecture_id)
    out = Path(args.output) if args.output else ROOT / "data" / "processed" / args.course_id / f"learning_path_{tag}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(path, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Learning path ({len(path)} nodes) → {out}")


if __name__ == "__main__":
    main()
