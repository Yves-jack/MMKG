#!/usr/bin/env python
"""Run multimodal RAG inference on a single query."""

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
from vatkg.rag.framework import MultimodalRAGFramework
from vatkg.rag.index import VATKGIndex


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VAT-KG multimodal RAG inference")
    parser.add_argument("--config", default=str(ROOT / "configs" / "default.yaml"))
    parser.add_argument("--index-dir", default=None)
    parser.add_argument("--question", required=True)
    parser.add_argument("--modality", choices=["audio", "video", "av"], default="video")
    parser.add_argument("--audio-path", default=None)
    parser.add_argument("--video-path", default=None)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(message)s")

    config = VATKGConfig.from_yaml(args.config)
    index_dir = Path(args.index_dir or config.index_dir)
    index = VATKGIndex(config)
    index.load(index_dir)

    rag = MultimodalRAGFramework(config, index, mock=args.mock)
    result = rag.run(
        question=args.question,
        modality=args.modality,
        audio_path=args.audio_path,
        video_path=args.video_path,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
