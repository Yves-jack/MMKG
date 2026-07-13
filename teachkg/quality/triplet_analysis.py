"""三元组质量分析与 discard 统计。"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def load_triplets(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if path.suffix == ".jsonl":
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    else:
        data = json.loads(path.read_text(encoding="utf-8"))
        rows = data if isinstance(data, list) else []
    return rows


def analyze_triplets(triplets: list[dict[str, Any]]) -> dict[str, Any]:
    by_lecture: dict[str, int] = Counter()
    by_relation: Counter[str] = Counter()
    by_cue: Counter[str] = Counter()
    entities: set[str] = set()

    for t in triplets:
        by_lecture[str(t.get("lecture_id", "?"))] += 1
        by_relation[str(t.get("abstract_relation", "?"))] += 1
        cid = str(t.get("cue_id", ""))
        if cid:
            by_cue[cid] += 1
        sub, obj = t.get("subject", ""), t.get("object", "")
        if sub:
            entities.add(sub)
        if obj:
            entities.add(obj)

    related = by_relation.get("related_with", 0)
    total = len(triplets) or 1
    return {
        "total": len(triplets),
        "unique_entities": len(entities),
        "by_lecture": dict(by_lecture),
        "by_relation": dict(by_relation),
        "related_with_ratio": round(related / total, 3),
        "triplets_per_cue_mean": round(len(triplets) / max(len(by_cue), 1), 2),
        "top_cues": by_cue.most_common(10),
    }


def parse_stage1_report(report_path: Path) -> dict[str, Any]:
    if not report_path.is_file():
        return {}
    return json.loads(report_path.read_text(encoding="utf-8"))


def build_quality_report(
    triplets_path: Path,
    *,
    stage1_report_path: Path | None = None,
) -> dict[str, Any]:
    triplets = load_triplets(triplets_path)
    report: dict[str, Any] = {"triplet_stats": analyze_triplets(triplets)}

    if stage1_report_path and stage1_report_path.is_file():
        s1 = parse_stage1_report(stage1_report_path)
        validation = s1.get("triplet_validation") or {}
        report["validation"] = validation
        report["validation_summary"] = {
            "pass": validation.get("pass", 0),
            "revise": validation.get("revise", 0),
            "discard": validation.get("discard", 0),
            "discard_rate": round(
                validation.get("discard", 0)
                / max(sum(validation.values()) if validation else 1, 1),
                3,
            ),
        }
        report["triplet_errors"] = s1.get("triplet_errors") or []

    return report


def export_review_template(triplets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """导出人工审阅模板（review_status: pending）。"""
    out: list[dict[str, Any]] = []
    for i, t in enumerate(triplets):
        out.append(
            {
                "id": i,
                "lecture_id": t.get("lecture_id"),
                "cue_id": t.get("cue_id"),
                "subject": t.get("subject"),
                "object": t.get("object"),
                "abstract_relation": t.get("abstract_relation"),
                "natural_statement": t.get("natural_statement"),
                "context": (t.get("context") or "")[:200],
                "review_status": "pending",
                "review_note": "",
            }
        )
    return out
