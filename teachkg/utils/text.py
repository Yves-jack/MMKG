"""轻量文本统计工具（避免 textbook_kg ↔ stage1 循环导入）。"""

from __future__ import annotations

import re


def count_text_words(text: str) -> int:
    """统计文本「词」数：拉丁词 + 每个 CJK 字符计 1（适配无空格中文 ASR）。"""
    s = text or ""
    if not s.strip():
        return 0
    latin = re.findall(r"[A-Za-z0-9]+(?:'[A-Za-z]+)?", s)
    cjk = re.findall(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", s)
    if cjk:
        return len(latin) + len(cjk)
    return len(re.findall(r"\w+", s, flags=re.UNICODE))
