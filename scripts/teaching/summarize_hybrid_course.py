#!/usr/bin/env python
"""汇总全课 hybrid vs llm 对比报告。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> None:
    course_id = "shuliluoji"
    proc = ROOT / "data/processed" / course_id
    kg = ROOT / "data/kg" / course_id

    rows = [
        json.loads(l)
        for l in (kg / "triplets.jsonl").read_text(encoding="utf-8").splitlines()
        if l.strip()
    ]
    llm_rows = [
        json.loads(l)
        for l in (kg / "llm_only/triplets.jsonl").read_text(encoding="utf-8").splitlines()
        if l.strip()
    ]

    from collections import Counter

    src = Counter(r.get("extract_source", "?") for r in rows)
    tb = [r for r in rows if r.get("extract_source") == "textbook"]

    reports = sorted(
        proc.glob("hybrid_vs_llm_lecture_*.json"),
        key=lambda p: int(p.stem.split("_")[-1]),
    )
    summary = []
    for p in reports:
        r = json.loads(p.read_text(encoding="utf-8"))
        q = r["hybrid"].get("quality", {})
        sem = r.get("semantic_overlap", {})
        ent = max(1, r["hybrid"]["entity_count"])
        summary.append(
            {
                "lec": r["lecture_id"],
                "llm": r["llm_only"]["triplet_count"],
                "hyb": r["hybrid"]["triplet_count"],
                "tb": r["hybrid"]["textbook_count"],
                "delta": r["hybrid"]["lecture_delta_count"],
                "fb": q.get("llm_fallback_count", 0),
                "overlap": r["relation_key_overlap"]["intersection"],
                "loose": sem.get("loose_key_intersection", 0),
                "near": sem.get("llm_near_match_to_hybrid", 0),
                "tb_ent_pct": round(100 * r["hybrid"]["textbook_exact_entity_overlap"] / ent, 1),
                "related": q.get("related_with_ratio", 0),
                "no_clip": q.get("textbook_without_clip_count", 0),
                "over_spec": q.get("overly_specific_count", 0),
            }
        )

    out = {
        "course": {
            "active_triplets": len(rows),
            "llm_baseline": len(llm_rows),
            "delta_vs_llm": len(rows) - len(llm_rows),
            "extract_source": dict(src),
            "textbook_clip_rate": f"{sum(1 for r in tb if r.get('clip_path'))}/{len(tb)}",
        },
        "aggregates": {
            "lectures": len(summary),
            "hyb_gt_llm": sum(1 for s in summary if s["hyb"] > s["llm"]),
            "hyb_lt_llm": sum(1 for s in summary if s["hyb"] < s["llm"]),
            "avg_key_overlap": round(sum(s["overlap"] for s in summary) / len(summary), 1),
            "avg_loose_overlap": round(sum(s["loose"] for s in summary) / len(summary), 1),
            "total_fallback": sum(s["fb"] for s in summary),
            "total_no_clip": sum(s["no_clip"] for s in summary),
            "total_over_specific": sum(s["over_spec"] for s in summary),
            "avg_related_with": round(sum(s["related"] for s in summary) / len(summary), 3),
        },
        "per_lecture": sorted(summary, key=lambda x: int(x["lec"])),
    }

    kgj = json.loads((kg / "kg.json").read_text(encoding="utf-8"))
    out["course_kg"] = {
        "entities": len(kgj.get("entities", [])),
        "edges": len(kgj.get("edges", [])),
    }

    out_path = proc / "hybrid_course_summary.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
