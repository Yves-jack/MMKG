#!/usr/bin/env python
"""构建课程学科方法资产库（定理 / 原理 / 技术）。

示例：
  python scripts/teaching/build_assets_library.py --course-id 数理逻辑
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.assets.build import build_asset_library, write_library
from teachkg.config import TeachKGConfig

logger = logging.getLogger("build_assets_library")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", default="数理逻辑")
    p.add_argument(
        "--curated",
        default=None,
        help="curated_seed.json 路径；默认 data/kg/{course}/assets/curated_seed.json",
    )
    p.add_argument(
        "--out",
        default=None,
        help="输出 library.json；默认 data/kg/{course}/assets/library.json",
    )
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    cfg = TeachKGConfig.from_yaml(args.config)
    tb_path = Path(
        (cfg.get("stage1", "textbook_kg") or {}).get(
            "path", "data/textbook/CS2501-离散数学（数理逻辑与集合论）"
        )
    )
    if not tb_path.is_absolute():
        tb_path = ROOT / tb_path

    assets_dir = ROOT / "data" / "kg" / args.course_id / "assets"
    curated = Path(args.curated) if args.curated else assets_dir / "curated_seed.json"
    out = Path(args.out) if args.out else assets_dir / "library.json"
    kg_dir = Path(cfg.get("project", "kg_dir", default="data/kg"))
    if not kg_dir.is_absolute():
        kg_dir = ROOT / kg_dir

    library = build_asset_library(
        course_id=args.course_id,
        textbook_path=tb_path,
        curated_path=curated if curated.is_file() else None,
        kg_dir=kg_dir,
    )
    write_library(library, out)
    stats = library.to_dict()["stats"]
    logger.info("Wrote %s cards=%d stats=%s", out, len(library.cards), stats)
    print(f"Wrote {out} ({len(library.cards)} cards)")
    print(f"stats: {stats}")


if __name__ == "__main__":
    main()
