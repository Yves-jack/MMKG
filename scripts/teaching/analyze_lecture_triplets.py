#!/usr/bin/env python
"""分析指定讲次混合抽取结果中的问题。"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.stage1_alignment.triplet_extract import Triplet, is_overly_specific_triplet


def load_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def primary(name: str) -> str:
    return name.split("/", 1)[0].strip()


def norm_key(row: dict) -> tuple[str, str, str]:
    return (primary(row["subject"]), row.get("abstract_relation", ""), primary(row["object"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-id", default="数理逻辑")
    parser.add_argument("--lecture-id", required=True)
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    kg_dir = ROOT / "data/kg" / args.course_id
    cues_path = ROOT / "data/segments" / args.course_id / "cues.jsonl"
    hyb = [r for r in load_jsonl(kg_dir / "triplets.jsonl") if str(r.get("lecture_id")) == args.lecture_id]
    llm = [r for r in load_jsonl(kg_dir / "llm_only/triplets.jsonl") if str(r.get("lecture_id")) == args.lecture_id]
    cues = [r for r in load_jsonl(cues_path) if str(r.get("lecture_id")) == args.lecture_id]

    tb_path = ROOT / "data/textbook/CS2501-离散数学（数理逻辑与集合论）/entity_final.json"
    tb_names = {e["name"] for e in json.loads(tb_path.read_text(encoding="utf-8"))}

    by_cue = Counter(r["cue_id"] for r in hyb)
    zero_cues = [c for c in cues if by_cue.get(c["cue_id"], 0) == 0]

    placeholder_delta = []
    for r in hyb:
        if r.get("extract_source") != "lecture_delta":
            continue
        blob = r.get("subject", "") + r.get("object", "")
        if any(x in blob for x in ("...", "a,b,c", "p,q,r", "x,y,z")):
            placeholder_delta.append(r)

    entity_variants: dict[str, set[str]] = {}
    for r in hyb:
        zh = primary(r["subject"])
        if len(zh) >= 2:
            entity_variants.setdefault(zh, set()).add(r["subject"])

    inconsistent = {k: sorted(v) for k, v in entity_variants.items() if len(v) > 1}

    llm_keys = {norm_key(r) for r in llm}
    hyb_keys = {norm_key(r) for r in hyb}
    overlap = llm_keys & hyb_keys

    delta_only_cues = []
    for c in cues:
        rows = [r for r in hyb if r["cue_id"] == c["cue_id"]]
        if not rows:
            continue
        tb = sum(1 for r in rows if r.get("extract_source") == "textbook")
        dl = sum(1 for r in rows if r.get("extract_source") == "lecture_delta")
        if tb == 0 and dl > 0:
            delta_only_cues.append(
                {
                    "cue_id": c["cue_id"],
                    "delta": dl,
                    "llm_only_count": sum(1 for r in llm if r["cue_id"] == c["cue_id"]),
                    "text_preview": c.get("asr_text", "")[:120],
                }
            )

    report = {
        "lecture_id": args.lecture_id,
        "summary": {
            "hybrid_count": len(hyb),
            "llm_count": len(llm),
            "textbook_count": sum(1 for r in hyb if r.get("extract_source") == "textbook"),
            "delta_count": sum(1 for r in hyb if r.get("extract_source") == "lecture_delta"),
            "relation_overlap": len(overlap),
            "zero_cue_count": len(zero_cues),
            "placeholder_delta_count": len(placeholder_delta),
            "inconsistent_entity_groups": len(inconsistent),
        },
        "zero_cues": [
            {"cue_id": c["cue_id"], "text_preview": c.get("asr_text", "")[:200], "llm_count": sum(1 for r in llm if r["cue_id"] == c["cue_id"])}
            for c in zero_cues
        ],
        "placeholder_delta": [
            {
                "natural_statement": r.get("natural_statement", ""),
                "subject": r.get("subject", ""),
                "object": r.get("object", ""),
                "cue_id": r.get("cue_id", ""),
            }
            for r in placeholder_delta
        ],
        "entity_naming_inconsistent": inconsistent,
        "delta_only_cues": delta_only_cues,
        "llm_only_unique_samples": [
            r.get("natural_statement") or r.get("description", "")
            for r in llm
            if norm_key(r) not in hyb_keys
        ][:8],
        "hybrid_unique_delta_samples": [
            r.get("natural_statement") or r.get("description", "")
            for r in hyb
            if r.get("extract_source") == "lecture_delta"
        ][:8],
    }

    out = Path(args.output) if args.output else ROOT / f"data/processed/{args.course_id}/lecture_{args.lecture_id}_issues.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print(f"详细报告: {out}")


if __name__ == "__main__":
    main()
