#!/usr/bin/env python
"""验证阶段一键检查：冒烟 → 数据汇总 → 检索 A/B（不调 LLM 生成）。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Hybrid KG validation suite")
    p.add_argument("--course-id", default="shuliluoji")
    p.add_argument("--python", default=sys.executable)
    p.add_argument("--skip-ab", action="store_true", help="跳过检索 A/B")
    p.add_argument("--with-rag", action="store_true", help="额外跑 qa_eval 全链路 RAG（调 LLM）")
    p.add_argument("--mock-rag", action="store_true", help="RAG 使用 mock")
    return p.parse_args()


def run(py: str, script: str, *extra: str) -> None:
    cmd = [py, str(ROOT / "scripts" / "teaching" / script), *extra]
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=True)


def smoke(course_id: str, root: Path) -> dict:
    kg = root / "data" / "kg" / course_id
    idx = root / "data" / "index" / course_id / "course" / "mmkg_index"
    rows = []
    tp = kg / "triplets.jsonl"
    if tp.is_file():
        rows = [json.loads(l) for l in tp.read_text(encoding="utf-8").splitlines() if l.strip()]
    tb = [r for r in rows if r.get("extract_source") == "textbook"]
    clip_ok = sum(1 for r in tb if r.get("clip_path"))
    return {
        "triplets": tp.is_file(),
        "course_kg": (kg / "kg.json").is_file(),
        "course_mmkg": (kg / "mmkg.json").is_file(),
        "course_index": (idx / "manifest.json").is_file(),
        "triplet_count": len(rows),
        "textbook_clip_rate": f"{clip_ok}/{len(tb)}" if tb else "n/a",
    }


def main() -> None:
    args = parse_args()
    py = args.python
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = ROOT / "data" / "eval" / args.course_id
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / f"validation_report_{ts}.json"

    report: dict = {"course_id": args.course_id, "timestamp": ts, "steps": []}

    smoke_result = smoke(args.course_id, ROOT)
    report["smoke"] = smoke_result
    report["steps"].append("smoke")
    print("=== Smoke ===")
    print(json.dumps(smoke_result, ensure_ascii=False, indent=2))
    if not all(smoke_result[k] for k in ("triplets", "course_kg", "course_mmkg", "course_index")):
        raise SystemExit("Smoke check failed: missing artifacts")

    run(py, "summarize_hybrid_course.py")
    summary_path = ROOT / "data" / "processed" / args.course_id / "hybrid_course_summary.json"
    report["hybrid_summary"] = json.loads(summary_path.read_text(encoding="utf-8"))
    report["steps"].append("hybrid_summary")

    if not args.skip_ab:
        run(py, "run_rag_ab_eval.py", "--course-id", args.course_id)
        ab_path = out_dir / "rag_ab_results.json"
        report["rag_ab"] = json.loads(ab_path.read_text(encoding="utf-8"))
        report["steps"].append("rag_ab")

    if args.with_rag:
        extra = ["--mock"] if args.mock_rag else []
        run(py, "run_rag_eval.py", "--course-id", args.course_id, *extra)
        eval_path = out_dir / "qa_eval_results.json"
        report["rag_eval"] = json.loads(eval_path.read_text(encoding="utf-8"))
        report["steps"].append("rag_eval")

    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nValidation report → {report_path}")
    if report.get("rag_ab"):
        print("Retrieval A/B summary:")
        print(json.dumps(report["rag_ab"]["summary"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
