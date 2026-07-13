#!/usr/bin/env python
"""批量处理课程可用讲次：自动跳过缺号/缺视频，增量合并产物。"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from teachkg.config import TeachKGConfig
from teachkg.stage0_segmentation.slicer import VideoSlicer
from teachkg.utils.io import load_jsonl


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Batch process available lectures for a course")
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", default="shuliluoji")
    p.add_argument("--workspace", default=None, help="raw 课程目录（默认自动发现）")
    p.add_argument("--python", default=sys.executable)
    p.add_argument("--from-stage", choices=("0", "1", "2", "3", "course"), default="0")
    p.add_argument("--lecture-id", action="append", dest="lecture_ids", help="仅处理指定讲次")
    p.add_argument("--force", action="store_true")
    p.add_argument("--skip-stage0", action="store_true", help="跳过 Stage 0（已有 cues）")
    p.add_argument("--dry-run", action="store_true", help="只输出讲次清单，不执行")
    return p.parse_args()


def _resolve_workspace(args: argparse.Namespace) -> Path:
    if args.workspace:
        return Path(args.workspace).resolve()
    raw = ROOT / "data" / "raw"
    for d in sorted(raw.iterdir()):
        if d.is_dir() and (d / "video" / "class").is_dir():
            return d.resolve()
    raise FileNotFoundError("未找到 workspace，请指定 --workspace")


def _processed_lectures(segments_dir: Path, course_id: str) -> set[str]:
    done: set[str] = set()
    cues_path = segments_dir / course_id / "cues.jsonl"
    if cues_path.is_file():
        for row in load_jsonl(cues_path):
            lid = str(row.get("lecture_id", "")).strip()
            if lid:
                done.add(lid)
    asr_root = segments_dir / course_id / "asr_work"
    if asr_root.is_dir():
        for d in asr_root.iterdir():
            if d.is_dir() and (d / "corrected_cues.json").is_file():
                done.add(d.name)
    return done


def _run(cmd: list[str], *, cwd: Path) -> None:
    print(">>>", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def main() -> None:
    args = parse_args()
    py = args.python
    config = TeachKGConfig.from_yaml(args.config)
    workspace = _resolve_workspace(args)
    slicer = VideoSlicer(config)
    inventory = slicer.lecture_inventory(workspace)
    segments_dir = Path(config.get("project", "segments_dir", default="data/segments"))
    processed = _processed_lectures(segments_dir, args.course_id)

    available = inventory["available"]
    if args.lecture_ids:
        wanted = {str(x) for x in args.lecture_ids}
        available = [lid for lid in available if lid in wanted]

    todo_stage0 = [lid for lid in available if lid not in processed]
    todo_rest = list(available)

    report = {
        "course_id": args.course_id,
        "workspace": str(workspace),
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "inventory": inventory,
        "processed_lectures": sorted(processed),
        "todo_stage0": todo_stage0,
        "todo_pipeline": todo_rest,
    }
    report_path = ROOT / "data" / "logs" / f"batch_lectures_{args.course_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"课程: {args.course_id}")
    print(f"Workspace: {workspace}")
    print(f"可用讲次 ({inventory['available_count']}): {', '.join(inventory['available'])}")
    if inventory["gaps_in_range"]:
        print(f"缺号讲次（源数据无视频）: {', '.join(inventory['gaps_in_range'])}")
    skipped = inventory.get("skipped_incomplete") or {}
    if skipped.get("class_only") or skipped.get("ppt_only"):
        print(f"不完整配对 class_only={skipped.get('class_only')} ppt_only={skipped.get('ppt_only')}")
    print(f"已处理: {', '.join(sorted(processed)) or '（无）'}")
    print(f"待 Stage 0: {', '.join(todo_stage0) or '（无）'}")
    print(f"报告: {report_path}")

    if args.dry_run:
        return

    force = ["--force"] if args.force else []
    stages = ["0", "1", "2", "3", "course"]
    start = stages.index(args.from_stage)

    failures: list[dict[str, str]] = []

    if start <= 0 and not args.skip_stage0:
        for lid in todo_stage0:
            cmd = [
                py,
                "scripts/teaching/run_stage0_segment.py",
                "--workspace",
                str(workspace),
                "--course-id",
                args.course_id,
                "--lecture-id",
                lid,
            ]
            try:
                _run(cmd, cwd=ROOT)
            except subprocess.CalledProcessError as exc:
                failures.append({"lecture_id": lid, "stage": "0", "error": str(exc)})
                print(f"[WARN] Stage 0 failed for lecture {lid}, continue.", flush=True)

    # 重新计算有 cues 的讲次
    processed_after = _processed_lectures(segments_dir, args.course_id)
    lecture_targets = [lid for lid in available if lid in processed_after]
    if not lecture_targets:
        print("No lectures with cues available after Stage 0.")
        return

    new_lectures = [lid for lid in todo_stage0 if lid in processed_after]

    if start <= 1:
        stage1_targets = new_lectures if start <= 0 else lecture_targets
        if args.lecture_ids:
            stage1_targets = [lid for lid in lecture_targets if lid in {str(x) for x in args.lecture_ids}]
        for lid in stage1_targets:
                cmd = [
                    py,
                    "scripts/teaching/run_stage1_filter.py",
                    "--course-id",
                    args.course_id,
                    "--lecture-id",
                    lid,
                ]
                if args.force:
                    cmd.append("--force")
                try:
                    _run(cmd, cwd=ROOT)
                except subprocess.CalledProcessError as exc:
                    failures.append({"lecture_id": lid, "stage": "1", "error": str(exc)})
                    print(f"[WARN] Stage 1 failed for lecture {lid}, continue.", flush=True)

    if start <= 2:
        for lid in lecture_targets:
            cmd = [
                py,
                "scripts/teaching/run_stage2_kg.py",
                "--course-id",
                args.course_id,
                "--lecture-id",
                lid,
                *force,
            ]
            try:
                _run(cmd, cwd=ROOT)
            except subprocess.CalledProcessError as exc:
                failures.append({"lecture_id": lid, "stage": "2", "error": str(exc)})

    if start <= 3:
        for lid in lecture_targets:
            cmd = [
                py,
                "scripts/teaching/run_stage3_mmkg.py",
                "--course-id",
                args.course_id,
                "--lecture-id",
                lid,
                "--step",
                "all",
                *force,
            ]
            try:
                _run(cmd, cwd=ROOT)
            except subprocess.CalledProcessError as exc:
                failures.append({"lecture_id": lid, "stage": "3", "error": str(exc)})

        _run(
            [
                py,
                "scripts/teaching/run_all_kg_viz.py",
                "--course-id",
                args.course_id,
            ],
            cwd=ROOT,
        )

    if start <= 4:
        _run(
            [
                py,
                "scripts/teaching/run_stage2_kg.py",
                "--course-id",
                args.course_id,
                *force,
            ],
            cwd=ROOT,
        )
        _run(
            [
                py,
                "scripts/teaching/run_course_pipeline.py",
                "--course-id",
                args.course_id,
                "--from-stage",
                "3",
                *force,
            ],
            cwd=ROOT,
        )

    report["failures"] = failures
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nBatch finished. failures={len(failures)}")
    if failures:
        for f in failures:
            print(f"  lecture {f['lecture_id']} stage {f['stage']}: {f['error']}")


if __name__ == "__main__":
    main()
