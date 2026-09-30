#!/usr/bin/env python
"""完整处理指定讲次：种子刷新 → 教材子图+增量 → Stage2/3 → 展示导出 → 多关系折叠 → 资产抽取。"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PY = sys.executable


def run(cmd: list[str], *, cwd: Path | None = None) -> None:
    print("\n>>>", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd or ROOT, check=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--course-id", default="数理逻辑")
    ap.add_argument("--lecture-id", action="append", dest="lecture_ids", required=True)
    ap.add_argument(
        "--from-step",
        choices=("seed", "textbook", "stage2", "stage3", "export", "collapse", "assets"),
        default="seed",
        help="从哪一步开始（用于续跑）",
    )
    ap.add_argument("--skip-seed-filter", action="store_true")
    ap.add_argument("--skip-assets", action="store_true")
    ap.add_argument("--skip-sync", action="store_true")
    ap.add_argument("--python", default=PY)
    args = ap.parse_args()
    py = args.python
    course = args.course_id
    lectures = [str(x) for x in args.lecture_ids]
    steps = ["seed", "textbook", "stage2", "stage3", "export", "collapse", "assets"]
    start = steps.index(args.from_step)

    for lec in lectures:
        print(f"\n======== lecture {lec} (from {args.from_step}) ========", flush=True)
        if start <= 0 and not args.skip_seed_filter:
            run(
                [
                    py,
                    "scripts/teaching/run_seed_filter_lecture.py",
                    "--course-id",
                    course,
                    "--lecture-id",
                    lec,
                ]
            )
        if start <= 1:
            run(
                [
                    py,
                    "scripts/teaching/run_textbook_from_seeds_lecture.py",
                    "--course-id",
                    course,
                    "--lecture-id",
                    lec,
                ]
            )
        if start <= 2:
            run(
                [
                    py,
                    "scripts/teaching/run_stage2_kg.py",
                    "--course-id",
                    course,
                    "--lecture-id",
                    lec,
                    "--force",
                ]
            )
        if start <= 3:
            run(
                [
                    py,
                    "scripts/teaching/run_stage3_mmkg.py",
                    "--course-id",
                    course,
                    "--lecture-id",
                    lec,
                    "--step",
                    "all",
                    "--force",
                ]
            )
        if start <= 4:
            run(
                [
                    py,
                    "scripts/teaching/export_pipeline_showcase.py",
                    "--course-id",
                    course,
                    "--lecture-id",
                    lec,
                ]
            )
            # collapse 读 public/data/pipeline；先同步该讲 pipeline JSON
            showcase = ROOT / "web" / "teachkg-showcase"
            src = ROOT / "data" / "viz" / course / f"pipeline_build_lecture_{lec}.json"
            dst_dir = showcase / "public" / "data" / "pipeline"
            dst_dir.mkdir(parents=True, exist_ok=True)
            if src.is_file():
                import shutil as _shutil

                _shutil.copy2(src, dst_dir / src.name)
                print(f"copied {src.name} → public/data/pipeline/", flush=True)
        if start <= 5:
            run([py, "-m", "scripts.teaching.collapse_multi_relations", "--lecture", lec])
        if start <= 6 and not args.skip_assets:
            run(
                [
                    py,
                    "-m",
                    "scripts.teaching.extract_assets_llm",
                    "--course-id",
                    course,
                    "--lecture",
                    lec,
                    "--no-textbook-theorems",
                    "--min-overlap",
                    "0.22",
                ]
            )

    if not args.skip_sync:
        npm = shutil.which("npm") or shutil.which("npm.cmd")
        if not npm:
            print("WARN: npm not found in PATH; skip sync-data", flush=True)
        else:
            run([npm, "run", "sync-data"], cwd=ROOT / "web" / "teachkg-showcase")
    print("\nAll lectures done:", lectures, flush=True)


if __name__ == "__main__":
    main()
