#!/usr/bin/env python
"""合并多本教材母图为单一目录，供 stage1.textbook_kg.path 使用。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _merge_entities(rows_list: list[list[dict]]) -> list[dict]:
    by_name: dict[str, dict] = {}
    for rows in rows_list:
        for row in rows:
            name = str(row.get("name", "")).strip()
            if not name:
                continue
            prev = by_name.get(name)
            if prev is None:
                by_name[name] = dict(row)
                continue
            # 保留更长定义；定理列表并集
            defn = str(row.get("definition") or "").strip()
            if len(defn) > len(str(prev.get("definition") or "").strip()):
                prev["definition"] = row.get("definition", "")
            th_old = list(prev.get("theorems") or prev.get("themorems") or [])
            th_new = list(row.get("theorems") or row.get("themorems") or [])
            if th_new:
                seen = {(t.get("name"), t.get("content")) for t in th_old if isinstance(t, dict)}
                for t in th_new:
                    if not isinstance(t, dict):
                        continue
                    key = (t.get("name"), t.get("content"))
                    if key not in seen:
                        th_old.append(t)
                        seen.add(key)
                prev["theorems"] = th_old
            prev["importance"] = max(
                float(prev.get("importance") or 0),
                float(row.get("importance") or 0),
            )
    return sorted(by_name.values(), key=lambda r: str(r.get("name", "")))


def _merge_relations(rows_list: list[list[dict]]) -> list[dict]:
    seen: set[tuple[str, str, str]] = set()
    out: list[dict] = []
    for rows in rows_list:
        for row in rows:
            s = str(row.get("subject", "")).strip()
            o = str(row.get("object", "")).strip()
            p = str(row.get("predicate", "related_with")).strip() or "related_with"
            if not s or not o:
                continue
            key = (s, p, o)
            if key in seen:
                continue
            seen.add(key)
            out.append(dict(row))
    return out


def _merge_sorted(rows_list: list[list]) -> list[list]:
    scores: dict[str, float] = {}
    for rows in rows_list:
        for item in rows:
            if isinstance(item, list) and len(item) >= 2:
                name, score = str(item[0]), float(item[1])
            elif isinstance(item, dict):
                name = str(item.get("node") or item.get("name") or "")
                score = float(item.get("score") or 0)
            else:
                continue
            if not name:
                continue
            scores[name] = max(scores.get(name, 0.0), score)
    return [[n, s] for n, s in sorted(scores.items(), key=lambda x: (-x[1], x[0]))]


def _merge_bundle(bundles: list[dict]) -> dict:
    global_scores: dict[str, float] = {}
    by_chapter: dict[str, dict[str, float]] = {}
    chapter_order: list[str] = []
    sources: list[str] = []

    for bundle in bundles:
        sources.extend(list(bundle.get("sources") or []))
        if bundle.get("source"):
            sources.append(str(bundle["source"]))
        for item in bundle.get("global") or []:
            if isinstance(item, list) and len(item) >= 2:
                name, score = str(item[0]), float(item[1])
                global_scores[name] = max(global_scores.get(name, 0.0), score)
        for ch in bundle.get("chapter_order") or []:
            ch = str(ch)
            if ch and ch not in chapter_order:
                chapter_order.append(ch)
        for ch, rows in (bundle.get("by_chapter") or {}).items():
            ch = str(ch)
            if ch not in chapter_order:
                chapter_order.append(ch)
            table = by_chapter.setdefault(ch, {})
            for item in rows or []:
                if isinstance(item, list) and len(item) >= 2:
                    name, score = str(item[0]), float(item[1])
                    table[name] = max(table.get(name, 0.0), score)

    return {
        "source": "merged_textbooks",
        "sources": sources,
        "chapter_order": chapter_order,
        "global": [[n, s] for n, s in sorted(global_scores.items(), key=lambda x: (-x[1], x[0]))],
        "by_chapter": {
            ch: [[n, s] for n, s in sorted(table.items(), key=lambda x: (-x[1], x[0]))]
            for ch, table in by_chapter.items()
        },
    }


def merge_dirs(sources: list[Path], out_dir: Path) -> dict:
    entity_rows = []
    relation_rows = []
    sorted_rows = []
    ppr_rows = []
    classic_rows = []
    bundles = []
    toc_parts: list[str] = []

    for src in sources:
        entity_rows.append(_load_json(src / "entity_final.json"))
        relation_rows.append(_load_json(src / "relations_final.json"))
        if (src / "entity_sorted.json").is_file():
            sorted_rows.append(_load_json(src / "entity_sorted.json"))
        if (src / "entity_sorted_ppr.json").is_file():
            ppr_rows.append(_load_json(src / "entity_sorted_ppr.json"))
        if (src / "entity_sorted_classic_pr.json").is_file():
            classic_rows.append(_load_json(src / "entity_sorted_classic_pr.json"))
        if (src / "importance_bundle.json").is_file():
            b = _load_json(src / "importance_bundle.json")
            b = dict(b)
            b["source"] = src.name
            bundles.append(b)
        toc = src / "toc.md"
        if toc.is_file():
            toc_parts.append(f"<!-- from {src.name} -->\n" + toc.read_text(encoding="utf-8").strip())

    entities = _merge_entities(entity_rows)
    relations = _merge_relations(relation_rows)
    bundle = _merge_bundle(bundles)
    ppr = _merge_sorted(ppr_rows) if ppr_rows else _merge_sorted(sorted_rows)
    classic = _merge_sorted(classic_rows) if classic_rows else ppr
    sorted_all = ppr

    out_dir.mkdir(parents=True, exist_ok=True)
    _save_json(out_dir / "entity_final.json", entities)
    _save_json(out_dir / "relations_final.json", relations)
    _save_json(out_dir / "entity_sorted.json", sorted_all)
    _save_json(out_dir / "entity_sorted_ppr.json", ppr)
    _save_json(out_dir / "entity_sorted_classic_pr.json", classic)
    _save_json(out_dir / "importance_bundle.json", bundle)
    if toc_parts:
        (out_dir / "toc.md").write_text("\n\n".join(toc_parts) + "\n", encoding="utf-8")

    meta = {
        "merged_from": [str(s.relative_to(ROOT)).replace("\\", "/") for s in sources],
        "n_entities": len(entities),
        "n_relations": len(relations),
        "n_chapters": len(bundle.get("chapter_order") or []),
    }
    _save_json(out_dir / "merge_meta.json", meta)
    return meta


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Merge multiple textbook KGs")
    p.add_argument(
        "--source",
        action="append",
        dest="sources",
        required=True,
        help="教材目录（可重复）",
    )
    p.add_argument("--out", required=True, help="输出合并目录")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    sources = [ROOT / s if not Path(s).is_absolute() else Path(s) for s in args.sources]
    out = ROOT / args.out if not Path(args.out).is_absolute() else Path(args.out)
    for s in sources:
        if not (s / "entity_final.json").is_file():
            raise SystemExit(f"missing entity_final.json: {s}")
    meta = merge_dirs(sources, out)
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
