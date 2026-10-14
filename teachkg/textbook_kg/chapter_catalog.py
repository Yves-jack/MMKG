"""教材 toc.md → 分主题（分册）的章节目录。

合并课（图论 + 数理逻辑）的 toc 里会有两个「第1章」；
用 `<!-- from … -->` 注释或独立 toc 划分主题，供资产库 / 导图规划与展示排序。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


_PART_FROM_RE = re.compile(
    r"<!--\s*from\s+(.+?)\s*-->",
    re.IGNORECASE,
)
_PART_TITLE_RE = re.compile(r"[（(]([^）)]+)[）)]\s*$")
_CHAPTER_RE = re.compile(r"^#{1,3}\s*(第\s*\d+\s*章\s*.+)$")
_SECTION_RE = re.compile(r"^#{2,4}\s*((?:\d+\.)+\d*\s*.+)$")
_CHAPTER_NUM_RE = re.compile(r"第\s*(\d+)\s*章")


def part_title_from_source(source: str) -> str:
    """从路径或注释文本抽出分册名，如「图论与代数结构」。"""
    text = (source or "").strip().replace("\\", "/")
    base = text.rstrip("/").split("/")[-1]
    base = re.sub(r"^CS\d+[-\s]*", "", base, flags=re.IGNORECASE)
    base = re.sub(r"^离散数学", "", base).strip(" -_（）()")
    m = _PART_TITLE_RE.search(text)
    if m:
        return m.group(1).strip()
    if base:
        return base
    return text or "未命名分册"


def part_id_from_title(title: str) -> str:
    t = (title or "").strip()
    if re.search(r"图论|代数结构|匹配|网络流", t):
        return "graph"
    if re.search(r"数理逻辑|命题|谓词|集合论|关系|函数|基数", t):
        return "logic"
    slug = re.sub(r"[^\w\u4e00-\u9fff]+", "_", t).strip("_").lower()
    return slug[:32] or "part"


def _normalize_chapter_title(raw: str) -> str:
    t = (raw or "").strip()
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"^第\s*(\d+)\s*章\s*", lambda m: f"第{m.group(1)}章 ", t)
    return t.strip()


def parse_toc_markdown(md_text: str, *, default_part: str | None = None) -> list[dict[str, Any]]:
    """解析 toc.md，返回按出现顺序的 part 列表。

    每个 part: {title, source, chapters: [{name, number, sections: [str]}]}
    """
    parts: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    current_chapter: dict[str, Any] | None = None

    def ensure_part(title: str, source: str = "") -> dict[str, Any]:
        nonlocal current, current_chapter
        current_chapter = None
        current = {
            "id": part_id_from_title(title),
            "title": title,
            "source": source,
            "chapters": [],
        }
        parts.append(current)
        return current

    if default_part:
        ensure_part(default_part, default_part)

    for line in (md_text or "").splitlines():
        raw = line.strip()
        if not raw:
            continue
        m_from = _PART_FROM_RE.search(raw)
        if m_from:
            src = m_from.group(1).strip()
            ensure_part(part_title_from_source(src), src)
            continue
        if raw.startswith("<!--"):
            continue

        m_ch = _CHAPTER_RE.match(raw)
        if m_ch:
            if current is None:
                ensure_part(default_part or "教材", default_part or "")
            assert current is not None
            title = _normalize_chapter_title(m_ch.group(1))
            num_m = _CHAPTER_NUM_RE.search(title)
            current_chapter = {
                "name": title,
                "number": int(num_m.group(1)) if num_m else None,
                "sections": [],
            }
            current["chapters"].append(current_chapter)
            continue

        m_sec = _SECTION_RE.match(raw)
        if m_sec and current_chapter is not None:
            sec = re.sub(r"\s+", " ", m_sec.group(1)).strip()
            if sec:
                current_chapter["sections"].append(sec)

    # 去掉空分册
    return [p for p in parts if p.get("chapters")]


def load_toc_parts(toc_path: Path, *, default_part: str | None = None) -> list[dict[str, Any]]:
    if not toc_path.is_file():
        return []
    text = toc_path.read_text(encoding="utf-8")
    title = default_part or part_title_from_source(str(toc_path.parent.name))
    return parse_toc_markdown(text, default_part=title)


def merge_part_lists(*part_lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按分册 id 合并，同 id 章节去重保序。"""
    by_id: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for parts in part_lists:
        for part in parts:
            pid = str(part.get("id") or part_id_from_title(str(part.get("title") or "")))
            if pid not in by_id:
                by_id[pid] = {
                    "id": pid,
                    "title": part.get("title") or pid,
                    "source": part.get("source") or "",
                    "chapters": [],
                }
                order.append(pid)
            seen = {c["name"] for c in by_id[pid]["chapters"]}
            for ch in part.get("chapters") or []:
                name = str(ch.get("name") or "").strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                by_id[pid]["chapters"].append(ch)
    return [by_id[i] for i in order]


def build_chapter_catalog(
    *,
    textbook_dir: Path | None = None,
    toc_path: Path | None = None,
    merge_meta: dict[str, Any] | None = None,
    course_id: str | None = None,
    repo_root: Path | None = None,
) -> dict[str, Any]:
    """构建课程章节目录（含主题分册）。

    优先按 merge_meta.merged_from 各分册 toc；否则解析合并 toc（支持 `<!-- from … -->`）。
    """
    parts: list[dict[str, Any]] = []
    tb = Path(textbook_dir) if textbook_dir else None
    toc = Path(toc_path) if toc_path else (tb / "toc.md" if tb else None)
    root = Path(repo_root) if repo_root else None

    meta = merge_meta
    if meta is None and tb and (tb / "merge_meta.json").is_file():
        import json

        meta = json.loads((tb / "merge_meta.json").read_text(encoding="utf-8"))

    merged_from = list((meta or {}).get("merged_from") or [])
    if merged_from:
        for rel in merged_from:
            p = Path(rel)
            if not p.is_absolute():
                if root is not None:
                    p = root / rel
                elif tb is not None:
                    p = (tb / rel).resolve()
            if p.is_dir():
                title = part_title_from_source(p.name)
                parts.extend(load_toc_parts(p / "toc.md", default_part=title))
            elif p.is_file() and p.name.endswith(".md"):
                parts.extend(load_toc_parts(p, default_part=part_title_from_source(p.stem)))
        parts = merge_part_lists(parts)

    if not parts and toc and toc.is_file():
        parts = parse_toc_markdown(
            toc.read_text(encoding="utf-8"),
            default_part=part_title_from_source(tb.name if tb else "教材"),
        )

    chapter_order: list[str] = []
    chapter_to_part: dict[str, str] = {}
    for part in parts:
        for ch in part.get("chapters") or []:
            name = str(ch.get("name") or "").strip()
            if not name:
                continue
            if name not in chapter_to_part:
                chapter_order.append(name)
                chapter_to_part[name] = str(part.get("id") or "")
            ch["part_id"] = part.get("id")
            ch["part_title"] = part.get("title")

    return {
        "course_id": course_id,
        "source_toc": str(toc) if toc else None,
        "n_parts": len(parts),
        "n_chapters": len(chapter_order),
        "parts": parts,
        "chapter_order": chapter_order,
        "chapter_to_part": chapter_to_part,
    }


def chapter_sort_key(name: str, catalog: dict[str, Any] | None = None) -> tuple:
    """展示排序：分册顺序 → 章号 → 名称。"""
    order = list((catalog or {}).get("chapter_order") or [])
    if name in order:
        return (0, order.index(name), name)
    parts = list((catalog or {}).get("parts") or [])
    part_ids = [str(p.get("id") or "") for p in parts]
    pid = str((catalog or {}).get("chapter_to_part", {}).get(name) or "")
    try:
        pi = part_ids.index(pid) if pid in part_ids else 99
    except ValueError:
        pi = 99
    m = _CHAPTER_NUM_RE.search(name or "")
    num = int(m.group(1)) if m else 10_000
    return (1, pi, num, name)
