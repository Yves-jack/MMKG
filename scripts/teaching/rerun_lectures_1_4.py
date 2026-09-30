"""Force re-run lectures 1–4 (Stage1→2→3 + viz) for preprocess preview."""
from __future__ import annotations

import sys
from pathlib import Path
from threading import Lock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.teaching.run_lisan_full_batch import _run_one  # noqa: E402


def main() -> int:
    lock = Lock()
    ok: list[str] = []
    fail: list[str] = []
    for lid in ["1", "2", "3", "4"]:
        print(f"\n######## FORCE RERUN lecture {lid} ########", flush=True)
        lec, success, err = _run_one(lid, lock, force=True)
        if success:
            ok.append(lid)
            print(f"######## lecture {lid} OK ########", flush=True)
        else:
            fail.append(lid)
            print(f"######## lecture {lid} FAIL: {err} ########", flush=True)
    print("SUMMARY ok=", ok, "fail=", fail, flush=True)
    return 0 if not fail else 1


if __name__ == "__main__":
    raise SystemExit(main())
