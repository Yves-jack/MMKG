"""Stage1/2/3 产物复用：输入指纹校验（避免静默吃过期图谱）。

用法概要：
1. 产出时用 :func:`save_meta` 写入 sidecar（如 ``kg_input_meta.json``）；
2. 复用前用 :func:`can_reuse` 比较产物文件与当前输入指纹是否一致。
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)


def file_identity(path: Path) -> dict[str, Any] | None:
    """生成文件身份摘要（路径 + mtime_ns + size）。

    Args:
        path: 目标文件。

    Returns:
        含 ``path`` / ``mtime_ns`` / ``size`` 的字典；文件不存在返回 ``None``。
    """
    path = Path(path)
    if not path.is_file():
        return None
    st = path.stat()
    return {
        "path": str(path.resolve()),
        "mtime_ns": int(st.st_mtime_ns),
        "size": int(st.st_size),
    }


def hash_text(text: str) -> str:
    """对文本做 SHA-256 并截取前 16 位十六进制。

    Args:
        text: 任意 UTF-8 文本。

    Returns:
        16 字符短哈希。
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def hash_jsonl_rows(
    path: Path,
    *,
    lecture_id: str | None = None,
    fields: Iterable[str] | None = None,
) -> str:
    """对 JSONL 行做稳定内容哈希。

    Args:
        path: ``.jsonl`` 文件路径。
        lecture_id: 若给定，只哈希 ``lecture_id`` 匹配的行。
        fields: 若给定，每行只取这些字段再序列化（忽略其余键）。

    Returns:
        16 字符短哈希；文件不存在返回空串。
    """
    path = Path(path)
    if not path.is_file():
        return ""
    h = hashlib.sha256()
    keep = set(fields) if fields else None
    lid = str(lecture_id).strip() if lecture_id is not None else None
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if lid is not None and str(row.get("lecture_id", "")).strip() != lid:
                continue
            if keep is not None:
                payload = {k: row.get(k) for k in sorted(keep)}
            else:
                payload = row
            h.update(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8"))
            h.update(b"\n")
    return h.hexdigest()[:16]


def meta_matches(saved: dict[str, Any] | None, expected: dict[str, Any]) -> bool:
    """判断已存 meta 是否覆盖 expected 的全部键值。

    Args:
        saved: 磁盘上的 meta（可为 ``None``）。
        expected: 当前运行算出的期望指纹字段。

    Returns:
        ``saved`` 为 dict 且对每个 ``expected`` 键值相等时为 True。
    """
    if not isinstance(saved, dict):
        return False
    for key, value in expected.items():
        if saved.get(key) != value:
            return False
    return True


def load_meta(path: Path) -> dict[str, Any] | None:
    """读取 sidecar meta JSON。

    Args:
        path: meta 文件路径。

    Returns:
        字典；文件缺失或 JSON 非法时返回 ``None``（打 warning）。
    """
    path = Path(path)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Artifact meta unreadable (%s): %s", path, exc)
        return None
    return data if isinstance(data, dict) else None


def save_meta(path: Path, meta: dict[str, Any]) -> None:
    """写入 sidecar meta JSON（自动创建父目录）。

    Args:
        path: 目标路径。
        meta: 要持久化的指纹/配置摘要。
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def can_reuse(
    artifact_path: Path,
    meta_path: Path,
    expected: dict[str, Any],
    *,
    adopt_missing_meta: bool = True,
) -> bool:
    """判断产物是否可在当前输入指纹下复用。

    Args:
        artifact_path: 产物文件（如 ``kg.json`` / ``mmkg.json``）。
        meta_path: 旁路 meta 文件路径。
        expected: 当前输入算出的指纹字典。
        adopt_missing_meta: 为 True 时，产物在但 meta 缺失则写入 ``expected``
            并视为可复用（升级兼容）；为 False 时 meta 缺失一律重建
            （讲次级 Stage1 增量应使用 False，避免误跳过未处理讲）。

    Returns:
        可复用为 True；否则 False（调用方应重新计算产物）。
    """
    if not Path(artifact_path).is_file():
        return False
    saved = load_meta(meta_path)
    if saved is None:
        if adopt_missing_meta:
            logger.warning(
                "Artifact meta missing → adopt current fingerprint and reuse (%s)",
                meta_path,
            )
            save_meta(meta_path, expected)
            return True
        logger.info("Artifact meta missing → rebuild (%s)", meta_path)
        return False
    if not meta_matches(saved, expected):
        logger.info(
            "Artifact meta mismatch → rebuild (%s). saved_keys=%s",
            meta_path,
            sorted(saved.keys()),
        )
        return False
    return True
