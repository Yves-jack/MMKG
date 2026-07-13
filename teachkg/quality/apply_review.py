"""将人工审阅结果回写到三元组列表。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def apply_review(
    triplets: list[dict[str, Any]],
    review_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """按 review 模板 id 过滤 reject 条目。"""
    reject_ids: set[int] = set()
    for row in review_rows:
        status = str(row.get("review_status", "pending")).lower()
        if status in {"reject", "rejected", "discard"}:
            reject_ids.add(int(row.get("id", -1)))

    kept: list[dict[str, Any]] = []
    for i, t in enumerate(triplets):
        if i in reject_ids:
            continue
        kept.append(t)

    stats = {
        "input": len(triplets),
        "rejected": len(reject_ids),
        "kept": len(kept),
    }
    return kept, stats


def apply_review_files(
    triplets_path: Path,
    review_path: Path,
    output_path: Path | None = None,
) -> dict[str, Any]:
    triplets = load_jsonl(triplets_path) if triplets_path.suffix == ".jsonl" else json.loads(
        triplets_path.read_text(encoding="utf-8")
    )
    review_rows = load_jsonl(review_path)
    kept, stats = apply_review(triplets, review_rows)
    out = output_path or triplets_path
    if out.suffix == ".jsonl":
        out.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in kept) + "\n", encoding="utf-8")
    else:
        out.write_text(json.dumps(kept, ensure_ascii=False, indent=2), encoding="utf-8")
    return stats
