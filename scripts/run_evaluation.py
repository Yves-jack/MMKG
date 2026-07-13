#!/usr/bin/env python
"""Evaluate multimodal RAG on a QA benchmark."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from vatkg.config import VATKGConfig
from vatkg.evaluation.evaluate import model_as_judge_stub, run_evaluation


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate VAT-KG RAG")
    parser.add_argument("--config", default=str(ROOT / "configs" / "default.yaml"))
    parser.add_argument("--qa", required=True, help="QA benchmark JSONL")
    parser.add_argument("--index-dir", default=None)
    parser.add_argument("--output", default=str(ROOT / "data" / "processed" / "rag_predictions.jsonl"))
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(message)s")

    config = VATKGConfig.from_yaml(args.config)
    index_dir = Path(args.index_dir or config.index_dir)
    outputs = run_evaluation(
        config=config,
        qa_path=args.qa,
        index_dir=index_dir,
        output_path=args.output,
        mock=args.mock,
    )
    summary = model_as_judge_stub(args.output)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Predictions: {args.output} ({len(outputs)} samples)")


if __name__ == "__main__":
    main()
