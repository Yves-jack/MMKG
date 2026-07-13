#!/usr/bin/env python
"""Stage 1: cue 后处理（规则校验 + PPT 帧 + 三元组抽取）。"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from teachkg.config import TeachKGConfig
from teachkg.stage1_alignment.pipeline import Stage1PreparePipeline


def setup_logging(log_level: str, log_file: Path) -> Path:
    log_file = log_file.resolve()
    log_file.parent.mkdir(parents=True, exist_ok=True)
    level = getattr(logging, log_level.upper(), logging.INFO)
    formatter = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")

    file_handler = logging.FileHandler(log_file, mode="w", encoding="utf-8")
    file_handler.setFormatter(formatter)
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level)
    root.addHandler(file_handler)
    root.addHandler(stream_handler)
    return log_file


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage 1: cue preparation (rules + PPT frames + triplets)")
    parser.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--log-file", default=None)
    parser.add_argument("--log-level", default="INFO")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Ignore cached filtered_cues.jsonl / triplets.jsonl and recompute",
    )
    parser.add_argument(
        "--mock",
        action="store_true",
        help="Mock LLM triplet extraction (no API calls)",
    )
    parser.add_argument(
        "--hybrid",
        action="store_true",
        help="启用教材混合抽取（等同 textbook_kg.enabled=true）",
    )
    parser.add_argument(
        "--lecture-id",
        action="append",
        dest="lecture_ids",
        help="仅处理指定讲次（增量合并 triplets）；可重复指定",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    default_log = ROOT / "data" / "logs" / f"stage1_{args.course_id}_{timestamp}.log"
    log_file = Path(args.log_file) if args.log_file else default_log
    setup_logging(args.log_level, log_file)

    logger = logging.getLogger(__name__)
    logger.info("Course ID: %s", args.course_id)

    config = TeachKGConfig.from_yaml(args.config)
    if args.hybrid:
        config.raw.setdefault("stage1", {}).setdefault("textbook_kg", {})["enabled"] = True
        config.raw["stage1"].setdefault("llm_only", {})["sync_active_triplets"] = False
    pipeline = Stage1PreparePipeline(config, project_root=ROOT, mock=args.mock)
    if args.force:
        pipeline.use_existing = False

    try:
        out_path = pipeline.run(args.course_id, lecture_ids=args.lecture_ids)
        triplets_path = pipeline.kg_dir / args.course_id / pipeline.triplets_filename
        logger.info("Filtered cues saved to: %s", out_path)
        logger.info("Triplets saved to: %s", triplets_path)
        print(f"Filtered cues saved to: {out_path}")
        print(f"Triplets saved to: {triplets_path}")
        print(f"Log saved to: {log_file}")
    except Exception:
        logger.exception("Stage 1 pipeline failed")
        raise


if __name__ == "__main__":
    main()
