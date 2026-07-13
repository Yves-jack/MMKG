#!/usr/bin/env python
"""Stage 0: 教学长视频语义切片。"""

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
from teachkg.stage0_segmentation.slicer import VideoSlicer


def setup_logging(log_level: str, log_file: Path) -> Path:
    """配置根 logger：所有模块日志写入同一文件，并同步输出到控制台。"""
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

    for name in ("httpx", "httpcore", "openai", "urllib3"):
        logging.getLogger(name).setLevel(max(level, logging.WARNING))

    return log_file


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage 0: teaching video semantic segmentation")
    parser.add_argument(
        "--config",
        default=str(ROOT / "configs" / "teaching.yaml"),
        help="Path to teaching.yaml",
    )
    parser.add_argument(
        "--workspace",
        required=True,
        help="Course workspace root (contains video/class and video/ppt)",
    )
    parser.add_argument(
        "--course-id",
        default=None,
        help="Course identifier (default: workspace folder name)",
    )
    parser.add_argument(
        "--log-file",
        default=None,
        help="Unified log file path (default: data/logs/stage0_<course>_<timestamp>.log)",
    )
    parser.add_argument(
        "--lecture-id",
        action="append",
        dest="lecture_ids",
        help="仅处理指定讲次（可重复指定）；省略则处理全部",
    )
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workspace = Path(args.workspace).resolve()
    course_id = args.course_id or workspace.name
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    default_log = ROOT / "data" / "logs" / f"stage0_{course_id}_{timestamp}.log"
    log_file = Path(args.log_file) if args.log_file else default_log
    log_file = setup_logging(args.log_level, log_file)

    logger = logging.getLogger(__name__)
    logger.info("Log file: %s", log_file)
    logger.info("Workspace: %s", workspace)
    logger.info("Course ID: %s", course_id)

    try:
        config = TeachKGConfig.from_yaml(args.config)
        slicer = VideoSlicer(config)
        out_path = slicer.run_workspace(
            workspace,
            course_id=course_id,
            lecture_ids=args.lecture_ids,
        )
        logger.info("Cues saved to: %s", out_path)
        print(f"Cues saved to: {out_path}")
        print(f"Log saved to: {log_file}")
    except Exception:
        logger.exception("Stage 0 pipeline failed")
        raise


if __name__ == "__main__":
    main()
