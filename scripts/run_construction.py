#!/usr/bin/env python
"""Run VAT-KG construction pipeline (paper Sec. 3)."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from vatkg.config import VATKGConfig
from vatkg.construction.pipeline import VATKGConstructionPipeline


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VAT-KG construction pipeline")
    parser.add_argument(
        "--config",
        default=str(ROOT / "configs" / "default.yaml"),
        help="Path to YAML config",
    )
    parser.add_argument(
        "--corpus",
        required=True,
        help="Input corpus JSONL (see data/raw/corpus_schema.example.jsonl)",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Override processed output directory",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Use mock encoders/LLM for dry-run without GPU weights",
    )
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(message)s")

    config = VATKGConfig.from_yaml(args.config)
    pipeline = VATKGConstructionPipeline(config, mock=args.mock)
    kg_path = pipeline.run(args.corpus, output_dir=args.output_dir)
    print(f"VAT-KG saved to: {kg_path}")


if __name__ == "__main__":
    main()
