# -*- coding: utf-8 -*-
"""导出新增实体分流审阅（调用通用 entity_triage）。"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

from teachkg.stage2_kg_build.entity_triage import EntityTriageConfig, triage_triplets
from teachkg.textbook_kg.entity_registry import EntityRegistry
from teachkg.textbook_kg.loader import TextbookKG

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    import argparse

    p = argparse.ArgumentParser(description="Export entity triage review for a course")
    p.add_argument("--course-id", default="数理逻辑")
    p.add_argument("--lectures", default="1,2,3", help="comma-separated lecture ids")
    p.add_argument(
        "--textbook",
        default="data/textbook/CS2501-离散数学（数理逻辑与集合论）",
    )
    args = p.parse_args()
    lecs = [x.strip() for x in args.lectures.split(",") if x.strip()]

    tb = TextbookKG.load(ROOT / args.textbook)
    reg = EntityRegistry.from_textbook_kg(tb)
    trips = []
    trip_path = ROOT / "data/kg" / args.course_id / "triplets.jsonl"
    for line in trip_path.open(encoding="utf-8"):
        t = json.loads(line)
        if str(t.get("lecture_id")) in lecs:
            trips.append(t)

    res = triage_triplets(trips, reg, cfg=EntityTriageConfig())
    out_dir = ROOT / "data/processed" / args.course_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_json = out_dir / "new_entity_triage_review.json"
    out_md = out_dir / "new_entity_triage_review.md"

    rows = [d.to_dict() for d in res.decisions]
    out_json.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    by = Counter(d.decision for d in res.decisions)
    by_lec: dict[str, Counter] = defaultdict(Counter)
    for d in res.decisions:
        by_lec[d.lecture_id][d.decision] += 1

    lines = [
        f"# 新增实体分流审阅清单（第{'-'.join(lecs)}讲）",
        "",
        "规则：`merge`=链回教材；`drop`=噪声；`keep`/`keep_under_parent`=保留。",
        "",
        f"合计 **{len(rows)}** → merge **{by['merge']}** / drop **{by['drop']}** / "
        f"keep **{by['keep']}** / keep_under_parent **{by['keep_under_parent']}**",
        "",
    ]
    for lec in lecs:
        c = by_lec[lec]
        lines.append(
            f"- 第{lec}讲：merge {c['merge']} · drop {c['drop']} · "
            f"keep {c['keep']} · under_parent {c['keep_under_parent']}"
        )
    lines.append("")

    titles = {
        "merge": "建议合并到教材",
        "drop": "建议丢弃",
        "keep": "建议保留",
        "keep_under_parent": "保留并挂父概念",
    }
    for decision, title in titles.items():
        part_all = [d for d in res.decisions if d.decision == decision]
        if not part_all:
            continue
        lines += [f"## {title}（{len(part_all)}）", ""]
        for lec in lecs:
            part = [d for d in part_all if d.lecture_id == lec]
            if not part:
                continue
            lines += [f"### 第 {lec} 讲（{len(part)}）", "", "| 实体 | 度数 | cue数 | 关系 | 说明 |", "|---|---:|---:|---|---|"]
            for d in part:
                ent = d.entity.replace("|", "\\|")
                why = "；".join(d.reasons)
                if d.merge_to:
                    why = f"→ `{d.merge_to}`；" + why
                if d.parent:
                    why = f"parent=`{d.parent}`；" + why
                lines.append(
                    f"| `{ent}` | {d.degree} | {d.n_cues} | {','.join(d.preds)} | {why} |"
                )
            lines.append("")

    out_md.write_text("\n".join(lines), encoding="utf-8")
    print("Wrote", out_md)
    print("Wrote", out_json)
    print(dict(by))
    print("apply stats", res.stats)


if __name__ == "__main__":
    main()
