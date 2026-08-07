"""代理评估教材子图检索：种子覆盖、文本锚定、多跳漂移（默认讲次 1、17）。"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def _ensure_pkg(name: str, path: Path) -> ModuleType:
    if name in sys.modules:
        return sys.modules[name]
    mod = ModuleType(name)
    mod.__path__ = [str(path)]  # type: ignore[attr-defined]
    sys.modules[name] = mod
    return mod


def _load(name: str, rel: str) -> ModuleType:
    path = ROOT / rel
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_ensure_pkg("teachkg", ROOT / "teachkg")
_ensure_pkg("teachkg.textbook_kg", ROOT / "teachkg" / "textbook_kg")
alias = _load("teachkg.textbook_kg.alias", "teachkg/textbook_kg/alias.py")
loader = _load("teachkg.textbook_kg.loader", "teachkg/textbook_kg/loader.py")
theorem_edges = _load(
    "teachkg.textbook_kg.theorem_edges", "teachkg/textbook_kg/theorem_edges.py"
)
subgraph = _load("teachkg.textbook_kg.subgraph", "teachkg/textbook_kg/subgraph.py")

clean_text = alias.clean_text
extract_entities_from_text = alias.extract_entities_from_text
TextbookKG = loader.TextbookKG
augment_textbook_kg = theorem_edges.augment_textbook_kg
TextbookSubgraphRetriever = subgraph.TextbookSubgraphRetriever

from teachkg.config import TeachKGConfig
from teachkg.utils.io import load_jsonl, save_json


def retrieve_lecture_subgraph(retriever, cue_texts: list[str]):
    """合并多 cue，检索讲次级教材子图（与 lecture_assign 同逻辑，避免循环导入）。"""
    texts = [t for t in cue_texts if t.strip()]
    combined = "\n\n".join(texts)
    if not combined.strip():
        return set(), []
    seeds: set[str] = set()
    for text in texts:
        seeds |= retriever._find_seed_entities(text)  # noqa: SLF001
    if retriever.embedding_link_enabled:
        emb_min = (
            retriever.lecture_embedding_link_min_score
            if retriever.lecture_embedding_link_min_score is not None
            else retriever.embedding_link_min_score
        )
        seeds |= retriever._embedding_link(  # noqa: SLF001
            combined, exclude=seeds, min_score=emb_min
        )
    if not seeds:
        return set(), []
    scored = retriever.expand_scored(seeds, combined)
    filtered = [
        rel for rel, score in scored if score >= retriever.lecture_min_relation_score
    ]
    limit = retriever.max_edges_per_lecture
    if retriever.lecture_dynamic_cap and texts:
        dynamic = int(len(texts) * retriever.lecture_edges_per_cue_cap)
        limit = min(limit, max(dynamic, len(texts)))
    return seeds, filtered[:limit]


def _resolve_extract_text(row: dict) -> str:
    s1 = row.get("stage1") or {}
    status = s1.get("text_preprocess_status")
    if status == "empty_after_preprocess" or s1.get("extract_text") == "":
        return ""
    et = s1.get("extract_text")
    if isinstance(et, str) and et.strip():
        return et.strip()
    return (row.get("asr_text") or "").strip()


def _entity_in_text(name: str, cue_clean: str) -> bool:
    if not cue_clean or not name:
        return False
    parts = [clean_text(p) for p in name.split("/")] + [clean_text(name)]
    return any(p and len(p) >= 2 and p in cue_clean for p in parts)


def _build_retriever(cfg: TeachKGConfig) -> TextbookSubgraphRetriever:
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    kg_path = ROOT / tb.get("path", "data/textbook")
    kg = TextbookKG.load(
        kg_path,
        entity_file=tb.get("entity_file", "entity_final.json"),
        relations_file=tb.get("relations_file", "relations_final.json"),
        importance_file=tb.get("importance_file", "entity_sorted.json"),
    )
    rcfg = tb.get("subgraph", {}) or {}
    if rcfg.get("include_theorem_edges", True):
        kg = augment_textbook_kg(kg)
    return TextbookSubgraphRetriever(
        kg,
        max_hops=int(rcfg.get("max_hops", 2)),
        max_edges_per_cue=rcfg.get("max_edges_per_cue"),
        max_edges_per_lecture=rcfg.get("max_edges_per_lecture", 60),
        max_seed_entities=int(rcfg.get("max_seed_entities", 20)),
        lecture_min_relation_score=float(rcfg.get("lecture_min_relation_score", 4.0)),
        cue_min_relation_score=float(rcfg.get("cue_min_relation_score", 4.0)),
        require_text_anchor=bool(rcfg.get("require_text_anchor", True)),
        lecture_dynamic_cap=bool(rcfg.get("lecture_dynamic_cap", True)),
        lecture_edges_per_cue_cap=float(rcfg.get("lecture_edges_per_cue_cap", 7.0)),
        lecture_embedding_link_min_score=rcfg.get("lecture_embedding_link_min_score"),
        embedding_link_enabled=bool(rcfg.get("embedding_link_enabled", False)),
        embedding_link_top_k=rcfg.get("embedding_link_top_k"),
        embedding_link_min_score=float(rcfg.get("embedding_link_min_score", 0.82)),
        embedder_model=str(
            rcfg.get("embedder_model", "shibing624/text2vec-base-multilingual")
        ),
        embedding_cache_enabled=bool(rcfg.get("embedding_cache_enabled", True)),
        textbook_base_path=kg_path,
    )


def _edge_anchor_stats(relations, cue_clean: str) -> dict:
    both = one = none = 0
    for rel in relations:
        s = _entity_in_text(rel.subject, cue_clean)
        o = _entity_in_text(rel.object, cue_clean)
        if s and o:
            both += 1
        elif s or o:
            one += 1
        else:
            none += 1
    n = max(1, len(relations))
    return {
        "edges": len(relations),
        "both_in_text": both,
        "one_in_text": one,
        "none_in_text": none,
        "none_ratio": round(none / n, 3),
        "anchored_ratio": round((both + one) / n, 3),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "configs/teaching.yaml"))
    parser.add_argument("--course-id", default="shuliluoji")
    parser.add_argument("--lecture-id", action="append", dest="lecture_ids", default=None)
    args = parser.parse_args()
    lecture_ids = [str(x) for x in (args.lecture_ids or ["1", "17"])]

    cfg = TeachKGConfig.from_yaml(args.config)
    cues_path = ROOT / cfg.processed_dir / args.course_id / "filtered_cues.jsonl"
    rows = [
        r
        for r in load_jsonl(cues_path)
        if str(r.get("lecture_id")) in set(lecture_ids)
    ]
    retriever = _build_retriever(cfg)

    by_lec: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_lec[str(r.get("lecture_id"))].append(r)

    report: dict = {
        "course_id": args.course_id,
        "lecture_ids": lecture_ids,
        "retriever": {
            "max_hops": retriever.max_hops,
            "cue_min_relation_score": retriever.cue_min_relation_score,
            "lecture_min_relation_score": retriever.lecture_min_relation_score,
            "require_text_anchor": retriever.require_text_anchor,
            "embedding_link_enabled": retriever.embedding_link_enabled,
            "max_edges_per_cue": retriever.max_edges_per_cue,
        },
        "lectures": {},
        "samples": [],
    }

    for lec in lecture_ids:
        items = by_lec.get(lec, [])
        texts = []
        cue_eval = []
        for row in items:
            text = _resolve_extract_text(row)
            texts.append(text)
            cue_clean = clean_text(text)
            alias_seeds = extract_entities_from_text(
                text, retriever.kg.alias_map, allow_weak=False
            )
            if not text:
                cue_eval.append(
                    {
                        "cue_id": row.get("cue_id"),
                        "extract_empty": True,
                        "alias_seeds": 0,
                        "retriever_seeds": 0,
                        "entities": 0,
                        "relations": 0,
                        "seed_in_final_entity_ratio": None,
                        "anchor": {"edges": 0, "none_ratio": None, "anchored_ratio": None},
                    }
                )
                continue
            sg = retriever.retrieve(text)
            seed_hit = sum(1 for s in sg.seed_entities if s in sg.entities)
            seed_cov = (seed_hit / len(sg.seed_entities)) if sg.seed_entities else None
            anchor = _edge_anchor_stats(sg.relations, cue_clean)
            # over-extract: final entities not literally in text
            ents_out = [e for e in sg.entities if not _entity_in_text(e, cue_clean)]
            stored = (row.get("stage1") or {}).get("textbook_subgraph") or {}
            tv = (row.get("stage1") or {}).get("triplet_validation") or {}
            cue_eval.append(
                {
                    "cue_id": row.get("cue_id"),
                    "extract_empty": False,
                    "extract_len": len(text),
                    "alias_seeds": len(alias_seeds),
                    "retriever_seeds": len(sg.seed_entities),
                    "entities": len(sg.entities),
                    "relations": len(sg.relations),
                    "seed_in_final_entity_ratio": (
                        round(seed_cov, 3) if seed_cov is not None else None
                    ),
                    "entity_not_in_text": len(ents_out),
                    "entity_not_in_text_ratio": round(
                        len(ents_out) / max(1, len(sg.entities)), 3
                    ),
                    "anchor": anchor,
                    "stored_subgraph": stored,
                    "assigned_textbook_edges": tv.get("assigned_textbook_edges"),
                    "triplet_count": (row.get("stage1") or {}).get("triplet_count"),
                    "seeds_preview": sorted(sg.seed_entities)[:8],
                    "edges_preview": [
                        {
                            "s": rel.subject.split("/")[0],
                            "r": rel.predicate,
                            "o": rel.object.split("/")[0],
                        }
                        for rel in sg.relations[:5]
                    ],
                }
            )

        # lecture-level pool
        active_texts = [t for t in texts if t]
        if active_texts:
            lec_seeds, lec_rels = retrieve_lecture_subgraph(retriever, active_texts)
            lec_clean = clean_text("\n".join(active_texts))
            lec_anchor = _edge_anchor_stats(lec_rels, lec_clean)
        else:
            lec_seeds, lec_rels = set(), []
            lec_anchor = {"edges": 0, "none_ratio": None, "anchored_ratio": None}

        active = [c for c in cue_eval if not c["extract_empty"]]
        empty_n = sum(1 for c in cue_eval if c["extract_empty"])

        def _avg(key: str) -> float | None:
            vals = [c[key] for c in active if c.get(key) is not None]
            return round(sum(vals) / len(vals), 3) if vals else None

        def _avg_anchor(field: str) -> float | None:
            vals = [
                c["anchor"][field]
                for c in active
                if c["anchor"].get(field) is not None and c["anchor"].get("edges", 0) > 0
            ]
            return round(sum(vals) / len(vals), 3) if vals else None

        summary = {
            "cues": len(cue_eval),
            "empty_extract": empty_n,
            "active_cues": len(active),
            "avg_alias_seeds": _avg("alias_seeds"),
            "avg_retriever_seeds": _avg("retriever_seeds"),
            "avg_entities": _avg("entities"),
            "avg_relations": _avg("relations"),
            "avg_seed_in_final_entity_ratio": _avg("seed_in_final_entity_ratio"),
            "avg_entity_not_in_text_ratio": _avg("entity_not_in_text_ratio"),
            "avg_edge_anchored_ratio": _avg_anchor("anchored_ratio"),
            "avg_edge_none_in_text_ratio": _avg_anchor("none_ratio"),
            "lecture_pool_seeds": len(lec_seeds),
            "lecture_pool_edges": len(lec_rels),
            "lecture_pool_anchor": lec_anchor,
            "zero_seed_active": sum(1 for c in active if c["retriever_seeds"] == 0),
            "zero_edge_active": sum(1 for c in active if c["relations"] == 0),
        }
        report["lectures"][lec] = {"summary": summary, "cues": cue_eval}
        # keep a few qualitative samples
        for c in active[:3]:
            report["samples"].append({"lecture_id": lec, **c})

        print(f"\n=== lecture {lec} ===")
        print(json.dumps(summary, ensure_ascii=False, indent=2))

    out = (
        ROOT
        / "data"
        / "experiments"
        / "comparisons"
        / args.course_id
        / f"subgraph_quality_lec{'_'.join(lecture_ids)}.json"
    )
    save_json(out, report)
    print("\nwrote", out)


if __name__ == "__main__":
    main()
