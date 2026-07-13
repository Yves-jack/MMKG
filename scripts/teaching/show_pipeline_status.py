#!/usr/bin/env python
"""查看课程/讲次流水线进度。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _checkpoint_progress(work_dir: Path) -> str:
    ck = work_dir / "raw_cues.checkpoint.json"
    if not ck.is_file():
        vad = work_dir / "vad_segments.json"
        if vad.is_file():
            n = len(json.loads(vad.read_text(encoding="utf-8")))
            return f"ASR 未开始 (VAD {n} 段)"
        return "未开始"
    data = json.loads(ck.read_text(encoding="utf-8"))
    next_idx = int(data.get("next_index", 0))
    vad_n = len(json.loads((work_dir / "vad_segments.json").read_text(encoding="utf-8"))) if (work_dir / "vad_segments.json").is_file() else "?"
    return f"ASR {next_idx}/{vad_n}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Show teaching pipeline status")
    parser.add_argument("--course-id", default="shuliluoji")
    args = parser.parse_args()

    seg = ROOT / "data" / "segments" / args.course_id
    kg = ROOT / "data" / "kg" / args.course_id
    idx = ROOT / "data" / "index" / args.course_id
    viz = ROOT / "data" / "viz" / args.course_id

    print(f"=== {args.course_id} 流水线状态 ===\n")

    manifest = seg / "stage0_manifest.json"
    per_lecture: set[str] = set()
    if manifest.is_file():
        m = json.loads(manifest.read_text(encoding="utf-8"))
        print(f"Stage 0 cues: {m.get('segment_count', 0)} 条（manifest）")
        per_lecture.update((m.get("per_lecture") or {}).keys())
    asr_root = seg / "asr_work"
    if asr_root.is_dir():
        per_lecture.update(p.name for p in asr_root.iterdir() if p.is_dir())

    for lid in sorted(per_lecture, key=lambda x: int(x) if str(x).isdigit() else str(x)):
        corrected = seg / "asr_work" / lid / "corrected_cues.json"
        if corrected.is_file():
            n = len(json.loads(corrected.read_text(encoding="utf-8")).get("cues", []))
            print(f"  讲次 {lid}: corrected_cues ✓ ({n} 段)")
        else:
            print(f"  讲次 {lid}: {_checkpoint_progress(seg / 'asr_work' / lid)}")
    if not per_lecture:
        print("Stage 0: 未开始")

    triplets = kg / "triplets.jsonl"
    if triplets.is_file():
        n = sum(1 for line in triplets.read_text(encoding="utf-8").splitlines() if line.strip())
        print(f"\nStage 1 triplets.jsonl: {n} 条")
    else:
        print("\nStage 1: 未完成")

    for lec_dir in sorted(kg.glob("lecture_*")):
        lid = lec_dir.name.replace("lecture_", "")
        kg_f = lec_dir / "kg.json"
        mmkg_f = lec_dir / "mmkg.json"
        index_f = idx / lec_dir.name / "mmkg_index" / "manifest.json"
        html_f = viz / f"lecture_{lid}_mmkg.html"
        parts = []
        if kg_f.is_file():
            d = json.loads(kg_f.read_text(encoding="utf-8"))
            parts.append(f"KG {d.get('entity_count', '?')}实体/{d.get('edge_count', '?')}边")
        if mmkg_f.is_file():
            parts.append("MMKG ✓")
        if index_f.is_file():
            m = json.loads(index_f.read_text(encoding="utf-8"))
            parts.append(f"索引 {m.get('record_count', '?')}条")
        if html_f.is_file():
            parts.append("可视化 ✓")
        print(f"  讲次 {lid}: {' | '.join(parts) if parts else 'Stage 2+ 未完成'}")

    course_kg = kg / "kg.json"
    course_mmkg = kg / "mmkg.json"
    course_idx = idx / "course" / "mmkg_index" / "manifest.json"
    course_html = viz / "course_mmkg.html"
    cparts = []
    if course_kg.is_file():
        d = json.loads(course_kg.read_text(encoding="utf-8"))
        cparts.append(f"KG {d.get('entity_count', '?')}实体/{d.get('edge_count', '?')}边")
    if course_mmkg.is_file():
        cparts.append("MMKG ✓")
    if course_idx.is_file():
        m = json.loads(course_idx.read_text(encoding="utf-8"))
        cparts.append(f"索引 {m.get('record_count', '?')}条")
    if course_html.is_file():
        cparts.append("可视化 ✓")
    if cparts:
        print(f"\n课程级: {' | '.join(cparts)}")

    quality = ROOT / "data" / "processed" / args.course_id / "triplet_quality_report.json"
    learning = ROOT / "data" / "processed" / args.course_id / "learning_path_course.json"
    export_dir = ROOT / "data" / "export" / args.course_id
    eval_file = ROOT / "data" / "eval" / args.course_id / "qa_eval.jsonl"
    extras = []
    if quality.is_file():
        extras.append("三元组质量报告 ✓")
    if learning.is_file():
        extras.append("学习路径 ✓")
    if export_dir.is_dir() and any(export_dir.glob("*")):
        extras.append("图谱导出 ✓")
    if eval_file.is_file():
        extras.append("RAG 评测集 ✓")
    if extras:
        print(f"\n扩展产物: {' | '.join(extras)}")


if __name__ == "__main__":
    main()
