"""Watch until lecture 30 mmkg exists, then stop the full-batch parent.

Does not interrupt lecture 30 itself; kills run_lisan_full_batch so 31+ never start.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COURSE = "离散数学(图论+数理逻辑与集合论)"
MMKG = ROOT / "data" / "kg" / COURSE / "lecture_30" / "mmkg.json"


def _batch_pids() -> list[int]:
    """Find PIDs of run_lisan_full_batch.py (Windows)."""
    try:
        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | "
                "Where-Object { $_.CommandLine -match 'run_lisan_full_batch' } | "
                "ForEach-Object { $_.ProcessId }",
            ],
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.CalledProcessError:
        return []
    pids: list[int] = []
    for line in out.splitlines():
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    return pids


def _kill(pid: int) -> None:
    subprocess.run(
        ["taskkill", "/PID", str(pid), "/T", "/F"],
        check=False,
        capture_output=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lecture", default="30")
    parser.add_argument("--poll-sec", type=float, default=15.0)
    args = parser.parse_args()
    mmkg = ROOT / "data" / "kg" / COURSE / f"lecture_{args.lecture}" / "mmkg.json"
    print(f"watching {mmkg}", flush=True)
    print(f"batch pids now: {_batch_pids()}", flush=True)

    while not mmkg.is_file():
        print(f"… waiting lecture {args.lecture} mmkg ({time.strftime('%H:%M:%S')})", flush=True)
        time.sleep(args.poll_sec)

    print(f"lecture {args.lecture} mmkg ready → stopping full batch", flush=True)
    # brief settle so parent finishes logging the OK line
    time.sleep(3.0)
    pids = _batch_pids()
    if not pids:
        print("no run_lisan_full_batch process found (already stopped?)", flush=True)
        return 0
    for pid in pids:
        print(f"taskkill /PID {pid} /T /F", flush=True)
        _kill(pid)
    time.sleep(1.0)
    left = _batch_pids()
    print(f"remaining batch pids: {left}", flush=True)
    print("done: subsequent lectures will not start", flush=True)
    return 0 if not left else 1


if __name__ == "__main__":
    raise SystemExit(main())
