#!/usr/bin/env python
"""导出教材知识图谱 showcase：多文件选择 + MD 分章 + extract 对齐。

扫描 AutoEduKG/data/processed 下各课程目录：
- 分章：content/ 多文件 或 主 MD 按「第N章」切分
- 对齐：extract chunk ∩ 章节 → triple.context ∩ 章节
- 输出：catalog.json + textbook_kg/{id}.json；并复制默认文件到 textbook_kg_showcase.json
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUTOEDU = ROOT.parent / "AutoEduKG"
DEFAULT_PROCESSED = AUTOEDU / "data" / "processed-former"
DEFAULT_EXTRACT_ROOT = AUTOEDU / "output" / "output-former"
DEFAULT_OUT_DIR = ROOT / "data" / "viz" / "数理逻辑" / "textbook_kg"
DEFAULT_LEGACY = ROOT / "data" / "viz" / "数理逻辑" / "textbook_kg_showcase.json"
# 当前试点：仅数理逻辑与集合论（processed 正式目录）
DEFAULT_COURSE = "CS2501-离散数学（数理逻辑与集合论）"
DEFAULT_FILE_ID = DEFAULT_COURSE

PRED_OK = {
    "belong_to",
    "part_of",
    "depend_on",
    "property_of",
    "synonym_of",
    "related_with",
}

CHAPTER_HEAD_RE = re.compile(
    r"^(#{1,2})\s*(第?\s*\d+\s*章[^\n]*)\s*$",
    re.M,
)
SECTION_CHAP_RE = re.compile(r"^#{1,4}\s*(\d+)\.(\d+)")
EXPLICIT_CHAP_RE = re.compile(r"^#{1,4}\s*第\s*(\d+)\s*章\s*(.*)$")


def chapter_num_of_heading(line: str) -> int | None:
    """标题行所属章号：第N章 或 N.x 小节。"""
    m = EXPLICIT_CHAP_RE.match(line.strip())
    if m:
        return int(m.group(1))
    m = SECTION_CHAP_RE.match(line.strip())
    if m:
        n = int(m.group(1))
        if 1 <= n <= 30:
            return n
    return None


def split_md_by_chapter_heads(text: str, *, fallback_title: str) -> list[dict]:
    """按章切分 MD。

    策略：
    1) 目录区提取章标题；
    2) 正文从第二次「第1章」起，按「第N章」或「N.x」小节标题归属聚合
       （正文缺章标题、小节交错时仍能凑齐各章）。
    """
    raw = (text or "").replace("\r\n", "\n")
    lines = raw.splitlines()
    if not lines:
        return []

    # 目录：文首连续的「第N章」标题
    toc_titles: dict[int, str] = {}
    first_ch1: int | None = None
    body_start: int | None = None
    for i, line in enumerate(lines):
        m = EXPLICIT_CHAP_RE.match(line.strip())
        if not m:
            continue
        n = int(m.group(1))
        title = re.sub(r"\s+", " ", line.strip().lstrip("#").strip())
        if n == 1:
            if first_ch1 is None:
                first_ch1 = i
            else:
                body_start = i
                break
        if n not in toc_titles:
            toc_titles[n] = title

    if body_start is None:
        # 无目录重复：从第一个第1章或全文开始
        body_start = first_ch1 if first_ch1 is not None else 0
        if not toc_titles:
            for i, line in enumerate(lines):
                m = EXPLICIT_CHAP_RE.match(line.strip())
                if m and int(m.group(1)) not in toc_titles:
                    toc_titles[int(m.group(1))] = re.sub(
                        r"\s+", " ", line.strip().lstrip("#").strip()
                    )

    # 正文按标题归属扫入各章缓冲（允许交错）
    buffers: dict[int, list[str]] = {}
    current: int | None = None
    for i in range(body_start, len(lines)):
        line = lines[i]
        n = chapter_num_of_heading(line)
        if n is not None:
            current = n
            if current not in buffers:
                buffers[current] = []
                # 若无显式第N章行，补一个标题
                if not EXPLICIT_CHAP_RE.match(line.strip()):
                    tit = toc_titles.get(current) or f"第{current}章"
                    buffers[current].append(f"## {tit}")
        if current is None:
            continue
        buffers.setdefault(current, []).append(line)

    chapters: list[dict] = []
    for n in sorted(buffers.keys()):
        body = format_slice_text("\n".join(buffers[n]))
        if len(body) < 80:
            continue
        title = toc_titles.get(n) or f"第{n}章"
        chapters.append(
            {
                "id": f"ch_{n}",
                "title": title,
                "chapter": str(n),
                "text": body,
            }
        )

    if chapters:
        return chapters

    # 回退：旧逻辑按显式第N章硬切
    matches = list(CHAPTER_HEAD_RE.finditer(raw))
    if not matches:
        body = format_slice_text(raw)
        if not body:
            return []
        return [
            {
                "id": "ch_all",
                "title": fallback_title,
                "chapter": "?",
                "text": body,
            }
        ]
    tmp: list[dict] = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
        title = re.sub(r"\s+", " ", m.group(2)).strip()
        num_m = re.search(r"(\d+)", title)
        num = num_m.group(1) if num_m else str(i + 1)
        body = format_slice_text(raw[start:end])
        if len(body) < 20:
            continue
        tmp.append(
            {"id": f"ch_{num}", "title": title, "chapter": num, "text": body}
        )
    best: dict[str, dict] = {}
    order: list[str] = []
    for c in tmp:
        key = c["chapter"]
        if key not in best:
            order.append(key)
            best[key] = c
        elif len(c["text"]) > len(best[key]["text"]):
            best[key] = c
    out = [best[k] for k in order if len(best[k]["text"]) >= 200]
    return out or [best[k] for k in order]


def zh(name: str) -> str:
    return (name or "").split("/")[0].strip()


def slug_id(name: str) -> str:
    """稳定文件 id：保留中文与字母数字。"""
    s = unicodedata.normalize("NFKC", name or "").strip()
    s = re.sub(r"[\\/:*?\"<>|]+", "_", s)
    s = re.sub(r"\s+", "_", s)
    return s[:80] or "file"


def format_slice_text(raw: str) -> str:
    t = (raw or "").replace("\r\n", "\n")
    t = re.sub(r"<---\s*Page Split\s*--->", "", t, flags=re.I)
    t = re.sub(r"^#{1,6}\s+", "", t, flags=re.M)
    t = re.sub(r"[ \t]+\n", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def content_only(s: str) -> str:
    return "".join(
        ch
        for ch in (s or "")
        if ("\u3400" <= ch <= "\u9fff")
        or ch.isalnum()
        or ch in "∧∨¬→↔∀∃∈⊆⊂∪∩×·∅"
    )


def _norm_for_match(s: str) -> str:
    punct = {
        "，": ",",
        "。": ".",
        "；": ";",
        "：": ":",
        "（": "(",
        "）": ")",
        "【": "[",
        "】": "]",
        "、": ",",
        "“": "'",
        "”": "'",
        "‘": "'",
        "’": "'",
        '"': "'",
        "＂": "'",
        "—": "-",
        "–": "-",
    }
    out: list[str] = []
    i = 0
    raw = s or ""
    while i < len(raw):
        ch = raw[i]
        if ch.isspace():
            i += 1
            continue
        if ch == "$":
            dbl = i + 1 < len(raw) and raw[i + 1] == "$"
            close = "$$" if dbl else "$"
            start = i + len(close)
            end = raw.find(close, start)
            if end >= 0:
                out.append(_norm_for_match(raw[start:end]))
                i = end + len(close)
                continue
        if ch == "\\" and i + 1 < len(raw) and raw[i + 1].isalpha():
            j = i + 1
            while j < len(raw) and raw[j].isalpha():
                j += 1
            cmd = raw[i + 1 : j].lower()
            sym = {
                "wedge": "∧",
                "vee": "∨",
                "land": "∧",
                "lor": "∨",
                "rightarrow": "→",
                "to": "→",
                "neg": "¬",
                "lnot": "¬",
            }.get(cmd)
            if sym:
                out.append(sym)
            i = j
            while i < len(raw) and raw[i] in "{}":
                i += 1
            continue
        if ch in "{}`*#~":
            i += 1
            continue
        out.append(punct.get(ch, ch))
        i += 1
    return "".join(out)


def lcs_len(a: str, b: str, *, cap: int = 800) -> int:
    """最长公共子串长度（截断，避免章节全文 O(nm)）。"""
    if not a or not b:
        return 0
    if len(a) > cap:
        a = a[:cap]
    if len(b) > cap:
        b = b[:cap]
    if len(a) > len(b):
        a, b = b, a
    best = 0
    prev = [0] * (len(b) + 1)
    cur = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        ai = a[i - 1]
        for j in range(1, len(b) + 1):
            if ai == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
            else:
                cur[j] = 0
        prev, cur = cur, prev
        for k in range(len(cur)):
            cur[k] = 0
    return best


def _probe_windows(s: str, win: int = 48) -> list[str]:
    if not s:
        return []
    if len(s) <= win:
        return [s]
    mid = max(0, (len(s) - win) // 2)
    out = [s[:win], s[mid : mid + win], s[-win:]]
    # 再取几段均匀探针
    step = max(win, len(s) // 5)
    for i0 in range(0, len(s) - win + 1, step):
        out.append(s[i0 : i0 + win])
    # 去重保序
    seen: set[str] = set()
    uniq: list[str] = []
    for w in out:
        if w not in seen:
            seen.add(w)
            uniq.append(w)
    return uniq


def overlap_score(query: str, body: str, *, body_content: str | None = None) -> float:
    """query 相对 body 的重叠分；优先子串探针，避免长文 LCS。"""
    q = (query or "").strip()
    b = (body or "").strip()
    if not q or not b:
        return 0.0
    # 短 query 直接包含
    if len(q) <= 400 and q in b:
        return 1.0 + min(len(q), 200) / 200.0

    nq = _norm_for_match(q)
    cq = content_only(nq)
    cb = body_content if body_content is not None else content_only(_norm_for_match(b))
    if len(cq) < 8 or not cb:
        return 0.0
    if cq in cb:
        return 0.9 + min(len(cq), 200) / 500.0

    hits = 0
    probes = _probe_windows(cq, win=min(48, max(12, len(cq) // 3)))
    for w in probes:
        if len(w) >= 8 and w in cb:
            hits += 1
    if hits:
        return 0.45 + 0.15 * hits + min(len(cq), 200) / 800.0

    # 末级：短截断 LCS
    lcs = lcs_len(cq[:600], cb[:3000], cap=600)
    need = max(24, int(0.12 * min(len(cq), 600)))
    if lcs >= need:
        return 0.3 + lcs / max(min(len(cq), 600), 1)
    return 0.0


def context_locatable(body: str, ctx: str, *, body_content: str | None = None) -> bool:
    return overlap_score(ctx, body, body_content=body_content) >= 0.35


def best_chapter_for_text(
    text: str,
    chapters: list[dict],
    *,
    min_score: float = 0.35,
    chapter_contents: list[str] | None = None,
) -> int | None:
    """返回章节下标或 None。"""
    best_i: int | None = None
    best_s = 0.0
    for i, ch in enumerate(chapters):
        bc = chapter_contents[i] if chapter_contents else None
        s = overlap_score(text, ch.get("text") or "", body_content=bc)
        if s > best_s:
            best_s = s
            best_i = i
    if best_i is None or best_s < min_score:
        return None
    return best_i


def align_extract_to_chapters(
    chapters: list[dict], extract_items: list[dict]
) -> tuple[list[list[dict]], dict]:
    """返回每章 triples 列表 + 统计。"""
    per_chapter: list[list[dict]] = [[] for _ in chapters]
    chapter_contents = [
        content_only(_norm_for_match(ch.get("text") or "")) for ch in chapters
    ]
    stats = {
        "extract_items": len(extract_items),
        "chunks_aligned": 0,
        "triples_total": 0,
        "triples_aligned": 0,
        "triples_dropped": 0,
    }
    for item in extract_items:
        chunk_text = item["chunk_plain"] or item["chunk"]
        # 只用 chunk 前部做章归属，足够且更快
        probe = chunk_text[:2500] if len(chunk_text) > 2500 else chunk_text
        ch_i = best_chapter_for_text(
            probe, chapters, chapter_contents=chapter_contents
        )
        if ch_i is None:
            n = len(item.get("triples") or [])
            stats["triples_total"] += n
            stats["triples_dropped"] += n
            continue
        stats["chunks_aligned"] += 1
        chap_body = chapters[ch_i]["text"]
        chap_content = chapter_contents[ch_i]
        for t in item.get("triples") or []:
            if not isinstance(t, dict):
                continue
            stats["triples_total"] += 1
            row = {
                "subject": (t.get("subject") or "").strip(),
                "object": (t.get("object") or "").strip(),
                "predicate": (t.get("predicate") or "").strip(),
                "description": (t.get("description") or "").strip(),
                "context": (t.get("context") or "").strip(),
                "concrete_relation": (
                    t.get("concrete_relation") or t.get("concrete") or ""
                ).strip(),
                "statement_direction": (t.get("statement_direction") or "").strip(),
                "attribute_category": (t.get("attribute_category") or "").strip(),
                "extract_index": item["extract_index"],
            }
            ctx = row["context"]
            if ctx:
                if not context_locatable(
                    chap_body, ctx, body_content=chap_content
                ):
                    stats["triples_dropped"] += 1
                    continue
            if not row["subject"] or not row["object"] or not row["predicate"]:
                stats["triples_dropped"] += 1
                continue
            if row["predicate"] not in PRED_OK:
                stats["triples_dropped"] += 1
                continue
            per_chapter[ch_i].append(row)
            stats["triples_aligned"] += 1
    return per_chapter, stats


def load_textbook_importance_scores(course_title: str) -> dict[str, float]:
    """从 data/textbook/<课名>/ 读取教材先验重要性（仅教材侧）。"""
    tb = ROOT / "data" / "textbook" / course_title
    candidates = (
        tb / "entity_sorted_ppr.json",
        tb / "entity_sorted.json",
        tb / "importance_bundle.json",
    )
    path = next((p for p in candidates if p.is_file()), None)
    if path is None:
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, float] = {}
    if isinstance(raw, dict) and ("global" in raw or "by_chapter" in raw):
        for item in raw.get("global") or []:
            if isinstance(item, list) and len(item) >= 2:
                out[str(item[0])] = float(item[1])
        return out
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, list) and len(item) >= 2:
                out[str(item[0])] = float(item[1])
            elif isinstance(item, dict):
                name = str(item.get("name") or item.get("entity") or "")
                if name:
                    out[name] = float(item.get("importance") or item.get("score") or 0)
    elif isinstance(raw, dict):
        for name, score in raw.items():
            if isinstance(score, (int, float)):
                out[str(name)] = float(score)
    return out


def importance_size(score: float | None, deg: int) -> float:
    if score is None:
        return 14 + min(18, deg * 2)
    x = min(1.0, max(0.0, float(score))) ** 0.5
    return 10.0 + 26.0 * x


def nodes_edges_from_triples(
    triples: list[dict],
    *,
    prefix: str,
    importance: dict[str, float] | None = None,
) -> tuple[list[dict], list[dict]]:
    deg: Counter[str] = Counter()
    clean: list[dict] = []
    for t in triples:
        s = (t.get("subject") or "").strip()
        o = (t.get("object") or "").strip()
        p = (t.get("predicate") or "").strip()
        if not s or not o or not p:
            continue
        if p not in PRED_OK:
            continue
        deg[s] += 1
        deg[o] += 1
        clean.append(t)

    imp = importance or {}

    def score_of(name: str) -> float | None:
        if name in imp:
            return float(imp[name])
        # 宽松：仅中文名命中
        z = zh(name)
        for k, v in imp.items():
            if zh(k) == z:
                return float(v)
        return None

    nodes = []
    for name, d in sorted(deg.items(), key=lambda x: (-x[1], x[0])):
        sc = score_of(name)
        node: dict = {
            "id": name,
            "label": zh(name)[:18],
            "title": name,
            "kind": "textbook",
            "size": importance_size(sc, d),
        }
        if sc is not None:
            # 教材页只展示教材先验；不写反馈字段
            node["importance_base"] = round(sc, 6)
            node["importance"] = round(sc, 6)
        nodes.append(node)

    edges = []
    for i, t in enumerate(clean):
        s, o, p = t["subject"], t["object"], t["predicate"]
        concrete = (t.get("concrete_relation") or t.get("concrete") or "").strip()
        direction = (t.get("statement_direction") or "subject_to_object").strip()
        edges.append(
            {
                "id": f"{prefix}_e{i}",
                "from": s,
                "to": o,
                "label": p,
                "title": t.get("description") or concrete or p,
                "statement": t.get("description") or "",
                "description": t.get("description") or "",
                "context": t.get("context") or "",
                "source": "textbook",
                "relation": p,
                "concrete": concrete,
                "concrete_relation": concrete,
                "statement_direction": direction,
                "attribute_category": t.get("attribute_category") or "",
                "source_section": t.get("source_section") or "",
                "extract_index": t.get("extract_index"),
            }
        )
    return nodes, edges



# —— MD 发现与分章 ——


def list_md_files(folder: Path) -> list[Path]:
    """课程目录下的 MD（兼容旧 content/ 与现根目录）。"""
    content = folder / "content"
    if content.is_dir():
        mds = sorted(
            p for p in content.glob("*.md") if not p.name.endswith(".qkdownloading")
        )
        if mds:
            return mds
    return sorted(
        p for p in folder.glob("*.md") if not p.name.endswith(".qkdownloading")
    )


def chapter_num_from_name(name: str) -> tuple[int, str]:
    stem = Path(name).stem
    m = re.search(r"第\s*(\d+)\s*章", stem)
    if m:
        return int(m.group(1)), stem
    m = re.search(r"(?:^|[_\-])(\d+)(?:$)", stem)
    if m:
        return int(m.group(1)), stem
    m = re.search(r"_(\d+)$", stem)
    if m:
        return int(m.group(1)), stem
    return 9999, stem


def _looks_like_chapter_files(mds: list[Path]) -> bool:
    """多个 MD 是否像按章拆分（文件名含章号）。"""
    if len(mds) < 2:
        return False
    numbered = 0
    for p in mds:
        num, _ = chapter_num_from_name(p.name)
        if num != 9999:
            numbered += 1
    return numbered >= max(2, len(mds) // 2)


def load_chapters_from_folder(folder: Path) -> list[dict]:
    mds = list_md_files(folder)
    if not mds:
        return []

    # 多文件按章（原 content/ 或现课程根目录）
    if _looks_like_chapter_files(mds):
        scored: list[tuple[int, Path]] = []
        for p in mds:
            num, _ = chapter_num_from_name(p.name)
            scored.append((num, p))
        scored.sort(key=lambda x: (x[0], x[1].name))
        chapters: list[dict] = []
        for num, p in scored:
            raw = p.read_text(encoding="utf-8", errors="ignore")
            body = format_slice_text(raw)
            if len(body) < 20:
                continue
            title = p.stem.replace("_", " ")
            chap = str(num) if num != 9999 else "?"
            chapters.append(
                {
                    "id": f"ch_{chap}_{len(chapters):02d}",
                    "title": title,
                    "chapter": chap,
                    "text": body,
                    "source_md": str(p),
                }
            )
        return chapters

    # 单本 MD：优先目录同名 → 唯一 md → 书名匹配
    preferred = folder / f"{folder.name}.md"
    if preferred.is_file():
        main = preferred
    elif len(mds) == 1:
        main = mds[0]
    else:
        named = [p for p in mds if "数理逻辑" in p.stem or folder.name[:8] in p.stem]
        main = named[0] if named else mds[0]
    raw = main.read_text(encoding="utf-8", errors="ignore")
    chapters = split_md_by_chapter_heads(raw, fallback_title=folder.name)
    for c in chapters:
        c["source_md"] = str(main)
    return chapters


def resolve_extract_path(folder_name: str, extract_root: Path) -> Path | None:
    if not extract_root.is_dir():
        return None
    candidates = [
        p
        for p in extract_root.iterdir()
        if p.is_dir() and (p / "result" / "extract" / "extract.json").is_file()
    ]
    if not candidates:
        return None

    name = folder_name.strip()
    # 精确 / 包含
    for p in candidates:
        if p.name == name or name in p.name or p.name in name:
            return p / "result" / "extract" / "extract.json"

    # 课程号 CS####
    code_m = re.match(r"^(CS\d+)", name, re.I)
    if code_m:
        code = code_m.group(1).upper()
        hits = [p for p in candidates if p.name.upper().startswith(code)]
        if len(hits) == 1:
            return hits[0] / "result" / "extract" / "extract.json"
        if hits:
            # 去掉教师名后缀后更接近的
            base = re.sub(r"[-_].+$", "", name)
            for p in hits:
                if base in p.name or p.name.startswith(code):
                    return p / "result" / "extract" / "extract.json"
            return hits[0] / "result" / "extract" / "extract.json"

    # 关键词：去掉括号与教师名
    key = re.sub(r"[（(].*?[）)]", "", name)
    key = re.sub(r"[-_].+$", "", key).strip()
    if len(key) >= 4:
        hits = [p for p in candidates if key in p.name]
        if hits:
            return hits[0] / "result" / "extract" / "extract.json"
    return None


def load_extract_items(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    out: list[dict] = []
    for i, it in enumerate(items if isinstance(items, list) else []):
        if not isinstance(it, dict):
            continue
        chunk = (it.get("chunk") or it.get("context") or "").strip()
        if not chunk:
            continue
        out.append(
            {
                "extract_index": i,
                "chunk": chunk,
                "chunk_plain": format_slice_text(chunk),
                "triples": list(it.get("triples") or []),
            }
        )
    return out


def build_file_payload(
    *,
    file_id: str,
    title: str,
    folder: Path,
    extract_path: Path,
    chapters: list[dict],
    per_chapter_triples: list[list[dict]],
    align_stats: dict,
    course_id: str,
    max_chars: int,
) -> dict:
    imp = load_textbook_importance_scores(title)
    slices: list[dict] = []
    all_triples: list[dict] = []
    for i, ch in enumerate(chapters):
        body = ch["text"]
        if len(body) > max_chars:
            body = body[:max_chars] + "\n…(截断)"
        trips = per_chapter_triples[i]
        # 章内 SPO 去重
        seen: set[tuple[str, str, str]] = set()
        deduped: list[dict] = []
        for t in trips:
            key = (t["subject"], t["predicate"], t["object"])
            if key in seen:
                continue
            seen.add(key)
            deduped.append(t)
        prefix = re.sub(r"\W+", "_", ch["id"])[:40] or f"ch{i}"
        nodes, edges = nodes_edges_from_triples(
            deduped, prefix=prefix, importance=imp
        )
        all_triples.extend(deduped)
        slices.append(
            {
                "id": ch["id"],
                "title": ch["title"],
                "chapter": ch["chapter"],
                "triple_count": len(edges),
                "node_count": len(nodes),
                "text": body,
                "nodes": nodes,
                "edges": edges,
                "aligned_triples": len(deduped),
                "sample_triples": [
                    {
                        "subject": zh(e.get("from", "")),
                        "predicate": e.get("relation") or e.get("label"),
                        "object": zh(e.get("to", "")),
                        "description": e.get("description") or "",
                    }
                    for e in edges[:8]
                ],
            }
        )

    # overview：全书对齐三元组去重
    seen_all: set[tuple[str, str, str]] = set()
    overview_trips: list[dict] = []
    for t in all_triples:
        key = (t["subject"], t["predicate"], t["object"])
        if key in seen_all:
            continue
        seen_all.add(key)
        overview_trips.append(t)
    overview_nodes, overview_edges = nodes_edges_from_triples(
        overview_trips, prefix="all", importance=imp
    )

    try:
        md_rel = str(folder.relative_to(AUTOEDU)).replace("\\", "/")
    except ValueError:
        md_rel = str(folder)
    try:
        ex_rel = str(extract_path.relative_to(AUTOEDU)).replace("\\", "/")
    except ValueError:
        ex_rel = str(extract_path)

    return {
        "brand": "TeachKG",
        "product": "教材知识图谱",
        "course_id": course_id,
        "file_id": file_id,
        "title": f"教材知识图谱 · {title}",
        "subtitle": "MD 分章 · extract chunk/context 重叠对齐",
        "source_dir": md_rel,
        "extract_json": ex_rel,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "stats": {
            "slices": len(slices),
            "entities": len(overview_nodes),
            "relations": len(overview_edges),
            "slices_with_text": sum(1 for s in slices if s.get("text")),
            "aligned_triples": align_stats.get("triples_aligned", 0),
            "dropped_triples": align_stats.get("triples_dropped", 0),
            "chunks_aligned": align_stats.get("chunks_aligned", 0),
            "extract_items": align_stats.get("extract_items", 0),
        },
        "align_stats": align_stats,
        "overview": {
            "id": "__all__",
            "title": "全书合并视图",
            "chapter": "all",
            "triple_count": len(overview_edges),
            "node_count": len(overview_nodes),
            "text": "",
            "nodes": overview_nodes,
            "edges": overview_edges,
            "sample_triples": [],
        },
        "slices": slices,
    }


def scan_processed(processed_dir: Path, extract_root: Path) -> list[dict]:
    entries: list[dict] = []
    if not processed_dir.is_dir():
        return entries
    for folder in sorted(processed_dir.iterdir(), key=lambda p: p.name):
        if not folder.is_dir():
            continue
        # 跳过仅有 course_file_type.json、无 md 的目录
        mds = list_md_files(folder)
        fid = slug_id(folder.name)
        extract_path = resolve_extract_path(folder.name, extract_root)
        chapters = load_chapters_from_folder(folder) if mds else []
        available = bool(mds and chapters and extract_path and extract_path.is_file())
        reason = ""
        if not mds:
            reason = "无 MD"
        elif not chapters:
            reason = "无法分章"
        elif not extract_path:
            reason = "未匹配 extract.json"
        entries.append(
            {
                "id": fid,
                "title": folder.name,
                "path": str(folder),
                "extract_path": str(extract_path) if extract_path else None,
                "chapter_count": len(chapters),
                "available": available,
                "reason": reason,
                "_folder": folder,
                "_chapters": chapters,
                "_extract": extract_path,
            }
        )
    return entries


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--processed-dir", type=Path, default=DEFAULT_PROCESSED)
    parser.add_argument("--extract-root", type=Path, default=DEFAULT_EXTRACT_ROOT)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--legacy-out", type=Path, default=DEFAULT_LEGACY)
    parser.add_argument("--default-file", default=DEFAULT_FILE_ID)
    parser.add_argument("--course-id", default="数理逻辑")
    parser.add_argument("--max-chars", type=int, default=80000)
    parser.add_argument(
        "--only",
        nargs="*",
        default=[DEFAULT_COURSE],
        help=f"只导出指定目录名（默认仅 {DEFAULT_COURSE}；传空串可扫全部）",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="导出 processed 下全部可用课程（忽略 --only 默认）",
    )
    args = parser.parse_args()

    only = None if args.all else (args.only or None)
    # argparse nargs=* 无参数时可能是 []；显式 --only 不带值 → 空列表，当作默认课
    if only is not None and len(only) == 0:
        only = [DEFAULT_COURSE]
    if only == [""] or only == ["*"]:
        only = None
    only_ids = {slug_id(x) for x in only} if only else set()

    def in_only(ent: dict) -> bool:
        if not only:
            return True
        return (
            ent["title"] in only
            or ent["id"] in only
            or ent["id"] in only_ids
        )

    entries = scan_processed(args.processed_dir, args.extract_root)
    print(f"processed: {args.processed_dir} entries={len(entries)}")
    print(f"extract_root: {args.extract_root}")
    print(f"only: {only or '(all)'}")

    args.out_dir.mkdir(parents=True, exist_ok=True)

    catalog_files: list[dict] = []
    default_payload: dict | None = None
    default_fid = slug_id(args.default_file)

    for ent in entries:
        # 试点阶段：catalog 也只保留 --only 指定课程
        if not in_only(ent):
            continue
        catalog_files.append(
            {
                "id": ent["id"],
                "title": ent["title"],
                "path": ent["path"],
                "extract_path": ent["extract_path"],
                "chapter_count": ent["chapter_count"],
                "available": ent["available"],
                "reason": ent.get("reason") or "",
                # 扁平旧路径；web sync-data 会改写为 /data/courses/{course}/textbook_kg/...
                "dataUrl": f"/data/textbook_kg/{ent['id']}.json",
            }
        )
        if not ent["available"]:
            print(f"  skip {ent['title']}: {ent.get('reason')}")
            continue

        folder: Path = ent["_folder"]
        chapters: list[dict] = ent["_chapters"]
        extract_path: Path = ent["_extract"]
        print(
            f"  build {ent['title']}: chapters={len(chapters)} extract={extract_path}"
        )
        if chapters:
            print(f"    md={chapters[0].get('source_md')}")
        extract_items = load_extract_items(extract_path)
        per_ch, align_stats = align_extract_to_chapters(chapters, extract_items)
        payload = build_file_payload(
            file_id=ent["id"],
            title=ent["title"],
            folder=folder,
            extract_path=extract_path,
            chapters=chapters,
            per_chapter_triples=per_ch,
            align_stats=align_stats,
            course_id=args.course_id,
            max_chars=args.max_chars,
        )
        out_path = args.out_dir / f"{ent['id']}.json"
        out_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(
            f"    wrote {out_path.name} aligned={align_stats['triples_aligned']} "
            f"dropped={align_stats['triples_dropped']} chunks={align_stats['chunks_aligned']}"
        )
        catalog_files[-1]["chapter_count"] = len(chapters)
        catalog_files[-1]["stats"] = {
            "aligned_triples": align_stats["triples_aligned"],
            "relations": payload["stats"]["relations"],
        }

        if ent["id"] == default_fid or ent["title"] == args.default_file:
            default_payload = payload
        elif default_payload is None:
            default_payload = payload

    # 清理旧试点产物文件名（避免前端误选「数理逻辑与集合论」短名）
    legacy_alias = args.out_dir / "数理逻辑与集合论.json"
    if legacy_alias.is_file() and default_fid != "数理逻辑与集合论":
        try:
            legacy_alias.unlink()
            print(f"removed stale {legacy_alias.name}")
        except OSError:
            pass

    catalog = {
        "brand": "TeachKG",
        "product": "教材知识图谱",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "processed_dir": str(args.processed_dir),
        "default_file_id": (default_payload or {}).get("file_id")
        or next(
            (f["id"] for f in catalog_files if f.get("available")),
            catalog_files[0]["id"] if catalog_files else "",
        ),
        "files": [],
    }
    # 仅当 JSON 已写出时标为 available，避免前端点到空文件
    final_files: list[dict] = []
    for f in catalog_files:
        row = {k: v for k, v in f.items() if not k.startswith("_")}
        out_json = args.out_dir / f"{row['id']}.json"
        if row.get("available") and not out_json.is_file():
            row["available"] = False
            row["reason"] = row.get("reason") or "尚未导出数据文件"
        final_files.append(row)
    catalog["files"] = final_files
    if not any(f["id"] == catalog["default_file_id"] and f.get("available") for f in final_files):
        for f in final_files:
            if f.get("available"):
                catalog["default_file_id"] = f["id"]
                break

    catalog_path = args.out_dir / "catalog.json"
    catalog_path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"wrote {catalog_path}")

    if default_payload:
        args.legacy_out.parent.mkdir(parents=True, exist_ok=True)
        args.legacy_out.write_text(
            json.dumps(default_payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"wrote legacy {args.legacy_out}")
    elif final_files:
        # 若默认文件未构建，用第一个已导出文件作 legacy
        for f in final_files:
            p = args.out_dir / f"{f['id']}.json"
            if p.is_file():
                args.legacy_out.write_text(p.read_text(encoding="utf-8"), encoding="utf-8")
                print(f"wrote legacy from {p.name}")
                break


if __name__ == "__main__":
    main()
