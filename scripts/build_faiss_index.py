#!/usr/bin/env python
"""Build FAISS indices for multimodal RAG."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from vatkg.config import VATKGConfig
from vatkg.rag.index import VATKGIndex


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build VAT-KG FAISS index")
    parser.add_argument("--config", default=str(ROOT / "configs" / "default.yaml"))
    parser.add_argument("--kg", required=True, help="Path to vatkg.jsonl")
    parser.add_argument("--index-dir", default=None, help="Output index directory")
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(message)s")

    config = VATKGConfig.from_yaml(args.config)
    index_dir = Path(args.index_dir or config.index_dir)
    index = VATKGIndex(config)
    index.build(args.kg)
    index.save(index_dir)
    print(f"FAISS index saved to: {index_dir}")


if __name__ == "__main__":
    main()
