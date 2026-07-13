#!/usr/bin/env python
"""导出三元组人工审阅模板 JSONL。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.quality.triplet_analysis import export_review_template, load_triplets


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--course-id", required=True)
    p.add_argument("--output", default=None)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    kg_dir = ROOT / "data" / "kg" / args.course_id
    src = kg_dir / "triplets.jsonl"
    if not src.is_file():
        src = kg_dir / "triplets.json"
    rows = load_triplets(src)
    template = export_review_template(rows)
    out = Path(args.output) if args.output else kg_dir / "triplets_review.jsonl"
    out.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in template) + "\n", encoding="utf-8")
    print(f"Exported {len(template)} rows → {out}")


if __name__ == "__main__":
    main()
