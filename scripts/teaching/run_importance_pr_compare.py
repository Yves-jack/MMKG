#!/usr/bin/env python3
"""对比 AutoEduKG 原版 Biased-PR 与 VAT-KG 改进版，并对照现有 entity_sorted。"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.importance_pr.biased_pagerank import (
    calculate_chapter_importance,
    calculate_global_importance,
    calculate_global_importance_improved,
    load_graph,
    load_graph_improved,
    results_to_sorted_list,
)
from teachkg.importance_pr.toc_score import (
    chapter_seed_maps,
    load_kg_nodes_from_relations,
    load_toc_structure,
    score_nodes_baseline,
    score_nodes_improved,
)


def _load_entity_sorted(path: Path) -> dict[str, float]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, float] = {}
    for item in raw:
        if isinstance(item, list) and len(item) >= 2:
            out[str(item[0])] = float(item[1])
        elif isinstance(item, dict):
            name = item.get("node") or item.get("name")
            score = item.get("score")
            if name is not None and score is not None:
                out[str(name)] = float(score)
    return out


def _rank_map(scores: dict[str, float]) -> dict[str, int]:
    ordered = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return {n: i + 1 for i, (n, _) in enumerate(ordered)}


def _spearman_top(a: dict[str, float], b: dict[str, float], top_n: int = 100) -> float | None:
    """在双方 top-N 交集上，用交集内相对名次算 Spearman。"""
    top_a = [n for n, _ in sorted(a.items(), key=lambda x: -x[1])[:top_n]]
    top_b = [n for n, _ in sorted(b.items(), key=lambda x: -x[1])[:top_n]]
    common = [n for n in top_a if n in set(top_b)]
    if len(common) < 3:
        return None
    # 交集内相对排名（1..m）
    order_a = {n: i + 1 for i, n in enumerate(sorted(common, key=lambda x: -a[x]))}
    order_b = {n: i + 1 for i, n in enumerate(sorted(common, key=lambda x: -b[x]))}
    m = len(common)
    d2 = sum((order_a[n] - order_b[n]) ** 2 for n in common)
    return 1.0 - (6.0 * d2) / (m * (m * m - 1))


def _overlap(a: dict[str, float], b: dict[str, float], k: int) -> float:
    sa = {n for n, _ in sorted(a.items(), key=lambda x: -x[1])[:k]}
    sb = {n for n, _ in sorted(b.items(), key=lambda x: -x[1])[:k]}
    return len(sa & sb) / k if k else 0.0


def _final_dict(detailed: dict) -> dict[str, float]:
    return {n: float(d["final"]) for n, d in detailed.items()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Biased-PR baseline vs improved 对比")
    parser.add_argument(
        "--textbook-dir",
        type=Path,
        default=ROOT / "data" / "textbook" / "CS2501-离散数学（数理逻辑与集合论）",
    )
    parser.add_argument("--top", type=int, default=30)
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument(
        "--ocr-md",
        type=Path,
        default=None,
        help="教材 OCR markdown；若提供则从中提取 toc.md",
    )
    args = parser.parse_args()

    tb = args.textbook_dir
    out_dir = args.out_dir or (tb / "importance_pr_compare")
    out_dir.mkdir(parents=True, exist_ok=True)

    relations = json.loads((tb / "relations_final.json").read_text(encoding="utf-8"))
    toc_path = tb / "toc.md"
    ocr_md = args.ocr_md
    if ocr_md is None:
        hint = tb / "toc_source.txt"
        if hint.is_file():
            candidate = Path(hint.read_text(encoding="utf-8").strip())
            if candidate.is_file():
                ocr_md = candidate
    if ocr_md is not None and ocr_md.is_file():
        from teachkg.importance_pr.extract_toc import extract_toc_file

        extract_toc_file(ocr_md, toc_path)
        print(f"TOC extracted from OCR: {ocr_md}")
    if not toc_path.is_file():
        raise FileNotFoundError(f"缺少 TOC: {toc_path}（可传 --ocr-md）")
    toc_items = load_toc_structure(toc_path.read_text(encoding="utf-8"))
    nodes = load_kg_nodes_from_relations(relations)

    seeds_base = score_nodes_baseline(nodes, toc_items, threshold=10)
    seeds_imp = score_nodes_improved(nodes, toc_items, threshold=10)

    G0 = load_graph(relations)
    G1 = load_graph_improved(relations, drop_related_with=False, out_degree_beta=0.5)

    base = calculate_global_importance(G0, seeds_base, k_core_weight=0.3)
    improved = calculate_global_importance_improved(
        G1, seeds_imp, k_core_weight=0.1, trust_direction="out", trust_hops=1
    )

    base_scores = _final_dict(base)
    imp_scores = _final_dict(improved)

    classic_path = tb / "entity_sorted.json"
    classic = _load_entity_sorted(classic_path) if classic_path.is_file() else {}

    # 分章（改进）
    ch_seeds = chapter_seed_maps(nodes, toc_items, improved=True, threshold=5)
    ch_results = calculate_chapter_importance(G1, ch_seeds, improved=True)

    # 落盘
    (out_dir / "node_scores_baseline.json").write_text(
        json.dumps([{"node": k, "score": v} for k, v in sorted(seeds_base.items(), key=lambda x: -x[1])], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out_dir / "node_scores_improved.json").write_text(
        json.dumps([{"node": k, "score": v} for k, v in sorted(seeds_imp.items(), key=lambda x: -x[1])], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out_dir / "entity_sorted_biased_baseline.json").write_text(
        json.dumps(results_to_sorted_list(base), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (out_dir / "entity_sorted_biased_improved.json").write_text(
        json.dumps(results_to_sorted_list(improved), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    by_chapter_export = {}
    for ch, det in ch_results.items():
        by_chapter_export[ch] = results_to_sorted_list(det)[:50]
    (out_dir / "importance_by_chapter.json").write_text(
        json.dumps(by_chapter_export, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    k_list = [10, 20, 50, 100]
    report = {
        "textbook": str(tb),
        "n_relations": len(relations),
        "n_nodes": len(nodes),
        "n_toc_items": len(toc_items),
        "n_seeds_baseline": len(seeds_base),
        "n_seeds_improved": len(seeds_imp),
        "seed_jaccard": (
            len(set(seeds_base) & set(seeds_imp)) / len(set(seeds_base) | set(seeds_imp))
            if seeds_base or seeds_imp
            else 0.0
        ),
        "overlap_baseline_vs_improved": {f"top{k}": _overlap(base_scores, imp_scores, k) for k in k_list},
        "overlap_classic_vs_baseline": {f"top{k}": _overlap(classic, base_scores, k) for k in k_list} if classic else {},
        "overlap_classic_vs_improved": {f"top{k}": _overlap(classic, imp_scores, k) for k in k_list} if classic else {},
        "spearman_top100_baseline_vs_improved": _spearman_top(base_scores, imp_scores, 100),
        "spearman_top100_classic_vs_improved": _spearman_top(classic, imp_scores, 100) if classic else None,
        "chapters": list(ch_results.keys()),
        "top_baseline": results_to_sorted_list(base)[: args.top],
        "top_improved": results_to_sorted_list(improved)[: args.top],
        "top_classic": [[n, s] for n, s in sorted(classic.items(), key=lambda x: -x[1])[: args.top]] if classic else [],
    }
    (out_dir / "compare_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # CSV：三方排名对照
    all_nodes = set(base_scores) | set(imp_scores) | set(classic)
    rb, ri, rc = _rank_map(base_scores), _rank_map(imp_scores), _rank_map(classic)
    # 取改进 top 200 做对照表
    focus = [n for n, _ in sorted(imp_scores.items(), key=lambda x: -x[1])[:200]]
    with (out_dir / "rank_compare_top200.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["node", "rank_improved", "rank_baseline", "rank_classic", "score_improved", "score_baseline", "score_classic"])
        for n in focus:
            w.writerow(
                [
                    n,
                    ri.get(n, ""),
                    rb.get(n, ""),
                    rc.get(n, "") if classic else "",
                    f"{imp_scores.get(n, 0):.6f}",
                    f"{base_scores.get(n, 0):.6f}",
                    f"{classic.get(n, 0):.6f}" if classic else "",
                ]
            )

    # 控制台摘要
    print("=== Importance PR Compare ===")
    print(f"nodes={len(nodes)} rels={len(relations)} toc={len(toc_items)}")
    print(f"seeds baseline={len(seeds_base)} improved={len(seeds_imp)} jaccard={report['seed_jaccard']:.3f}")
    print("overlap baseline vs improved:", report["overlap_baseline_vs_improved"])
    if classic:
        print("overlap classic vs improved:", report["overlap_classic_vs_improved"])
    print(f"spearman@100 baseline vs improved: {report['spearman_top100_baseline_vs_improved']:.3f}")
    print("\n--- Top10 baseline ---")
    for n, s in report["top_baseline"][:10]:
        print(f"  {s:.4f}  {n}")
    print("\n--- Top10 improved ---")
    for n, s in report["top_improved"][:10]:
        print(f"  {s:.4f}  {n}")
    if classic:
        print("\n--- Top10 classic entity_sorted ---")
        for n, s in report["top_classic"][:10]:
            print(f"  {s:.4f}  {n}")
    print(f"\nWrote → {out_dir}")


if __name__ == "__main__":
    main()
