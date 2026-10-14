#!/usr/bin/env python3
"""去掉本学期未讲的章（无讲次 / 仅教材空壳），重拼课总图与 index，并同步 showcase。"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.textbook_kg.mindmap_pipeline import (
    build_course_from_chapters,
    chapter_file_slug,
    update_mindmap_index,
)

COURSE = "离散数学(图论+数理逻辑与集合论)"


def is_taught_chapter(doc: dict) -> bool:
    meta = doc.get("meta") or {}
    if meta.get("lecture_ids"):
        return True
    if meta.get("pipeline") == "textbook_toc_entities":
        return False
    if meta.get("skeleton_source") == "textbook_toc":
        return False
    if meta.get("empty"):
        return False
    if int(doc.get("n_nodes") or 0) <= 1:
        return False
    if not ((doc.get("root") or {}).get("children") or []):
        return False
    return True


def main() -> int:
    out_dir = ROOT / "data/viz" / COURSE / "mindmaps"
    sum_dirs = [
        ROOT / "data/viz" / COURSE / "summaries",
        ROOT / "web/teachkg-showcase/public/data/courses" / COURSE / "summaries",
    ]
    cat_path = ROOT / "data/viz" / COURSE / "chapter_catalog.json"
    if not cat_path.is_file():
        cat_path = (
            ROOT
            / "data/textbook/CS2501-离散数学（图论+数理逻辑与集合论）/chapter_catalog.json"
        )
    cat = json.loads(cat_path.read_text(encoding="utf-8"))

    kept: list[tuple[str, dict]] = []
    removed: list[str] = []
    for path in sorted(out_dir.glob("chapter_*.json")):
        if path.name.endswith(".prev.json"):
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        ch = (doc.get("meta") or {}).get("chapter") or path.stem
        if is_taught_chapter(doc):
            kept.append((ch, doc))
            continue
        removed.append(str(ch))
        path.unlink(missing_ok=True)
        slug = chapter_file_slug(str(ch))
        for base in sum_dirs:
            sp = base / f"chapter_{slug}.json"
            if sp.is_file():
                sp.unlink()
        print("removed", ch)

    taught = {ch for ch, _ in kept}
    slim_parts = []
    for part in cat.get("parts") or []:
        if not isinstance(part, dict):
            continue
        chs = []
        for ch in part.get("chapters") or []:
            name = ch.get("name") if isinstance(ch, dict) else str(ch)
            if name in taught:
                chs.append(ch if isinstance(ch, dict) else {"name": name})
        if chs:
            slim_parts.append({**part, "chapters": chs})
    slim_cat = {
        **cat,
        "parts": slim_parts,
        "chapter_order": [c for c in (cat.get("chapter_order") or []) if c in taught],
    }

    course_doc = build_course_from_chapters(
        "离散数学", kept, catalog=slim_cat, max_chapter_depth=2
    )
    (out_dir / "course.json").write_text(
        json.dumps(course_doc, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    index_path = out_dir / "index.json"
    index = (
        json.loads(index_path.read_text(encoding="utf-8"))
        if index_path.is_file()
        else {"courseId": COURSE, "title": "思维导图", "items": []}
    )
    non_ch = [
        it
        for it in (index.get("items") or [])
        if it.get("scope") not in ("chapter", "course")
        and str(it.get("lecture_id") or "") not in ("course",)
        and not str(it.get("lecture_id") or "").startswith("chapter:")
        and str(it.get("chapter") or "") not in removed
    ]
    index["items"] = non_ch
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    upserts = [
        {
            "lecture_id": f"chapter:{ch}",
            "chapter": ch,
            "chapter_id": ch,
            "root_zh": (doc.get("meta") or {}).get("root_zh"),
            "n_nodes": doc.get("n_nodes"),
            "max_depth": doc.get("max_depth"),
            "orphan_count": doc.get("orphan_count") or 0,
            "path": f"mindmaps/chapter_{chapter_file_slug(ch)}.json",
            "scope": "chapter",
            "lecture_ids": (doc.get("meta") or {}).get("lecture_ids") or [],
            "source": (doc.get("meta") or {}).get("source") or "kg",
        }
        for ch, doc in kept
    ]
    upserts.append(
        {
            "lecture_id": "course",
            "chapter": "离散数学",
            "root_zh": "离散数学",
            "n_nodes": course_doc.get("n_nodes"),
            "max_depth": course_doc.get("max_depth"),
            "orphan_count": 0,
            "path": "mindmaps/course.json",
            "scope": "course",
            "source": "kg",
        }
    )
    update_mindmap_index(index_path, course_id=COURSE, items_upsert=upserts)

    dst = ROOT / "web/teachkg-showcase/public/data/courses" / COURSE
    mind_dst = dst / "mindmaps"
    mind_dst.mkdir(parents=True, exist_ok=True)
    for ch in removed:
        p = mind_dst / f"chapter_{chapter_file_slug(ch)}.json"
        if p.is_file():
            p.unlink()
            print("sync-remove", p.name)
    for name in ("course.json", "index.json"):
        shutil.copy2(out_dir / name, mind_dst / name)
    for ch, _doc in kept:
        slug = chapter_file_slug(ch)
        shutil.copy2(out_dir / f"chapter_{slug}.json", mind_dst / f"chapter_{slug}.json")
    shutil.copy2(index_path, dst / "mindmap_showcase.json")

    print(f"kept {len(kept)}, removed {len(removed)}: {removed}")
    for c in (course_doc.get("root") or {}).get("children") or []:
        print(
            " ",
            c.get("zh"),
            "→",
            [x.get("zh") for x in (c.get("children") or [])],
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
