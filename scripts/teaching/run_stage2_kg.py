#!/usr/bin/env python
"""Stage 2: 实体合并 → 课程/单讲知识图谱。"""

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
from teachkg.stage2_kg_build.pipeline import Stage2KGPipeline


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
    parser = argparse.ArgumentParser(description="Stage 2: entity merge → knowledge graph")
    parser.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--lecture-id", default=None, help="仅合并单讲；省略则整门课")
    parser.add_argument("--log-file", default=None)
    parser.add_argument("--log-level", default="INFO")
    parser.add_argument("--force", action="store_true", help="忽略已有 kg.json 并重建")
    parser.add_argument(
        "--input-filename",
        default=None,
        help="三元组文件名（默认 stage2.input_filename / triplets.jsonl）",
    )
    parser.add_argument(
        "--output-filename",
        default=None,
        help="输出 kg 文件名（默认 kg.json）",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = f"_{args.lecture_id}" if args.lecture_id else ""
    default_log = ROOT / "data" / "logs" / f"stage2_{args.course_id}{suffix}_{timestamp}.log"
    log_file = Path(args.log_file) if args.log_file else default_log
    setup_logging(args.log_level, log_file)

    logger = logging.getLogger(__name__)
    logger.info("Course ID: %s, Lecture ID: %s", args.course_id, args.lecture_id or "all")

    config = TeachKGConfig.from_yaml(args.config)
    pipeline = Stage2KGPipeline(config, project_root=ROOT)
    if args.force:
        pipeline.use_existing = False

    try:
        kg_path = pipeline.run(
            args.course_id,
            lecture_id=args.lecture_id,
            force=args.force,
            input_filename=args.input_filename,
            output_filename=args.output_filename,
        )
        logger.info("Knowledge graph saved to: %s", kg_path)
        print(f"Knowledge graph saved to: {kg_path}")
        print(f"Log saved to: {log_file}")
    except Exception:
        logger.exception("Stage 2 pipeline failed")
        raise


if __name__ == "__main__":
    main()
