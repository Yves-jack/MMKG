"""Precheck + resilient Stage0 batch for 离散数学 lectures 3-44."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

COURSE_ID = "离散数学(图论+数理逻辑与集合论)"
WORKSPACE = ROOT / "data" / "raw" / COURSE_ID
PY = sys.executable


def dashscope_configured() -> bool:
    if os.environ.get("DASHSCOPE_API_KEY"):
        return True
    env = ROOT / ".env"
    if not env.is_file():
        return False
    for line in env.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        if k.strip() == "DASHSCOPE_API_KEY" and len(v.strip().strip("\"'")) > 8:
            return True
    return False


def processed_lectures(segments_dir: Path) -> set[str]:
    from teachkg.utils.io import load_jsonl

    done: set[str] = set()
    cues_path = segments_dir / COURSE_ID / "cues.jsonl"
    if cues_path.is_file():
        for row in load_jsonl(cues_path):
            lid = str(row.get("lecture_id", "")).strip()
            if lid:
                done.add(lid)
    asr_root = segments_dir / COURSE_ID / "asr_work"
    if asr_root.is_dir():
        for d in asr_root.iterdir():
            if d.is_dir() and (d / "corrected_cues.json").is_file():
                done.add(d.name)
    return done


def inventory_and_todo() -> tuple[list[str], list[str], Path]:
    from teachkg.config import TeachKGConfig
    from teachkg.stage0_segmentation.slicer import VideoSlicer

    cfg = TeachKGConfig.from_yaml(str(ROOT / "configs" / "teaching_lisan.yaml"))
    slicer = VideoSlicer(cfg)
    inv = slicer.lecture_inventory(WORKSPACE)
    segments_dir = Path(cfg.get("project", "segments_dir", default="data/segments"))
    if not segments_dir.is_absolute():
        segments_dir = ROOT / segments_dir
    done = processed_lectures(segments_dir)
    available = inv["available"]
    todo = [lid for lid in available if lid not in done]
    return available, todo, segments_dir


def precheck() -> list[str]:
    print("ffmpeg:", bool(shutil.which("ffmpeg")))
    print("dashscope_configured:", dashscope_configured())
    if not WORKSPACE.is_dir():
        raise SystemExit(f"workspace missing: {WORKSPACE}")
    available, todo, segments_dir = inventory_and_todo()
    print(f"available={len(available)}")
    print(f"done={[x for x in available if x not in todo]}")
    print(f"todo_count={len(todo)}")
    print(f"todo={','.join(todo)}")
    print(f"segments_dir={segments_dir}")
    if not dashscope_configured():
        raise SystemExit("DASHSCOPE_API_KEY not configured in env or .env")
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found on PATH")
    if not todo:
        print("Nothing to do.")
    return todo


def run_batch(todo: list[str]) -> int:
    log_dir = ROOT / "data" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = log_dir / f"stage0_batch_{COURSE_ID}_{stamp}.json"
    failures: list[dict[str, str]] = []
    ok: list[str] = []

    for i, lid in enumerate(todo, 1):
        print(f"\n===== [{i}/{len(todo)}] Stage0 lecture {lid} =====", flush=True)
        cmd = [
            PY,
            "scripts/teaching/run_stage0_segment.py",
            "--config",
            str(ROOT / "configs" / "teaching_lisan.yaml"),
            "--workspace",
            str(WORKSPACE),
            "--course-id",
            COURSE_ID,
            "--lecture-id",
            lid,
        ]
        print(">>>", " ".join(cmd), flush=True)
        try:
            subprocess.run(cmd, cwd=ROOT, check=True)
            ok.append(lid)
        except subprocess.CalledProcessError as exc:
            failures.append({"lecture_id": lid, "error": str(exc)})
            print(f"[WARN] lecture {lid} failed, continue.", flush=True)

    report = {
        "course_id": COURSE_ID,
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "todo": todo,
        "ok": ok,
        "failures": failures,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nBatch done. ok={len(ok)} fail={len(failures)} report={report_path}", flush=True)
    return 0 if not failures else 1


def verify() -> None:
    available, todo, segments_dir = inventory_and_todo()
    asr = segments_dir / COURSE_ID / "asr_work"
    corrected = []
    if asr.is_dir():
        for d in sorted(asr.iterdir(), key=lambda p: int(p.name) if p.name.isdigit() else 0):
            if d.is_dir() and (d / "corrected_cues.json").is_file():
                corrected.append(d.name)
    cues = segments_dir / COURSE_ID / "cues.jsonl"
    n_cues = sum(1 for _ in cues.open(encoding="utf-8")) if cues.is_file() else 0
    manifest = segments_dir / COURSE_ID / "stage0_manifest.json"
    print("corrected_lectures:", ",".join(corrected))
    print("corrected_count:", len(corrected))
    print("cues_jsonl_lines:", n_cues)
    print("manifest_exists:", manifest.is_file())
    print("remaining_todo:", ",".join(todo) if todo else "(none)")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "precheck"
    if mode == "precheck":
        precheck()
    elif mode == "run":
        todo = precheck()
        if todo:
            raise SystemExit(run_batch(todo))
    elif mode == "verify":
        verify()
    else:
        raise SystemExit(f"unknown mode: {mode}")
