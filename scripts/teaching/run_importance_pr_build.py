#!/usr/bin/env python3
"""构建可部署的教材重要性：全局 PPR + 分章 PPR → importance_bundle.json。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.importance_pr.biased_pagerank import (
    calculate_chapter_importance,
    calculate_global_importance_improved,
    demote_meta_hubs,
    load_graph_improved,
    results_to_sorted_list,
)
from teachkg.importance_pr.extract_toc import extract_toc_file
from teachkg.importance_pr.toc_score import (
    chapter_seed_maps,
    load_kg_nodes_from_relations,
    load_toc_structure,
    score_nodes_improved,
)


def _resolve_ocr(tb: Path, ocr_md: Path | None) -> Path | None:
    if ocr_md and ocr_md.is_file():
        return ocr_md
    hint = tb / "toc_source.txt"
    if hint.is_file():
        cand = Path(hint.read_text(encoding="utf-8").strip())
        if cand.is_file():
            return cand
    return None


def build_bundle(
    textbook_dir: Path,
    *,
    ocr_md: Path | None = None,
    drop_related_with: bool = False,
    out_degree_beta: float = 0.5,
    promote: bool = False,
) -> dict:
    tb = textbook_dir
    relations = json.loads((tb / "relations_final.json").read_text(encoding="utf-8"))
    toc_path = tb / "toc.md"

    src = _resolve_ocr(tb, ocr_md)
    if src is not None:
        extract_toc_file(src, toc_path)
        (tb / "toc_source.txt").write_text(str(src.resolve()), encoding="utf-8")

    if not toc_path.is_file():
        raise FileNotFoundError(f"缺少 toc.md: {toc_path}")

    toc_items = load_toc_structure(toc_path.read_text(encoding="utf-8"))
    nodes = load_kg_nodes_from_relations(relations)
    seeds = score_nodes_improved(nodes, toc_items, threshold=10)
    G = load_graph_improved(
        relations,
        drop_related_with=drop_related_with,
        out_degree_beta=out_degree_beta,
    )
    global_det = calculate_global_importance_improved(
        G, seeds, trust_direction="out", trust_hops=1
    )
    ch_seeds = chapter_seed_maps(nodes, toc_items, improved=True, threshold=5)
    ch_det = calculate_chapter_importance(G, ch_seeds, improved=True)

    global_sorted = results_to_sorted_list(global_det)
    by_chapter = {
        ch: results_to_sorted_list(demote_meta_hubs(det)) for ch, det in ch_det.items()
    }
    # 章标题列表（保持 TOC 顺序）
    chapter_order: list[str] = []
    for item in toc_items:
        ch = item.get("chapter") or ""
        if ch and ch not in chapter_order:
            chapter_order.append(ch)

    bundle = {
        "method": "biased_pagerank_improved",
        "params": {
            "related_with_weight": 0.0 if drop_related_with else 0.25,
            "out_degree_beta": out_degree_beta,
            "k_core_weight": 0.1,
            "trust_hops": 1,
            "trust_direction": "out",
            "hub_penalty_gamma": 0.15,
        },
        "toc_items": len(toc_items),
        "n_seeds": len(seeds),
        "chapter_order": chapter_order,
        "global": global_sorted,
        "by_chapter": by_chapter,
    }

    bundle_path = tb / "importance_bundle.json"
    sorted_path = tb / "entity_sorted_ppr.json"
    bundle_path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    sorted_path.write_text(json.dumps(global_sorted, ensure_ascii=False, indent=2), encoding="utf-8")

    if promote:
        # 备份经典 PR，再切换默认文件名
        classic = tb / "entity_sorted.json"
        backup = tb / "entity_sorted_classic_pr.json"
        if classic.is_file() and not backup.is_file():
            backup.write_text(classic.read_text(encoding="utf-8"), encoding="utf-8")
        classic.write_text(json.dumps(global_sorted, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "bundle_path": str(bundle_path),
        "sorted_path": str(sorted_path),
        "n_global": len(global_sorted),
        "n_chapters": len(by_chapter),
        "chapter_order": chapter_order,
        "top10": global_sorted[:10],
        "promoted": promote,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="构建教材 importance_bundle")
    parser.add_argument(
        "--textbook-dir",
        type=Path,
        default=ROOT / "data" / "textbook" / "CS2501-离散数学（数理逻辑与集合论）",
    )
    parser.add_argument("--ocr-md", type=Path, default=None)
    parser.add_argument("--drop-related-with", action="store_true")
    parser.add_argument(
        "--promote",
        action="store_true",
        help="备份原 entity_sorted.json 后，用改进全局分覆盖之",
    )
    args = parser.parse_args()
    info = build_bundle(
        args.textbook_dir,
        ocr_md=args.ocr_md,
        drop_related_with=args.drop_related_with,
        promote=args.promote,
    )
    print("Built importance bundle")
    print(f"  chapters={info['n_chapters']} nodes={info['n_global']}")
    print(f"  -> {info['bundle_path']}")
    print(f"  -> {info['sorted_path']}")
    if info["promoted"]:
        print("  promoted -> entity_sorted.json (classic backed up)")
    print("Top10:")
    for n, s in info["top10"]:
        print(f"  {s:.4f}  {n}")
    print("Chapters:")
    for ch in info["chapter_order"]:
        print(f"  - {ch}")


if __name__ == "__main__":
    main()
