#!/usr/bin/env python
"""对 assets/library.json 卡片做嵌入分章，写回 chapters + index_by_chapter。

  python scripts/teaching/assign_assets_chapters.py \\
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

from teachkg.assets.chapter_assign import assign_card_chapters
from teachkg.assets.schema import AssetCard, AssetLibrary
from teachkg.textbook_kg.loader import TextbookKG
from teachkg.utils.env import load_project_env

logger = logging.getLogger("assign_assets_chapters")


def _chapter_entities(tb: TextbookKG) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    by_ch = getattr(tb, "importance_by_chapter", None) or {}
    for ch, scores in by_ch.items():
        if not isinstance(scores, dict):
            continue
        # 取章内重要性靠前的实体名
        ranked = sorted(
            ((str(n), float(s)) for n, s in scores.items()),
            key=lambda x: x[1],
            reverse=True,
        )
        names = []
        for n, _ in ranked[:50]:
            zh = n.split("/", 1)[0].strip()
            if zh:
                names.append(zh)
        out[str(ch)] = list(dict.fromkeys(names))
    return out


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching_lisan.yaml"))
    p.add_argument("--course-id", default="离散数学(图论+数理逻辑与集合论)")
    p.add_argument("--library", default=None, help="默认 data/kg/<course>/assets/library.json")
    p.add_argument("--top-k", type=int, default=2)
    p.add_argument("--min-sim", type=float, default=0.28)
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    load_project_env()
    course = args.course_id
    lib_path = Path(args.library) if args.library else ROOT / "data" / "kg" / course / "assets" / "library.json"
    if not lib_path.is_file():
        logger.error("missing library: %s", lib_path)
        return 1

    yml = yaml.safe_load(Path(args.config).read_text(encoding="utf-8")) or {}
    tb_cfg = ((yml.get("stage1") or {}).get("textbook_kg") or {})
    lecture_map = tb_cfg.get("lecture_chapter_map") or {}
    tb_path = Path(tb_cfg.get("path") or "")
    if not tb_path.is_absolute():
        tb_path = ROOT / tb_path

    chapter_order: list[str] = []
    chapter_entities: dict[str, list[str]] = {}
    if tb_path.is_dir():
        tb = TextbookKG.load(
            tb_path,
            entity_file=tb_cfg.get("entity_file", "entity_final.json"),
            relations_file=tb_cfg.get("relations_file", "relations_final.json"),
            importance_file=tb_cfg.get("importance_file", "entity_sorted_ppr.json"),
            importance_bundle_file=tb_cfg.get("importance_bundle_file"),
        )
        chapter_order = list(tb.chapter_order or [])
        chapter_entities = _chapter_entities(tb)

    # 优先用 toc 分册目录的 chapter_order（区分两个「第1章」）
    from teachkg.textbook_kg.chapter_catalog import build_chapter_catalog

    catalog = None
    if tb_path.is_dir():
        catalog = build_chapter_catalog(
            textbook_dir=tb_path,
            toc_path=tb_path / "toc.md",
            course_id=course,
            repo_root=ROOT,
        )
        if catalog.get("chapter_order"):
            chapter_order = list(catalog["chapter_order"])
            (tb_path / "chapter_catalog.json").write_text(
                json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
    if not chapter_order:
        seen: list[str] = []
        for v in lecture_map.values():
            if isinstance(v, list):
                seen.extend(str(x) for x in v)
            elif v:
                seen.append(str(v))
        chapter_order = list(dict.fromkeys(seen))

    raw = json.loads(lib_path.read_text(encoding="utf-8"))
    cards = [AssetCard.from_dict(r) for r in (raw.get("cards") or []) if isinstance(r, dict)]
    stats = assign_card_chapters(
        cards,
        chapter_order=chapter_order,
        lecture_chapter_map=lecture_map,
        chapter_entities=chapter_entities,
        top_k=int(args.top_k),
        min_sim=float(args.min_sim),
        model_name=((tb_cfg.get("subgraph") or {}).get("embedder_model") or "shibing624/text2vec-base-multilingual"),
    )
    logger.info("assign stats: %s", stats)

    library = AssetLibrary(
        course_id=str(raw.get("course_id") or course),
        cards=cards,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        stats={
            **(raw.get("stats") or {}),
            "chapter_assign": stats,
            "chapter_catalog": {
                "n_parts": (catalog or {}).get("n_parts"),
                "n_chapters": (catalog or {}).get("n_chapters"),
            },
        },
    )
    payload = library.to_dict()
    if catalog:
        payload["chapter_catalog"] = catalog
    lib_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    idx = library.to_dict().get("index_by_chapter") or {}
    print(f"Wrote {lib_path} cards={len(cards)} chapters_indexed={len(idx)}")
    for ch, aids in list(idx.items())[:20]:
        print(f"  {ch}: {len(aids)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
