#!/usr/bin/env python3
"""为目录中缺失的章导图，按 lecture_chapter_map 从讲次内容补全（无讲次层）。"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.textbook_kg.mindmap_pipeline import (
    build_course_from_chapters,
    build_or_update_chapter_doc,
    chapter_file_slug,
    forest_stats,
    iter_chapter_slices_from_lecture,
    strip_internal_fields,
    unwrap_lecture_to_topic_forest,
    update_mindmap_index,
    wrap_lecture_by_assignments,
)

COURSE = "离散数学(图论+数理逻辑与集合论)"


def _as_list(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [str(v).strip()] if str(v).strip() else []


def main() -> int:
    cfg = TeachKGConfig.from_yaml(ROOT / "configs" / "teaching_lisan.yaml")
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    lecture_map = tb.get("lecture_chapter_map") or {}

    out_dir = ROOT / "data/viz" / COURSE / "mindmaps"
    catalog = json.loads(
        (
            ROOT
            / "data/textbook/CS2501-离散数学（图论+数理逻辑与集合论）/chapter_catalog.json"
        ).read_text(encoding="utf-8")
    )

    # chapter -> lectures that map to it
    ch_to_lecs: dict[str, list[str]] = {}
    for lid, raw in lecture_map.items():
        for ch in _as_list(raw):
            ch_to_lecs.setdefault(ch, []).append(str(lid))

    existing: set[str] = set()
    for p in out_dir.glob("chapter_*.json"):
        if p.name.endswith(".prev.json"):
            continue
        doc = json.loads(p.read_text(encoding="utf-8"))
        ch = (doc.get("meta") or {}).get("chapter")
        if ch:
            existing.add(ch)

    catalog_chapters: list[str] = []
    for part in catalog.get("parts") or []:
        for ch in part.get("chapters") or []:
            name = ch.get("name") if isinstance(ch, dict) else str(ch)
            if name:
                catalog_chapters.append(name)

    upserts: list[dict] = []
    synced: list[str] = []

    for chapter in catalog_chapters:
        if chapter in existing:
            # 仍清洗可能残留的讲次枝
            slug = chapter_file_slug(chapter)
            path = out_dir / f"chapter_{slug}.json"
            doc = json.loads(path.read_text(encoding="utf-8"))
            root = doc.get("root") or {}
            kids = root.get("children") or []
            if any(str(c.get("id") or "").startswith("__lecture__/") for c in kids):
                flat_doc = None
                for c in kids:
                    if str(c.get("id") or "").startswith("__lecture__/"):
                        lid = str(c["id"]).split("/", 1)[-1]
                        flat_doc = build_or_update_chapter_doc(
                            chapter,
                            existing=flat_doc,
                            subtrees=list(c.get("children") or []),
                            lecture_id=lid,
                        )
                    else:
                        flat_doc = build_or_update_chapter_doc(
                            chapter,
                            existing=flat_doc,
                            subtrees=[c],
                            lecture_id="0",
                        )
                if flat_doc:
                    flat_doc["root"] = strip_internal_fields(flat_doc["root"])
                    flat_doc["roots"] = [flat_doc["root"]]
                    path.write_text(
                        json.dumps(flat_doc, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                    print("flattened lecture branches:", chapter)
                    synced.append(path.name)
            continue

        lids = ch_to_lecs.get(chapter) or []
        ch_doc = None
        used: list[str] = []
        for lid in lids:
            lec_path = out_dir / f"lecture_{lid}.json"
            assign_path = out_dir / f"lecture_{lid}.assign.json"
            if not lec_path.is_file():
                print(f"  skip L{lid}: no lecture json for {chapter}")
                continue
            lec = json.loads(lec_path.read_text(encoding="utf-8"))
            slices = dict(iter_chapter_slices_from_lecture(lec))
            subtrees = slices.get(chapter)
            if not subtrees:
                # 映射章与 assign 不一致：强制把本讲主题森林收进目标章
                forest = unwrap_lecture_to_topic_forest(lec)
                if not forest:
                    continue
                forced = [
                    {
                        "subtree_root_id": str(t.get("id") or ""),
                        "chapter": chapter,
                        "confidence": 1.0,
                        "reason": "map_force_fill",
                    }
                    for t in forest
                    if t.get("id") and not str(t.get("id")).startswith("__")
                ]
                flat = {
                    **lec,
                    "roots": forest,
                    "root": forest[0] if forest else None,
                }
                wrapped = wrap_lecture_by_assignments(
                    flat,
                    lecture_id=str(lid),
                    assignments=forced,
                    chapter_hint=chapter,
                )
                # 回写讲次导图，使讲次视图也挂到正确章下
                lec_path.write_text(
                    json.dumps(wrapped, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                synced.append(lec_path.name)
                if assign_path.is_file() or True:
                    assign_path.write_text(
                        json.dumps(
                            {
                                "lecture_id": str(lid),
                                "candidates": [chapter],
                                "assignments": forced,
                            },
                            ensure_ascii=False,
                            indent=2,
                        ),
                        encoding="utf-8",
                    )
                    synced.append(assign_path.name)
                slices = dict(iter_chapter_slices_from_lecture(wrapped))
                subtrees = slices.get(chapter) or unwrap_lecture_to_topic_forest(wrapped)
                print(
                    f"  L{lid}: force-wrap → {chapter} tops={len(subtrees or [])}"
                )
            ch_doc = build_or_update_chapter_doc(
                chapter,
                existing=ch_doc,
                subtrees=subtrees or [],
                lecture_id=str(lid),
            )
            used.append(str(lid))

        if not ch_doc or not (ch_doc.get("root") or {}).get("children"):
            # 空骨架
            bare = chapter
            import re

            bare = re.sub(r"^第\s*\d+\s*章\s*", "", chapter).strip() or chapter
            root = {
                "id": f"__chapter__/{bare}",
                "zh": chapter,
                "importance": 0.5,
                "relation": None,
                "related": [],
                "children": [],
            }
            ch_doc = {
                "lecture_id": f"chapter:{chapter}",
                "root": root,
                "roots": [root],
                "n_nodes": 1,
                "max_depth": 0,
                "orphan_count": 0,
                "meta": {
                    "chapter": chapter,
                    "root_zh": bare,
                    "virtual_root": True,
                    "scope": "chapter",
                    "lecture_ids": used,
                    "pipeline": "lecture_assign_merge",
                    "stitch": "entity_merge",
                    "source": "kg",
                    "empty": True,
                },
            }
            print(f"empty skeleton: {chapter} (mapped lectures={lids})")
        else:
            ch_doc["root"] = strip_internal_fields(ch_doc["root"])
            ch_doc["roots"] = [ch_doc["root"]]
            n, d = forest_stats([ch_doc["root"]])
            ch_doc["n_nodes"], ch_doc["max_depth"] = n, d
            print(f"filled {chapter}: n={n} from L{used}")

        slug = chapter_file_slug(chapter)
        path = out_dir / f"chapter_{slug}.json"
        path.write_text(json.dumps(ch_doc, ensure_ascii=False, indent=2), encoding="utf-8")
        synced.append(path.name)
        upserts.append(
            {
                "lecture_id": f"chapter:{chapter}",
                "chapter": chapter,
                "chapter_id": chapter,
                "root_zh": (ch_doc.get("meta") or {}).get("root_zh"),
                "n_nodes": ch_doc.get("n_nodes"),
                "max_depth": ch_doc.get("max_depth"),
                "orphan_count": 0,
                "path": f"mindmaps/chapter_{slug}.json",
                "scope": "chapter",
                "lecture_ids": (ch_doc.get("meta") or {}).get("lecture_ids") or used,
                "source": "kg",
            }
        )

    # rebuild course
    chapter_docs = []
    for p in sorted(out_dir.glob("chapter_*.json")):
        if p.name.endswith(".prev.json"):
            continue
        doc = json.loads(p.read_text(encoding="utf-8"))
        if (doc.get("meta") or {}).get("pipeline") not in (
            "lecture_assign_merge",
            None,
        ) and (doc.get("meta") or {}).get("scope") != "chapter":
            continue
        ch = (doc.get("meta") or {}).get("chapter")
        if ch:
            chapter_docs.append((ch, doc))

    course_doc = build_course_from_chapters(
        "离散数学", chapter_docs, catalog=catalog, max_chapter_depth=2
    )
    (out_dir / "course.json").write_text(
        json.dumps(course_doc, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    synced.append("course.json")

    index_path = out_dir / "index.json"
    update_mindmap_index(index_path, course_id=COURSE, items_upsert=upserts)
    synced.append("index.json")

    dst = ROOT / "web/teachkg-showcase/public/data/courses" / COURSE / "mindmaps"
    dst.mkdir(parents=True, exist_ok=True)
    for name in synced:
        s = out_dir / name
        if s.is_file():
            shutil.copy2(s, dst / name)
            print("sync", name)
    shutil.copy2(index_path, ROOT / "web/teachkg-showcase/public/data/courses" / COURSE / "mindmap_showcase.json")
    print("done, course chapters", course_doc.get("meta"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
