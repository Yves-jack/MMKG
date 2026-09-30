"""OpenCV I/O helpers that work with non-ASCII paths on Windows."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def imread_unicode(path: str | Path, flags: int = cv2.IMREAD_COLOR) -> np.ndarray | None:
    """Read an image; unlike cv2.imread, supports Chinese/Unicode paths on Windows."""
    path = Path(path)
    if not path.is_file():
        return None
    try:
        data = np.fromfile(str(path), dtype=np.uint8)
    except OSError:
        return None
    if data.size == 0:
        return None
    return cv2.imdecode(data, flags)


def imwrite_unicode(path: str | Path, image: np.ndarray) -> bool:
    """Write an image; unlike cv2.imwrite, supports Chinese/Unicode paths on Windows."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    ext = path.suffix.lower() or ".jpg"
    ok, buf = cv2.imencode(ext, image)
    if not ok:
        return False
    try:
        path.write_bytes(buf.tobytes())
    except OSError:
        return False
    return path.is_file()
