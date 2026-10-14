#!/usr/bin/env python3
"""全量重跑导图：讲次四步 → 章实体合并(+LLM) → 剔未讲章 → 整课+同步。

示例：
  python scripts/teaching/rerun_all_mindmaps.py
  python scripts/teaching/rerun_all_mindmaps.py --skip-lecture-llm   # 仅重拼章/课
  python scripts/teaching/rerun_all_mindmaps.py --lectures 1,2,3
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COURSE = "离散数学(图论+数理逻辑与集合论)"


def list_lecture_ids() -> list[str]:
    kg = ROOT / "data/kg" / COURSE
    lids: list[str] = []
    for p in kg.glob("lecture_*"):
        if not (p / "kg.json").is_file():
            continue
        lid = p.name.split("_", 1)[-1]
        if lid.isdigit():
            lids.append(lid)
    return sorted(lids, key=int)


def run(cmd: list[str]) -> int:
    print("\n>>>", " ".join(cmd), flush=True)
    r = subprocess.run(cmd, cwd=str(ROOT))
    return int(r.returncode)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lectures", default="", help="逗号分隔；默认全部有 kg 的讲次")
    ap.add_argument("--skip-lecture-llm", action="store_true", help="跳过讲次 LLM，只重拼章/课")
    ap.add_argument("--no-chapter-merge-llm", action="store_true")
    ap.add_argument("--config", default=str(ROOT / "configs" / "teaching_lisan.yaml"))
    args = ap.parse_args()

    lids = [x.strip() for x in args.lectures.split(",") if x.strip()]
    if not lids:
        lids = list_lecture_ids()
    # 第17讲无图谱
    lids = [x for x in lids if x != "17"]
    print(f"lectures ({len(lids)}): {','.join(lids)}", flush=True)

    py = sys.executable
    if not args.skip_lecture_llm:
        # 分批跑，避免命令行过长；每批后继续
        batch = 5
        for i in range(0, len(lids), batch):
            chunk = lids[i : i + batch]
            rc = run(
                [
                    py,
                    str(ROOT / "scripts/teaching/run_lecture_mindmap_pipeline.py"),
                    "--config",
                    args.config,
                    "--course",
                    COURSE,
                    "--lectures",
                    ",".join(chunk),
                    "--sync-showcase",
                ]
                + (["--no-chapter-merge-llm"] if args.no_chapter_merge_llm else [])
            )
            if rc != 0:
                print(f"lecture batch failed rc={rc}: {chunk}", flush=True)
                return rc
    else:
        # 仅 restitch + 可选章 LLM
        cmd = [
            py,
            str(ROOT / "scripts/teaching/run_lecture_mindmap_pipeline.py"),
            "--config",
            args.config,
            "--course",
            COURSE,
            "--restitch-chapters",
            "--sync-showcase",
        ]
        if args.no_chapter_merge_llm:
            cmd.append("--no-chapter-merge-llm")
        rc = run(cmd)
        if rc != 0:
            return rc

    # 章骨架已由 PPT 提取；此处不再跑 build-chapter-mindmaps（会冲掉四步合并结果）

    rc = run([py, str(ROOT / "scripts/teaching/prune_untaught_chapters.py")])
    if rc != 0:
        return rc

    print("\n=== ALL DONE ===", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
