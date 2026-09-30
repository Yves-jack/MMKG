#!/usr/bin/env python
"""用大模型从课堂片段抽取定理/原理/方法（含原文依据），重叠关联实体后写入资产库。

示例：
  python scripts/teaching/extract_assets_llm.py --course-id 数理逻辑 --lecture 1
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import yaml

from teachkg.assets.build import build_asset_library, write_library
from teachkg.assets.llm_extract import extract_assets_for_lecture
from teachkg.config import TeachKGConfig
from teachkg.utils.env import load_project_env

logger = logging.getLogger("extract_assets_llm")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", default="数理逻辑")
    p.add_argument("--lecture", default="1")
    p.add_argument(
        "--cues",
        default="",
        help="filtered_cues.json；默认 pretty_view/processed/{course}/filtered_cues.json",
    )
    p.add_argument(
        "--lecture-kg",
        default="",
        help="讲次 kg.json；默认 data/kg/{course}/lecture_{N}/kg.json",
    )
    p.add_argument(
        "--no-textbook-theorems",
        action="store_true",
        help="不合并教材 theorems（仅 LLM + curated）",
    )
    p.add_argument("--min-overlap", type=float, default=0.22)
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    load_project_env()
    cfg = TeachKGConfig.from_yaml(args.config)
    course = args.course_id
    lecture = str(args.lecture)

    cues_path = Path(
        args.cues
        or ROOT / "data" / "pretty_view" / "processed" / course / "filtered_cues.json"
    )
    if not cues_path.is_file():
        alt = ROOT / "data" / "processed" / course / "filtered_cues.json"
        cues_path = alt if alt.is_file() else cues_path
    kg_path = Path(
        args.lecture_kg
        or ROOT / "data" / "kg" / course / f"lecture_{lecture}" / "kg.json"
    )
    if not cues_path.is_file():
        logger.error("missing cues: %s", cues_path)
        return 1
    if not kg_path.is_file():
        logger.error("missing lecture kg: %s", kg_path)
        return 1

    llm_cfg = {}
    yml = ROOT / "configs" / "teaching.yaml"
    if yml.is_file():
        llm_cfg = (yaml.safe_load(yml.read_text(encoding="utf-8")) or {}).get("llm") or {}

    llm_cards = extract_assets_for_lecture(
        course_id=course,
        lecture_id=lecture,
        cues_path=cues_path,
        lecture_kg_path=kg_path,
        llm_cfg=llm_cfg,
        course_context=course,
        min_overlap=float(args.min_overlap),
    )

    # 缓存本讲 LLM 结果
    assets_dir = ROOT / "data" / "kg" / course / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    llm_cache = assets_dir / f"llm_assets_lecture_{lecture}.json"
    llm_cache.write_text(
        json.dumps(
            {
                "course_id": course,
                "lecture_id": lecture,
                "count": len(llm_cards),
                "cards": [c.to_dict() for c in llm_cards],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    logger.info("wrote %s (%d)", llm_cache, len(llm_cards))

    # 合并已有各讲 LLM 缓存
    all_llm: list = []
    for p in sorted(assets_dir.glob("llm_assets_lecture_*.json")):
        try:
            payload = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        from teachkg.assets.schema import AssetCard

        for row in payload.get("cards") or []:
            if isinstance(row, dict):
                all_llm.append(AssetCard.from_dict(row))

    tb_path = Path(
        (cfg.get("stage1", "textbook_kg") or {}).get(
            "path", "data/textbook/CS2501-离散数学（数理逻辑与集合论）"
        )
    )
    if not tb_path.is_absolute():
        tb_path = ROOT / tb_path
    curated = assets_dir / "curated_seed.json"
    kg_dir = Path(cfg.get("project", "kg_dir", default="data/kg"))
    if not kg_dir.is_absolute():
        kg_dir = ROOT / kg_dir

    library = build_asset_library(
        course_id=course,
        textbook_path=tb_path,
        curated_path=curated if curated.is_file() else None,
        kg_dir=kg_dir,
        llm_cards=all_llm,
        include_textbook_theorems=not args.no_textbook_theorems,
    )
    out = assets_dir / "library.json"
    write_library(library, out)
    print(f"Wrote {out} cards={len(library.cards)} stats={library.stats}")
    print(f"This lecture LLM assets: {len(llm_cards)} (cache {llm_cache})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
