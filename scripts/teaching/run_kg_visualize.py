#!/usr/bin/env python
"""将 kg.json / mmkg.json 导出为交互式 HTML 图谱。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from teachkg.config import TeachKGConfig
from teachkg.viz.kg_html import export_kg_html


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export KG/MMKG to interactive HTML graph")
    parser.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--lecture-id", default=None, help="讲次 ID；省略则导出课程级 kg/mmkg")
    parser.add_argument(
        "--source",
        choices=("kg", "mmkg"),
        default="mmkg",
        help="kg.json 或 mmkg.json",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="输出 HTML 路径（默认 data/viz/<course>/lecture_<id>_<source>.html）",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = TeachKGConfig.from_yaml(args.config)
    kg_dir = Path(config.get("project", "kg_dir", default="data/kg"))

    filename = "mmkg.json" if args.source == "mmkg" else "kg.json"
    if args.lecture_id:
        kg_path = kg_dir / args.course_id / f"lecture_{args.lecture_id}" / filename
        default_out = ROOT / "data" / "viz" / args.course_id / f"lecture_{args.lecture_id}_{args.source}.html"
        title = f"{args.course_id} 第{args.lecture_id}讲 {'多模态' if args.source == 'mmkg' else ''}知识图谱"
    else:
        kg_path = kg_dir / args.course_id / filename
        default_out = ROOT / "data" / "viz" / args.course_id / f"course_{args.source}.html"
        title = f"{args.course_id} 课程级{'多模态' if args.source == 'mmkg' else ''}知识图谱"

    if not kg_path.is_file():
        raise FileNotFoundError(f"Graph file not found: {kg_path}")

    out_path = Path(args.output) if args.output else default_out
    export_kg_html(kg_path, out_path, title=title)
    print(f"Graph HTML saved to: {out_path}")


if __name__ == "__main__":
    main()
