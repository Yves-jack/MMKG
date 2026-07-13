#!/usr/bin/env python
"""导出 entity merge_map 人工抽查表。"""

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


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--course-id", required=True)
    p.add_argument("--lecture-id", default=None)
    p.add_argument("--output", default=None)
    args = p.parse_args()

    base = ROOT / "data" / "kg" / args.course_id
    if args.lecture_id:
        path = base / f"lecture_{args.lecture_id}" / "entity_merge_map.json"
        tag = f"lecture_{args.lecture_id}"
    else:
        path = base / "entity_merge_map.json"
        tag = "course"

    data = json.loads(path.read_text(encoding="utf-8"))
    merge_map = data.get("merge_map") or {}
    rows = [
        {
            "alias": alias,
            "canonical": canonical,
            "review_status": "pending",
            "review_note": "",
        }
        for alias, canonical in sorted(merge_map.items())
    ]
    out = Path(args.output) if args.output else base / f"merge_map_review_{tag}.jsonl"
    out.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")
    print(f"Exported {len(rows)} merge pairs → {out}")


if __name__ == "__main__":
    main()
