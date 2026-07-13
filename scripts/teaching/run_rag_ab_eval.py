#!/usr/bin/env python
"""RAG 检索 A/B 对比（单 index 加载，避免重复占内存）。"""

from __future__ import annotations

import argparse
import gc
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from teachkg.config import TeachKGConfig
from teachkg.rag.hybrid_retriever import hybrid_search
from teachkg.rag.mmkg_rag import MMKGRAG, _filter_hits_by_lecture
from teachkg.stage3_mmkg.index_builder import MMKGIndex


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", required=True)
    p.add_argument("--eval-file", default=None)
    p.add_argument("--output", default=None)
    return p.parse_args()


def _retrieve(
    index: MMKGIndex,
    mmkg: dict | None,
    question: str,
    *,
    mode: str,
    top_k: int,
    min_score: float,
    vector_weight: float,
    bm25_weight: float,
    graph_max: int,
) -> list[dict]:
    if mode == "dense":
        hits = index.search(question, top_k=top_k)
    elif mode == "hybrid":
        hits = hybrid_search(
            index, question, top_k=top_k,
            vector_weight=vector_weight, bm25_weight=bm25_weight,
            mmkg=None, graph_hops=0,
        )
    else:
        hits = hybrid_search(
            index, question, top_k=top_k,
            vector_weight=vector_weight, bm25_weight=bm25_weight,
            mmkg=mmkg, graph_hops=1, graph_max=graph_max,
        )
    if min_score > 0:
        hits = [h for h in hits if h.get("score", 0) >= min_score]
    return hits


def main() -> None:
    args = parse_args()
    eval_path = Path(args.eval_file) if args.eval_file else ROOT / "data" / "eval" / args.course_id / "qa_eval.jsonl"
    rows = [json.loads(line) for line in eval_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    config = TeachKGConfig.from_yaml(args.config)
    rag_cfg = config.get("stage4", default={}).get("rag", {})
    top_k = int(rag_cfg.get("top_k", 5))
    min_score = float(rag_cfg.get("min_score", 0.15))
    vw = float(rag_cfg.get("vector_weight", 0.65))
    bw = float(rag_cfg.get("bm25_weight", 0.35))
    graph_max = int(rag_cfg.get("graph_max", 5))
    retrieval_scope = str(rag_cfg.get("retrieval_scope", "course")).strip().lower()

    helper = MMKGRAG(config, project_root=ROOT, mock=True)
    idx_path = helper._index_path(args.course_id, None)
    index = MMKGIndex.load(idx_path)
    try:
        mmkg = helper._load_mmkg(args.course_id, None)
    except FileNotFoundError:
        mmkg = None

    modes = ["dense", "hybrid", "hybrid_graph"]
    summary: dict[str, dict] = {}
    details: list[dict] = []

    for mode in modes:
        hits_total = 0
        topic_hits = 0
        for row in rows:
            q = row["question"]
            lid = row.get("lecture_id")
            lecture_id = None if lid in (None, "all", "") else str(lid)
            effective = helper._resolve_lecture_id(q, lecture_id)
            hits = _retrieve(
                index, mmkg, q, mode=mode, top_k=top_k, min_score=min_score,
                vector_weight=vw, bm25_weight=bw, graph_max=graph_max,
            )
            if retrieval_scope != "course" and lecture_id is None and effective:
                hits = _filter_hits_by_lecture(hits, effective)
            hits_total += len(hits)
            topics = row.get("expected_topics") or []
            text_blob = " ".join(h.get("text", "") for h in hits)
            ok = bool(topics and any(t in text_blob for t in topics))
            topic_hits += int(ok)
            details.append({
                "mode": mode, "id": row.get("id"), "question": q,
                "hit_count": len(hits),
                "top_score": hits[0].get("score") if hits else 0,
                "topic_recall": ok,
            })
        n = max(len(rows), 1)
        summary[mode] = {
            "avg_hits": round(hits_total / n, 2),
            "topic_recall_rate": round(topic_hits / n, 3),
        }

    out = Path(args.output) if args.output else ROOT / "data" / "eval" / args.course_id / "rag_ab_results.json"
    out.write_text(json.dumps({"summary": summary, "details": details}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Details → {out}")
    gc.collect()


if __name__ == "__main__":
    main()
