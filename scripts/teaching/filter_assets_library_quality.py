#!/usr/bin/env python3
"""按最新质检规则过滤已有 assets library（不去 LLM）。"""
from __future__ import annotations

import argparse
import json
import shutil
from collections import Counter
from pathlib import Path

from teachkg.assets.llm_extract import _quality_drop_reason
from teachkg.assets.schema import AssetCard, AssetLibrary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--course-id", required=True)
    ap.add_argument(
        "--repo",
        type=Path,
        default=Path(__file__).resolve().parents[2],
    )
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    lib_path = args.repo / "data" / "kg" / args.course_id / "assets" / "library.json"
    if not lib_path.is_file():
        raise SystemExit(f"missing {lib_path}")

    raw = json.loads(lib_path.read_text(encoding="utf-8"))
    cards = raw.get("cards") or []
    kept_dicts: list[dict] = []
    dropped: Counter[str] = Counter()
    drop_samples: dict[str, list[str]] = {}
    for c in cards:
        if not isinstance(c, dict):
            continue
        kind = str(c.get("kind") or "")
        name = str(c.get("name") or "")
        evidence = str(c.get("evidence") or "")
        steps = [str(s).strip() for s in (c.get("steps") or []) if str(s).strip()]
        reason = _quality_drop_reason(
            kind,
            name,
            evidence,
            steps,
            evidence or str(c.get("summary") or ""),
            latex=str(c.get("latex") or ""),
            summary=str(c.get("summary") or ""),
            statement=str(c.get("statement") or ""),
        )
        if reason:
            dropped[reason] += 1
            drop_samples.setdefault(reason, [])
            if len(drop_samples[reason]) < 5:
                drop_samples[reason].append(name)
            continue
        kept_dicts.append(c)

    report = {
        "path": str(lib_path),
        "before": len(cards),
        "after": len(kept_dicts),
        "removed": len(cards) - len(kept_dicts),
        "dropped_by_reason": dict(dropped),
        "samples": drop_samples,
        "kept_by_kind": dict(Counter(str(c.get("kind")) for c in kept_dicts)),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not args.apply:
        print("dry-run only; pass --apply to write")
        return 0

    bak = lib_path.with_suffix(".json.bak_quality")
    shutil.copy2(lib_path, bak)

    parsed = [AssetCard.from_dict(c) for c in kept_dicts]
    lib = AssetLibrary(
        course_id=str(raw.get("course_id") or args.course_id),
        cards=parsed,
        generated_at=str(raw.get("generated_at") or ""),
        stats=dict(raw.get("stats") or {}),
    )
    out = lib.to_dict()
    # 保留分章目录等扩展字段
    for k in ("chapter_catalog", "meta", "title"):
        if k in raw:
            out[k] = raw[k]
    lib_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote", lib_path, "backup", bak)

    for rel in (
        Path("web/teachkg-showcase/public/data/assets_library.json"),
        Path(f"web/teachkg-showcase/public/data/courses/{args.course_id}/assets_library.json"),
    ):
        dest = args.repo / rel
        if dest.parent.is_dir():
            dest.write_text(lib_path.read_text(encoding="utf-8"), encoding="utf-8")
            print("synced", dest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
