"""时间格式工具（改编自 AI-Teaching process/utils.py）。"""

from __future__ import annotations

import re


def sec2hms(seconds: float) -> str:
    """秒 → SRT 时间戳 HH:MM:SS,mmm。"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    sec = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{int(sec):06.3f}".replace(".", ",")


def ms2sec(time_str: str) -> int:
    """MM:SS → 秒。"""
    m, s = map(int, time_str.split(":"))
    return m * 60 + s


def sec2ms(seconds: float) -> str:
    """秒 → MM:SS。"""
    total = int(seconds)
    return f"{total // 60:02d}:{total % 60:02d}"


def any2sec(time_str: str) -> float:
    """多种时间字符串 → 秒（浮点）。"""
    s = (time_str or "").strip()
    if not s:
        return 0.0

    s = s.replace(",", ".")
    if "." in s and ":" not in s:
        return float(s)

    if s.isdigit():
        return float(s)

    if " --> " in s:
        s = s.split(" --> ")[0].strip()

    if "-" in s and ":" in s:
        s = s.split("-")[0].strip()

    # HH:MM:SS.mmm or MM:SS
    parts = s.split(":")
    try:
        if len(parts) == 3:
            h, m, sec = parts
            sec = float(sec)
            return int(h) * 3600 + int(m) * 60 + sec
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
    except ValueError:
        pass

    match = re.search(r"(\d+(?:\.\d+)?)", s)
    return float(match.group(1)) if match else 0.0


def parse_time_nodes_file(path: str) -> list[float]:
    """解析 PPT 翻页时间节点文件（每行 MM:SS 或秒数）。"""
    points: list[float] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            points.append(any2sec(line))
    return sorted(set(points))
