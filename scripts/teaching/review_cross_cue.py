#!/usr/bin/env python
"""汇总 triplets.jsonl 中的 cross_cue 边，便于人工审阅。"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.stage1_alignment.triplet_extract import is_cross_cue_extract_source

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Review cross_cue triplets")
    parser.add_argument("--course-id", default="数理逻辑")
    parser.add_argument("--lecture-id", action="append", dest="lecture_ids")
    parser.add_argument(
        "--triplets",
        default=None,
        help="默认 data/kg/{course}/triplets.jsonl",
    )
    parser.add_argument("--out", default=None, help="可选 Markdown 审阅导出")
    args = parser.parse_args()

    path = (
        Path(args.triplets)
        if args.triplets
        else ROOT / "data" / "kg" / args.course_id / "triplets.jsonl"
    )
    rows = [
        json.loads(line)
        for line in path.open(encoding="utf-8")
        if line.strip()
    ]
    lectures = set(str(x) for x in (args.lecture_ids or []))
    cross = [
        r
        for r in rows
        if is_cross_cue_extract_source(str(r.get("extract_source") or ""))
        and (not lectures or str(r.get("lecture_id")) in lectures)
    ]
    by_lec: dict[str, list[dict]] = defaultdict(list)
    for r in cross:
        by_lec[str(r.get("lecture_id"))].append(r)

    print(f"file={path}")
    print(f"cross_cue_total={len(cross)}")
    for lec in sorted(by_lec, key=lambda x: int(x) if x.isdigit() else x):
        print(f"  lecture {lec}: {len(by_lec[lec])}")
    rel = Counter(r.get("abstract_relation") or "?" for r in cross)
    print("relations:", dict(rel))

    # 质量粗检：是否误挂媒体 / context
    bad_media = [
        r
        for r in cross
        if r.get("clip_path") or r.get("ppt_frame_path") or r.get("source_text") or r.get("context")
    ]
    print(f"bad_media_or_context={len(bad_media)}")

    lines = [
        f"# cross_cue review ({args.course_id})",
        "",
        f"- file: `{path}`",
        f"- total: **{len(cross)}**",
        f"- bad_media_or_context: {len(bad_media)}",
        "",
    ]
    for lec in sorted(by_lec, key=lambda x: int(x) if x.isdigit() else x):
        items = by_lec[lec]
        lines.append(f"## Lecture {lec} ({len(items)})")
        lines.append("")
        for i, r in enumerate(items, 1):
            lines.append(
                f"{i}. `{r.get('subject')}` —[{r.get('abstract_relation')}/{r.get('concrete_relation')}]→ "
                f"`{r.get('object')}`  \n"
                f"   source=`{r.get('extract_source')}` cue=`{r.get('cue_id')}` "
                f"grounding=`{r.get('grounding')}`  \n"
                f"   {r.get('description') or ''}"
            )
        lines.append("")

    text = "\n".join(lines)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out}")
    else:
        print(text)


if __name__ == "__main__":
    main()
