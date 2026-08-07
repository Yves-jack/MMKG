#!/usr/bin/env python
"""用第1讲已有 seeds，对比旧母图 vs 试点新图的子图扩展效果（不写回生产数据）。"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.textbook_kg.loader import TextbookKG
from teachkg.textbook_kg.subgraph import TextbookSubgraphRetriever
from teachkg.utils.io import load_jsonl

OLD = ROOT / "data/textbook/CS2501-离散数学（数理逻辑与集合论）"
NEW = ROOT / "data/textbook/_pilot_reextract/CS2501-logic-ch1-6"
OUT = NEW / "lecture1_expand_compare.json"
CUES = ROOT / "data/processed/shuliluoji/filtered_cues.jsonl"


def zh(name: str) -> str:
    return (name or "").split("/")[0].strip()


def make_retriever(kg: TextbookKG, base: Path) -> TextbookSubgraphRetriever:
    return TextbookSubgraphRetriever(
        kg,
        max_hops=2,
        max_edges_per_cue=None,
        max_edges_per_lecture=None,
        require_both_ends_in_candidate_seeds=True,
        score_prune_edges=False,
        lecture_dynamic_cap=False,
        embedding_link_enabled=False,
        textbook_base_path=base,
    )


def resolve_rate(kg: TextbookKG, seeds: set[str]) -> dict:
    names = set(kg.entities)
    alias = kg.alias_map or {}
    # alias_map: alias -> [canonical...]
    hit_exact = set()
    hit_alias = set()
    miss = set()
    for s in seeds:
        if s in names:
            hit_exact.add(s)
            continue
        z = zh(s)
        found = False
        for n in names:
            if zh(n) == z or z in zh(n) or zh(n) in z:
                hit_alias.add(s)
                found = True
                break
        if found:
            continue
        # alias map keys
        for key, cans in alias.items():
            if z == zh(key) or z in zh(key) or s == key:
                if any(c in names for c in cans):
                    hit_alias.add(s)
                    found = True
                    break
        if not found:
            miss.add(s)
    return {
        "seeds": len(seeds),
        "exact": len(hit_exact),
        "fuzzy": len(hit_alias),
        "miss": len(miss),
        "hit_rate": round((len(hit_exact) + len(hit_alias)) / max(len(seeds), 1), 3),
        "miss_examples": sorted(zh(x) for x in miss)[:15],
    }


def run_side(retriever: TextbookSubgraphRetriever, cues: list[dict], label: str) -> dict:
    per = []
    all_ents: set[str] = set()
    all_edges: set[tuple[str, str, str]] = set()
    seed_hits = 0
    seed_total = 0
    for row in cues:
        s1 = row.get("stage1") or {}
        sg = dict(s1.get("textbook_subgraph") or {})
        seeds = set(sg.get("seed_entities") or [])
        alias = set(sg.get("alias_seeds") or [])
        emb = set(sg.get("embedding_seeds") or [])
        cand_a = set(sg.get("seed_candidates_alias") or [])
        cand_e = set(sg.get("seed_candidates_embedding") or [])
        if not seeds:
            seeds = alias | emb
        pool = cand_a | cand_e | seeds
        if not cand_a and not cand_e:
            pool = seeds
        text = (
            (s1.get("extract_text") or "").strip()
            or (row.get("extract_text") or "").strip()
            or (row.get("asr_text") or "").strip()
        )
        seed_total += len(seeds)
        if not seeds:
            per.append({"cue_id": row.get("cue_id"), "seeds": 0, "edges": 0, "ents": 0})
            continue
        result = retriever.retrieve_from_seeds(
            seeds,
            text,
            candidate_seed_pool=pool,
            alias_seeds=alias or seeds,
            embedding_seeds=emb,
        )
        # count how many seeds appear in kg entities after retrieval seed set
        resolved = set(result.seed_entities or seeds)
        seed_hits += sum(1 for s in seeds if s in retriever.kg.entities or zh(s) in {zh(n) for n in retriever.kg.entities})
        edges = list(result.relations or [])
        ents = set()
        for r in edges:
            ents.add(r.subject)
            ents.add(r.object)
            all_edges.add((r.subject, r.predicate, r.object))
        all_ents |= ents
        per.append(
            {
                "cue_id": row.get("cue_id"),
                "seeds": len(seeds),
                "edges": len(edges),
                "ents": len(ents),
                "sample": [
                    f"{zh(r.subject)}-{r.predicate}-{zh(r.object)}" for r in edges[:5]
                ],
            }
        )
    return {
        "label": label,
        "cues": len(cues),
        "total_edges_unique": len(all_edges),
        "total_ents_unique": len(all_ents),
        "sum_edges": sum(p["edges"] for p in per),
        "cues_with_edges": sum(1 for p in per if p["edges"] > 0),
        "cues_with_zero": sum(1 for p in per if p["seeds"] > 0 and p["edges"] == 0),
        "per_cue": per,
        "top_ents": Counter(zh(e) for e in all_ents).most_common(15),
    }


def main() -> None:
    cues = [r for r in load_jsonl(CUES) if str(r.get("lecture_id")) == "1"]
    cues.sort(key=lambda r: float(r.get("start_sec") or 0))
    all_seeds: set[str] = set()
    for row in cues:
        sg = (row.get("stage1") or {}).get("textbook_subgraph") or {}
        all_seeds |= set(sg.get("seed_entities") or [])

    print(f"lecture1 cues={len(cues)} unique_seeds={len(all_seeds)}")
    print("loading old KG…")
    old_kg = TextbookKG.load(OLD, importance_file="entity_sorted_ppr.json")
    print("loading new KG…")
    new_kg = TextbookKG.load(NEW)

    old_res = resolve_rate(old_kg, all_seeds)
    new_res = resolve_rate(new_kg, all_seeds)
    print("seed resolve old:", old_res)
    print("seed resolve new:", new_res)

    old_side = run_side(make_retriever(old_kg, OLD), cues, "old_mother")
    new_side = run_side(make_retriever(new_kg, NEW), cues, "pilot_logic_ch1_6")

    report = {
        "note": "不写回 filtered_cues / 不覆盖母图；仅对比 retrieve_from_seeds",
        "seed_resolve": {"old": old_res, "new": new_res},
        "expand": {"old": old_side, "new": new_side},
        "verdict": None,
    }
    # 判定：覆盖导向——种子可解析 + 有边的 cue 比例
    if new_res["hit_rate"] >= 0.7 and new_side["cues_with_edges"] >= old_side["cues_with_edges"] * 0.6:
        report["verdict"] = "试点图可用于教学扩展（种子对齐良好）；可继续扩集合论或替换母图试跑全链路"
    elif new_res["hit_rate"] >= 0.5:
        report["verdict"] = "部分可用：需补种子别名对齐或重跑 seed filter 后再替换母图"
    else:
        report["verdict"] = "种子与新图实体名错位严重，替换母图前必须先重跑种子匹配"

    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n=== expand compare ===")
    for side in (old_side, new_side):
        print(
            f"{side['label']}: edges_sum={side['sum_edges']} unique_e={side['total_edges_unique']} "
            f"unique_n={side['total_ents_unique']} cues_with_edges={side['cues_with_edges']}/{side['cues']} "
            f"zero={side['cues_with_zero']}"
        )
    print("verdict:", report["verdict"])
    print("wrote", OUT)


if __name__ == "__main__":
    main()
