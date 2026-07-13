#!/usr/bin/env python
"""RAG 评测：对 qa_eval.jsonl 批量问答并统计。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.rag.mmkg_rag import MMKGRAG


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", required=True)
    p.add_argument("--eval-file", default=None)
    p.add_argument("--mock", action="store_true")
    p.add_argument("--output", default=None)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    eval_path = Path(args.eval_file) if args.eval_file else ROOT / "data" / "eval" / args.course_id / "qa_eval.jsonl"
    if not eval_path.is_file():
        raise SystemExit(f"Eval file not found: {eval_path}")

    config = TeachKGConfig.from_yaml(args.config)
    rag = MMKGRAG(config, project_root=ROOT, mock=args.mock)
    rag.reset_history()

    rows = [json.loads(line) for line in eval_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    results: list[dict] = []
    hit_count = 0
    supported = 0
    partial = 0
    unsupported = 0

    for row in rows:
        q = row["question"]
        ans = rag.answer(q, args.course_id, use_history=False)
        has_hits = bool(ans.get("hits"))
        hit_count += int(has_hits)
        verdict = (ans.get("check") or {}).get("verdict")
        if verdict == "supported":
            supported += 1
        elif verdict == "partial":
            partial += 1
        elif verdict == "unsupported":
            unsupported += 1
        results.append(
            {
                "id": row.get("id"),
                "question": q,
                "expected_topics": row.get("expected_topics"),
                "has_hits": has_hits,
                "verdict": verdict,
                "answer_preview": ans.get("answer", "")[:200],
            }
        )

    rag.clear_cache()

    n = max(len(rows), 1)
    summary = {
        "total": len(rows),
        "hit_rate": round(hit_count / n, 3),
        "supported_rate": round(supported / n, 3),
        "partial_rate": round(partial / n, 3),
        "unsupported_rate": round(unsupported / n, 3),
    }
    out = Path(args.output) if args.output else ROOT / "data" / "eval" / args.course_id / "qa_eval_results.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Details → {out}")


if __name__ == "__main__":
    main()
