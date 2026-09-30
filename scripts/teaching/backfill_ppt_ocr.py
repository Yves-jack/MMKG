"""为已有 Stage0 OCR 帧补写 ppt_ocr.json（供 Stage1 抽取拼接）。

例：
  python scripts/teaching/backfill_ppt_ocr.py --course-id 离散数学(图论+数理逻辑与集合论) --lecture-id 1
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill Stage0 ppt_ocr.json from frames")
    parser.add_argument("--config", default="configs/teaching_lisan.yaml")
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--lecture-id", action="append", default=None)
    parser.add_argument("--force", action="store_true", help="overwrite existing ppt_ocr.json")
    args = parser.parse_args()

    from teachkg.config import TeachKGConfig
    from teachkg.models.qwen_vl_ocr import QwenVLOCRModel

    cfg = TeachKGConfig.from_yaml(str(ROOT / args.config))
    segments = Path(cfg.get("project", "segments_dir", default="data/segments"))
    if not segments.is_absolute():
        segments = ROOT / segments
    corr = cfg.get("stage0", "pipeline", "correction", default={}) or {}
    ocr = QwenVLOCRModel(
        api_key=corr.get("api_key"),
        base_url=corr.get("base_url"),
        model=corr.get("ocr_model", "qwen-vl-ocr"),
    )

    course = args.course_id
    asr_root = segments / course / "asr_work"
    if not asr_root.is_dir():
        raise SystemExit(f"asr_work missing: {asr_root}")
    lecture_ids = args.lecture_id or sorted(
        d.name for d in asr_root.iterdir() if d.is_dir()
    )

    for lid in lecture_ids:
        ocr_dir = asr_root / lid / "ocr"
        out = ocr_dir / "ppt_ocr.json"
        if out.is_file() and not args.force:
            print(f"[skip] {lid}: {out.name} exists")
            continue
        if not ocr_dir.is_dir():
            print(f"[skip] {lid}: no ocr dir")
            continue
        pages: dict[str, str] = {}
        for frame in sorted(ocr_dir.glob("ppt_page_*.jpg")):
            # ppt_page_012.jpg / ppt_page_012_0.jpg
            stem = frame.stem  # ppt_page_012
            try:
                idx = int(stem.split("_")[2][:3])
            except (IndexError, ValueError):
                continue
            try:
                text = (ocr.extract_text(frame) or "").strip()
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] {lid} page {idx}: {exc}")
                continue
            if text:
                pages[str(idx)] = text
                print(f"[ok] {lid} page {idx}: {len(text)} chars")
        if not pages:
            print(f"[skip] {lid}: no OCR text")
            continue
        ocr_dir.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps({"pages": pages}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"[done] {lid}: {len(pages)} pages → {out}")


if __name__ == "__main__":
    main()
