#!/usr/bin/env python3
"""课堂图谱纯 PageRank 重要性（实验）。

写出 data/kg/<course>/entity_importance_pagerank.json
**不会**修改 entity_importance_feedback.json。

用法:
  python scripts/teaching/run_importance_pagerank.py --course 数理逻辑 --write
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.textbook_kg.importance_pagerank import (
    DEFAULT_DAMPING,
    classic_pagerank_normalized,
    merge_lecture_scores_max,
    normalize_scores,
    pack_pagerank_document,
)


def _load_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description="纯 PageRank 课堂重要性（独立产物）")
    parser.add_argument("--course", default="数理逻辑")
    parser.add_argument("--lecture", default=None, help="仅计算指定讲次")
    parser.add_argument("--damping", type=float, default=DEFAULT_DAMPING)
    parser.add_argument("--write", action="store_true")
    parser.add_argument(
        "--out",
        default=None,
        help="默认 data/kg/<course>/entity_importance_pagerank.json",
    )
    args = parser.parse_args()

    kg_dir = ROOT / "data/kg" / args.course
    trips = _load_jsonl(kg_dir / "triplets.jsonl")
    if not trips:
        trips = _load_jsonl(kg_dir / "llm_only" / "triplets.jsonl")
    if not trips:
        raise SystemExit(f"no triplets for course={args.course}")

    trips_by: dict[str, list] = defaultdict(list)
    for t in trips:
        lid = str(t.get("lecture_id") or "").strip()
        if lid:
            trips_by[lid].append(t)

    lecture_ids = sorted(trips_by.keys(), key=lambda x: int(x) if x.isdigit() else 999)
    if args.lecture:
        lecture_ids = [args.lecture]
        if args.lecture not in trips_by:
            raise SystemExit(f"lecture {args.lecture} has no triplets")

    by_lecture: dict[str, dict[str, float]] = {}
    n_trips: dict[str, int] = {}
    for lid in lecture_ids:
        lec_trips = trips_by[lid]
        n_trips[lid] = len(lec_trips)
        scores = classic_pagerank_normalized(lec_trips, damping=args.damping)
        by_lecture[lid] = scores
        top = sorted(scores.items(), key=lambda x: -x[1])[:8]
        top_s = ", ".join(f"{n.split('/')[0]}={v:.3f}" for n, v in top)
        print(f"lecture:{lid} nodes={len(scores)} trips={len(lec_trips)} top: {top_s}")

    if args.lecture:
        course_scores = dict(by_lecture[args.lecture])
    else:
        # 全量三元组整课 PR，与分讲 max 取并集后再归一化
        all_pr = classic_pagerank_normalized(trips, damping=args.damping)
        max_pr = merge_lecture_scores_max(by_lecture)
        merged = dict(max_pr)
        merged.update(all_pr)
        course_scores = normalize_scores(merged)

    doc = pack_pagerank_document(
        course=args.course,
        by_lecture=by_lecture,
        course_scores=course_scores,
        damping=args.damping,
        n_triplets_by_lecture=n_trips,
    )

    # 打印 命题 对比提示
    for key in ("命题/proposition", "命题逻辑/propositional logic", "谓词/predicate"):
        v = course_scores.get(key)
        if v is not None:
            print(f"course PR {key.split('/')[0]} = {v:.4f}")

    if not args.write:
        print("(dry-run; pass --write to save)")
        return

    out = Path(args.out) if args.out else kg_dir / "entity_importance_pagerank.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out} (feedback file untouched)")


if __name__ == "__main__":
    main()
