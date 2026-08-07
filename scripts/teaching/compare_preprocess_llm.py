#!/usr/bin/env python
"""对比规则清洗 vs 轻规则+LLM 清洗（默认讲次 1、17），并可选写报告。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.stage1_alignment.text_preprocess import (
    CueTextPreprocessor,
    rule_preprocess_cue_text,
)
from teachkg.utils.io import load_jsonl, save_json
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config


def _status(raw: str, cleaned: str) -> str:
    raw = (raw or "").strip()
    cleaned = (cleaned or "").strip()
    if not raw:
        return "empty_source"
    if not cleaned:
        return "empty_after_preprocess"
    if cleaned == raw:
        return "unchanged"
    return "changed"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "configs/teaching.yaml"))
    parser.add_argument("--course-id", default="shuliluoji")
    parser.add_argument("--lecture-id", action="append", dest="lecture_ids", default=None)
    parser.add_argument(
        "--out",
        default=None,
        help="对比报告 JSON 路径（默认 data/experiments/comparisons/<course>/...）",
    )
    args = parser.parse_args()
    lecture_ids = [str(x) for x in (args.lecture_ids or ["1", "17"])]

    cfg = TeachKGConfig.from_yaml(args.config)
    cues_path = ROOT / cfg.segments_dir / args.course_id / "cues.jsonl"
    rows = [
        r
        for r in load_jsonl(cues_path)
        if str(r.get("lecture_id")) in set(lecture_ids)
    ]

    rule_full = {
        "remove_markdown_noise": True,
        "remove_classroom_admin": True,
        "remove_non_knowledge": True,
        "knowledge_min_score": 1.0,
        "remove_example_labels": True,
        "dedupe_paragraphs": True,
    }
    # 大模型实验：只做版式噪声，语义过滤交给 LLM
    rule_light = {
        "remove_markdown_noise": True,
        "remove_classroom_admin": False,
        "remove_non_knowledge": False,
        "remove_example_labels": True,
        "dedupe_paragraphs": True,
    }

    llm_cfg = cfg.get("llm", default={}) or {}
    settings = llm_settings_from_config(
        llm_cfg,
        model=cfg.get("stage1", "text_preprocess", "llm", "llm_model"),
    )
    llm_client = LLMClient(**settings)
    llm_pp = CueTextPreprocessor(
        enabled=True,
        rule_options=rule_light,
        llm_enabled=True,
        llm_prompt=cfg.get(
            "stage1", "text_preprocess", "llm", "prompt", default="stage1/cue_text_preprocess.txt"
        ),
        llm_client=llm_client,
        temperature=float(
            cfg.get("stage1", "text_preprocess", "llm", "temperature", default=0.1) or 0.1
        ),
    )

    course_context = args.course_id
    report_rows: list[dict] = []
    summary: dict[str, dict] = {}

    for row in rows:
        lec = str(row.get("lecture_id"))
        asr = (row.get("asr_text") or "").strip()
        rule_out = rule_preprocess_cue_text(asr, options=rule_full)
        llm_out = llm_pp.process(asr, course_context)
        item = {
            "cue_id": row.get("cue_id"),
            "lecture_id": lec,
            "asr_len": len(asr),
            "asr_preview": asr[:120],
            "rule": {
                "status": _status(asr, rule_out),
                "len": len(rule_out),
                "text": rule_out,
            },
            "llm": {
                "status": _status(asr, llm_out),
                "len": len(llm_out),
                "text": llm_out,
            },
        }
        report_rows.append(item)
        bucket = summary.setdefault(
            lec,
            {
                "cues": 0,
                "rule_empty": 0,
                "llm_empty": 0,
                "rule_changed": 0,
                "llm_changed": 0,
                "agree_empty": 0,
                "agree_keep": 0,
                "diverge": 0,
            },
        )
        bucket["cues"] += 1
        if item["rule"]["status"] == "empty_after_preprocess":
            bucket["rule_empty"] += 1
        if item["llm"]["status"] == "empty_after_preprocess":
            bucket["llm_empty"] += 1
        if item["rule"]["status"] == "changed":
            bucket["rule_changed"] += 1
        if item["llm"]["status"] == "changed":
            bucket["llm_changed"] += 1
        rule_empty = item["rule"]["status"] == "empty_after_preprocess"
        llm_empty = item["llm"]["status"] == "empty_after_preprocess"
        if rule_empty and llm_empty:
            bucket["agree_empty"] += 1
        elif (not rule_empty) and (not llm_empty):
            bucket["agree_keep"] += 1
        else:
            bucket["diverge"] += 1
        print(
            f"[{lec}] {row.get('cue_id')}: rule={item['rule']['status']}({item['rule']['len']}) "
            f"llm={item['llm']['status']}({item['llm']['len']})"
        )

    lec_tag = "_".join(f"lec{x}" for x in lecture_ids)
    out = Path(
        args.out
        or (
            ROOT
            / "data"
            / "experiments"
            / "comparisons"
            / args.course_id
            / f"preprocess_rule_vs_llm_{lec_tag}.json"
        )
    )
    payload = {
        "course_id": args.course_id,
        "lecture_ids": lecture_ids,
        "mode": {
            "rule": "full rules including knowledge density",
            "llm": "light rules (markdown/labels) + LLM semantic filter",
        },
        "summary": summary,
        "items": report_rows,
    }
    save_json(out, payload)
    print("summary", json.dumps(summary, ensure_ascii=False, indent=2))
    print("wrote", out)


if __name__ == "__main__":
    main()
