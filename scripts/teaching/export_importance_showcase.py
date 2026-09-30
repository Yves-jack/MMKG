#!/usr/bin/env python3
"""导出实体重要性前端展示数据 → data/viz/{course}/importance_showcase.json"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

VERDICTS = {
    "1": ("好", "命题逻辑居首，章主题明确"),
    "2": ("好", "谓词逻辑+论域+谓词，贴合第4章"),
    "3": ("较好", "论域/谓词逻辑/一阶语言均为谓词章核心"),
    "4": ("好", "命题逻辑+联结词+命题公式"),
    "6": ("好", "命题逻辑居首"),
    "7": ("好", "命题逻辑+公理+公理系统"),
    "9": ("好", "同公理化单元"),
    "10": ("中", "谓词逻辑对，集合挤进 Top2"),
    "11": ("中", "谓词逻辑对，书名 hub 偏高"),
    "12": ("中偏上", "谓词逻辑居首，集合略高"),
    "13": ("中", "集合论进 Top2，数理逻辑占 Top1"),
    "14": ("好", "集合论→集合，已纠正命题污染"),
    "16": ("好", "关系居首"),
    "18": ("好", "关系居首"),
    "19": ("较好", "函数在 Top2，集合作基础词合理"),
    "25": ("中", "集合对；定理/公理系统偏泛"),
    "26": ("中", "集合对，联结词噪声仍在"),
}


def _zh(name: str) -> str:
    return (name or "").split("/")[0].strip()


def chapter_keys(ch: str) -> list[str]:
    bare = re.sub(r"^第\s*\d+\s*章\s*", "", ch).strip()
    parts = re.split(r"[与和及、,，/\s]+", bare)
    keys = [p for p in parts if len(p) >= 2]
    if bare and bare not in keys:
        keys.insert(0, bare)
    stems = []
    for s in (
        "命题逻辑",
        "谓词逻辑",
        "集合论",
        "集合",
        "关系",
        "函数",
        "公理",
        "等值",
        "推理",
        "基数",
        "实数",
        "一阶",
        "模型",
    ):
        if any(s in k or k in s for k in keys + [bare]):
            stems.append(s)
    return list(dict.fromkeys(keys + stems))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--course", default="数理逻辑")
    args = ap.parse_args()

    course = args.course
    fb_path = ROOT / "data/kg" / course / "entity_importance_feedback.json"
    summary_path = (
        ROOT / "data/experiments/comparisons" / course / "importance_p3" / "summary.json"
    )
    tb = ROOT / "data/textbook/CS2501-离散数学（数理逻辑与集合论）"
    bundle_path = tb / "importance_bundle.json"

    fb = json.loads(fb_path.read_text(encoding="utf-8"))
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    chapters = []
    if bundle_path.is_file():
        chapters = list(
            json.loads(bundle_path.read_text(encoding="utf-8")).get("chapter_order") or []
        )

    global_top = []
    for i, x in enumerate(fb.get("top") or [], 1):
        global_top.append(
            {
                "rank": i,
                "name": x.get("name"),
                "zh": x.get("zh") or _zh(x.get("name") or ""),
                "score": x.get("importance"),
                "base": x.get("base_norm"),
                "classroom": x.get("classroom_norm"),
            }
        )

    lectures = []
    grade_counts: dict[str, int] = {}
    for row in summary:
        lid = str(row["lecture_id"])
        grade, note = VERDICTS.get(lid, ("—", ""))
        grade_counts[grade] = grade_counts.get(grade, 0) + 1
        # richer top from feedback file if present
        top5 = list(row.get("top5") or [])
        fpath = Path(row.get("path") or "")
        top_detail = []
        if fpath.is_file():
            detail = json.loads(fpath.read_text(encoding="utf-8"))
            for j, x in enumerate((detail.get("top") or [])[:12], 1):
                top_detail.append(
                    {
                        "rank": j,
                        "zh": x.get("zh") or _zh(x.get("name") or ""),
                        "score": x.get("importance"),
                        "base": x.get("base_norm"),
                        "classroom": x.get("classroom_norm"),
                    }
                )
        else:
            for j, zh in enumerate(top5, 1):
                top_detail.append({"rank": j, "zh": zh, "score": None})

        lectures.append(
            {
                "id": lid,
                "chapters": row.get("chapters") or [],
                "alpha_base": row.get("alpha_base"),
                "alpha_used": round(float(row.get("alpha_used") or 0), 3),
                "jaccard": row.get("jaccard"),
                "grade": grade,
                "note": note,
                "top": top_detail,
            }
        )

    # TOC alignment against global top40
    top40 = global_top[:40]
    toc_rows = []
    for ch in chapters:
        keys = chapter_keys(ch)
        hits = []
        for item in top40:
            zh = item["zh"]
            if any(k in zh or zh in k for k in keys):
                hits.append(
                    {"rank": item["rank"], "zh": zh, "score": item["score"]}
                )
        toc_rows.append(
            {
                "chapter": ch,
                "keywords": keys[:6],
                "hits": hits[:6],
                "hit_count": len(hits),
                "best_rank": hits[0]["rank"] if hits else None,
            }
        )

    payload = {
        "courseId": course,
        "title": "数理逻辑与集合论",
        "subtitle": "教材先验 × 课堂时长融合 · 实体重要性",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "meta": {
            "n_lectures": (fb.get("meta") or {}).get("n_lectures") or len(lectures),
            "entity_count": fb.get("entity_count") or len(fb.get("scores") or {}),
            "alpha": fb.get("alpha"),
            "merge": (fb.get("meta") or {}).get("merge") or "duration_weighted",
            "method": "分章 Biased-PPR 先验 + 课堂反馈 + 自适应 α + IDF + 章外衰减",
        },
        "grade_counts": grade_counts,
        "global": {"top": global_top[:40]},
        "lectures": lectures,
        "toc": {"chapters": toc_rows},
        "notes": [
            "分讲次视图按主章对齐；全局视图为 17 讲时长加权合并，贯穿词会自然抬高。",
            "与目录比：命题/谓词/集合/关系主脊梁对齐；函数与基数偏弱；证明论章几乎未单独体现。",
        ],
    }

    out = ROOT / "data/viz" / course / "importance_showcase.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out} (lectures={len(lectures)} global_top={len(global_top[:40])})")


if __name__ == "__main__":
    main()
