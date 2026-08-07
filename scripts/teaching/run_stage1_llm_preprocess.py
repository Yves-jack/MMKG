#!/usr/bin/env python
"""Stage1：轻规则 + LLM 预处理，仅跑指定讲次（默认 1、17）。"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.stage1_alignment.pipeline import Stage1PreparePipeline


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "configs/teaching.yaml"))
    parser.add_argument("--course-id", default="shuliluoji")
    parser.add_argument("--lecture-id", action="append", dest="lecture_ids", default=None)
    parser.add_argument("--force", action="store_true", default=True)
    args = parser.parse_args()
    lecture_ids = [str(x) for x in (args.lecture_ids or ["1", "17"])]

    log_file = ROOT / "data" / "logs" / f"stage1_llm_pre_{args.course_id}_{datetime.now():%Y%m%d_%H%M%S}.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        handlers=[
            logging.FileHandler(log_file, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )

    cfg = TeachKGConfig.from_yaml(args.config)
    s1 = cfg.raw.setdefault("stage1", {})
    s1.setdefault("textbook_kg", {})["enabled"] = True
    s1.setdefault("llm_only", {})["sync_active_triplets"] = False
    tp = s1.setdefault("text_preprocess", {})
    rules = tp.setdefault("rules", {})
    # 语义过滤交给 LLM；规则只清版式
    rules["remove_non_knowledge"] = False
    rules["remove_classroom_admin"] = False
    rules["remove_markdown_noise"] = True
    rules["remove_example_labels"] = True
    rules["dedupe_paragraphs"] = True
    llm = tp.setdefault("llm", {})
    llm["enabled"] = True

    pipeline = Stage1PreparePipeline(cfg, project_root=ROOT, mock=False)
    pipeline.use_existing = False
    out = pipeline.run(args.course_id, lecture_ids=lecture_ids)
    print("filtered_cues:", out)
    print("log:", log_file)


if __name__ == "__main__":
    main()
