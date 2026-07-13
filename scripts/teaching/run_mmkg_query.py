#!/usr/bin/env python
"""多模态知识图谱文本检索（Stage 5 索引查询）。"""

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
from teachkg.stage3_mmkg.index_builder import MMKGIndex


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query MMKG FAISS text index")
    parser.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--lecture-id", default="1")
    parser.add_argument("--query", required=True)
    parser.add_argument("--top-k", type=int, default=5)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = TeachKGConfig.from_yaml(args.config)
    kg_dir = Path(config.get("project", "kg_dir", default="data/kg"))
    index_dir = Path(config.get("project", "index_dir", default="data/index"))
    subdir = config.get("stage3", "index", default={}).get("subdir", "mmkg_index")

    idx_path = index_dir / args.course_id / f"lecture_{args.lecture_id}" / subdir
    if not idx_path.is_dir():
        idx_path = index_dir / args.course_id / "course" / subdir
    if not idx_path.is_dir():
        raise FileNotFoundError(f"Index not found under {index_dir / args.course_id}")

    index = MMKGIndex.load(idx_path)
    hits = index.search(args.query, top_k=args.top_k)
    print(json.dumps(hits, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
