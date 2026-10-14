"""为已有 Stage0 OCR 帧补写 ppt_ocr.json（供 Stage1 抽取 / 章节骨架）。

支持断点续跑：已有 pages 会跳过对应帧。

例：
  python scripts/teaching/backfill_ppt_ocr.py --course-id 离散数学(图论+数理逻辑与集合论)
  python scripts/teaching/backfill_ppt_ocr.py --course-id 离散数学(图论+数理逻辑与集合论) --lecture-id 1
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _frame_page_idx(frame: Path) -> int | None:
    # ppt_page_012.jpg / ppt_page_012_0.jpg
    parts = frame.stem.split("_")
    if len(parts) < 3:
        return None
    try:
        return int(parts[2][:3])
    except ValueError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill Stage0 ppt_ocr.json from frames")
    parser.add_argument("--config", default="configs/teaching_lisan.yaml")
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--lecture-id", action="append", default=None)
    parser.add_argument("--force", action="store_true", help="overwrite existing page texts")
    args = parser.parse_args()

    from teachkg.config import TeachKGConfig
    from teachkg.models.qwen_vl_ocr import QwenVLOCRModel
    from teachkg.utils.env import load_project_env

    load_project_env()
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

    total_ok = total_skip = total_fail = 0
    t0 = time.time()

    for lid in lecture_ids:
        ocr_dir = asr_root / lid / "ocr"
        out = ocr_dir / "ppt_ocr.json"
        if not ocr_dir.is_dir():
            print(f"[skip] {lid}: no ocr dir")
            continue

        pages: dict[str, str] = {}
        if out.is_file() and not args.force:
            try:
                raw = json.loads(out.read_text(encoding="utf-8"))
                pages = {
                    str(k): str(v)
                    for k, v in (raw.get("pages") or {}).items()
                    if str(v).strip()
                }
            except Exception:  # noqa: BLE001
                pages = {}

        frames = sorted(ocr_dir.glob("ppt_page_*.jpg"))
        if not frames:
            print(f"[skip] {lid}: no frames")
            continue

        lid_ok = lid_skip = lid_fail = 0
        for frame in frames:
            idx = _frame_page_idx(frame)
            if idx is None:
                continue
            key = str(idx)
            if key in pages and not args.force:
                lid_skip += 1
                continue
            try:
                result = ocr.extract_text(frame)
                text = (result.text if hasattr(result, "text") else str(result) or "").strip()
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] {lid} page {idx}: {exc}")
                lid_fail += 1
                continue
            if text:
                pages[key] = text
                lid_ok += 1
                print(f"[ok] {lid} page {idx}: {len(text)} chars")
                # 每页落盘，便于断点续跑
                ocr_dir.mkdir(parents=True, exist_ok=True)
                out.write_text(
                    json.dumps({"pages": pages}, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            else:
                print(f"[empty] {lid} page {idx}")
                lid_fail += 1

        total_ok += lid_ok
        total_skip += lid_skip
        total_fail += lid_fail
        print(
            f"[done] {lid}: pages={len(pages)} new={lid_ok} skip={lid_skip} fail={lid_fail} → {out.name}"
        )

    elapsed = time.time() - t0
    print(
        f"\nall done: new={total_ok} skip={total_skip} fail={total_fail} "
        f"elapsed={elapsed:.0f}s"
    )


if __name__ == "__main__":
    main()
