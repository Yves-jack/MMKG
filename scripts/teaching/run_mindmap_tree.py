#!/usr/bin/env python3
"""讲次 / 整课 KG → 思维导树；导出 JSON 供前端展示。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.textbook_kg.importance_feedback import configure_entity_weights
from teachkg.textbook_kg.mindmap_tree import build_course_mindmap_tree, build_mindmap_tree
from teachkg.textbook_kg.propagate_importance import propagate_importance_to_parents


def _with_graph_propagation(kg: dict, importance: dict[str, float]) -> dict[str, float]:
    """重要性规则在图谱侧完成传递；导图只拿结果展示。"""
    entities = kg.get("entities") or []
    node_ids = [
        str(e.get("id") or e.get("name") or "").strip()
        for e in entities
        if str(e.get("id") or e.get("name") or "").strip()
    ]
    return propagate_importance_to_parents(
        importance, kg.get("edges") or [], node_ids=node_ids or None
    )


def _load_importance(course: str, lecture_id: str | None = None) -> dict[str, float]:
    """优先课堂归一化分（by_context / classroom），与课堂图谱一致。"""
    path = ROOT / "data/kg" / course / "entity_importance_feedback.json"
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    classroom: dict[str, float] = {}
    if lecture_id and lecture_id != "course":
        ctx = (raw.get("by_context") or {}).get(f"lecture:{lecture_id}") or {}
        if isinstance(ctx.get("classroom"), dict):
            for k, v in ctx["classroom"].items():
                try:
                    classroom[str(k)] = float(v)
                except (TypeError, ValueError):
                    pass
        for name, rec in (ctx.get("entities") or {}).items():
            if not isinstance(rec, dict):
                continue
            cn = rec.get("classroom_norm")
            if cn is None:
                continue
            try:
                classroom[str(name)] = float(cn)
            except (TypeError, ValueError):
                pass
        if classroom:
            return classroom
    if isinstance(raw.get("classroom"), dict):
        for k, v in raw["classroom"].items():
            try:
                classroom[str(k)] = float(v)
            except (TypeError, ValueError):
                pass
        if classroom:
            return classroom
    scores = raw.get("scores") or {}
    return {str(k): float(v) for k, v in scores.items()}


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


def _chapter_file_slug(chapter: str) -> str:
    bare = re.sub(r"^第\s*\d+\s*章\s*", "", str(chapter or "")).strip()
    base = bare or str(chapter or "chapter")
    for ch in '<>:"|?*':
        base = base.replace(ch, "_")
    return base.replace("/", "_").replace("\\", "_").replace(" ", "_")[:80]


def _write_chapter_mindmaps(
    course: str, out_dir: Path, showcase_items: list[dict], root: Path
) -> None:
    """路径 B：按 chapter 字段融合讲次导图为 chapter_*.json，并插入 index。"""
    lectures = [
        it
        for it in showcase_items
        if it.get("scope") == "lecture" or (
            it.get("lecture_id") not in (None, "course")
            and not str(it.get("lecture_id", "")).startswith("chapter:")
            and it.get("scope") != "course"
            and it.get("scope") != "chapter"
        )
    ]
    by_ch: dict[str, list[dict]] = {}
    for it in lectures:
        ch = str(it.get("chapter") or "").strip()
        if not ch:
            continue
        by_ch.setdefault(ch, []).append(it)

    chapter_items: list[dict] = []
    for ch, items in sorted(
        by_ch.items(),
        key=lambda kv: (
            int(re.search(r"第\s*(\d+)\s*章", kv[0]).group(1))
            if re.search(r"第\s*(\d+)\s*章", kv[0])
            else 999,
            kv[0],
        ),
    ):
        lids = sorted(
            {str(i["lecture_id"]) for i in items},
            key=lambda x: int(x) if x.isdigit() else 999,
        )
        branches = []
        orphan = 0
        for lid in lids:
            path = out_dir / f"lecture_{lid}.json"
            if not path.is_file():
                continue
            doc = json.loads(path.read_text(encoding="utf-8"))
            orphan += int(doc.get("orphan_count") or 0)
            trees = doc.get("roots") or ([doc["root"]] if doc.get("root") else [])
            branches.append(
                {
                    "id": f"__lecture__/{lid}",
                    "zh": f"第 {lid} 讲",
                    "importance": max(
                        (float(t.get("importance") or 0) for t in trees), default=0.3
                    ),
                    "relation": "toc_lecture",
                    "related": [],
                    "children": trees,
                }
            )
        if not branches:
            continue

        # 跨讲去重：同一实体 id 只在首次讲枝保留深子树
        seen: set[str] = set()

        def strip_dup(n: dict) -> dict:
            nid = str(n.get("id") or "")
            if nid in seen and not nid.startswith("__"):
                return {**n, "copy": True, "weak": True, "children": []}
            if not nid.startswith("__lecture__/") and not nid.startswith("__chapter__/"):
                seen.add(nid)
            return {**n, "children": [strip_dup(c) for c in (n.get("children") or [])]}

        deduped = [strip_dup(b) for b in branches]
        root_node = {
            "id": f"__chapter__/{ch}",
            "zh": ch,
            "importance": 0.7,
            "relation": None,
            "related": [],
            "children": deduped,
        }

        def count_nodes(n: dict) -> int:
            return 1 + sum(count_nodes(c) for c in (n.get("children") or []))

        def depth_of(n: dict, d: int = 0) -> int:
            kids = n.get("children") or []
            if not kids:
                return d
            return max(depth_of(c, d + 1) for c in kids)

        # 路径 A 强骨架：若有 summaries/chapter_*.json 则标 summary+kg
        slug = _chapter_file_slug(ch)
        summary_path = root / "data/viz" / course / "summaries" / f"chapter_{slug}.json"
        source = "summary+kg" if summary_path.is_file() else "kg"
        doc = {
            "lecture_id": f"chapter:{ch}",
            "root": root_node,
            "roots": [root_node],
            "n_nodes": count_nodes(root_node),
            "max_depth": depth_of(root_node),
            "orphan_count": orphan,
            "meta": {
                "chapter": ch,
                "root_zh": ch,
                "virtual_root": True,
                "scope": "chapter",
                "lecture_ids": lids,
                "source": source,
                "n_trees": 1,
            },
        }
        out = out_dir / f"chapter_{slug}.json"
        out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"wrote {out} (source={source})")
        chapter_items.append(
            {
                "lecture_id": f"chapter:{ch}",
                "chapter": ch,
                "chapter_id": ch,
                "root_zh": re.sub(r"^第\s*\d+\s*章\s*", "", ch).strip() or ch,
                "n_nodes": doc["n_nodes"],
                "max_depth": doc["max_depth"],
                "orphan_count": orphan,
                "path": f"mindmaps/chapter_{slug}.json",
                "scope": "chapter",
                "lecture_ids": lids,
                "source": source,
            }
        )

    # 重建 items：course → chapter → lecture
    course_items = [
        it
        for it in showcase_items
        if it.get("scope") == "course" or it.get("lecture_id") == "course"
    ]
    lecture_items = [
        it
        for it in showcase_items
        if it.get("lecture_id") != "course"
        and it.get("scope") != "course"
        and it.get("scope") != "chapter"
        and not str(it.get("lecture_id", "")).startswith("chapter:")
    ]
    showcase_items.clear()
    showcase_items.extend(course_items)
    showcase_items.extend(chapter_items)
    showcase_items.extend(lecture_items)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    ap.add_argument("--course", default="数理逻辑")
    ap.add_argument("--lecture", default="1")
    ap.add_argument("--lectures", default="", help="逗号分隔多个讲次")
    ap.add_argument("--scope", choices=("lecture", "course", "both"), default="lecture")
    ap.add_argument("--max-nodes", type=int, default=64)
    ap.add_argument("--max-depth", type=int, default=4)
    ap.add_argument("--max-children", type=int, default=8)
    ap.add_argument("--course-max-nodes", type=int, default=120)
    ap.add_argument("--per-chapter", type=int, default=12)
    ap.add_argument(
        "--course-title",
        default="",
        help="整课思维导图根标题（默认取 importance_feedback.meta_titles[0]）",
    )
    args = ap.parse_args()

    cfg = TeachKGConfig.from_yaml(args.config)
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
    # 仅保留 lecture_chapter_map 中已映射的章节，避免整本教材 TOC 产生空章
    mapped_chapters: list[str] = []
    seen_ch: set[str] = set()
    for _lid, chs in lecture_map.items():
        items = chs if isinstance(chs, list) else ([chs] if chs else [])
        for ch in items:
            name = str(ch or "").strip()
            if name and name not in seen_ch:
                seen_ch.add(name)
                mapped_chapters.append(name)
    if mapped_chapters:
        order_idx = {c: i for i, c in enumerate(chapter_order)}
        chapter_order = sorted(
            mapped_chapters,
            key=lambda c: order_idx.get(c, 10_000 + mapped_chapters.index(c)),
        )

    course_title = (args.course_title or "").strip() or "数理逻辑与集合论"
    if not args.course_title:
        meta_titles = fb.get("meta_titles") or []
        if meta_titles:
            course_title = str(meta_titles[0]).split("/")[0].strip() or course_title
        # 新课目录名优先于泛化书名
        if args.course and args.course not in {"数理逻辑", "shuliluoji"}:
            course_title = args.course.split("(")[0].strip() or course_title

    out_dir = ROOT / "data/viz" / args.course / "mindmaps"
    out_dir.mkdir(parents=True, exist_ok=True)
    showcase_items = []

    # —— 整课 ——
    if args.scope in ("course", "both"):
        kg_path = ROOT / "data/kg" / args.course / "kg.json"
        if kg_path.is_file():
            kg = json.loads(kg_path.read_text(encoding="utf-8"))
            imp = _with_graph_propagation(kg, _load_importance(args.course))
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
                    "source": "kg",
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
            imp = _with_graph_propagation(kg, _load_importance(args.course, lid))
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
                    "chapter_id": chapter,
                    "root_zh": result.meta.get("root_zh"),
                    "n_nodes": result.n_nodes,
                    "max_depth": result.max_depth,
                    "orphan_count": result.orphan_count,
                    "path": f"mindmaps/lecture_{lid}.json",
                    "scope": "lecture",
                    "source": "kg",
                }
            )
            _print_tree(result)
            print(f"wrote {out}")

        # —— 章级融合（路径 B：讲次树按 chapter_map 聚类）——
        _write_chapter_mindmaps(args.course, out_dir, showcase_items, ROOT)

    # 若只跑 course，仍保留已有 lecture 条目进 index，并补章级融合
    if args.scope == "course":
        existing = out_dir / "index.json"
        if existing.is_file():
            old = json.loads(existing.read_text(encoding="utf-8"))
            for it in old.get("items") or []:
                if it.get("lecture_id") == "course":
                    continue
                if it.get("scope") == "chapter" or str(it.get("lecture_id", "")).startswith(
                    "chapter:"
                ):
                    continue
                if (out_dir / Path(it["path"]).name).is_file() or (
                    ROOT / "data/viz" / args.course / it["path"]
                ).is_file():
                    showcase_items.append(it)
        _write_chapter_mindmaps(args.course, out_dir, showcase_items, ROOT)

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
