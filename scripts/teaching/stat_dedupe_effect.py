"""统计 hybrid 增量相对 cue 子图的去重效果（讲次 1）。"""

from __future__ import annotations

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
_load("teachkg.textbook_kg.alias", "teachkg/textbook_kg/alias.py")
loader = _load("teachkg.textbook_kg.loader", "teachkg/textbook_kg/loader.py")
theorem_edges = _load(
    "teachkg.textbook_kg.theorem_edges", "teachkg/textbook_kg/theorem_edges.py"
)
subgraph_mod = _load("teachkg.textbook_kg.subgraph", "teachkg/textbook_kg/subgraph.py")
seed_filter_mod = _load(
    "teachkg.textbook_kg.seed_filter", "teachkg/textbook_kg/seed_filter.py"
)
edge_filter_mod = _load(
    "teachkg.textbook_kg.edge_filter", "teachkg/textbook_kg/edge_filter.py"
)
convert = _load("teachkg.textbook_kg.convert", "teachkg/textbook_kg/convert.py")

from teachkg.config import TeachKGConfig
from teachkg.utils.io import load_jsonl, save_json


def primary(name: str) -> str:
    return (name or "").split("/")[0].strip()


def exact_key(t) -> tuple:
    if isinstance(t, dict):
        return (
            t.get("subject"),
            t.get("abstract_relation") or "",
            t.get("concrete_relation") or "",
            t.get("object"),
        )
    return t.dedupe_key


def loose_key(t) -> tuple:
    if isinstance(t, dict):
        return (
            primary(t.get("subject", "")),
            t.get("abstract_relation") or "",
            primary(t.get("object", "")),
        )
    return (primary(t.subject), t.abstract_relation, primary(t.object))


def abs_spo_key(t) -> tuple:
    """忽略 concrete，仅 subject/abstract/object 全名。"""
    if isinstance(t, dict):
        return (
            t.get("subject"),
            t.get("abstract_relation") or "",
            t.get("object"),
        )
    return (t.subject, t.abstract_relation, t.object)


def unord_key(t) -> tuple:
    if isinstance(t, dict):
        a, b = primary(t.get("subject", "")), primary(t.get("object", ""))
        return (t.get("abstract_relation") or "", tuple(sorted([a, b])))
    a, b = primary(t.subject), primary(t.object)
    return (t.abstract_relation, tuple(sorted([a, b])))


def build_retriever(cfg: TeachKGConfig):
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    rcfg = tb.get("subgraph", {}) or {}
    kg_path = ROOT / tb.get("path")
    kg = loader.TextbookKG.load(
        kg_path,
        entity_file=tb.get("entity_file", "entity_final.json"),
        relations_file=tb.get("relations_file", "relations_final.json"),
        importance_file=tb.get("importance_file", "entity_sorted.json"),
    )
    if rcfg.get("include_theorem_edges", True):
        kg = theorem_edges.augment_textbook_kg(kg)

    seed_cfg = rcfg.get("seed_llm_filter", {}) or {}
    edge_cfg = rcfg.get("edge_llm_filter", {}) or {}
    seed_llm_filter = None
    if seed_cfg.get("enabled", False):
        seed_llm_filter = seed_filter_mod.SeedLLMFilter(
            enabled=True,
            prompt=seed_cfg.get("prompt", "stage1/seed_filter.txt"),
            temperature=float(seed_cfg.get("temperature", 0.1) or 0.1),
            llm_model=seed_cfg.get("llm_model"),
            min_candidates=int(seed_cfg.get("min_candidates", 1) or 1),
            fallback_keep_all_on_empty=bool(
                seed_cfg.get("fallback_keep_all_on_empty", False)
            ),
            fallback_to_alias_on_empty=(
                seed_cfg["fallback_to_alias_on_empty"]
                if "fallback_to_alias_on_empty" in seed_cfg
                else None
            ),
            course_context="数理逻辑",
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
            course_context="数理逻辑",
        )

    return subgraph_mod.TextbookSubgraphRetriever(
        kg,
        max_hops=int(rcfg.get("max_hops", 1)),
        max_edges_per_cue=rcfg.get("max_edges_per_cue"),
        max_seed_entities=int(rcfg.get("max_seed_entities", 40)),
        lecture_min_relation_score=float(rcfg.get("lecture_min_relation_score", 4.0)),
        cue_min_relation_score=float(rcfg.get("cue_min_relation_score", 4.0)),
        require_text_anchor=bool(rcfg.get("require_text_anchor", False)),
        require_both_ends_in_candidate_seeds=bool(
            rcfg.get("require_both_ends_in_candidate_seeds", True)
        ),
        score_prune_edges=bool(rcfg.get("score_prune_edges", False)),
        embedding_link_enabled=bool(rcfg.get("embedding_link_enabled", False)),
        embedding_link_top_k=rcfg.get("embedding_link_top_k"),
        embedding_link_min_score=float(rcfg.get("embedding_link_min_score", 0.82)),
        lecture_embedding_link_min_score=rcfg.get("lecture_embedding_link_min_score"),
        embedder_model=str(
            rcfg.get("embedder_model", "shibing624/text2vec-base-multilingual")
        ),
        embedding_cache_enabled=bool(rcfg.get("embedding_cache_enabled", True)),
        textbook_base_path=kg_path,
        seed_llm_filter=seed_llm_filter,
        edge_llm_filter=edge_llm_filter,
    )


def resolve_extract(row: dict) -> str:
    s1 = row.get("stage1") or {}
    if s1.get("text_preprocess_status") == "empty_after_preprocess" or s1.get(
        "extract_text"
    ) == "":
        return ""
    et = s1.get("extract_text")
    if isinstance(et, str) and et.strip():
        return et.strip()
    return (row.get("asr_text") or "").strip()


def main() -> None:
    cfg = TeachKGConfig.from_yaml(str(ROOT / "configs/teaching.yaml"))
    retriever = build_retriever(cfg)

    cues = [
        r
        for r in load_jsonl(ROOT / "data/processed/数理逻辑/filtered_cues.jsonl")
        if str(r.get("lecture_id")) == "1"
    ]
    cues.sort(key=lambda r: float(r.get("start_sec") or 0))

    trips = load_jsonl(ROOT / "data/kg/数理逻辑/triplets.jsonl")
    hyb_by: dict[str, dict[str, list]] = defaultdict(
        lambda: {"textbook": [], "delta": [], "fallback": []}
    )
    for r in trips:
        if str(r.get("lecture_id")) != "1":
            continue
        src = r.get("extract_source") or ""
        if src == "textbook":
            hyb_by[r["cue_id"]]["textbook"].append(r)
        elif src == "lecture_delta":
            hyb_by[r["cue_id"]]["delta"].append(r)
        elif src == "llm_fallback":
            hyb_by[r["cue_id"]]["fallback"].append(r)

    llm_by: dict[str, list] = defaultdict(list)
    for r in load_jsonl(ROOT / "data/kg/数理逻辑/llm_only/triplets.jsonl"):
        if str(r.get("lecture_id")) == "1":
            llm_by[r["cue_id"]].append(r)

    per_cue = []
    # final delta vs live subgraph
    fin = {"delta": 0, "exact": 0, "loose": 0, "abs_spo": 0, "unord": 0}
    # llm_only vs live subgraph (proxy for pre-dedupe hit rate)
    est = {
        "llm": 0,
        "exact": 0,
        "loose": 0,
        "abs_spo": 0,
        "unord": 0,
        "sg_edges": 0,
    }
    loose_block_samples = []
    exact_block_samples = []

    for i, row in enumerate(cues, 1):
        cid = row["cue_id"]
        extract = resolve_extract(row)
        print(f"[{i}/{len(cues)}] {cid} extract_len={len(extract)}")
        if not extract:
            sg_trips = []
        else:
            result = retriever.retrieve(extract)
            sg_trips = convert.relations_to_triplets(result.relations)

        e_set = {exact_key(t) for t in sg_trips}
        l_set = {loose_key(t) for t in sg_trips}
        a_set = {abs_spo_key(t) for t in sg_trips}
        u_set = {unord_key(t) for t in sg_trips}
        est["sg_edges"] += len(sg_trips)

        # final deltas
        c_ex = c_lo = c_ab = c_un = 0
        for r in hyb_by[cid]["delta"]:
            fin["delta"] += 1
            if exact_key(r) in e_set:
                fin["exact"] += 1
                c_ex += 1
            if loose_key(r) in l_set:
                fin["loose"] += 1
                c_lo += 1
            if abs_spo_key(r) in a_set:
                fin["abs_spo"] += 1
                c_ab += 1
            if unord_key(r) in u_set:
                fin["unord"] += 1
                c_un += 1

        # llm_only proxy
        for r in llm_by[cid]:
            est["llm"] += 1
            if exact_key(r) in e_set:
                est["exact"] += 1
                if len(exact_block_samples) < 8:
                    exact_block_samples.append(
                        {
                            "cue_id": cid,
                            "triple": f"{primary(r['subject'])}-[{r.get('abstract_relation')}|{r.get('concrete_relation')}]->{primary(r['object'])}",
                        }
                    )
            if loose_key(r) in l_set:
                est["loose"] += 1
                if len(loose_block_samples) < 12:
                    loose_block_samples.append(
                        {
                            "cue_id": cid,
                            "triple": f"{primary(r['subject'])}-[{r.get('abstract_relation')}|{r.get('concrete_relation')}]->{primary(r['object'])}",
                        }
                    )
            if abs_spo_key(r) in a_set:
                est["abs_spo"] += 1
            if unord_key(r) in u_set:
                est["unord"] += 1

        per_cue.append(
            {
                "cue_id": cid,
                "extract_len": len(extract),
                "subgraph_edges": len(sg_trips),
                "written_textbook": len(hyb_by[cid]["textbook"]),
                "delta": len(hyb_by[cid]["delta"]),
                "llm_only": len(llm_by[cid]),
                "final_exact_overlap": c_ex,
                "final_loose_overlap": c_lo,
                "final_abs_spo_overlap": c_ab,
                "llm_exact_hit": sum(
                    1 for r in llm_by[cid] if exact_key(r) in e_set
                ),
                "llm_loose_hit": sum(1 for r in llm_by[cid] if loose_key(r) in l_set),
                "llm_abs_spo_hit": sum(
                    1 for r in llm_by[cid] if abs_spo_key(r) in a_set
                ),
            }
        )

    def rate(n, d):
        return round(n / d, 4) if d else None

    report = {
        "lecture_id": "1",
        "note": (
            "精确键=(subject,abstract,concrete,object)；"
            "loose=中文名+abstract+中文名；"
            "abs_spo=全名subject+abstract+object（忽略concrete）；"
            "llm_only 作为「若增量长得像基线」的命中率代理；"
            "子图为当场重检索（含种子/边 LLM 筛），与线上一致"
        ),
        "final_delta_vs_subgraph": {
            "delta_count": fin["delta"],
            "exact_overlap": fin["exact"],
            "loose_overlap": fin["loose"],
            "abs_spo_overlap": fin["abs_spo"],
            "unordered_overlap": fin["unord"],
        },
        "llm_only_vs_subgraph_proxy": {
            "llm_only_count": est["llm"],
            "subgraph_edge_sum": est["sg_edges"],
            "exact_hit": est["exact"],
            "exact_hit_rate": rate(est["exact"], est["llm"]),
            "loose_hit": est["loose"],
            "loose_hit_rate": rate(est["loose"], est["llm"]),
            "abs_spo_hit": est["abs_spo"],
            "abs_spo_hit_rate": rate(est["abs_spo"], est["llm"]),
            "unordered_hit": est["unord"],
            "unordered_hit_rate": rate(est["unord"], est["llm"]),
            "exact_block_samples": exact_block_samples,
            "loose_block_samples": loose_block_samples,
        },
        "per_cue": per_cue,
    }

    out = (
        ROOT
        / "data/experiments/comparisons/数理逻辑/dedupe_effect_lec1.json"
    )
    save_json(out, report)
    print("wrote", out)
    print(json.dumps(report["final_delta_vs_subgraph"], ensure_ascii=False, indent=2))
    print(json.dumps(report["llm_only_vs_subgraph_proxy"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
