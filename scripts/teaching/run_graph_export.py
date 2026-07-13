#!/usr/bin/env python
"""导出 GraphML / Neo4j Cypher。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.export.graph_export import export_graphml, export_neo4j_cypher


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--course-id", required=True)
    p.add_argument("--lecture-id", default=None)
    p.add_argument("--format", choices=["graphml", "cypher", "both"], default="both")
    p.add_argument("--output-dir", default=None)
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
    out_dir = Path(args.output_dir) if args.output_dir else ROOT / "data" / "export" / args.course_id
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.format in ("graphml", "both"):
        export_graphml(mmkg, out_dir / f"{tag}.graphml")
        print(f"GraphML → {out_dir / f'{tag}.graphml'}")
    if args.format in ("cypher", "both"):
        export_neo4j_cypher(mmkg, out_dir / f"{tag}.cypher")
        print(f"Cypher → {out_dir / f'{tag}.cypher'}")


if __name__ == "__main__":
    main()
