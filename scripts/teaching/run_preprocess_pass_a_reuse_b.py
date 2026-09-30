#!/usr/bin/env python
"""存量接入 AB：只跑 A（通畅），已有 extract_text 当作 B，不重跑抽取。

- A：``cue_text_fluency``
- B 提示词已就位（``cue_text_focus``，由原 preprocess 改写），本脚本不跑 B
- 写回 ``stage1.fluency_text``，保留 ``extract_text`` / 三元组

默认输入：data/pretty_view/processed/{course}/filtered_cues.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.stage1_alignment.text_preprocess import (
    CueTextPreprocessor,
    default_light_rule_options,
)
from teachkg.utils.io import save_json
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config


def _load_cues(path: Path) -> list[dict]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in ("cues", "items", "filtered_cues"):
            if isinstance(raw.get(key), list):
                return raw[key]
    raise ValueError(f"unsupported cues json shape: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "configs/teaching_lisan.yaml"))
    parser.add_argument(
        "--course-id",
        default="离散数学(图论+数理逻辑与集合论)",
    )
    parser.add_argument("--lecture-id", action="append", dest="lecture_ids", default=None)
    parser.add_argument("--cues", default=None)
    parser.add_argument("--out", default=None)
    parser.add_argument(
        "--write-back",
        action="store_true",
        help="把 fluency_text 写回 --cues（不改 extract_text / 三元组）",
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        default=True,
        help="已有非空 fluency_text 则跳过（默认开）",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="忽略已有 fluency，全部重跑 A",
    )
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--mock", action="store_true")
    args = parser.parse_args()
    skip_existing = bool(args.skip_existing) and not bool(args.force)
    lecture_ids = [str(x) for x in (args.lecture_ids or [])]

    cfg = TeachKGConfig.from_yaml(args.config)
    cues_path = Path(
        args.cues
        or (
            ROOT
            / "data"
            / "pretty_view"
            / "processed"
            / args.course_id
            / "filtered_cues.json"
        )
    )
    if not cues_path.is_file():
        raise SystemExit(f"cues not found: {cues_path}")

    all_rows = _load_cues(cues_path)
    if lecture_ids:
        rows = [r for r in all_rows if str(r.get("lecture_id")) in set(lecture_ids)]
    else:
        rows = list(all_rows)
        lecture_ids = sorted(
            {str(r.get("lecture_id")) for r in rows if r.get("lecture_id") is not None},
            key=lambda x: int(x) if x.isdigit() else x,
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
        llm_enabled=not args.mock,
        llm_two_pass=True,
        focus_pass=False,
        focus_lecture_level=False,
        llm_fluency_prompt=llm_cfg.get("fluency_prompt", "stage1/cue_text_fluency.txt"),
        llm_focus_prompt=llm_cfg.get("focus_prompt", "stage1/cue_text_focus.txt"),
        llm_client=client,
        temperature=float(llm_cfg.get("temperature", 0.1) or 0.1),
        mock=bool(args.mock),
    )

    experiments_dir = cfg.get("project", "experiments_dir", default="data/experiments")
    out_path = Path(
        args.out
        or (
            ROOT
            / experiments_dir
            / "preprocess_a_reuse_b"
            / args.course_id
            / f"lec_{'_'.join(lecture_ids) if lecture_ids else 'all'}.json"
        )
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    by_lecture: dict[str, list[dict]] = {}
    for row in rows:
        by_lecture.setdefault(str(row.get("lecture_id")), []).append(row)

    report: dict = {
        "course_id": args.course_id,
        "lecture_ids": lecture_ids,
        "cues_path": str(cues_path),
        "mode": "pass_a + reuse existing extract_text as B (B prompt ready, not run)",
        "skip_existing": skip_existing,
        "workers": int(args.workers),
        "lectures": {},
    }
    t0 = time.perf_counter()
    fluency_by_id: dict[str, str] = {}
    skipped = 0
    ran = 0

    def _run_one(row: dict) -> tuple[str, str, dict]:
        cue_id = str(row.get("cue_id") or "")
        asr = (row.get("asr_text") or "").strip()
        stage1 = row.get("stage1") if isinstance(row.get("stage1"), dict) else {}
        existing_b = str(stage1.get("extract_text") or "").strip()
        existing_a = str(stage1.get("fluency_text") or "").strip()
        if skip_existing and existing_a:
            return cue_id, existing_a, {
                "cue_id": cue_id,
                "lecture_id": str(row.get("lecture_id")),
                "start_sec": row.get("start_sec"),
                "end_sec": row.get("end_sec"),
                "asr_len": len(asr),
                "fluency_len": len(existing_a),
                "fluency_preview": existing_a[:200],
                "fluency_text": existing_a,
                "b_reuse_len": len(existing_b),
                "b_reuse_preview": existing_b[:200],
                "has_existing_b": bool(existing_b),
                "skipped": True,
            }
        fluent = pp.process_pass_a(asr, args.course_id) if asr else ""
        if args.mock and asr and not fluent:
            fluent = asr
        return cue_id, fluent or "", {
            "cue_id": cue_id,
            "lecture_id": str(row.get("lecture_id")),
            "start_sec": row.get("start_sec"),
            "end_sec": row.get("end_sec"),
            "asr_len": len(asr),
            "fluency_len": len(fluent or ""),
            "fluency_preview": (fluent or "")[:200],
            "fluency_text": fluent or "",
            "b_reuse_len": len(existing_b),
            "b_reuse_preview": existing_b[:200],
            "has_existing_b": bool(existing_b),
            "skipped": False,
        }

    workers = max(1, int(args.workers or 1))
    for lid in lecture_ids:
        lec_rows = by_lecture.get(lid) or []
        lec_rows = sorted(lec_rows, key=lambda r: float(r.get("start_sec") or 0))
        if args.limit and args.limit > 0:
            lec_rows = lec_rows[: args.limit]
        print(f"===== lecture {lid}: {len(lec_rows)} cues (A, workers={workers}) =====", flush=True)
        items: list[dict] = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(_run_one, row): row for row in lec_rows}
            done = 0
            for fut in as_completed(futs):
                cue_id, fluent, meta = fut.result()
                fluency_by_id[cue_id] = fluent
                items.append(meta)
                done += 1
                if meta.get("skipped"):
                    skipped += 1
                    tag = "skip"
                else:
                    ran += 1
                    tag = "A"
                if done % 5 == 0 or done == len(lec_rows):
                    print(
                        f"  [{done}/{len(lec_rows)}] last={cue_id} {tag} "
                        f"a_len={meta['fluency_len']}",
                        flush=True,
                    )
        items.sort(key=lambda x: float(x.get("start_sec") or 0))
        report["lectures"][lid] = {
            "n_cues": len(items),
            "with_existing_b": sum(1 for x in items if x["has_existing_b"]),
            "nonempty_a": sum(1 for x in items if x["fluency_len"]),
            "skipped": sum(1 for x in items if x.get("skipped")),
            "ran": sum(1 for x in items if not x.get("skipped")),
            "items": items,
        }
        save_json(out_path, report)
        if args.write_back:
            # 增量落盘，避免长跑中断丢进度
            for row in all_rows:
                cue_id = str(row.get("cue_id") or "")
                if cue_id not in fluency_by_id:
                    continue
                stage1 = row.get("stage1")
                if not isinstance(stage1, dict):
                    stage1 = {}
                    row["stage1"] = stage1
                stage1["fluency_text"] = fluency_by_id[cue_id]
                stage1["preprocess_ab_mode"] = "a_run_b_reused_extract_text"
            cues_path.write_text(
                json.dumps(all_rows, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            print(f"  checkpoint write-back → {cues_path}", flush=True)

    if args.write_back:
        n_write = sum(1 for cid in fluency_by_id)
        report["write_back"] = {"path": str(cues_path), "n_updated": n_write}

    report["elapsed_sec"] = round(time.perf_counter() - t0, 1)
    report["out"] = str(out_path)
    report["totals"] = {"ran": ran, "skipped": skipped, "n": ran + skipped}
    save_json(out_path, report)
    print(
        json.dumps(
            {
                k: report[k]
                for k in (
                    "course_id",
                    "lecture_ids",
                    "elapsed_sec",
                    "out",
                    "mode",
                    "totals",
                )
                if k in report
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    for lid, block in report["lectures"].items():
        print(
            f"lec{lid}: cues={block['n_cues']} A={block['nonempty_a']} "
            f"ran={block['ran']} skip={block['skipped']} reuseB={block['with_existing_b']}"
        )


if __name__ == "__main__":
    main()
