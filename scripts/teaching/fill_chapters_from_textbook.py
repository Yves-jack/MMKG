#!/usr/bin/env python3
"""[DEPRECATED] 勿再运行：章大纲/章导图禁止用教材补。

历史用途：无课堂讲次时用教材 toc + 实体生成骨架。
现行约定见 .cursor/rules/mindmap-chapter-sources.mdc：
  只用课堂 PPT OCR / 人工大纲；学期未讲的章直接剔除（prune_untaught_chapters）。
"""

from __future__ import annotations

import sys


def main() -> int:
    print(
        "DEPRECATED: fill_chapters_from_textbook.py 已禁用（禁止教材补章）。\n"
        "请用: scripts/teaching/backfill_ppt_ocr.py\n"
        "然后: scripts/teaching/extract_taught_chapter_outlines.py",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
