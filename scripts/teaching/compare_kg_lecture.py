#!/usr/bin/env python
"""对比 hybrid 与 llm_only 的讲次 KG 统计，并导出可视化 HTML。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.viz.kg_html import export_kg_html


def load_kg_stats(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    entities = data.get("entities", [])
    edges = data.get("edges", [])
    return {
        "path": str(path),
        "entity_count": len(entities),
        "edge_count": len(edges),
        "sources": {},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-id", default="shuliluoji")
    parser.add_argument("--lecture-id", default="10")
    parser.add_argument("--export-viz", action="store_true")
    args = parser.parse_args()

    base = ROOT / "data/kg" / args.course_id / f"lecture_{args.lecture_id}"
    hybrid_path = base / "kg.json"
    llm_path = base / "kg_llm_baseline.json"

    report = {
        "lecture_id": args.lecture_id,
        "hybrid_kg": load_kg_stats(hybrid_path) if hybrid_path.is_file() else None,
        "llm_baseline_kg": load_kg_stats(llm_path) if llm_path.is_file() else None,
    }

    out = ROOT / f"data/processed/{args.course_id}/kg_compare_lecture_{args.lecture_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.export_viz:
        viz_dir = ROOT / "data/viz" / args.course_id
        viz_dir.mkdir(parents=True, exist_ok=True)
        if hybrid_path.is_file():
            export_kg_html(
                hybrid_path,
                viz_dir / f"lecture_{args.lecture_id}_kg_hybrid.html",
                title=f"第{args.lecture_id}讲 混合 KG",
            )
        if llm_path.is_file():
            export_kg_html(
                llm_path,
                viz_dir / f"lecture_{args.lecture_id}_kg_llm_baseline.html",
                title=f"第{args.lecture_id}讲 LLM 基线 KG",
            )

    h = report.get("hybrid_kg") or {}
    l = report.get("llm_baseline_kg") or {}
    print(f"讲次 {args.lecture_id} KG 对比")
    print(f"  混合: {h.get('entity_count', '-')} 实体 / {h.get('edge_count', '-')} 边")
    print(f"  LLM:  {l.get('entity_count', '-')} 实体 / {l.get('edge_count', '-')} 边")
    print(f"报告: {out}")


if __name__ == "__main__":
    main()
