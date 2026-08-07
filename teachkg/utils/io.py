from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

# 可读 JSON 根目录与 data 根目录；可由配置注入。
_PRETTY_ROOT: Path | None = None
_DATA_ROOT: Path | None = None


def configure_pretty_export(
    *,
    pretty_dir: str | Path | None = None,
    data_dir: str | Path | None = None,
) -> None:
    """设置可读结果导出位置（与 jsonl 结果分开放置）。"""
    global _PRETTY_ROOT, _DATA_ROOT
    _PRETTY_ROOT = Path(pretty_dir) if pretty_dir else None
    _DATA_ROOT = Path(data_dir) if data_dir else None


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    return items


def pretty_json_path(path: str | Path) -> Path:
    """jsonl 对应的可读 JSON 路径：镜像到 pretty_dir，后缀改为 .json。"""
    path = Path(path)
    pretty_root = _PRETTY_ROOT or Path("data/pretty_view")
    data_root = _DATA_ROOT or Path("data")

    resolved = path
    try:
        # 未 resolve 前先尝试相对 data_root（便于测试用相对路径）
        rel = path.relative_to(data_root)
    except ValueError:
        try:
            rel = path.resolve().relative_to(data_root.resolve())
        except ValueError:
            # 不在 data/ 下时，退回 sibling：foo.jsonl → view/foo.json 不易定位，
            # 仍写到 pretty_root/_external/...
            rel = Path("_external") / path.name
            return (pretty_root / rel).with_suffix(".json")

    return (pretty_root / rel).with_suffix(".json")


def save_json(
    path: str | Path,
    data: Any,
    *,
    indent: int = 2,
) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=indent)
        f.write("\n")


def save_jsonl(
    path: str | Path,
    records: Iterable[dict[str, Any]],
    *,
    pretty: bool = True,
    indent: int = 2,
) -> None:
    """写入 JSONL；默认另存一份缩进 JSON 到 pretty_view，与结果目录分离。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    items = list(records)
    with open(path, "w", encoding="utf-8") as f:
        for record in items:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    if pretty:
        save_json(pretty_json_path(path), items, indent=indent)
