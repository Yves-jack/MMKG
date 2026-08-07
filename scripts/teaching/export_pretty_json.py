#!/usr/bin/env python
"""把 data 下结果 jsonl 导出为缩进 JSON，写入 data/pretty_view（与原结果分离）。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.utils.io import (
    configure_pretty_export,
    load_jsonl,
    pretty_json_path,
    save_json,
)

# 跳过示例/schema，只处理流水线结果
_SKIP_NAME_PARTS = (
    "schema.example",
    "corpus_schema",
    "qa_schema",
)


def _should_export(path: Path) -> bool:
    name = path.name.lower()
    if not name.endswith(".jsonl"):
        return False
    return not any(part in name for part in _SKIP_NAME_PARTS)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        default=str(ROOT / "configs/teaching.yaml"),
        help="配置文件（读取 pretty_dir / data_dir）",
    )
    parser.add_argument(
        "--clean-sidecar",
        action="store_true",
        default=True,
        help="删除结果目录旁旧的 *.pretty.json（默认开启）",
    )
    parser.add_argument(
        "--no-clean-sidecar",
        action="store_false",
        dest="clean_sidecar",
    )
    args = parser.parse_args()

    cfg = TeachKGConfig.from_yaml(args.config)
    data_dir = (ROOT / cfg.data_dir).resolve()
    pretty_dir = (ROOT / cfg.pretty_dir).resolve()
    configure_pretty_export(pretty_dir=pretty_dir, data_dir=data_dir)

    if args.clean_sidecar:
        removed = 0
        for stale in data_dir.rglob("*.pretty.json"):
            stale.unlink()
            removed += 1
            print(f"removed sidecar {stale.relative_to(ROOT)}")
        print(f"removed {removed} sidecar *.pretty.json")

    exported = 0
    for path in sorted(data_dir.rglob("*.jsonl")):
        if not _should_export(path):
            continue
        items = load_jsonl(path)
        out = pretty_json_path(path)
        save_json(out, items)
        print(f"wrote {out.relative_to(ROOT)}  (n={len(items)})")
        exported += 1

    print(f"done: exported {exported} files -> {pretty_dir.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
