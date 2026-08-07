"""仅对指定讲次重跑种子召回 + LLM 筛选，不跑边筛/抽取。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.textbook_kg.subgraph import count_text_words, embedding_top_k_for_text
from teachkg.utils.io import load_jsonl, pretty_json_path, save_json, save_jsonl


def _resolve_extract(cue: dict) -> str:
    s1 = cue.get("stage1") or {}
    return (
        (s1.get("extract_text") or "").strip()
        or (cue.get("extract_text") or "").strip()
        or (cue.get("asr_text") or "").strip()
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--course-id", default="shuliluoji")
    parser.add_argument("--lecture-id", required=True)
    parser.add_argument("--dry-run", action="store_true", help="不写回 filtered_cues")
    args = parser.parse_args()

    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "export_pipeline_showcase",
        ROOT / "scripts/teaching/export_pipeline_showcase.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    build_seed_retriever = mod.build_seed_retriever

    course = args.course_id
    lec = str(args.lecture_id)
    cues_path = ROOT / "data/processed" / course / "filtered_cues.jsonl"
    all_cues = load_jsonl(cues_path)
    cues = [c for c in all_cues if str(c.get("lecture_id")) == lec]
    cues.sort(key=lambda r: float(r.get("start_sec") or 0))
    if not cues:
        raise SystemExit(f"no cues for lecture {lec}")

    print(f"building retriever for {course} …")
    retriever = build_seed_retriever(course)
    words_per = retriever.embedding_link_words_per_seed
    max_k = retriever.embedding_link_top_k

    rows = []
    updated = 0
    for cue in cues:
        extract = _resolve_extract(cue)
        cid = cue.get("cue_id")
        words = count_text_words(extract)
        dyn_k = embedding_top_k_for_text(
            extract, words_per_seed=words_per, min_k=0, max_k=max_k
        )
        alias_raw, emb_raw = retriever.find_seed_entities_by_source(extract)
        kept, alias_src, emb_src = retriever.resolve_seed_sets(extract)
        # resolve 返回的 2/3 仍是原始来源；展示保留前后对比
        kept_alias = sorted(kept & alias_raw)
        kept_emb = sorted((kept & emb_raw) - set(kept_alias))
        note = ""
        filt = retriever.seed_llm_filter
        if filt is not None:
            note = getattr(filt, "last_note", "") or ""

        s1 = cue.get("stage1") or {}
        sg = dict(s1.get("textbook_subgraph") or {})
        sg["seed_entities"] = sorted(kept)
        sg["alias_seeds"] = kept_alias
        sg["embedding_seeds"] = kept_emb
        sg["seed_candidates_alias"] = sorted(alias_raw)
        sg["seed_candidates_embedding"] = sorted(emb_raw - alias_raw)
        sg["seed_filter_note"] = note
        sg["embedding_top_k_dynamic"] = dyn_k
        sg["extract_word_count"] = words
        s1["textbook_subgraph"] = sg
        cue["stage1"] = s1
        updated += 1

        rows.append(
            {
                "cue_id": cid,
                "words": words,
                "dyn_k": dyn_k,
                "alias_raw": len(alias_raw),
                "emb_raw": len(emb_raw - alias_raw),
                "kept_alias": len(kept_alias),
                "kept_emb": len(kept_emb),
                "kept_total": len(kept),
                "note": note,
            }
        )
        print(
            f"{cid}: words={words} dyn_k={dyn_k} "
            f"alias {len(alias_raw)}→{len(kept_alias)} "
            f"emb {len(emb_raw - alias_raw)}→{len(kept_emb)} "
            f"total={len(kept)}"
            + (f" | {note}" if note else "")
        )

    if not args.dry_run:
        by_id = {str(c.get("cue_id")): c for c in cues}
        merged = [
            by_id[str(row.get("cue_id"))]
            if str(row.get("cue_id")) in by_id
            else row
            for row in all_cues
        ]
        save_jsonl(cues_path, merged)
        save_json(pretty_json_path(cues_path), merged)
        print(f"updated {updated} cues → {cues_path}")

    summary = {
        "course_id": course,
        "lecture_id": lec,
        "words_per_seed": words_per,
        "embedding_link_top_k_cap": max_k,
        "cues": rows,
        "totals": {
            "alias_raw": sum(r["alias_raw"] for r in rows),
            "emb_raw": sum(r["emb_raw"] for r in rows),
            "kept_alias": sum(r["kept_alias"] for r in rows),
            "kept_emb": sum(r["kept_emb"] for r in rows),
            "kept_total": sum(r["kept_total"] for r in rows),
        },
    }
    out = ROOT / "data/processed" / course / f"seed_filter_lecture_{lec}.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("summary →", out)
    print("totals", summary["totals"])


if __name__ == "__main__":
    main()
