#!/usr/bin/env python
"""按当前预处理规则回填 filtered_cues 的 text_preprocess_* / extract_text。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.stage1_alignment.text_preprocess import rule_preprocess_cue_text
from teachkg.utils.io import load_jsonl, save_json, save_jsonl


def annotate_row(row: dict, rule_options: dict | None = None) -> dict:
    asr = (row.get("asr_text") or "").strip()
    cleaned = rule_preprocess_cue_text(asr, options=rule_options)
    stage1 = dict(row.get("stage1") or {})

    if not asr:
        status = "empty_source"
        note = "原始 asr_text 为空，无预处理文本。"
        extract_text = ""
    elif not cleaned:
        status = "empty_after_preprocess"
        note = (
            "当前预处理规则下无保留可用知识内容；不应用 asr_text 抽取。"
            "若仍有 triplets，属于旧流水线残留，建议对该讲次重跑 Stage1。"
        )
        extract_text = ""
        if not stage1.get("triplet_error"):
            stage1["triplet_error"] = "empty_text_after_preprocess"
    elif cleaned == asr:
        status = "unchanged"
        note = "当前预处理规则未改动原文；抽取使用与 asr_text 相同的 extract_text。"
        extract_text = cleaned
    else:
        status = "changed"
        note = "当前预处理规则已改动原文；抽取应使用 extract_text。"
        extract_text = cleaned

    stage1["text_preprocess_status"] = status
    stage1["text_preprocess_note"] = note
    stage1["extract_text"] = extract_text

    out = dict(row)
    out["stage1"] = stage1
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "configs/teaching.yaml"))
    parser.add_argument("--course-id", default="shuliluoji")
    parser.add_argument(
        "--lecture-id",
        action="append",
        dest="lecture_ids",
        help="仅回填指定讲次；默认可全部",
    )
    args = parser.parse_args()

    cfg = TeachKGConfig.from_yaml(args.config)
    rule_options = cfg.get("stage1", "text_preprocess", "rules", default={}) or {}
    src = ROOT / cfg.processed_dir / args.course_id / "filtered_cues.jsonl"
    if not src.exists():
        raise FileNotFoundError(src)

    rows = load_jsonl(src)
    wanted = {str(x) for x in args.lecture_ids} if args.lecture_ids else None
    updated = []
    stats = {"changed": 0, "unchanged": 0, "empty_after_preprocess": 0, "empty_source": 0}
    for row in rows:
        if wanted and str(row.get("lecture_id")) not in wanted:
            updated.append(row)
            continue
        new_row = annotate_row(row, rule_options=rule_options)
        status = new_row["stage1"]["text_preprocess_status"]
        stats[status] = stats.get(status, 0) + 1
        updated.append(new_row)

    save_jsonl(src, updated)
    # pretty_view 同步
    from teachkg.utils.io import pretty_json_path

    save_json(pretty_json_path(src), updated)
    print(f"updated {src}")
    print("stats", stats)


if __name__ == "__main__":
    main()
