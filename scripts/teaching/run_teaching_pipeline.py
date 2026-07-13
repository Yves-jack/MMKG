#!/usr/bin/env python
"""教学流水线编排：Stage 0 → 1 → 2 → 3–5（可按讲次/阶段）。"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PY = sys.executable


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Teaching KG pipeline orchestrator")
    parser.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--lecture-id", default=None, help="Stage 2/3 单讲；Stage 0/1 处理全部 cues")
    parser.add_argument(
        "--workspace",
        default=None,
        help="Stage 0 课程 raw 目录（含 video/class 与 video/ppt）",
    )
    parser.add_argument(
        "--from-stage",
        choices=("0", "1", "2", "3"),
        default="0",
        help="从哪一阶段开始（0=切片, 1=三元组, 2=KG, 3=MMKG）",
    )
    parser.add_argument("--force", action="store_true", help="各阶段强制重算")
    parser.add_argument("--mock", action="store_true", help="Stage 1 mock LLM")
    parser.add_argument(
        "--python",
        default=PY,
        help="Python 解释器路径（推荐 auto-edukg）",
    )
    return parser.parse_args()


def _run(cmd: list[str], *, cwd: Path) -> None:
    print(f"\n>>> {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, check=True)


def _resolve_workspace(args: argparse.Namespace) -> Path:
    if args.workspace:
        return Path(args.workspace).resolve()
    raw = ROOT / "data" / "raw"
    for d in sorted(raw.iterdir()):
        if d.is_dir() and (d / "video" / "class").is_dir():
            return d.resolve()
    raise FileNotFoundError("未找到 workspace，请指定 --workspace")


def main() -> None:
    args = parse_args()
    py = args.python
    stages = ["0", "1", "2", "3"]
    start_idx = stages.index(args.from_stage)

    if start_idx <= 0:
        ws = _resolve_workspace(args)
        cmd = [py, "scripts/teaching/run_stage0_segment.py", "--workspace", str(ws), "--course-id", args.course_id]
        _run(cmd, cwd=ROOT)

    if start_idx <= 1:
        cmd = [py, "scripts/teaching/run_stage1_filter.py", "--course-id", args.course_id]
        if args.force:
            cmd.append("--force")
        if args.mock:
            cmd.append("--mock")
        _run(cmd, cwd=ROOT)

    if start_idx <= 2:
        cmd = [py, "scripts/teaching/run_stage2_kg.py", "--course-id", args.course_id]
        if args.lecture_id:
            cmd.extend(["--lecture-id", args.lecture_id])
        if args.force:
            cmd.append("--force")
        _run(cmd, cwd=ROOT)

    if start_idx <= 3:
        cmd = [
            py,
            "scripts/teaching/run_stage3_mmkg.py",
            "--course-id",
            args.course_id,
            "--step",
            "all",
        ]
        if args.lecture_id:
            cmd.extend(["--lecture-id", args.lecture_id])
        if args.force:
            cmd.append("--force")
        _run(cmd, cwd=ROOT)

        viz_cmd = [
            py,
            "scripts/teaching/run_kg_visualize.py",
            "--course-id",
            args.course_id,
            "--source",
            "mmkg",
        ]
        if args.lecture_id:
            viz_cmd.extend(["--lecture-id", args.lecture_id])
        _run(viz_cmd, cwd=ROOT)

    print("\nPipeline finished.")


if __name__ == "__main__":
    main()
