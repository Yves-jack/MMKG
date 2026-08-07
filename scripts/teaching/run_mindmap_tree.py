#!/usr/bin/env python3
"""讲次 / 整课 KG → 思维导树；导出 JSON 供前端展示。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.textbook_kg.importance_feedback import configure_entity_weights
from teachkg.textbook_kg.mindmap_tree import build_course_mindmap_tree, build_mindmap_tree


def _load_importance(course: str, lecture_id: str | None = None) -> dict[str, float]:
    paths = []
    if lecture_id and lecture_id != "course":
        paths.append(
            ROOT
            / "data/experiments/comparisons"
            / course
            / "importance_p3"
            / f"feedback_lec{lecture_id}_a0.45.json"
        )
    paths.append(ROOT / "data/kg" / course / "entity_importance_feedback.json")
    for path in paths:
        if not path.is_file():
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        scores = raw.get("scores") or {}
        return {str(k): float(v) for k, v in scores.items()}
    return {}


def _print_tree(result, limit_depth: int = 3) -> None:
    print(
        f"\n=== scope={result.lecture_id} root={result.meta.get('root_zh')} "
        f"nodes={result.n_nodes} depth={result.max_depth} orphans={result.orphan_count} ==="
    )

    def walk(node, indent=0):
        if indent > limit_depth:
            return
        pad = "  " * indent
        rel = f" ({node.relation})" if node.relation else ""
        print(f"{pad}· {node.zh}{rel}  [{node.importance:.3f}]")
        for c in node.children[:12]:
            walk(c, indent + 1)
        if len(node.children) > 12:
            print(f"{pad}  · … +{len(node.children) - 12}")

    walk(result.root)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--course", default="shuliluoji")
    ap.add_argument("--lecture", default="1")
    ap.add_argument("--lectures", default="", help="逗号分隔多个讲次")
    ap.add_argument("--scope", choices=("lecture", "course", "both"), default="lecture")
    ap.add_argument("--max-nodes", type=int, default=36)
    ap.add_argument("--max-depth", type=int, default=4)
    ap.add_argument("--max-children", type=int, default=8)
    ap.add_argument("--course-max-nodes", type=int, default=120)
    ap.add_argument("--per-chapter", type=int, default=12)
    args = ap.parse_args()

    cfg = TeachKGConfig.from_yaml(ROOT / "configs/teaching.yaml")
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    fb = tb.get("importance_feedback", {}) or {}
    configure_entity_weights(fb)
    lecture_map = tb.get("lecture_chapter_map") or {}
    tb_dir = ROOT / tb.get("path", "data/textbook/CS2501-离散数学（数理逻辑与集合论）")
    bundle_path = tb_dir / tb.get("importance_bundle_file", "importance_bundle.json")
    chapter_order: list[str] = []
    if bundle_path.is_file():
        chapter_order = list(
            json.loads(bundle_path.read_text(encoding="utf-8")).get("chapter_order") or []
        )

    course_title = "数理逻辑与集合论"
    meta_titles = fb.get("meta_titles") or []
    if meta_titles:
        course_title = str(meta_titles[0]).split("/")[0].strip() or course_title

    out_dir = ROOT / "data/viz" / args.course / "mindmaps"
    out_dir.mkdir(parents=True, exist_ok=True)
    showcase_items = []

    # —— 整课 ——
    if args.scope in ("course", "both"):
        kg_path = ROOT / "data/kg" / args.course / "kg.json"
        if kg_path.is_file():
            kg = json.loads(kg_path.read_text(encoding="utf-8"))
            imp = _load_importance(args.course)
            result = build_course_mindmap_tree(
                kg,
                importance=imp,
                chapter_order=chapter_order,
                course_title=course_title,
                max_nodes=args.course_max_nodes,
                max_depth=args.max_depth,
                max_children_per_chapter=args.max_children,
                max_nodes_per_chapter=args.per_chapter,
            )
            out = out_dir / "course.json"
            out.write_text(
                json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
            )
            showcase_items.append(
                {
                    "lecture_id": "course",
                    "chapter": course_title,
                    "root_zh": result.meta.get("root_zh"),
                    "n_nodes": result.n_nodes,
                    "max_depth": result.max_depth,
                    "orphan_count": result.orphan_count,
                    "path": "mindmaps/course.json",
                    "scope": "course",
                }
            )
            _print_tree(result, limit_depth=2)
            print(f"wrote {out}")
        else:
            print(f"skip course: missing {kg_path}")

    # —— 分讲 ——
    if args.scope in ("lecture", "both"):
        lids = [x.strip() for x in args.lectures.split(",") if x.strip()]
        if not lids and args.scope == "lecture":
            lids = [str(args.lecture)]
        elif not lids and args.scope == "both":
            lids = sorted(
                {
                    p.name.replace("lecture_", "")
                    for p in (ROOT / "data/kg" / args.course).glob("lecture_*")
                    if p.is_dir()
                },
                key=lambda x: int(x) if x.isdigit() else 999,
            )

        for lid in lids:
            kg_path = ROOT / "data/kg" / args.course / f"lecture_{lid}" / "kg.json"
            if not kg_path.is_file():
                print(f"skip L{lid}: missing {kg_path}")
                continue
            kg = json.loads(kg_path.read_text(encoding="utf-8"))
            chapter = lecture_map.get(str(lid)) or lecture_map.get(lid)
            if isinstance(chapter, list):
                chapter = chapter[0] if chapter else None
            imp = _load_importance(args.course, lid)
            result = build_mindmap_tree(
                kg,
                importance=imp,
                chapter=str(chapter) if chapter else None,
                max_nodes=args.max_nodes,
                max_depth=args.max_depth,
                max_children=args.max_children,
            )
            out = out_dir / f"lecture_{lid}.json"
            out.write_text(
                json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
            )
            showcase_items.append(
                {
                    "lecture_id": lid,
                    "chapter": chapter,
                    "root_zh": result.meta.get("root_zh"),
                    "n_nodes": result.n_nodes,
                    "max_depth": result.max_depth,
                    "orphan_count": result.orphan_count,
                    "path": f"mindmaps/lecture_{lid}.json",
                    "scope": "lecture",
                }
            )
            _print_tree(result)
            print(f"wrote {out}")

    # 若只跑 course，仍保留已有 lecture 条目进 index
    if args.scope == "course":
        existing = out_dir / "index.json"
        if existing.is_file():
            old = json.loads(existing.read_text(encoding="utf-8"))
            for it in old.get("items") or []:
                if it.get("lecture_id") == "course":
                    continue
                if (out_dir / Path(it["path"]).name).is_file() or (
                    ROOT / "data/viz" / args.course / it["path"]
                ).is_file():
                    showcase_items.append(it)

    index = {
        "courseId": args.course,
        "title": "思维导图",
        "items": showcase_items,
    }
    (out_dir / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (ROOT / "data/viz" / args.course / "mindmap_showcase.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nindex → {out_dir / 'index.json'} ({len(showcase_items)} items)")


if __name__ == "__main__":
    main()
