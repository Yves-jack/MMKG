#!/usr/bin/env python
"""基于 MMKG 生成练习题。"""

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
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from teachkg.config import TeachKGConfig
from teachkg.rag.quiz_generator import generate_quiz
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", required=True)
    p.add_argument("--lecture-id", default=None)
    p.add_argument("--n", type=int, default=5)
    p.add_argument("--mock", action="store_true")
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
    config = TeachKGConfig.from_yaml(args.config)
    llm = LLMClient(**llm_settings_from_config(config.get("llm", default={})))
    quiz = generate_quiz(mmkg, n_questions=args.n, lecture_id=args.lecture_id, llm_client=llm, mock=args.mock)
    out = Path(args.output) if args.output else ROOT / "data" / "processed" / args.course_id / f"quiz_{tag}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(quiz, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(quiz, ensure_ascii=False, indent=2))
    print(f"\nSaved: {out}")


if __name__ == "__main__":
    main()
