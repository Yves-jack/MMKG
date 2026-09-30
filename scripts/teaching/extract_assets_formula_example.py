#!/usr/bin/env python
"""从 asr_text 抽取公式/例子（不用 preprocess 后的 extract_text，那里已删例子）。

  python scripts/teaching/extract_assets_formula_example.py --course-id 数理逻辑 --lectures 1
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
from teachkg.assets.formula_quality import keep_generic_formulas
from teachkg.assets.llm_extract import extract_formula_example_for_lecture
from teachkg.assets.schema import AssetCard
from teachkg.config import TeachKGConfig
from teachkg.utils.env import load_project_env

logger = logging.getLogger("extract_formula_example")


def _refilter_caches(assets_dir: Path, course: str) -> list[AssetCard]:
    """按通式规则重过滤已有 lecture cache，并重挂抽象层，不调 LLM。"""
    from teachkg.assets.relink import relink_library_cards

    out: list[AssetCard] = []
    for path in sorted(assets_dir.glob("llm_assets_formula_example_lecture_*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        before = [AssetCard.from_dict(row) for row in (raw.get("assets") or []) if isinstance(row, dict)]
        after = keep_generic_formulas(before)
        relink_library_cards(after, ROOT / "data" / "kg", course)
        raw["assets"] = [c.to_dict() for c in after]
        raw["filter"] = "generic_formula"
        path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
        n_form_b = sum(1 for c in before if c.kind == "formula")
        n_form_a = sum(1 for c in after if c.kind == "formula")
        logger.info("refilter %s formula %d → %d (cards %d → %d)", path.name, n_form_b, n_form_a, len(before), len(after))
        out.extend(after)
    return out


def _cues_path(course: str) -> Path:
    for p in (
        ROOT / "data" / "pretty_view" / "processed" / course / "filtered_cues.json",
        ROOT / "data" / "pretty_view" / "segments" / course / "cues.json",
        ROOT / "data" / "processed" / course / "filtered_cues.json",
    ):
        if p.is_file():
            return p
    return ROOT / "data" / "pretty_view" / "processed" / course / "filtered_cues.json"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", default="数理逻辑")
    p.add_argument("--lectures", default="1")
    p.add_argument("--no-textbook-theorems", action="store_true", default=True)
    p.add_argument("--refilter-only", action="store_true", help="不调 LLM，按通式规则重过滤已有 cache")
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
    lectures = [x.strip() for x in str(args.lectures).split(",") if x.strip()]
    llm_cfg = {}
    yml = Path(args.config)
    if yml.is_file():
        llm_cfg = (yaml.safe_load(yml.read_text(encoding="utf-8")) or {}).get("llm") or {}

    assets_dir = ROOT / "data" / "kg" / course / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    prev_lib = assets_dir / "library.json"
    keep: list[AssetCard] = []
    if prev_lib.is_file():
        raw_lib = json.loads(prev_lib.read_text(encoding="utf-8"))
        for row in raw_lib.get("cards") or []:
            if not isinstance(row, dict):
                continue
            card = AssetCard.from_dict(row)
            if card.kind not in {"formula", "example"}:
                keep.append(card)

    new_cards: list[AssetCard] = []
    if args.refilter_only:
        new_cards = _refilter_caches(assets_dir, course)
    else:
        cues_path = _cues_path(course)
        if not cues_path.is_file():
            logger.error("missing cues: %s", cues_path)
            return 1
        extracted: set[str] = set()
        for lec in lectures:
            kg_path = ROOT / "data" / "kg" / course / f"lecture_{lec}" / "kg.json"
            if not kg_path.is_file():
                logger.warning("skip L%s missing kg", lec)
                continue
            cards = extract_formula_example_for_lecture(
                course_id=course,
                lecture_id=str(lec),
                cues_path=cues_path,
                lecture_kg_path=kg_path,
                llm_cfg=llm_cfg,
                course_context=course,
            )
            cache = assets_dir / f"llm_assets_formula_example_lecture_{lec}.json"
            cache.write_text(
                json.dumps(
                    {
                        "lecture_id": lec,
                        "source": "asr_text",
                        "assets": [c.to_dict() for c in cards],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            logger.info("wrote %s (%d)", cache, len(cards))
            new_cards.extend(cards)
            extracted.add(str(lec))
        for path in sorted(assets_dir.glob("llm_assets_formula_example_lecture_*.json")):
            lec = path.stem.rsplit("_", 1)[-1]
            if lec in extracted:
                continue
            raw = json.loads(path.read_text(encoding="utf-8"))
            new_cards.extend(
                keep_generic_formulas(
                    [
                        AssetCard.from_dict(row)
                        for row in (raw.get("assets") or [])
                        if isinstance(row, dict)
                    ]
                )
            )

    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    textbook_path = ROOT / tb.get("path", "data/textbook/CS2501-离散数学（数理逻辑与集合论）")
    curated = assets_dir / "curated_seed.json"
    lib = build_asset_library(
        course_id=course,
        textbook_path=textbook_path,
        curated_path=curated if curated.is_file() else None,
        kg_dir=ROOT / "data" / "kg",
        llm_cards=keep + new_cards,
        include_textbook_theorems=not args.no_textbook_theorems,
    )
    out = assets_dir / "library.json"
    write_library(lib, out)
    logger.info("library → %s cards=%d", out, len(lib.cards))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
