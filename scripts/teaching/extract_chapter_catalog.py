#!/usr/bin/env python
"""从教材 toc 提取分主题章节目录，写入 textbook/chapter_catalog.json，
并注入 assets/library.json（若存在），便于资产库 / 导图规划与展示排序。

  python scripts/teaching/extract_chapter_catalog.py \\
    --config configs/teaching_lisan.yaml \\
    --course-id 离散数学(图论+数理逻辑与集合论)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.textbook_kg.chapter_catalog import build_chapter_catalog

logger = logging.getLogger("extract_chapter_catalog")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching_lisan.yaml"))
    p.add_argument("--course-id", default="离散数学(图论+数理逻辑与集合论)")
    p.add_argument(
        "--textbook-dir",
        default=None,
        help="默认读 config stage1.textbook_kg.path",
    )
    p.add_argument(
        "--library",
        default=None,
        help="可选：写入 chapter_catalog 到 assets/library.json",
    )
    p.add_argument(
        "--showcase",
        action="store_true",
        help="同步写入 web/teachkg-showcase/public/data/courses/<id>/",
    )
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    yml = yaml.safe_load(Path(args.config).read_text(encoding="utf-8")) or {}
    tb_cfg = ((yml.get("stage1") or {}).get("textbook_kg") or {})
    tb_path = Path(args.textbook_dir) if args.textbook_dir else Path(tb_cfg.get("path") or "")
    if not tb_path.is_absolute():
        tb_path = ROOT / tb_path
    if not tb_path.is_dir():
        logger.error("textbook dir missing: %s", tb_path)
        return 1

    # 解析 merge_meta 里的相对路径时，相对仓库根
    meta = None
    meta_path = tb_path / "merge_meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        fixed = []
        for rel in meta.get("merged_from") or []:
            p = Path(rel)
            if not p.is_absolute():
                p = ROOT / rel
            fixed.append(str(p))
        meta = {**meta, "merged_from": fixed}

    catalog = build_chapter_catalog(
        textbook_dir=tb_path,
        toc_path=tb_path / "toc.md",
        merge_meta=meta,
        course_id=args.course_id,
        repo_root=ROOT,
    )
    catalog["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    out_tb = tb_path / "chapter_catalog.json"
    out_tb.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    logger.info(
        "wrote %s parts=%s chapters=%s",
        out_tb,
        catalog.get("n_parts"),
        catalog.get("n_chapters"),
    )
    for part in catalog.get("parts") or []:
        logger.info(
            "  [%s] %s · %s 章",
            part.get("id"),
            part.get("title"),
            len(part.get("chapters") or []),
        )

    lib_path = (
        Path(args.library)
        if args.library
        else ROOT / "data" / "kg" / args.course_id / "assets" / "library.json"
    )
    if lib_path.is_file():
        raw = json.loads(lib_path.read_text(encoding="utf-8"))
        raw["chapter_catalog"] = catalog
        stats = dict(raw.get("stats") or {})
        stats["chapter_catalog"] = {
            "n_parts": catalog.get("n_parts"),
            "n_chapters": catalog.get("n_chapters"),
        }
        raw["stats"] = stats
        lib_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        logger.info("injected chapter_catalog → %s", lib_path)

    if args.showcase:
        course_out = (
            ROOT
            / "web"
            / "teachkg-showcase"
            / "public"
            / "data"
            / "courses"
            / args.course_id
        )
        course_out.mkdir(parents=True, exist_ok=True)
        (course_out / "chapter_catalog.json").write_text(
            json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        assets_lib = course_out / "assets_library.json"
        if assets_lib.is_file():
            raw = json.loads(assets_lib.read_text(encoding="utf-8"))
            raw["chapter_catalog"] = catalog
            assets_lib.write_text(
                json.dumps(raw, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            logger.info("updated showcase assets_library.json")
        # mirror default public/data
        pub = ROOT / "web" / "teachkg-showcase" / "public" / "data"
        (pub / "chapter_catalog.json").write_text(
            json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        pub_assets = pub / "assets_library.json"
        if pub_assets.is_file():
            raw = json.loads(pub_assets.read_text(encoding="utf-8"))
            raw["chapter_catalog"] = catalog
            pub_assets.write_text(
                json.dumps(raw, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        logger.info("mirrored → %s", pub)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
