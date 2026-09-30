"""离散数学：单讲跑完 Stage1→2→3（跳过 mindmap），双讲并行。

Stage0 已完成时跳过；Stage1 仅在「覆盖率+教材边+课堂边」判据满足时跳过。
完成判据：data/kg/{course}/lecture_{id}/mmkg.json
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

from scripts.teaching._lisan_progress import (  # noqa: E402
    COURSE_ID,
    all_lectures,
    kg_done,
    mmkg_done,
    pipeline_settled,
    skipped_lectures,
    stage1_done,
)
from teachkg.lecture_skip import (  # noqa: E402
    LectureSkipInfo,
    auto_skip_empty_enabled,
    config_skip_lectures,
    detect_empty_knowledge,
    ensure_config_skips,
    is_skipped,
    write_skip_marker,
)

CONFIG = ROOT / "configs" / "teaching_lisan.yaml"
PY = sys.executable
DEFAULT_WORKERS = 1


def _load_batch_cfg() -> dict:
    try:
        import yaml

        raw = yaml.safe_load(CONFIG.read_text(encoding="utf-8")) or {}
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def precheck() -> list[str]:
    if not CONFIG.is_file():
        raise SystemExit(f"missing config: {CONFIG}")
    cfg = _load_batch_cfg()
    ensure_config_skips(COURSE_ID, config_skip_lectures(cfg), root=ROOT)
    avail = all_lectures()
    s1 = stage1_done()
    kg = kg_done()
    mmkg = mmkg_done()
    skipped = skipped_lectures()
    settled = pipeline_settled()
    todo = [lid for lid in avail if lid not in settled]
    print("config:", CONFIG.name)
    print(f"available={len(avail)}")
    print(f"stage1_done={sorted(s1, key=int)}")
    print(f"kg_done={sorted(kg, key=int)}")
    print(f"mmkg_done={sorted(mmkg, key=int)}")
    print(f"skipped={sorted(skipped, key=int)}")
    print(f"todo_count={len(todo)}")
    print(f"todo={','.join(todo)}")
    return todo


def _run(cmd: list[str], print_lock: Lock, tag: str) -> None:
    with print_lock:
        print(f">>> [{tag}] {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=ROOT, check=True)


def _mark_empty_skip(lid: str, print_lock: Lock, *, info) -> tuple[str, str, str]:
    path = write_skip_marker(
        COURSE_ID,
        lid,
        reason=info.reason,
        detail=info.detail,
        source=info.source,
        root=ROOT,
    )
    with print_lock:
        print(
            f"===== lecture {lid} SKIPPED ({info.reason}) → {path} =====",
            flush=True,
        )
    return lid, "skipped", info.reason


def _run_one(lid: str, print_lock: Lock, *, force: bool) -> tuple[str, str, str]:
    """Returns (lecture_id, status, detail) where status is ok|skipped|failed."""
    force_args = ["--force"] if force else []
    s1_done = stage1_done()
    cfg = _load_batch_cfg()
    try:
        with print_lock:
            print(f"\n===== lecture {lid} FULL START =====", flush=True)

        if is_skipped(COURSE_ID, lid, root=ROOT) and not force:
            with print_lock:
                print(f"[{lid}] already skipped (no_knowledge)", flush=True)
            return lid, "skipped", "already_marked"

        # 配置显式跳过：不跑 Stage1–3
        if lid in config_skip_lectures(cfg) and not force:
            path = write_skip_marker(
                COURSE_ID,
                lid,
                reason="config_skip_lectures",
                detail="配置 batch.skip_lectures 显式跳过",
                source="config",
                root=ROOT,
            )
            with print_lock:
                print(f"===== lecture {lid} SKIPPED (config) → {path} =====", flush=True)
            return lid, "skipped", "config_skip_lectures"

        # Stage 1（覆盖率+教材边+课堂边齐全才跳过；指纹校验在 pipeline 内）
        if force or lid not in s1_done:
            _run(
                [
                    PY,
                    "scripts/teaching/run_stage1_filter.py",
                    "--config",
                    str(CONFIG),
                    "--course-id",
                    COURSE_ID,
                    "--lecture-id",
                    lid,
                    "--hybrid",
                    *force_args,
                ],
                print_lock,
                f"{lid}/s1",
            )
        else:
            with print_lock:
                print(f"[{lid}] skip Stage1 (coverage+hybrid complete)", flush=True)

        # Stage1 后：无三元组 → 结案为 skipped（考试/行政场等）
        if auto_skip_empty_enabled(cfg):
            empty = detect_empty_knowledge(COURSE_ID, lid, root=ROOT)
            if empty is not None:
                return _mark_empty_skip(lid, print_lock, info=empty)

        # Stage 2
        _run(
            [
                PY,
                "scripts/teaching/run_stage2_kg.py",
                "--config",
                str(CONFIG),
                "--course-id",
                COURSE_ID,
                "--lecture-id",
                lid,
                *force_args,
            ],
            print_lock,
            f"{lid}/s2",
        )

        # Stage 3（evidence→alignment→describe→index）
        _run(
            [
                PY,
                "scripts/teaching/run_stage3_mmkg.py",
                "--config",
                str(CONFIG),
                "--course-id",
                COURSE_ID,
                "--lecture-id",
                lid,
                "--step",
                "all",
                *force_args,
            ],
            print_lock,
            f"{lid}/s3",
        )

        # 可视化（轻量，失败不阻断）
        try:
            _run(
                [
                    PY,
                    "scripts/teaching/run_kg_visualize.py",
                    "--config",
                    str(CONFIG),
                    "--course-id",
                    COURSE_ID,
                    "--lecture-id",
                    lid,
                    "--source",
                    "mmkg",
                ],
                print_lock,
                f"{lid}/viz",
            )
        except subprocess.CalledProcessError as exc:
            with print_lock:
                print(f"[WARN] lecture {lid} viz failed: {exc}", flush=True)

        with print_lock:
            print(f"===== lecture {lid} FULL OK =====", flush=True)
        return lid, "ok", ""
    except subprocess.CalledProcessError as exc:
        # Stage2「No triplets」兜底：仍记 skipped，避免批处理 exit 1
        err = str(exc)
        if auto_skip_empty_enabled(cfg) and "No triplets" in err:
            empty = detect_empty_knowledge(COURSE_ID, lid, root=ROOT)
            if empty is None:
                empty = LectureSkipInfo(
                    course_id=COURSE_ID,
                    lecture_id=lid,
                    reason="no_knowledge_content",
                    detail=err,
                    source="auto",
                )
            return _mark_empty_skip(lid, print_lock, info=empty)
        with print_lock:
            print(f"[WARN] lecture {lid} FAILED: {exc}", flush=True)
        return lid, "failed", err


def run_batch(todo: list[str], workers: int = DEFAULT_WORKERS, *, force: bool = False) -> int:
    log_dir = ROOT / "data" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = log_dir / f"stage_full_batch_{COURSE_ID}_{stamp}.json"
    workers = max(1, int(workers))
    print(f"parallel_workers={workers} (per-lecture Stage1→2→3)", flush=True)

    ok: list[str] = []
    skipped: list[dict[str, str]] = []
    failures: list[dict[str, str]] = []
    print_lock = Lock()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_run_one, lid, print_lock, force=force): lid for lid in todo
        }
        for fut in as_completed(futures):
            lid, status, detail = fut.result()
            if status == "ok":
                ok.append(lid)
            elif status == "skipped":
                skipped.append({"lecture_id": lid, "reason": detail})
            else:
                failures.append({"lecture_id": lid, "error": detail})

    report = {
        "course_id": COURSE_ID,
        "config": str(CONFIG),
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "workers": workers,
        "todo": todo,
        "ok": sorted(ok, key=lambda x: int(x) if x.isdigit() else x),
        "skipped": skipped,
        "failures": failures,
        "pipeline": "stage1→2→3(+viz), skip mindmap; empty→skipped",
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"\nBatch done. ok={len(ok)} skipped={len(skipped)} fail={len(failures)} "
        f"workers={workers} report={report_path}",
        flush=True,
    )
    return 0 if not failures else 1


def verify() -> None:
    avail = all_lectures()
    s1 = stage1_done()
    kg = kg_done()
    mmkg = mmkg_done()
    skipped = skipped_lectures()
    settled = pipeline_settled()
    print("available", len(avail))
    print("stage1_done", len(s1), sorted(s1, key=int))
    print("kg_done", len(kg), sorted(kg, key=int))
    print("mmkg", len(mmkg), sorted(mmkg, key=int))
    print("skipped", len(skipped), sorted(skipped, key=int))
    missing = [x for x in avail if x not in settled]
    print("remaining_unsettle", ",".join(missing) if missing else "(none)")

def main() -> None:
    parser = argparse.ArgumentParser(description="离散数学单讲全 Stage 批处理（双讲并行）")
    parser.add_argument("mode", nargs="?", default="precheck", choices=["precheck", "run", "verify"])
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if args.mode == "precheck":
        precheck()
    elif args.mode == "run":
        todo = precheck()
        if todo:
            raise SystemExit(run_batch(todo, workers=args.workers, force=args.force))
    elif args.mode == "verify":
        verify()


if __name__ == "__main__":
    main()
