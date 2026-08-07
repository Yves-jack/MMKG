"""导出 asr / extract_text / 别名&向量候选 / LLM筛选种子 / 子图边，供人工检查。"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

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
_load("teachkg.textbook_kg.alias", "teachkg/textbook_kg/alias.py")
loader = _load("teachkg.textbook_kg.loader", "teachkg/textbook_kg/loader.py")
theorem_edges = _load(
    "teachkg.textbook_kg.theorem_edges", "teachkg/textbook_kg/theorem_edges.py"
)
subgraph = _load("teachkg.textbook_kg.subgraph", "teachkg/textbook_kg/subgraph.py")
seed_filter_mod = _load(
    "teachkg.textbook_kg.seed_filter", "teachkg/textbook_kg/seed_filter.py"
)
edge_filter_mod = _load(
    "teachkg.textbook_kg.edge_filter", "teachkg/textbook_kg/edge_filter.py"
)

from teachkg.config import TeachKGConfig
from teachkg.utils.io import load_jsonl, save_json


def _resolve_extract(row: dict) -> str:
    s1 = row.get("stage1") or {}
    if s1.get("text_preprocess_status") == "empty_after_preprocess" or s1.get(
        "extract_text"
    ) == "":
        return ""
    et = s1.get("extract_text")
    if isinstance(et, str) and et.strip():
        return et.strip()
    return (row.get("asr_text") or "").strip()


def _zh(name: str) -> str:
    return name.split("/")[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "configs/teaching.yaml"))
    parser.add_argument("--course-id", default="shuliluoji")
    parser.add_argument("--lecture-id", action="append", dest="lecture_ids", default=None)
    args = parser.parse_args()
    lecture_ids = [str(x) for x in (args.lecture_ids or ["1", "17"])]

    cfg = TeachKGConfig.from_yaml(args.config)
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    rcfg = tb.get("subgraph", {}) or {}
    filter_cfg = rcfg.get("seed_llm_filter", {}) or {}
    edge_cfg = rcfg.get("edge_llm_filter", {}) or {}
    kg_path = ROOT / tb.get("path")
    kg = loader.TextbookKG.load(
        kg_path,
        entity_file=tb.get("entity_file", "entity_final.json"),
        relations_file=tb.get("relations_file", "relations_final.json"),
        importance_file=tb.get("importance_file", "entity_sorted.json"),
    )
    if rcfg.get("include_theorem_edges", True):
        kg = theorem_edges.augment_textbook_kg(kg)

    seed_llm_filter = None
    if filter_cfg.get("enabled", False):
        seed_llm_filter = seed_filter_mod.SeedLLMFilter(
            enabled=True,
            prompt=filter_cfg.get("prompt", "stage1/seed_filter.txt"),
            temperature=float(filter_cfg.get("temperature", 0.1) or 0.1),
            llm_model=filter_cfg.get("llm_model"),
            min_candidates=int(filter_cfg.get("min_candidates", 1) or 1),
            fallback_keep_all_on_empty=bool(
                filter_cfg.get("fallback_keep_all_on_empty", False)
            ),
            fallback_to_alias_on_empty=(
                filter_cfg["fallback_to_alias_on_empty"]
                if "fallback_to_alias_on_empty" in filter_cfg
                else None
            ),
            course_context=args.course_id,
        )
    edge_llm_filter = None
    if edge_cfg.get("enabled", False):
        edge_llm_filter = edge_filter_mod.EdgeLLMFilter(
            enabled=True,
            prompt=edge_cfg.get("prompt", "stage1/edge_filter.txt"),
            temperature=float(edge_cfg.get("temperature", 0.1) or 0.1),
            llm_model=edge_cfg.get("llm_model"),
            min_candidates=int(edge_cfg.get("min_candidates", 1) or 1),
            fallback_keep_all_on_empty=bool(
                edge_cfg.get("fallback_keep_all_on_empty", False)
            ),
            description_max_chars=int(edge_cfg.get("description_max_chars", 60) or 0),
            require_classroom_evidence=bool(
                edge_cfg.get("require_classroom_evidence", True)
            ),
            min_evidence_chars=int(edge_cfg.get("min_evidence_chars", 4) or 4),
            course_context=args.course_id,
        )

    retriever = subgraph.TextbookSubgraphRetriever(
        kg,
        max_hops=int(rcfg.get("max_hops", 1)),
        max_edges_per_cue=rcfg.get("max_edges_per_cue"),
        max_edges_per_lecture=rcfg.get("max_edges_per_lecture", 60),
        max_seed_entities=int(rcfg.get("max_seed_entities", 40)),
        lecture_min_relation_score=float(rcfg.get("lecture_min_relation_score", 4.0)),
        cue_min_relation_score=float(rcfg.get("cue_min_relation_score", 4.0)),
        require_text_anchor=bool(rcfg.get("require_text_anchor", False)),
        require_both_ends_in_candidate_seeds=bool(
            rcfg.get("require_both_ends_in_candidate_seeds", True)
        ),
        score_prune_edges=bool(rcfg.get("score_prune_edges", False)),
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
        seed_llm_filter=seed_llm_filter,
        # 导出时手动分步，便于分别展示规则边 / LLM 边
        edge_llm_filter=None,
    )

    lec_set = set(lecture_ids)
    rows = [
        r
        for r in load_jsonl(ROOT / cfg.processed_dir / args.course_id / "filtered_cues.jsonl")
        if str(r.get("lecture_id")) in lec_set
    ]
    rows.sort(key=lambda r: (str(r.get("lecture_id")), float(r.get("start_sec") or 0)))

    items: list[dict] = []
    for i, row in enumerate(rows, 1):
        asr = (row.get("asr_text") or "").strip()
        extract = _resolve_extract(row)
        s1 = row.get("stage1") or {}
        cue_id = row.get("cue_id")
        print(f"[{i}/{len(rows)}] {cue_id} extract_len={len(extract)}")

        if extract:
            alias_seeds, emb_seeds = retriever.find_seed_entities_by_source(extract)
            pre_union = alias_seeds | emb_seeds
            llm_kept: set[str] = set()
            llm_note = ""
            if seed_llm_filter is not None:
                llm_kept = seed_llm_filter.filter(
                    extract,
                    alias_seeds=alias_seeds,
                    embedding_seeds=emb_seeds,
                    course_context=args.course_id,
                )
                llm_note = seed_llm_filter.last_note or ""
            else:
                llm_kept = set(pre_union)

            # 直接用筛选后种子扩展，避免 retrieve() 内二次调用 LLM；
            # 边过滤池仍用别名∪向量候选（两端都必须在该池中）
            result = (
                retriever.retrieve_from_seeds(
                    llm_kept,
                    extract,
                    candidate_seed_pool=pre_union,
                    alias_seeds=alias_seeds,
                    embedding_seeds=emb_seeds,
                )
                if llm_kept
                else subgraph.SubgraphResult()
            )
            rule_relations = list(result.relations)
            edge_note = ""
            if edge_llm_filter is not None and rule_relations:
                kept_relations = edge_llm_filter.filter(
                    extract,
                    rule_relations,
                    expansion_seeds=llm_kept,
                    course_context=args.course_id,
                )
                edge_note = edge_llm_filter.last_note or ""
            else:
                kept_relations = rule_relations
                if edge_llm_filter is not None:
                    edge_note = "skipped (no rule-pool edges)"

            final_seeds = set(result.seed_entities)
            llm_dropped = sorted(pre_union - llm_kept)
            alias_in_llm = sorted(alias_seeds & llm_kept)
            emb_in_llm = sorted(emb_seeds & llm_kept)
            cap_dropped = sorted(llm_kept - final_seeds)

            def _edge_dict(rel: Any) -> dict:
                return {
                    "subject": rel.subject,
                    "predicate": rel.predicate,
                    "object": rel.object,
                    "subject_zh": _zh(rel.subject),
                    "object_zh": _zh(rel.object),
                }

            edges_rule = [_edge_dict(rel) for rel in rule_relations]
            edges = [_edge_dict(rel) for rel in kept_relations]
            entities = sorted(
                {r.subject for r in kept_relations}
                | {r.object for r in kept_relations}
                | set(final_seeds)
            )
            kept_keys = {
                (e["subject"], e["predicate"], e["object"]) for e in edges
            }
            edge_dropped = [
                e
                for e in edges_rule
                if (e["subject"], e["predicate"], e["object"]) not in kept_keys
            ]
        else:
            alias_seeds = emb_seeds = llm_kept = set()
            llm_dropped = alias_in_llm = emb_in_llm = cap_dropped = []
            edges = edges_rule = edge_dropped = []
            entities = []
            llm_note = edge_note = ""
            pre_union = set()
            result = subgraph.SubgraphResult()

        items.append(
            {
                "cue_id": cue_id,
                "lecture_id": str(row.get("lecture_id")),
                "start_sec": row.get("start_sec"),
                "end_sec": row.get("end_sec"),
                "text_preprocess_status": s1.get("text_preprocess_status"),
                "asr_text": asr,
                "extract_text": extract,
                "seeds": {
                    "alias": sorted(alias_seeds),
                    "embedding": sorted(emb_seeds),
                    "llm_kept": sorted(llm_kept),
                    "llm_dropped": llm_dropped,
                    "alias_in_llm_kept": alias_in_llm,
                    "embedding_in_llm_kept": emb_in_llm,
                    "dropped_by_seed_cap": cap_dropped,
                    "llm_note": llm_note,
                },
                "subgraph": {
                    "entity_count": len(entities),
                    "edge_count": len(edges),
                    "edge_count_rule_pool": len(edges_rule),
                    "entities": entities,
                    "edges": edges,
                    "edges_rule_pool": edges_rule,
                    "edges_llm_dropped": edge_dropped,
                    "edge_llm_note": edge_note,
                    "final_seeds": sorted(result.seed_entities) if extract else [],
                },
                "assigned_textbook_edges": (s1.get("triplet_validation") or {}).get(
                    "assigned_textbook_edges"
                ),
                "triplet_count": s1.get("triplet_count"),
            }
        )

    out_dir = ROOT / "data" / "experiments" / "comparisons" / args.course_id
    out_dir.mkdir(parents=True, exist_ok=True)
    # 固定主文件名，便于对照历史检查文档
    out_json = out_dir / "extract_text_with_subgraph_lec1_17.json"
    out_md = out_dir / "extract_text_with_subgraph_lec1_17.md"
    if lecture_ids != ["1", "17"]:
        lec_tag = "_".join(f"lec{x}" for x in lecture_ids)
        out_json = out_dir / f"extract_text_with_subgraph_{lec_tag}.json"
        out_md = out_dir / f"extract_text_with_subgraph_{lec_tag}.md"

    filter_enabled = bool(filter_cfg.get("enabled", False))
    edge_filter_enabled = bool(edge_cfg.get("enabled", False))
    save_json(
        out_json,
        {
            "course_id": args.course_id,
            "lecture_ids": lecture_ids,
            "note": (
                "asr_text=原始；extract_text=抽取用；"
                "alias/embedding=筛选前候选；llm_kept=LLM种子筛选后；"
                "edges_rule_pool=两端均在候选池的规则边；"
                "edges=LLM边筛选后"
            ),
            "retriever": {
                "embedding_link_enabled": retriever.embedding_link_enabled,
                "embedding_link_min_score": retriever.embedding_link_min_score,
                "embedding_link_top_k": retriever.embedding_link_top_k,
                "max_seed_entities": retriever.max_seed_entities,
                "require_both_ends_in_candidate_seeds": (
                    retriever.require_both_ends_in_candidate_seeds
                ),
                "score_prune_edges": retriever.score_prune_edges,
                "require_text_anchor": retriever.require_text_anchor,
                "seed_llm_filter_enabled": filter_enabled,
                "seed_llm_filter": filter_cfg,
                "edge_llm_filter_enabled": edge_filter_enabled,
                "edge_llm_filter": edge_cfg,
            },
            "items": items,
        },
    )

    md = [
        f"# 原始文本 × extract_text × 种子/边筛选 × subgraph（{', '.join(lecture_ids)}）",
        "",
        f"共 {len(items)} 条 cue",
        "",
        "- **asr_text**：原始课堂文本",
        "- **extract_text**：抽取/检索用文本",
        "- **alias / embedding**：LLM 种子筛选前的候选",
        "- **llm_kept**：LLM 种子筛选后（用于扩展）",
        "- **edges_rule_pool**：两端均在 alias∪embedding 的规则硬剪枝边",
        "- **edges**：LLM 边筛选后（最终子图边）",
        f"- embedding_min_score={retriever.embedding_link_min_score}, "
        f"top_k={retriever.embedding_link_top_k}, "
        f"max_hops={retriever.max_hops}, "
        f"max_edges_per_cue={retriever.max_edges_per_cue}, "
        f"max_seed_entities={retriever.max_seed_entities}, "
        f"both_ends_in_candidate_seeds={retriever.require_both_ends_in_candidate_seeds}, "
        f"score_prune_edges={retriever.score_prune_edges}, "
        f"seed_llm_filter={filter_enabled}, "
        f"edge_llm_filter={edge_filter_enabled}",
        "",
    ]
    for it in items:
        seeds = it["seeds"]
        sg = it["subgraph"]
        md += [
            f"## [{it['lecture_id']}] {it['cue_id']}",
            "",
            (
                f"- status: `{it['text_preprocess_status']}` | "
                f"alias={len(seeds['alias'])} emb={len(seeds['embedding'])} "
                f"→ llm_kept={len(seeds['llm_kept'])} "
                f"(alias={len(seeds['alias_in_llm_kept'])}, "
                f"emb={len(seeds['embedding_in_llm_kept'])}) | "
                f"entities={sg['entity_count']} "
                f"edges={sg['edge_count_rule_pool']}→{sg['edge_count']}"
            ),
            "",
            "### asr_text（原始）",
            "",
            it["asr_text"] or "*(empty)*",
            "",
            "### extract_text（抽取用）",
            "",
            it["extract_text"] or "*(empty)*",
            "",
            "### alias seeds（别名候选）",
            "",
        ]
        md += [f"- {_zh(s)}" for s in seeds["alias"]] or ["*(none)*"]
        md += ["", "### embedding seeds（向量候选）", ""]
        md += [f"- {_zh(s)}" for s in seeds["embedding"]] or ["*(none)*"]
        md += ["", "### llm_kept（筛选后种子）", ""]
        if seeds.get("llm_note"):
            md += [f"_note: {seeds['llm_note']}_", ""]
        md += [f"- {_zh(s)}" for s in seeds["llm_kept"]] or ["*(none)*"]
        if seeds["llm_dropped"]:
            md += [
                "",
                f"_LLM 丢弃 ({len(seeds['llm_dropped'])}):_ "
                + ", ".join(_zh(s) for s in seeds["llm_dropped"][:20]),
            ]
            if len(seeds["llm_dropped"]) > 20:
                md.append(f"  …共 {len(seeds['llm_dropped'])} 个")
        if seeds["dropped_by_seed_cap"]:
            md += [
                "",
                f"_max_seed_entities 截断 ({len(seeds['dropped_by_seed_cap'])}):_ "
                + ", ".join(_zh(s) for s in seeds["dropped_by_seed_cap"][:12]),
            ]
        md += [
            "",
            f"### edges_rule_pool（两端均在候选池，{sg['edge_count_rule_pool']}）",
            "",
        ]
        md += [
            f"- {e['subject_zh']} —[{e['predicate']}]→ {e['object_zh']}"
            for e in sg["edges_rule_pool"]
        ] or ["*(none)*"]
        md += [
            "",
            f"### edges（LLM 边筛选后，{sg['edge_count']}）",
            "",
        ]
        if sg.get("edge_llm_note"):
            md += [f"_note: {sg['edge_llm_note']}_", ""]
        md += [
            f"- {e['subject_zh']} —[{e['predicate']}]→ {e['object_zh']}"
            for e in sg["edges"]
        ] or ["*(none)*"]
        if sg.get("edges_llm_dropped"):
            dropped = sg["edges_llm_dropped"]
            md += [
                "",
                f"_LLM 丢弃边 ({len(dropped)}):_",
            ]
            md += [
                f"- {e['subject_zh']} —[{e['predicate']}]→ {e['object_zh']}"
                for e in dropped[:30]
            ]
            if len(dropped) > 30:
                md.append(f"  …共 {len(dropped)} 条")
        md += ["", "---", ""]
   
    out_md.write_text("\n".join(md), encoding="utf-8")
    # 兼容旧文件名副本
    if out_md.name == "extract_text_with_subgraph_lec1_17.md":
        (out_dir / "extract_text_with_subgraph_lec1_lec17.md").write_text(
            "\n".join(md), encoding="utf-8"
        )
    print("wrote", out_json)
    print("wrote", out_md)


if __name__ == "__main__":
    main()
