"""Resilient Stage1-only batch for 离散数学 (skip Stage2/3, skip mindmap).

Supports parallel lecture workers. Shared filtered_cues/triplets merges are
serialized by exclusive_dir_lock inside Stage1AlignmentPipeline.run().
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from threading import Lock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

CONFIG = ROOT / "configs" / "teaching_lisan.yaml"
PY = sys.executable
DEFAULT_WORKERS = 4

from scripts.teaching._lisan_progress import (  # noqa: E402
    COURSE_ID,
    all_lectures,
    filtered_counts,
    stage1_done,
)


def precheck() -> list[str]:
    if not CONFIG.is_file():
        raise SystemExit(f"missing config: {CONFIG}")
    from teachkg.config import TeachKGConfig

    cfg = TeachKGConfig.from_yaml(str(CONFIG))
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    tb_path = ROOT / tb.get("path", "")
    print("config:", CONFIG.name)
    print("textbook_kg.enabled:", tb.get("enabled"))
    print("textbook_path:", tb.get("path"), "exists=", tb_path.is_dir())
    avail = all_lectures()
    s1 = stage1_done()
    todo = [lid for lid in avail if lid not in s1]
    print(f"available={len(avail)}")
    print(f"stage1_done={sorted(s1, key=int)}")
    print(f"filtered_counts_n={len(filtered_counts())}")
    print(f"todo_count={len(todo)}")
    print(f"todo={','.join(todo)}")
    if not tb_path.is_dir():
        raise SystemExit("textbook dir missing")
    return todo


def _run_one(lid: str, print_lock: Lock) -> tuple[str, bool, str]:
    cmd = [
        PY,
        "scripts/teaching/run_stage1_filter.py",
        "--config",
        str(CONFIG),
        "--course-id",
        COURSE_ID,
        "--lecture-id",
        lid,
        "--hybrid",
    ]
    with print_lock:
        print(f"\n===== Stage1 lecture {lid} START =====", flush=True)
        print(">>>", " ".join(cmd), flush=True)
    try:
        subprocess.run(cmd, cwd=ROOT, check=True)
        with print_lock:
            print(f"===== Stage1 lecture {lid} OK =====", flush=True)
        return lid, True, ""
    except subprocess.CalledProcessError as exc:
        with print_lock:
            print(f"[WARN] lecture {lid} failed: {exc}", flush=True)
        return lid, False, str(exc)


def run_batch(todo: list[str], workers: int = DEFAULT_WORKERS) -> int:
    log_dir = ROOT / "data" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = log_dir / f"stage1_batch_{COURSE_ID}_{stamp}.json"
    workers = max(1, int(workers))
    print(f"parallel_workers={workers}", flush=True)

    ok: list[str] = []
    failures: list[dict[str, str]] = []
    print_lock = Lock()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_run_one, lid, print_lock): lid for lid in todo}
        for fut in as_completed(futures):
            lid, success, err = fut.result()
            if success:
                ok.append(lid)
            else:
                failures.append({"lecture_id": lid, "error": err})

    ok_sorted = sorted(ok, key=lambda x: int(x) if x.isdigit() else x)
    report = {
        "course_id": COURSE_ID,
        "config": str(CONFIG),
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "workers": workers,
        "todo": todo,
        "ok": ok_sorted,
        "failures": failures,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"\nBatch done. ok={len(ok)} fail={len(failures)} workers={workers} report={report_path}",
        flush=True,
    )
    return 0 if not failures else 1


def verify() -> None:
    avail = all_lectures()
    s1 = stage1_done()
    filt = filtered_counts()
    print("available", len(avail))
    print("filtered_lectures", len(filt), sorted(filt, key=int)[:10], "...")
    print("stage1_done", len(s1), sorted(s1, key=int)[:10], "...")
    missing = [x for x in avail if x not in s1]
    print("remaining_without_stage1", ",".join(missing) if missing else "(none)")
    trip = ROOT / "data" / "kg" / COURSE_ID / "triplets.jsonl"
    if trip.is_file():
        n = sum(1 for line in trip.read_text(encoding="utf-8").splitlines() if line.strip())
        print("triplets_lines", n)


def main() -> None:
    parser = argparse.ArgumentParser(description="Stage1 batch for 离散数学")
    parser.add_argument(
        "mode",
        nargs="?",
        default="precheck",
        choices=["precheck", "run", "verify"],
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"parallel lecture workers (default {DEFAULT_WORKERS})",
    )
    args = parser.parse_args()

    if args.mode == "precheck":
        precheck()
    elif args.mode == "run":
        todo = precheck()
        if todo:
            raise SystemExit(run_batch(todo, workers=args.workers))
    elif args.mode == "verify":
        verify()


if __name__ == "__main__":
    main()
