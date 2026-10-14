"""从 lecture_*.assign.json 回填章导图 meta.lecture_ids，并重拼课总图 / index。"""

from __future__ import annotations

import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from teachkg.textbook_kg.mindmap_pipeline import (
    build_course_from_chapters,
    chapter_file_slug,
    update_mindmap_index,
)

COURSE = "离散数学(图论+数理逻辑与集合论)"


def main() -> None:
    mm = ROOT / "data/viz" / COURSE / "mindmaps"
    by_ch: dict[str, set[str]] = defaultdict(set)
    for p in mm.glob("lecture_*.assign.json"):
        d = json.loads(p.read_text(encoding="utf-8"))
        lid = str(d.get("lecture_id") or "")
        if not lid:
            m = re.fullmatch(r"lecture_(\d+)\.assign\.json", p.name)
            lid = m.group(1) if m else ""
        for a in d.get("assignments") or []:
            ch = str(a.get("chapter") or "").strip()
            if ch and lid:
                by_ch[ch].add(lid)

    upserts: list[dict] = []
    chapter_docs: list[tuple[str, dict]] = []
    for chapter, lids in sorted(by_ch.items()):
        slug = chapter_file_slug(chapter)
        path = mm / f"chapter_{slug}.json"
        if not path.is_file():
            print("missing chapter file", path)
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        meta = dict(doc.get("meta") or {})
        ordered = sorted(lids, key=lambda x: int(x) if x.isdigit() else 999)
        meta["lecture_ids"] = ordered
        meta["pipeline"] = "lecture_assign_merge"
        meta["source"] = "kg"
        meta["chapter"] = chapter
        doc["meta"] = meta
        path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"patched {path.name}: {ordered}")
        chapter_docs.append((chapter, doc))
        upserts.append(
            {
                "lecture_id": f"chapter:{chapter}",
                "chapter": chapter,
                "chapter_id": chapter,
                "root_zh": meta.get("root_zh"),
                "n_nodes": doc.get("n_nodes"),
                "max_depth": doc.get("max_depth"),
                "orphan_count": doc.get("orphan_count") or 0,
                "path": f"mindmaps/chapter_{slug}.json",
                "scope": "chapter",
                "lecture_ids": ordered,
                "source": "kg",
            }
        )

    catalog_path = (
        ROOT
        / "data/textbook/CS2501-离散数学（图论+数理逻辑与集合论）/chapter_catalog.json"
    )
    catalog = json.loads(catalog_path.read_text(encoding="utf-8")) if catalog_path.is_file() else {}
    course_title = COURSE.split("(")[0].strip() or COURSE
    course_doc = build_course_from_chapters(
        course_title, chapter_docs, catalog=catalog, max_chapter_depth=2
    )
    (mm / "course.json").write_text(
        json.dumps(course_doc, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    upserts.append(
        {
            "lecture_id": "course",
            "chapter": course_title,
            "root_zh": course_title,
            "n_nodes": course_doc.get("n_nodes"),
            "max_depth": course_doc.get("max_depth"),
            "orphan_count": 0,
            "path": "mindmaps/course.json",
            "scope": "course",
            "source": "kg",
        }
    )

    # lecture items
    for p in sorted(
        mm.glob("lecture_*.json"),
        key=lambda x: int(x.stem.split("_")[1]) if x.stem.split("_")[1].isdigit() else 999,
    ):
        if not re.fullmatch(r"lecture_\d+\.json", p.name):
            continue
        doc = json.loads(p.read_text(encoding="utf-8"))
        lid = str(doc.get("lecture_id") or p.stem.split("_")[1])
        meta = doc.get("meta") or {}
        upserts.append(
            {
                "lecture_id": lid,
                "chapter": meta.get("chapter"),
                "chapter_id": meta.get("chapter"),
                "root_zh": meta.get("root_zh"),
                "n_nodes": doc.get("n_nodes"),
                "max_depth": doc.get("max_depth"),
                "orphan_count": doc.get("orphan_count"),
                "path": f"mindmaps/{p.name}",
                "scope": "lecture",
                "source": "kg",
            }
        )

    update_mindmap_index(mm / "index.json", course_id=COURSE, items_upsert=upserts)

    pub = ROOT / "web/teachkg-showcase/public/data/courses" / COURSE / "mindmaps"
    pub.mkdir(parents=True, exist_ok=True)
    for name in ["course.json", "index.json", *[f"chapter_{chapter_file_slug(c)}.json" for c in by_ch]]:
        src = mm / name
        if src.is_file():
            shutil.copy2(src, pub / name)
    for p in mm.glob("lecture_*.json"):
        if re.fullmatch(r"lecture_\d+\.json", p.name) or p.name.endswith(".assign.json"):
            shutil.copy2(p, pub / p.name)
    shutil.copy2(mm / "index.json", pub.parent / "mindmap_showcase.json")
    print("synced showcase")


if __name__ == "__main__":
    main()
