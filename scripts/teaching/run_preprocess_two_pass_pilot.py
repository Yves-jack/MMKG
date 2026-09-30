#!/usr/bin/env python
"""试点：A 按 cue 通畅；可选 B（默认关闭整讲拼接，PPT 翻页片段上下文已够）。

默认 ``--mode a-only``：只跑 A，最终文本=通畅结果。
``--mode a-then-lecture-b``：旧行为，整讲拼接 B（一般不再使用）。
存量接入请用 ``run_preprocess_pass_a_reuse_b.py``（A + 已有 extract_text 当 B）。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.stage1_alignment.text_preprocess import (
    CueTextPreprocessor,
    default_light_rule_options,
)
from teachkg.utils.io import load_jsonl, save_json
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "configs/teaching_lisan.yaml"))
    parser.add_argument(
        "--course-id",
        default="离散数学(图论+数理逻辑与集合论)",
    )
    parser.add_argument("--lecture-id", action="append", dest="lecture_ids", default=None)
    parser.add_argument(
        "--mode",
        choices=("a-only", "a-then-lecture-b"),
        default="a-only",
        help="a-only=只跑 A；a-then-lecture-b=旧整讲拼接 B",
    )
    parser.add_argument("--out", default=None)
    args = parser.parse_args()
    lecture_ids = [str(x) for x in (args.lecture_ids or ["1", "2"])]
    use_lecture_b = args.mode == "a-then-lecture-b"

    cfg = TeachKGConfig.from_yaml(args.config)
    cues_path = ROOT / cfg.segments_dir / args.course_id / "cues.jsonl"
    all_rows = [
        r
        for r in load_jsonl(cues_path)
        if str(r.get("lecture_id")) in set(lecture_ids)
    ]
    all_rows.sort(
        key=lambda r: (
            int(r["lecture_id"]) if str(r.get("lecture_id", "")).isdigit() else 0,
            float(r.get("start_sec") or 0),
        )
    )

    llm_cfg = cfg.get("stage1", "text_preprocess", "llm", default={}) or {}
    rule_opts = cfg.get("stage1", "text_preprocess", "rules", default={}) or {}
    if not rule_opts:
        rule_opts = default_light_rule_options()

    settings = llm_settings_from_config(
        cfg.get("llm", default={}) or {},
        model=llm_cfg.get("llm_model"),
    )
    client = LLMClient(**settings)
    pp = CueTextPreprocessor(
        enabled=True,
        rule_options=dict(rule_opts),
        llm_enabled=True,
        llm_two_pass=True,
        focus_pass=use_lecture_b,
        focus_lecture_level=use_lecture_b,
        llm_fluency_prompt=llm_cfg.get("fluency_prompt", "stage1/cue_text_fluency.txt"),
        llm_focus_lecture_prompt=llm_cfg.get(
            "focus_lecture_prompt", "stage1/cue_text_focus_lecture.txt"
        ),
        llm_client=client,
        temperature=float(llm_cfg.get("temperature", 0.1) or 0.1),
    )

    experiments_dir = cfg.get("project", "experiments_dir", default="data/experiments")
    out_path = Path(
        args.out
        or (
            ROOT
            / experiments_dir
            / "preprocess_two_pass_lecture"
            / args.course_id
            / f"lec_{'_'.join(lecture_ids)}.json"
        )
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lectures: dict[str, list[dict]] = {}
    for row in all_rows:
        lectures.setdefault(str(row.get("lecture_id")), []).append(row)

    report: dict = {
        "course_id": args.course_id,
        "lecture_ids": lecture_ids,
        "mode": args.mode,
        "lectures": {},
    }
    t0 = time.perf_counter()

    for lid in lecture_ids:
        rows = lectures.get(lid) or []
        print(f"===== lecture {lid}: {len(rows)} cues (pass A) =====", flush=True)
        fluents: list[tuple[str, str]] = []
        cue_meta: dict[str, dict] = {}
        for i, row in enumerate(rows, 1):
            cue_id = str(row.get("cue_id"))
            asr = (row.get("asr_text") or "").strip()
            print(f"  A [{i}/{len(rows)}] {cue_id} asr_len={len(asr)}", flush=True)
            fluent = pp.process_pass_a(asr, args.course_id)
            fluents.append((cue_id, fluent))
            cue_meta[cue_id] = {
                "cue_id": cue_id,
                "lecture_id": lid,
                "start_sec": row.get("start_sec"),
                "end_sec": row.get("end_sec"),
                "asr_len": len(asr),
                "asr_preview": asr[:200],
                "fluency_len": len(fluent or ""),
                "fluency_preview": (fluent or "")[:200],
                "fluency_text": fluent or "",
            }

        outline: list[str] = []
        if use_lecture_b:
            print(f"===== lecture {lid}: pass B (concat) =====", flush=True)
            focus = pp.process_lecture_focus(
                fluents,
                course_context=args.course_id,
                lecture_id=lid,
            )
            outline = list(focus.outline)
            finals = focus.cue_texts
        else:
            finals = {cid: text for cid, text in fluents}

        items = []
        for cue_id, fluent in fluents:
            final = finals.get(cue_id, "") or ""
            meta = cue_meta[cue_id]
            meta.update(
                {
                    "final_len": len(final),
                    "final_preview": final[:240],
                    "final_text": final,
                }
            )
            items.append(meta)

        report["lectures"][lid] = {
            "n_cues": len(items),
            "outline": outline,
            "nonempty_final": sum(1 for x in items if x["final_len"]),
            "mean_compression": round(
                sum((x["final_len"] / x["asr_len"]) if x["asr_len"] else 0.0 for x in items)
                / max(len(items), 1),
                3,
            ),
            "items": items,
        }
        save_json(out_path, report)
        print(
            f"  outline={len(outline)} nonempty={report['lectures'][lid]['nonempty_final']}",
            flush=True,
        )
        for line in outline[:12]:
            print(f"    - {line}", flush=True)

    report["elapsed_sec"] = round(time.perf_counter() - t0, 1)
    report["out"] = str(out_path)
    save_json(out_path, report)
    print(
        json.dumps(
            {
                k: report[k]
                for k in ("course_id", "lecture_ids", "mode", "elapsed_sec", "out")
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    for lid, block in report["lectures"].items():
        print(
            f"lec{lid}: cues={block['n_cues']} nonempty={block['nonempty_final']} "
            f"compress={block['mean_compression']} outline={len(block['outline'])}"
        )


if __name__ == "__main__":
    main()
