"""从教材 OCR Markdown 提取近似目录（优先「目录」页，否则用正文标题层级）。"""

from __future__ import annotations

import re
from pathlib import Path

_CHAPTER = re.compile(r"^第\s*(\d+)\s*章\s*(.+)$")
_SECTION = re.compile(r"^(\d+(?:\.\d+)+)\s+(.+)$")
_PAGE_TAIL = re.compile(r"\s+\d+\s*$")
_LATEX = re.compile(r"\$[^$]*\$")
_EXERCISE = re.compile(r"^习题\s*\d+")
_SKIP_TITLES = frozenset(
    {
        "概述",
        "目录",
        "前言",
        "再版前言",
        "内容简介",
        "参考文献",
        "索引",
    }
)


def _clean_title(raw: str) -> str:
    text = _LATEX.sub("", raw)
    text = _PAGE_TAIL.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    # OCR 常见噪声
    text = text.replace("—", "-").replace("–", "-")
    return text


def _heading_depth_from_number(num: str) -> int:
    """1.2 → 3, 1.2.3 → 4（与 markdown # 层大致对齐：章=2）。"""
    parts = [p for p in num.split(".") if p]
    return 1 + len(parts)  # 章用 2；一节 3；二节 4 …


def extract_toc_from_catalog_block(text: str) -> list[tuple[int, str]]:
    """解析「## 目录」到正文开始之间的纯文本目录行。"""
    lines = text.splitlines()
    start = None
    for i, line in enumerate(lines):
        s = line.strip()
        if re.match(r"^#{1,3}\s*目录\s*$", s) or s == "目录":
            start = i + 1
            break
    if start is None:
        return []

    items: list[tuple[int, str]] = []
    for line in lines[start:]:
        s = line.strip()
        if not s or s.startswith("<---"):
            continue
        # 目录结束后进入正文常见标志
        if re.match(r"^#{1,2}\s*概述\s*$", s):
            break
        if re.match(r"^#{1,2}\s*第\s*1\s*章", s) and items:
            # 有的 OCR 目录后紧接正文同标题，已收集则停
            break
        if s.startswith("#"):
            # 目录块内偶发带 # 的章标题（如第5章）
            s = re.sub(r"^#{1,6}\s*", "", s).strip()

        title = _clean_title(s)
        if not title or _EXERCISE.match(title):
            continue
        if title in _SKIP_TITLES:
            continue

        m_ch = _CHAPTER.match(title)
        if m_ch:
            items.append((2, f"第{m_ch.group(1)}章 {m_ch.group(2).strip()}"))
            continue
        m_sec = _SECTION.match(title)
        if m_sec:
            num, name = m_sec.group(1), m_sec.group(2).strip()
            # 跳过误识别的过深噪声（>3 级节号少见且 OCR 易错）
            if num.count(".") > 2:
                continue
            depth = _heading_depth_from_number(num)
            items.append((depth, f"{num} {name}"))
            continue
    return items


def extract_toc_from_body_headings(text: str) -> list[tuple[int, str]]:
    """回退：从正文 markdown 标题中抽第X章 / a.b 编号标题。"""
    items: list[tuple[int, str]] = []
    seen: set[str] = set()
    for line in text.splitlines():
        m = re.match(r"^(#{1,6})\s+(.+)$", line.strip())
        if not m:
            continue
        title = _clean_title(m.group(2))
        if not title or _EXERCISE.match(title) or title in _SKIP_TITLES:
            continue
        m_ch = _CHAPTER.match(title)
        if m_ch:
            key = f"ch:{m_ch.group(1)}"
            if key in seen:
                continue
            seen.add(key)
            items.append((2, f"第{m_ch.group(1)}章 {m_ch.group(2).strip()}"))
            continue
        m_sec = _SECTION.match(title)
        if m_sec:
            num, name = m_sec.group(1), m_sec.group(2).strip()
            if num.count(".") > 2:
                continue
            key = f"sec:{num}"
            if key in seen:
                continue
            seen.add(key)
            items.append((_heading_depth_from_number(num), f"{num} {name}"))
    return items


def extract_toc_items(text: str) -> list[tuple[int, str]]:
    items = extract_toc_from_catalog_block(text)
    if len(items) >= 10:
        return items
    return extract_toc_from_body_headings(text)


def toc_items_to_markdown(items: list[tuple[int, str]]) -> str:
    # 不用 # 一级标题，避免被记成 major 种子
    lines = ["<!-- 教材目录（自 OCR 提取） -->", ""]
    for level, title in items:
        # clamp 2..4 → ## / ### / ####
        hashes = "#" * max(2, min(level, 4))
        lines.append(f"{hashes} {title}")
    lines.append("")
    return "\n".join(lines)


def extract_toc_file(ocr_md: Path, out_toc: Path | None = None) -> str:
    text = ocr_md.read_text(encoding="utf-8", errors="replace")
    items = extract_toc_items(text)
    md = toc_items_to_markdown(items)
    if out_toc is not None:
        out_toc.parent.mkdir(parents=True, exist_ok=True)
        out_toc.write_text(md, encoding="utf-8")
    return md


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="从教材 OCR md 提取 toc.md")
    parser.add_argument("--ocr-md", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    md = extract_toc_file(args.ocr_md, args.out)
    n = sum(1 for line in md.splitlines() if line.startswith("#"))
    print(f"Extracted {n} headings -> {args.out}")


if __name__ == "__main__":
    main()
