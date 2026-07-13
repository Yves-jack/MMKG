#!/usr/bin/env python
"""对比 llm_only 基线与教材混合抽取（指定讲次）。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _oral_entity(name: str) -> bool:
    zh = name.split("/", 1)[0].strip()
    return bool(re.match(r"^(?:第[一二三四五六七八九十\d]+个)?(?:公理|定理|命题|推论|引理)\s*\d+", zh))


def _quality_metrics(rows: list[dict], delta_rows: list[dict]) -> dict:
    from teachkg.stage1_alignment.triplet_extract import Triplet, is_overly_specific_triplet

    overly = 0
    for r in rows:
        t = Triplet(
            subject=r.get("subject", ""),
            object=r.get("object", ""),
            abstract_relation=r.get("abstract_relation", ""),
            concrete_relation=r.get("concrete_relation", ""),
            statement_direction=r.get("statement_direction", "subject_to_object"),
        )
        if is_overly_specific_triplet(t):
            overly += 1
    oral_delta = sum(
        1
        for r in delta_rows
        if _oral_entity(r.get("subject", "")) or _oral_entity(r.get("object", ""))
    )
    rel_total = len(rows) or 1
    related = sum(1 for r in rows if r.get("abstract_relation") == "related_with")
    tb_no_clip = sum(
        1
        for r in rows
        if r.get("extract_source") == "textbook" and not r.get("clip_path")
    )
    llm_fallback = sum(1 for r in rows if r.get("extract_source") == "llm_fallback")
    return {
        "overly_specific_count": overly,
        "delta_oral_entity_count": oral_delta,
        "related_with_ratio": round(related / rel_total, 4),
        "textbook_without_clip_count": tb_no_clip,
        "llm_fallback_count": llm_fallback,
        "extract_mode_counts": dict(Counter(r.get("extract_mode", "?") for r in rows)),
        "extract_source_counts": dict(Counter(r.get("extract_source", "?") for r in rows)),
    }


def primary(name: str) -> str:
    return name.split("/")[0].strip()


def norm_key(row: dict) -> tuple[str, str, str]:
    rel = row.get("abstract_relation") or row.get("relation", "").split("|")[0]
    return (primary(row["subject"]), rel, primary(row["object"]))


def loose_key(row: dict) -> tuple[str, tuple[str, str]]:
    rel = row.get("abstract_relation") or row.get("relation", "").split("|")[0]
    return (rel, tuple(sorted([primary(row["subject"]), primary(row["object"])])))


def compute_semantic_overlap(llm_rows: list[dict], hyb_rows: list[dict]) -> dict:
    from teachkg.stage1_alignment.triplet_extract import statement_jaccard

    llm_loose = {loose_key(r): r for r in llm_rows}
    hyb_loose = {loose_key(r): r for r in hyb_rows}
    loose_intersection = set(llm_loose) & set(hyb_loose)

    stmt_matched = 0
    stmt_pairs = 0
    for lk in loose_intersection:
        a = llm_loose[lk].get("natural_statement") or llm_loose[lk].get("description") or ""
        b = hyb_loose[lk].get("natural_statement") or hyb_loose[lk].get("description") or ""
        stmt_pairs += 1
        if statement_jaccard(str(a), str(b)) >= 0.55:
            stmt_matched += 1

    llm_only_loose = set(llm_loose) - set(hyb_loose)
    hybrid_only_loose = set(hyb_loose) - set(llm_loose)
    near_match = 0
    for lk in llm_only_loose:
        rel, pair = lk
        for hlk in hybrid_only_loose:
            if hlk[0] != rel:
                continue
            if pair == hlk[1]:
                near_match += 1
                break
            a = llm_loose[lk].get("natural_statement") or ""
            b = hyb_loose[hlk].get("natural_statement") or ""
            if statement_jaccard(str(a), str(b)) >= 0.72:
                near_match += 1
                break

    return {
        "loose_key_intersection": len(loose_intersection),
        "loose_llm_only": len(llm_only_loose),
        "loose_hybrid_only": len(hybrid_only_loose),
        "statement_agree_on_loose": stmt_matched,
        "statement_pairs_on_loose": stmt_pairs,
        "llm_near_match_to_hybrid": near_match,
    }


def load_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-id", default="shuliluoji")
    parser.add_argument("--lecture-id", default="10")
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    kg_dir = ROOT / "data/kg" / args.course_id
    llm_rows = [r for r in load_jsonl(kg_dir / "llm_only/triplets.jsonl") if str(r.get("lecture_id")) == args.lecture_id]
    hyb_rows = [r for r in load_jsonl(kg_dir / "triplets.jsonl") if str(r.get("lecture_id")) == args.lecture_id]

    tb_path = ROOT / "data/textbook/CS2501-离散数学（数理逻辑与集合论）/entity_final.json"
    tb_names = {e["name"] for e in json.loads(tb_path.read_text(encoding="utf-8"))}

    def entities(rows: list[dict]) -> set[str]:
        out: set[str] = set()
        for r in rows:
            out.add(r["subject"])
            out.add(r["object"])
        return out

    llm_ents = entities(llm_rows)
    hyb_ents = entities(hyb_rows)
    hyb_tb = [r for r in hyb_rows if r.get("extract_source") == "textbook"]
    hyb_delta = [r for r in hyb_rows if r.get("extract_source") == "lecture_delta"]

    llm_keys = {norm_key(r) for r in llm_rows}
    hyb_keys = {norm_key(r) for r in hyb_rows}
    overlap = llm_keys & hyb_keys
    only_llm = llm_keys - hyb_keys
    only_hyb = hyb_keys - llm_keys

    llm_only_examples = []
    for r in llm_rows:
        if norm_key(r) in only_llm and len(llm_only_examples) < 5:
            llm_only_examples.append(r.get("natural_statement") or r.get("description", ""))

    delta_examples = []
    for r in hyb_delta:
        if len(delta_examples) < 5:
            delta_examples.append(r.get("natural_statement") or r.get("description", ""))

    by_cue: dict[str, dict[str, int]] = {}
    for r in hyb_rows:
        cid = r["cue_id"]
        by_cue.setdefault(cid, {"textbook": 0, "lecture_delta": 0, "other": 0})
        src = r.get("extract_source", "other")
        if src in by_cue[cid]:
            by_cue[cid][src] += 1
        else:
            by_cue[cid]["other"] += 1

    llm_by_cue = Counter(r["cue_id"] for r in llm_rows)

    report = {
        "lecture_id": args.lecture_id,
        "llm_only": {
            "triplet_count": len(llm_rows),
            "cue_count": len(llm_by_cue),
            "entity_count": len(llm_ents),
            "textbook_exact_entity_overlap": sum(1 for e in llm_ents if e in tb_names),
            "relation_types": dict(Counter(r.get("abstract_relation", "?") for r in llm_rows)),
        },
        "hybrid": {
            "triplet_count": len(hyb_rows),
            "cue_count": len(by_cue),
            "textbook_count": len(hyb_tb),
            "lecture_delta_count": len(hyb_delta),
            "entity_count": len(hyb_ents),
            "textbook_exact_entity_overlap": sum(1 for e in hyb_ents if e in tb_names),
            "extract_source": dict(Counter(r.get("extract_source", "?") for r in hyb_rows)),
            "delta_relation_types": dict(Counter(r.get("abstract_relation", "?") for r in hyb_delta)),
            "quality": _quality_metrics(hyb_rows, hyb_delta),
        },
        "relation_key_overlap": {
            "intersection": len(overlap),
            "llm_only_unique": len(only_llm),
            "hybrid_unique": len(only_hyb),
        },
        "semantic_overlap": compute_semantic_overlap(llm_rows, hyb_rows),
        "per_cue": {
            cid: {
                "llm_only": llm_by_cue.get(cid, 0),
                **by_cue.get(cid, {}),
                "hybrid_total": sum(by_cue.get(cid, {}).values()),
            }
            for cid in sorted(set(llm_by_cue) | set(by_cue))
        },
        "examples": {
            "llm_only_unique": llm_only_examples,
            "lecture_delta": delta_examples,
        },
    }

    out_path = Path(args.output) if args.output else ROOT / f"data/processed/{args.course_id}/hybrid_vs_llm_lecture_{args.lecture_id}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"讲次 {args.lecture_id} 对比")
    print(f"  llm_only: {report['llm_only']['triplet_count']} 条, {report['llm_only']['entity_count']} 实体")
    print(f"  混合: {report['hybrid']['triplet_count']} 条 (教材 {report['hybrid']['textbook_count']} + 增量 {report['hybrid']['lecture_delta_count']})")
    print(f"  教材同名实体: llm {report['llm_only']['textbook_exact_entity_overlap']}/{report['llm_only']['entity_count']} → hybrid {report['hybrid']['textbook_exact_entity_overlap']}/{report['hybrid']['entity_count']}")
    print(f"  关系键交集/仅llm/仅混合: {len(overlap)}/{len(only_llm)}/{len(only_hyb)}")
    sem = report.get("semantic_overlap", {})
    if sem:
        print(
            f"  语义(无序实体+关系)交集: {sem.get('loose_key_intersection', 0)}"
            f" | LLM近邻匹配: {sem.get('llm_near_match_to_hybrid', 0)}"
        )
    q = report["hybrid"].get("quality", {})
    if q:
        print(f"  质量: 过具体={q.get('overly_specific_count', 0)}, related_with占比={q.get('related_with_ratio', 0)}")
    print(f"报告: {out_path}")


if __name__ == "__main__":
    main()
