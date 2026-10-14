#!/usr/bin/env python3
"""讲次导图四步流水线。

1. 讲次图谱 → 规则初稿 → LLM 整理
2. 子树章节匹配 → 裁剪并增加章节层（讲→章→子树）→ LLM 微调
3. 融合各讲次的章节部分 → LLM 简单拼接合并
4. 合并各章为整课导图，并按目录增加分部层

示例：
  python scripts/teaching/run_lecture_mindmap_pipeline.py \\
    --config configs/teaching_lisan.yaml \\
    --course \"离散数学(图论+数理逻辑与集合论)\" \\
    --lecture 18

  # 只做规则初稿（不调 LLM）
  python scripts/teaching/run_lecture_mindmap_pipeline.py --lecture 18 --skip-llm

  # 步骤1 only：整理后的扁平讲次导图，不分章
  python scripts/teaching/run_lecture_mindmap_pipeline.py --lecture 18 --no-assign
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.textbook_kg.importance_feedback import configure_entity_weights
from teachkg.textbook_kg.mindmap_pipeline import (
    assign_subtrees_with_llm,
    build_course_from_chapters,
    build_lecture_draft,
    build_or_update_chapter_doc,
    chapter_file_slug,
    forest_stats,
    iter_chapter_slices_from_lecture,
    load_classroom_importance,
    merge_chapter_with_llm,
    node_to_dict,
    result_to_doc,
    strip_internal_fields,
    tidy_lecture_mindmap_with_llm,
    tune_lecture_chapters_with_llm,
    unwrap_lecture_to_topic_forest,
    update_mindmap_index,
    wrap_lecture_by_assignments,
)
from teachkg.utils.env import load_project_env
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config

logger = logging.getLogger("run_lecture_mindmap_pipeline")


def _lecture_map_chapters(lecture_map: dict, lecture_id: str) -> list[str]:
    raw = lecture_map.get(str(lecture_id)) or lecture_map.get(lecture_id)
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if raw:
        return [str(raw).strip()]
    return []


def _load_catalog(course: str) -> dict:
    candidates = [
        ROOT / "data/viz" / course / "chapter_catalog.json",
        ROOT
        / "web/teachkg-showcase/public/data/courses"
        / course
        / "chapter_catalog.json",
        ROOT / "data/textbook/CS2501-离散数学（图论+数理逻辑与集合论）/chapter_catalog.json",
    ]
    for p in candidates:
        if p.is_file():
            return json.loads(p.read_text(encoding="utf-8"))
    return {}


def _load_lecture_map(cfg_map: dict, course: str) -> dict:
    """优先用 PPT 归章结果，避免 yaml 里过期的教材章名。"""
    p = ROOT / "data/viz" / course / "lecture_ppt_chapter_map.json"
    if p.is_file():
        raw = json.loads(p.read_text(encoding="utf-8"))
        by_lec = raw.get("by_lecture") if isinstance(raw, dict) else None
        if isinstance(by_lec, dict) and by_lec:
            return {str(k): v for k, v in by_lec.items()}
        if isinstance(raw, dict) and raw:
            return {str(k): v for k, v in raw.items() if k != "by_chapter"}
    return cfg_map or {}


def _catalog_chapter_order(catalog: dict) -> list[str]:
    from teachkg.textbook_kg.mindmap_pipeline import _iter_catalog_chapters

    return _iter_catalog_chapters(catalog)


def _print_forest(doc: dict, *, limit_depth: int = 3) -> None:
    trees = doc.get("roots") or ([doc["root"]] if doc.get("root") else [])

    def walk(n: dict, indent: int = 0) -> None:
        if indent > limit_depth:
            return
        pad = "  " * indent
        rel = f" ({n.get('relation')})" if n.get("relation") else ""
        print(f"{pad}· {n.get('zh')}{rel}  [{float(n.get('importance') or 0):.3f}]")
        for c in (n.get("children") or [])[:12]:
            walk(c, indent + 1)
        if len(n.get("children") or []) > 12:
            print(f"{pad}  · … +{len(n.get('children') or []) - 12}")

    for t in trees:
        walk(node_to_dict(t))


def _write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {path}")


def _sync_showcase(course: str, src_dir: Path, names: list[str]) -> None:
    dst = ROOT / "web/teachkg-showcase/public/data/courses" / course / "mindmaps"
    dst.mkdir(parents=True, exist_ok=True)
    for name in names:
        s = src_dir / name
        if s.is_file():
            shutil.copy2(s, dst / name)
            print(f"sync {dst / name}")
    showcase = ROOT / "web/teachkg-showcase/public/data/courses" / course / "mindmap_showcase.json"
    idx = src_dir / "index.json"
    if idx.is_file():
        shutil.copy2(idx, showcase)
        print(f"sync {showcase}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching_lisan.yaml"))
    p.add_argument("--course", default="离散数学(图论+数理逻辑与集合论)")
    p.add_argument("--lecture", default="18")
    p.add_argument("--lectures", default="", help="逗号分隔多个讲次；覆盖 --lecture")
    p.add_argument("--max-nodes", type=int, default=80)
    p.add_argument("--max-depth", type=int, default=5)
    p.add_argument("--max-children", type=int, default=10)
    p.add_argument("--skip-llm", action="store_true", help="跳过全部 LLM 步骤")
    p.add_argument("--no-assign", action="store_true", help="只做步骤1，不分章/合并")
    p.add_argument("--no-tune", action="store_true", help="跳过步骤2的 LLM 微调")
    p.add_argument("--no-chapter-merge-llm", action="store_true", help="跳过步骤3的章级 LLM 合并")
    p.add_argument("--mock-llm", action="store_true", help="不调 API，走 mock 路径")
    p.add_argument("--sync-showcase", action="store_true", help="同步到 showcase public/data")
    p.add_argument(
        "--out-dir",
        default="",
        help="导图输出目录；默认 data/viz/<course>/mindmaps。用于预览时勿指向现网目录。",
    )
    p.add_argument(
        "--skip-chapter-stitch",
        action="store_true",
        help="只写讲次导图，不改章图/课图",
    )
    p.add_argument("--rebuild-course", action="store_true", help="用已有章导图重拼课总图")
    p.add_argument(
        "--restitch-chapters",
        action="store_true",
        help="用已有 lecture/tidy+assign 重包讲次，并实体合并重拼章图与课总图（默认可再跑章级 LLM）",
    )
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def restitch_chapters_from_existing(
    *,
    course: str,
    out_dir: Path,
    catalog: dict,
    chapter_order: list[str],
    lecture_map: dict,
    sync_showcase: bool,
    llm_merge: bool = True,
    mock_llm: bool = False,
    client: LLMClient | None = None,
    llm_cfg: dict | None = None,
) -> int:
    """用已有讲次/assign：包章 → 各讲章节部分实体合并成章图（无讲次层）→ 可选 LLM 合并 → 课总图。"""
    upserts: list[dict] = []
    synced: list[str] = []
    chapter_accum: dict[str, dict] = {}

    assign_files = sorted(
        out_dir.glob("lecture_*.assign.json"),
        key=lambda p: int(p.stem.split("_")[1].split(".")[0])
        if p.stem.split("_")[1].split(".")[0].isdigit()
        else 999,
    )
    if not assign_files:
        logger.error("no lecture_*.assign.json under %s", out_dir)
        return 1

    for ap in assign_files:
        lid = ap.stem.split("_")[1].split(".")[0]
        assign_doc = json.loads(ap.read_text(encoding="utf-8"))
        assignments = assign_doc.get("assignments") or []
        candidates = _lecture_map_chapters(lecture_map, lid) or list(
            assign_doc.get("candidates") or []
        )

        tidy_path = out_dir / f"lecture_{lid}.tidy.json"
        lec_path = out_dir / f"lecture_{lid}.json"
        if not lec_path.is_file() and not tidy_path.is_file():
            logger.warning("skip L%s: missing lecture json", lid)
            continue

        def _is_wrapped(doc: dict) -> bool:
            roots = doc.get("roots") or ([doc["root"]] if doc.get("root") else [])
            if not roots:
                return False
            return str((roots[0] or {}).get("id") or "").startswith("__lecture__/")

        # 优先用扁平 tidy/未包章稿 + assign 重包，避免沿用旧结构
        if tidy_path.is_file():
            base = json.loads(tidy_path.read_text(encoding="utf-8"))
            wrapped = wrap_lecture_by_assignments(
                base,
                lecture_id=str(lid),
                assignments=assignments,
                chapter_hint=candidates[0] if candidates else None,
                chapter_order=chapter_order,
            )
        else:
            base = json.loads(lec_path.read_text(encoding="utf-8"))
            if _is_wrapped(base):
                forest = unwrap_lecture_to_topic_forest(base)
                flat = {
                    **base,
                    "roots": forest,
                    "root": forest[0] if forest else None,
                }
                wrapped = wrap_lecture_by_assignments(
                    flat,
                    lecture_id=str(lid),
                    assignments=assignments,
                    chapter_hint=candidates[0] if candidates else None,
                    chapter_order=chapter_order,
                )
            else:
                wrapped = wrap_lecture_by_assignments(
                    base,
                    lecture_id=str(lid),
                    assignments=assignments,
                    chapter_hint=candidates[0] if candidates else None,
                    chapter_order=chapter_order,
                )

        meta = dict(wrapped.get("meta") or {})
        meta["scope"] = "lecture"
        meta["chapter"] = candidates[0] if candidates else meta.get("chapter")
        meta["chapter_candidates"] = candidates
        wrapped["meta"] = meta
        wrapped["lecture_id"] = str(lid)
        _write_json(lec_path, wrapped)
        synced.append(lec_path.name)
        upserts.append(
            {
                "lecture_id": str(lid),
                "chapter": candidates[0] if candidates else None,
                "chapter_id": candidates[0] if candidates else None,
                "root_zh": meta.get("root_zh"),
                "n_nodes": wrapped.get("n_nodes"),
                "max_depth": wrapped.get("max_depth"),
                "orphan_count": wrapped.get("orphan_count"),
                "path": f"mindmaps/lecture_{lid}.json",
                "scope": "lecture",
                "source": "kg",
            }
        )

        for chapter, subtrees in iter_chapter_slices_from_lecture(wrapped):
            ch_doc = build_or_update_chapter_doc(
                chapter,
                existing=chapter_accum.get(chapter),
                subtrees=subtrees,
                lecture_id=str(lid),
            )
            chapter_accum[chapter] = ch_doc
            print(
                f"  merge → {chapter}: +L{lid} "
                f"({len(subtrees)} tops, nodes={ch_doc.get('n_nodes')})"
            )

    for chapter, ch_doc in chapter_accum.items():
        slug = chapter_file_slug(chapter)
        ch_path = out_dir / f"chapter_{slug}.json"
        if llm_merge:
            print(f"\n=== chapter LLM merge: {chapter} ===")
            ch_doc = merge_chapter_with_llm(
                ch_doc,
                course_id=course,
                chapter=chapter,
                client=client,
                llm_cfg=llm_cfg,
                mock=mock_llm,
            )
            print(
                f"  → nodes={ch_doc.get('n_nodes')} "
                f"notes={((ch_doc.get('meta') or {}).get('llm_merge_notes') or '')[:100]}"
            )
        if ch_doc.get("root"):
            ch_doc["root"] = strip_internal_fields(ch_doc["root"])
            # 清掉偶发讲次虚根
            ch_doc["root"]["children"] = [
                c
                for c in (ch_doc["root"].get("children") or [])
                if isinstance(c, dict)
                and not str(c.get("id") or "").startswith("__lecture__/")
            ]
            ch_doc["roots"] = [ch_doc["root"]]
            n_nodes, max_d = forest_stats([ch_doc["root"]])
            ch_doc["n_nodes"] = n_nodes
            ch_doc["max_depth"] = max_d
        chapter_accum[chapter] = ch_doc
        _write_json(ch_path, ch_doc)
        synced.append(ch_path.name)
        upserts.append(
            {
                "lecture_id": f"chapter:{chapter}",
                "chapter": chapter,
                "chapter_id": chapter,
                "root_zh": (ch_doc.get("meta") or {}).get("root_zh"),
                "n_nodes": ch_doc.get("n_nodes"),
                "max_depth": ch_doc.get("max_depth"),
                "orphan_count": ch_doc.get("orphan_count") or 0,
                "path": f"mindmaps/chapter_{slug}.json",
                "scope": "chapter",
                "lecture_ids": (ch_doc.get("meta") or {}).get("lecture_ids") or [],
                "source": "kg",
            }
        )

    chapter_docs: list[tuple[str, dict]] = list(chapter_accum.items())
    if chapter_docs:
        course_title = course.split("(")[0].strip() or course
        course_doc = build_course_from_chapters(
            course_title,
            chapter_docs,
            catalog=catalog,
            max_chapter_depth=2,
        )
        course_path = out_dir / "course.json"
        _write_json(course_path, course_doc)
        synced.append(course_path.name)
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
        print(f"\n=== course restitch nodes={course_doc.get('n_nodes')} ===")

    index_path = out_dir / "index.json"
    update_mindmap_index(index_path, course_id=course, items_upsert=upserts)
    synced.append("index.json")
    if sync_showcase:
        _sync_showcase(course, out_dir, synced)
    return 0


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    load_project_env()

    cfg = TeachKGConfig.from_yaml(args.config)
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    fb = tb.get("importance_feedback", {}) or {}
    configure_entity_weights(fb)
    lecture_map = _load_lecture_map(tb.get("lecture_chapter_map") or {}, args.course)
    llm_cfg = cfg.get("llm", default={}) or {}

    lids = [x.strip() for x in args.lectures.split(",") if x.strip()]
    if not lids:
        lids = [str(args.lecture)]

    if args.out_dir:
        out_dir = Path(args.out_dir)
        if not out_dir.is_absolute():
            out_dir = ROOT / out_dir
    else:
        out_dir = ROOT / "data/viz" / args.course / "mindmaps"
    out_dir.mkdir(parents=True, exist_ok=True)
    catalog = _load_catalog(args.course)
    chapter_order = _catalog_chapter_order(catalog)

    if args.restitch_chapters:
        client: LLMClient | None = None
        do_llm = not args.skip_llm and not args.no_chapter_merge_llm
        if do_llm and not args.mock_llm:
            client = LLMClient(**llm_settings_from_config(llm_cfg))
        return restitch_chapters_from_existing(
            course=args.course,
            out_dir=out_dir,
            catalog=catalog,
            chapter_order=chapter_order,
            lecture_map=lecture_map,
            sync_showcase=args.sync_showcase,
            llm_merge=do_llm,
            mock_llm=args.mock_llm,
            client=client,
            llm_cfg=llm_cfg,
        )

    client: LLMClient | None = None
    if not args.skip_llm and not args.mock_llm:
        settings = llm_settings_from_config(llm_cfg)
        client = LLMClient(
            **{k: v for k, v in settings.items() if v is not None},
            timeout_sec=240,
            sdk_max_retries=1,
        )

    upserts: list[dict] = []
    synced_names: list[str] = []
    touched_chapters: set[str] = set()
    # 步骤3 用：章名 → 本批汇入的讲次子树（先规则合并，批末再 LLM）
    chapter_accum: dict[str, dict] = {}

    for lid in lids:
        kg_path = ROOT / "data/kg" / args.course / f"lecture_{lid}" / "kg.json"
        if not kg_path.is_file():
            logger.error("missing %s", kg_path)
            continue
        kg = json.loads(kg_path.read_text(encoding="utf-8"))
        candidates = _lecture_map_chapters(lecture_map, lid)
        chapter_hint = "；".join(candidates) if candidates else ""
        importance = load_classroom_importance(ROOT, args.course, lid)

        # ── 步骤1：规则初稿 → LLM 整理 ──
        draft = build_lecture_draft(
            kg,
            importance=importance,
            chapter=candidates[0] if candidates else None,
            max_nodes=args.max_nodes,
            max_depth=args.max_depth,
            max_children=args.max_children,
        )
        draft_doc = result_to_doc(draft)
        draft_path = out_dir / f"lecture_{lid}.draft.json"
        _write_json(draft_path, draft_doc)
        print(
            f"\n=== L{lid} [1/4 draft] nodes={draft_doc.get('n_nodes')} "
            f"depth={draft_doc.get('max_depth')} orphans={draft_doc.get('orphan_count')} ==="
        )
        _print_forest(draft_doc)

        if args.skip_llm:
            tidy_doc = draft_doc
        else:
            tidy_doc = tidy_lecture_mindmap_with_llm(
                draft_doc,
                course_id=args.course,
                lecture_id=lid,
                chapter_hint=chapter_hint,
                client=client,
                llm_cfg=llm_cfg,
                mock=args.mock_llm,
            )
            print(
                f"\n=== L{lid} [1/4 tidy] nodes={tidy_doc.get('n_nodes')} "
                f"depth={tidy_doc.get('max_depth')} "
                f"notes={((tidy_doc.get('meta') or {}).get('llm_tidy_notes') or '')[:80]} ==="
            )
            _print_forest(tidy_doc)

        # 扁平整理结果备份（步骤2之前）
        tidy_flat_path = out_dir / f"lecture_{lid}.tidy.json"
        _write_json(tidy_flat_path, tidy_doc)
        synced_names.append(tidy_flat_path.name)

        if args.skip_llm or args.no_assign:
            lecture_doc = tidy_doc
            meta = dict(lecture_doc.get("meta") or {})
            meta["scope"] = "lecture"
            meta["chapter"] = candidates[0] if candidates else meta.get("chapter")
            meta["chapter_candidates"] = candidates
            lecture_doc["meta"] = meta
            lecture_doc["lecture_id"] = str(lid)
            lec_path = out_dir / f"lecture_{lid}.json"
            _write_json(lec_path, lecture_doc)
            synced_names.append(lec_path.name)
            upserts.append(
                {
                    "lecture_id": str(lid),
                    "chapter": candidates[0] if candidates else None,
                    "chapter_id": candidates[0] if candidates else None,
                    "root_zh": (lecture_doc.get("meta") or {}).get("root_zh"),
                    "n_nodes": lecture_doc.get("n_nodes"),
                    "max_depth": lecture_doc.get("max_depth"),
                    "orphan_count": lecture_doc.get("orphan_count"),
                    "path": f"mindmaps/lecture_{lid}.json",
                    "scope": "lecture",
                    "source": "kg",
                }
            )
            continue

        # ── 步骤2：章节匹配 → 裁剪包章 → LLM 微调 ──
        assignments = assign_subtrees_with_llm(
            tidy_doc,
            course_id=args.course,
            lecture_id=lid,
            candidate_chapters=candidates,
            catalog=catalog,
            client=client,
            llm_cfg=llm_cfg,
            mock=args.mock_llm,
        )
        assign_path = out_dir / f"lecture_{lid}.assign.json"
        _write_json(
            assign_path,
            {
                "lecture_id": lid,
                "candidates": candidates,
                "assignments": assignments,
            },
        )
        synced_names.append(assign_path.name)

        for a in assignments:
            print(
                f"  assign {str(a['subtree_root_id']).split('/')[0]} "
                f"→ {a['chapter']} ({a.get('confidence', 0):.2f}) [{a.get('reason', '')[:40]}]"
            )

        wrapped = wrap_lecture_by_assignments(
            tidy_doc,
            lecture_id=str(lid),
            assignments=assignments,
            chapter_hint=candidates[0] if candidates else None,
            chapter_order=chapter_order,
        )
        print(
            f"\n=== L{lid} [2/4 wrap] nodes={wrapped.get('n_nodes')} "
            f"chapters={((wrapped.get('meta') or {}).get('chapters') or [])} ==="
        )
        _print_forest(wrapped)

        if args.no_tune or args.skip_llm:
            lecture_doc = wrapped
        else:
            lecture_doc = tune_lecture_chapters_with_llm(
                wrapped,
                course_id=args.course,
                lecture_id=lid,
                client=client,
                llm_cfg=llm_cfg,
                mock=args.mock_llm,
            )
            print(
                f"\n=== L{lid} [2/4 tune] nodes={lecture_doc.get('n_nodes')} "
                f"notes={((lecture_doc.get('meta') or {}).get('llm_tune_notes') or '')[:80]} ==="
            )
            _print_forest(lecture_doc)

        meta = dict(lecture_doc.get("meta") or {})
        meta["scope"] = "lecture"
        meta["chapter"] = candidates[0] if candidates else meta.get("chapter")
        meta["chapter_candidates"] = candidates
        lecture_doc["meta"] = meta
        lecture_doc["lecture_id"] = str(lid)

        lec_path = out_dir / f"lecture_{lid}.json"
        _write_json(lec_path, lecture_doc)
        synced_names.append(lec_path.name)
        upserts.append(
            {
                "lecture_id": str(lid),
                "chapter": candidates[0] if candidates else None,
                "chapter_id": candidates[0] if candidates else None,
                "root_zh": (lecture_doc.get("meta") or {}).get("root_zh"),
                "n_nodes": lecture_doc.get("n_nodes"),
                "max_depth": lecture_doc.get("max_depth"),
                "orphan_count": lecture_doc.get("orphan_count"),
                "path": f"mindmaps/lecture_{lid}.json",
                "scope": "lecture",
                "source": "kg",
            }
        )

        # 步骤3素材：直接取步骤2「讲→章→子树」里各章下的内容（按讲次枝拼接）
        slices = iter_chapter_slices_from_lecture(lecture_doc)
        if not slices:
            logger.warning("L%s wrapped lecture has no chapter slices", lid)
        for chapter, subtrees in slices:
            existing = chapter_accum.get(chapter)
            if existing is None:
                slug = chapter_file_slug(chapter)
                ch_path = out_dir / f"chapter_{slug}.json"
                if ch_path.is_file():
                    existing = json.loads(ch_path.read_text(encoding="utf-8"))
                    src = (existing.get("meta") or {}).get("pipeline")
                    if src != "lecture_assign_merge":
                        bak = out_dir / f"chapter_{slug}.prev.json"
                        _write_json(bak, existing)
                        existing = None
            ch_doc = build_or_update_chapter_doc(
                chapter,
                existing=existing,
                subtrees=subtrees,
                lecture_id=str(lid),
            )
            chapter_accum[chapter] = ch_doc
            touched_chapters.add(chapter)
            print(
                f"  stitch → {chapter}: +L{lid} "
                f"({len(subtrees)} tops, chapter_nodes={ch_doc.get('n_nodes')})"
            )

    if args.skip_chapter_stitch:
        chapter_accum = {}
        touched_chapters = set()

    # ── 步骤3：章级规则合并结果 → LLM 简单拼接整理 ──
    for chapter, ch_doc in chapter_accum.items():
        slug = chapter_file_slug(chapter)
        ch_path = out_dir / f"chapter_{slug}.json"
        if not args.skip_llm and not args.no_chapter_merge_llm:
            ch_doc = merge_chapter_with_llm(
                ch_doc,
                course_id=args.course,
                chapter=chapter,
                client=client,
                llm_cfg=llm_cfg,
                mock=args.mock_llm,
            )
            print(
                f"\n=== chapter [3/4 merge] {chapter} nodes={ch_doc.get('n_nodes')} "
                f"notes={((ch_doc.get('meta') or {}).get('llm_merge_notes') or '')[:80]} ==="
            )
        else:
            print(f"\n=== chapter [3/4 rule] {chapter} nodes={ch_doc.get('n_nodes')} ===")

        if ch_doc.get("root"):
            ch_doc["root"] = strip_internal_fields(ch_doc["root"])
            ch_doc["roots"] = [ch_doc["root"]]
        _write_json(ch_path, ch_doc)
        synced_names.append(ch_path.name)
        upserts.append(
            {
                "lecture_id": f"chapter:{chapter}",
                "chapter": chapter,
                "chapter_id": chapter,
                "root_zh": (ch_doc.get("meta") or {}).get("root_zh"),
                "n_nodes": ch_doc.get("n_nodes"),
                "max_depth": ch_doc.get("max_depth"),
                "orphan_count": ch_doc.get("orphan_count") or 0,
                "path": f"mindmaps/chapter_{slug}.json",
                "scope": "chapter",
                "lecture_ids": (ch_doc.get("meta") or {}).get("lecture_ids") or [],
                "source": "kg",
            }
        )

    # ── 步骤4：章 → 整课，按目录加分部层 ──
    if args.rebuild_course or touched_chapters:
        chapter_docs: list[tuple[str, dict]] = []
        seen_ch: set[str] = set()
        for path in sorted(out_dir.glob("chapter_*.json")):
            if path.name.endswith(".prev.json"):
                continue
            doc = json.loads(path.read_text(encoding="utf-8"))
            if (doc.get("meta") or {}).get("pipeline") != "lecture_assign_merge":
                continue
            ch = (doc.get("meta") or {}).get("chapter") or doc.get("lecture_id", "").removeprefix(
                "chapter:"
            )
            if not ch or ch in seen_ch:
                continue
            seen_ch.add(ch)
            chapter_docs.append((ch, doc))
        if chapter_docs:
            course_title = args.course.split("(")[0].strip() or args.course
            course_doc = build_course_from_chapters(
                course_title,
                chapter_docs,
                catalog=catalog,
                max_chapter_depth=2,
            )
            course_path = out_dir / "course.json"
            _write_json(course_path, course_doc)
            synced_names.append(course_path.name)
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
            print(
                f"\n=== course [4/4] nodes={course_doc.get('n_nodes')} "
                f"parts/chapters={len((course_doc.get('root') or {}).get('children') or [])} ==="
            )

    index_path = out_dir / "index.json"
    update_mindmap_index(index_path, course_id=args.course, items_upsert=upserts)
    synced_names.append("index.json")
    print(f"\nindex → {index_path} (+{len(upserts)} upserts)")

    if args.sync_showcase:
        _sync_showcase(args.course, out_dir, synced_names)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
