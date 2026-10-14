#!/usr/bin/env python3
"""只跑「章节提取」：按课堂 PPT OCR 归章并生成大纲（禁止教材 toc 补章）。

归章：用 PPT 正文关键词匹配章名，不用 lecture_chapter_map / 旧讲次导图标签。
大纲：只从该章命中讲次的 PPT 页标题抽取。
分册：仅用 chapter_catalog 把已提取的章放到正确分册，不写入教材节标题。

不重跑讲次四步；叶实体尽量挂现有 lecture_*.json。

例：
  python scripts/teaching/extract_taught_chapter_outlines.py
  python scripts/teaching/extract_taught_chapter_outlines.py --llm-tidy
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.textbook_kg.mindmap_pipeline import (
    build_course_from_chapters,
    chapter_file_slug,
    forest_stats,
    iter_chapter_slices_from_lecture,
    unwrap_lecture_to_topic_forest,
    update_mindmap_index,
)
from teachkg.utils.env import load_project_env
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config

COURSE = "离散数学(图论+数理逻辑与集合论)"
SECTION_RE = re.compile(r"^(\d+(?:\.\d+)*)\s+(.+)$")
KEEP_SOURCES = frozenset({"manual"})
HTML_TAG_RE = re.compile(r"<[^>]+>")
NOISE_LINE_RE = re.compile(
    r"上海交通|让每个学生|SHANGHAI|JIAO TONG|SJTU|```|<!DOCTYPE|<html|"
    r"新建标签|热门搜索|PowerPoint|受保护|oc\.sjtu|Canvas|Adobe|"
    r"此电脑|启用编辑|推荐扫码|剪切|课程清单|高散数学|"
    r"2025-2026|Spring|搜素|搜索$|^文件$|^视图|^菜单|刷 新|应签|微信扫|"
    r"什么是离散数学|三次数学危机|科学思维支柱",
    re.I,
)
COORD_RE = re.compile(r"^[\d,.\s/:-]+$")
CJK_RE = re.compile(r"[\u4e00-\u9fff]")

# PPT 封面章名 → 三册（图论 / 数理逻辑 / 集合论）；不用教材两册合并
CLASSROOM_PARTS: list[tuple[str, str, list[str]]] = [
    (
        "graph",
        "图论",
        [
            "第1章 图的基本概念与表示",
            "第2章 道路与回路",
            "第3章 树",
            "第4章 平面图与图的着色",
        ],
    ),
    (
        "logic",
        "数理逻辑",
        [
            "第1章 命题逻辑的基本概念",
            "第2章 命题逻辑的等值和推理演算",
            "第3章 命题逻辑的公理化系统",
            "第4章 谓词逻辑的基本概念",
            "第5章 谓词逻辑的等值和推理演算",
            "第6章 谓词逻辑的公理化系统",
        ],
    ),
    (
        "set",
        "集合论",
        [
            "第9章 集合",
            "第10章 关系",
            "第11章 函数",
            "第12章 实数集合与集合的基数",
        ],
    ),
]
CHAPTER_KEYWORDS: dict[str, list[str]] = {
    "第1章 图的基本概念与表示": [
        "图的定义", "邻接矩阵", "关联矩阵", "无向图", "有向图", "简单图",
        "图的代数", "顶点度", "握手定理",
    ],
    "第2章 道路与回路": [
        "欧拉", "哈密顿", "最短路径", "连通性", "中国邮路", "旅行商",
        "关键路径", "回路的判定", "道路与回路",
    ],
    "第3章 树": [
        "Huffman", "哈夫曼", "支撑树", "生成树", "割集矩阵", "回路矩阵",
        "树的有关定义", "最短树",
    ],
    "第4章 平面图与图的着色": [
        "平面图", "极大平面", "四色", "图的着色", "Kuratowski", "欧拉公式",
    ],
    "第5章 匹配": [
        "最大匹配", "完全匹配", "最佳匹配", "二分图的匹配", "匈牙利算法", "Hall定理",
    ],
    "第8章 群": [
        "半群", "陪集", "正规子群", "Lagrange", "Cayley", "循环群",
        "置换群", "商群", "群的同态",
    ],
    "第1章 命题逻辑的基本概念": [
        "命题联结", "真值表", "合式公式", "重言式", "波兰", "命题形式化", "原子命题",
        "逻辑第1章",
    ],
    "第2章 命题逻辑的等值和推理演算": [
        "等值定理", "主范式", "对偶式", "联结词的完备", "推理演算", "归结推理法",
    ],
    "第3章 命题逻辑的公理化系统": [
        "命题逻辑公理", "王浩", "加头", "公理系统A", "公理系统B", "演绎定理",
        "自然演绎系统", "命题逻辑的公理化系统",
    ],
    "第4章 谓词逻辑的基本概念": [
        "谓词和个体", "谓词公式", "自然语句的形式化", "有限论域", "普遍有效",
        "逻辑第4章",
    ],
    "第5章 谓词逻辑的等值和推理演算": [
        "量词分配", "前束范式", "谓词逻辑的归结", "否定型等值",
    ],
    "第6章 谓词逻辑的公理化系统": [
        "谓词逻辑的公理", "谓词逻辑公理系统", "FOL1", "FOL2", "逻辑第6章",
        "谓词逻辑的公理化系统",
    ],
    "第9章 集合": [
        "子集公理", "分离公理", "集合运算", "文氏", "集合论公理", "空集",
        "交集集合存在", "正则公理",
    ],
    "第10章 关系": [
        "二元关系", "关系矩阵", "关系的闭包", "等价关系", "偏序关系",
        "相容关系", "关系图",
    ],
    "第11章 函数": [
        "函数定义", "函数的合成", "函数的象", "左逆", "右逆", "反函数",
        "单值性", "全域性", "部分函数", "Set03-函数", "函数复习",
    ],
    "第12章 实数集合与集合的基数": [
        "等势", "可数集合", "连续统", "基数的比较", "无限集合", "基数的算术",
    ],
}


def _as_list(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    s = str(v).strip()
    return [s] if s else []


def _bare(ch: str) -> str:
    return re.sub(r"^第\s*\d+\s*章\s*", "", ch or "").strip() or ch


def classroom_catalog(taught: set[str]) -> dict:
    """按 PPT 封面分三册；只收录本学期讲过的章。"""
    parts = []
    order: list[str] = []
    chapter_to_part: dict[str, str] = {}
    for pid, title, names in CLASSROOM_PARTS:
        chs = []
        for name in names:
            if name not in taught:
                continue
            chs.append({"name": name, "part_id": pid, "part_title": title})
            order.append(name)
            chapter_to_part[name] = pid
        if chs:
            parts.append({"id": pid, "title": title, "source": "classroom_ppt", "chapters": chs})
    extra = sorted(taught - set(order))
    if extra:
        chs = [{"name": n, "part_id": "other", "part_title": "其他"} for n in extra]
        parts.append({"id": "other", "title": "其他", "source": "classroom_ppt", "chapters": chs})
        order.extend(extra)
        for n in extra:
            chapter_to_part[n] = "other"
    return {
        "course_id": COURSE,
        "source": "classroom_ppt",
        "n_parts": len(parts),
        "n_chapters": len(order),
        "parts": parts,
        "chapter_order": order,
        "chapter_to_part": chapter_to_part,
    }


def clean_ocr_text(text: str) -> str:
    t = HTML_TAG_RE.sub(" ", text or "")
    t = t.replace("```html", " ").replace("```", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def lecture_ppt_pages(asr_root: Path, lid: str) -> list[str]:
    path = asr_root / str(lid) / "ocr" / "ppt_ocr.json"
    if not path.is_file():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    pages = raw.get("pages") or {}
    out = []
    for k in sorted(pages.keys(), key=lambda x: int(x) if str(x).isdigit() else 999):
        t = str(pages.get(k) or "").strip()
        if t:
            out.append(t)
    return out


def score_chapter(blob: str, words: list[str]) -> int:
    return sum(blob.count(w) for w in words if w)


def classify_lecture_ppt(blob: str) -> list[tuple[str, int]]:
    """PPT 正文 → 命中的章（可多章，需明显领先噪声）。"""
    if len(blob) < 80:
        return []
    scored = [
        (ch, score_chapter(blob, words))
        for ch, words in CHAPTER_KEYWORDS.items()
    ]
    scored = [(ch, s) for ch, s in scored if s > 0]
    if not scored:
        return []
    scored.sort(key=lambda x: -x[1])
    best = scored[0][1]
    if best < 3:
        return []
    keep = [
        (ch, s)
        for ch, s in scored
        if s >= 3 and s >= min(int(0.45 * best), 8)
    ]
    return keep[:3]


def taught_chapters_from_ppt(
    asr_root: Path,
) -> tuple[dict[str, list[str]], dict[str, list[tuple[str, int]]]]:
    """只用 PPT OCR 归章。"""
    out: dict[str, list[str]] = defaultdict(list)
    debug: dict[str, list[tuple[str, int]]] = {}
    lids = sorted(
        (
            d.name
            for d in asr_root.iterdir()
            if d.is_dir() and (d / "ocr" / "ppt_ocr.json").is_file()
        ),
        key=lambda x: int(x) if x.isdigit() else 999,
    )
    for lid in lids:
        pages = lecture_ppt_pages(asr_root, lid)
        blob = clean_ocr_text("\n".join(pages))
        hits = classify_lecture_ppt(blob)
        debug[lid] = hits
        for ch, _s in hits:
            if lid not in out[ch]:
                out[ch].append(lid)
    for ch in out:
        out[ch].sort(key=lambda x: int(x) if x.isdigit() else 999)
    return dict(out), debug


def load_ppt_ocr_pages(asr_root: Path, lids: list[str]) -> list[str]:
    texts: list[str] = []
    for lid in lids:
        texts.extend(lecture_ppt_pages(asr_root, lid))
    return texts


def _heading_candidate(line: str) -> str | None:
    t = HTML_TAG_RE.sub("", line or "").strip()
    t = re.sub(r"^[-*•·]\s*", "", t)
    t = re.sub(r"^\d+[)）、]\s*", "", t)
    t = re.sub(r"[。；;]+$", "", t).strip()
    t = re.sub(r"^#+\s*", "", t)
    if len(t) < 2 or len(t) > 36:
        return None
    if NOISE_LINE_RE.search(t):
        return None
    if re.match(r"^(第\s*\d+\s*页|page\s*\d+|幻灯片)", t, re.I):
        return None
    if re.search(r"好，|那么|我们|今天|上课", t):
        return None
    if COORD_RE.match(t):
        return None
    if len(CJK_RE.findall(t)) < 2:
        return None
    return t


def headings_from_ppt_pages(
    pages: list[str],
    chapter: str,
    max_sections: int = 16,
) -> list[str]:
    """每页取一个合格标题；优先与本章关键词相关的行。"""
    words = CHAPTER_KEYWORDS.get(chapter) or [_bare(chapter)]
    headings: list[str] = []
    seen: set[str] = set()

    def add(title: str) -> bool:
        key = re.sub(r"\s+", "", title).lower()
        if key in seen:
            return False
        seen.add(key)
        headings.append(title)
        return len(headings) >= max_sections

    for page in pages:
        raw_lines = [ln.strip() for ln in str(page).splitlines() if ln.strip()]
        html_heads = re.findall(
            r"<h[12][^>]*>(.*?)</h[12]>", page, flags=re.I | re.S
        )
        cands: list[str] = []
        for h in html_heads:
            t = _heading_candidate(h)
            if t:
                cands.append(t)
        for line in raw_lines[:6]:
            t = _heading_candidate(line)
            if t:
                cands.append(t)
        if not cands:
            continue
        ranked = sorted(
            cands,
            key=lambda x: -sum(1 for w in words if w and w in x),
        )
        picked = None
        for t in ranked:
            if any(w in t for w in words) or (_bare(chapter) in t):
                picked = t
                break
        if picked is None:
            continue
        if add(picked):
            break
    if len(headings) >= 2:
        return headings
    # 关键词太严时退回「干净中文标题」，仍不收课件外壳
    for page in pages:
        raw_lines = [ln.strip() for ln in str(page).splitlines() if ln.strip()]
        html_heads = re.findall(
            r"<h[12][^>]*>(.*?)</h[12]>", page, flags=re.I | re.S
        )
        for h in html_heads + raw_lines[:4]:
            t = _heading_candidate(h)
            if t and add(t):
                return headings
    return headings


def llm_tidy_outline(
    client: LLMClient, chapter: str, raw_lines: list[str]
) -> tuple[str, str]:
    prompt = f"""你是课程大纲整理助手。下面是「{chapter}」从课堂 PPT OCR 抽出的页标题草稿。
请整理成适合思维导图的章节大纲（2 级为主，必要时 3 级缩进）。

要求：
- 只输出大纲文本，不要解释
- 每行一个主题；二级用两个空格缩进
- 不要发明未在草稿中出现的大主题；可合并同义、删噪声与页眉页脚
- 不要出现「第 N 讲」

草稿：
{chr(10).join(raw_lines)}
"""
    raw = client.chat(prompt, temperature=0.2)
    text = (raw or "").strip()
    text = re.sub(r"^```\w*\n|\n```$", "", text).strip()
    notes = ""
    if len(text) < 8:
        text = "\n".join(raw_lines)
        notes = "llm_fallback_raw"
    return text, notes


def outline_to_summary(
    chapter: str, outline_text: str, source: str, notes: str = ""
) -> dict:
    bare = _bare(chapter)
    sections = []
    edges = []
    outline = []
    last = None
    for raw in outline_text.splitlines():
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        title = re.sub(r"^[-*•·]\s*", "", raw.strip())
        title = re.sub(r"^\d+[)）、]\s*", "", title).strip()
        if not title or re.match(r"^第\s*\d+\s*章", title):
            continue
        if indent >= 2 and last:
            edges.append({"parent": last, "child": title})
            continue
        m = SECTION_RE.match(title)
        bare_s = (m.group(2) if m else title).strip()
        sections.append(
            {"title": title, "bare": bare_s, "num": m.group(1) if m else None}
        )
        outline.append(bare_s)
        edges.append({"parent": bare, "child": bare_s})
        last = bare_s
    return {
        "chapter": chapter,
        "source": source,
        "outline": outline,
        "sections": sections,
        "edges": edges,
        "outline_text": outline_text,
        "llm_notes": notes or None,
    }


def collect_leaves_from_lectures(
    out_dir: Path, lids: list[str], chapter: str
) -> list[dict]:
    leaves: dict[str, dict] = {}

    def add_tree(n: dict) -> None:
        nid = str(n.get("id") or "")
        if nid and not nid.startswith("__"):
            prev = leaves.get(nid)
            imp = float(n.get("importance") or 0)
            if not prev or imp > float(prev.get("importance") or 0):
                leaves[nid] = {
                    "id": nid,
                    "zh": n.get("zh") or nid.split("/")[0],
                    "importance": imp,
                    "relation": n.get("relation"),
                    "related": list(n.get("related") or []),
                    "children": [],
                }
        for c in n.get("children") or []:
            if isinstance(c, dict):
                add_tree(c)

    for lid in lids:
        p = out_dir / f"lecture_{lid}.json"
        if not p.is_file():
            continue
        doc = json.loads(p.read_text(encoding="utf-8"))
        slices = dict(iter_chapter_slices_from_lecture(doc))
        trees = slices.get(chapter)
        if not trees:
            trees = unwrap_lecture_to_topic_forest(doc)
        for t in trees or []:
            add_tree(t)
    return sorted(leaves.values(), key=lambda x: -float(x.get("importance") or 0))


def score_leaf(zh: str, eid: str, label: str) -> float:
    def norm(s: str) -> str:
        s = (s or "").lower()
        s = re.sub(r"\s+", "", s)
        s = re.sub(r"[（(].*?[）)]", "", s)
        return s

    ez, lb = norm(zh or eid.split("/")[0]), norm(label)
    if not ez or not lb:
        return 0.0
    if ez == lb:
        return 10.0
    if len(lb) >= 2 and (lb in ez or ez in lb):
        return 6.0 if min(len(ez), len(lb)) / max(len(ez), len(lb)) >= 0.45 else 3.0
    return 0.0


def build_chapter_preview(
    chapter: str, summary: dict, leaves: list[dict], lids: list[str]
) -> dict:
    bare = _bare(chapter)
    used: set[str] = set()
    section_nodes: list[dict] = []
    for sec in summary.get("sections") or []:
        label = sec.get("bare") or sec.get("title") or ""
        kids = []
        scored = []
        for leaf in leaves:
            if leaf["id"] in used:
                continue
            s = score_leaf(str(leaf.get("zh") or ""), leaf["id"], label)
            if s >= 6:
                scored.append((s, leaf))
        scored.sort(key=lambda x: (-x[0], -float(x[1].get("importance") or 0)))
        for s, leaf in scored[:8]:
            used.add(leaf["id"])
            kids.append(dict(leaf))
        for e in summary.get("edges") or []:
            if e.get("parent") != label:
                continue
            child_label = e.get("child") or ""
            topic_kids = []
            scored2 = []
            for leaf in leaves:
                if leaf["id"] in used:
                    continue
                s = score_leaf(str(leaf.get("zh") or ""), leaf["id"], child_label)
                if s >= 6:
                    scored2.append((s, leaf))
            scored2.sort(key=lambda x: (-x[0], -float(x[1].get("importance") or 0)))
            for s, leaf in scored2[:4]:
                used.add(leaf["id"])
                topic_kids.append(dict(leaf))
            kids.append(
                {
                    "id": f"__topic__/{label}/{child_label}",
                    "zh": child_label,
                    "importance": 0.45,
                    "relation": "ppt_topic",
                    "related": [],
                    "children": topic_kids,
                }
            )
        section_nodes.append(
            {
                "id": f"__section__/{sec.get('title') or label}",
                "zh": sec.get("title") or label,
                "importance": 0.55,
                "relation": "ppt_section",
                "related": [],
                "children": kids,
            }
        )
    root = {
        "id": f"__chapter__/{bare}",
        "zh": chapter,
        "importance": 0.7,
        "relation": None,
        "related": [],
        "children": section_nodes,
    }
    n, d = forest_stats([root])
    return {
        "lecture_id": f"chapter:{chapter}",
        "root": root,
        "roots": [root],
        "n_nodes": n,
        "max_depth": d,
        "orphan_count": 0,
        "meta": {
            "chapter": chapter,
            "root_zh": bare,
            "virtual_root": True,
            "scope": "chapter",
            "lecture_ids": lids,
            "pipeline": "chapter_outline_extract",
            "skeleton_source": summary.get("source"),
            "source": "summary+kg",
            "n_trees": 1,
            "preview": True,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", default=str(ROOT / "configs/teaching_lisan.yaml"))
    ap.add_argument("--course", default=COURSE)
    ap.add_argument("--llm-tidy", action="store_true", help="LLM 整理 PPT 大纲")
    ap.add_argument("--force", action="store_true", help="覆盖已有课堂 summaries")
    args = ap.parse_args()

    load_project_env()
    cfg = TeachKGConfig.from_yaml(args.config)
    llm_cfg = cfg.get("llm", default={}) or {}

    out_dir = ROOT / "data/viz" / args.course / "mindmaps"
    asr_root = ROOT / "data/segments" / args.course / "asr_work"
    taught, lecture_hits = taught_chapters_from_ppt(asr_root)
    print(f"taught chapters from PPT: {len(taught)}")
    for ch, lids in sorted(taught.items(), key=lambda x: x[0]):
        print(f"  {ch} ← L{','.join(lids)}")
    unassigned = [lid for lid, hits in lecture_hits.items() if not hits]
    if unassigned:
        print(f"unassigned lectures (PPT chrome/noise): {', '.join(unassigned)}")

    sum_dir = ROOT / "data/viz" / args.course / "summaries"
    out_dir.mkdir(parents=True, exist_ok=True)
    sum_dir.mkdir(parents=True, exist_ok=True)

    client = None
    if args.llm_tidy:
        client = LLMClient(**llm_settings_from_config(llm_cfg))

    upserts: list[dict] = []
    chapter_docs: list[tuple[str, dict]] = []

    for chapter, lids in sorted(
        taught.items(),
        key=lambda x: (
            int(re.search(r"第\s*(\d+)\s*章", x[0]).group(1))
            if re.search(r"第\s*\d+\s*章", x[0])
            else 999,
            x[0],
        ),
    ):
        slug = chapter_file_slug(chapter)
        sum_path = sum_dir / f"chapter_{slug}.json"
        existing = None
        if sum_path.is_file():
            existing = json.loads(sum_path.read_text(encoding="utf-8"))
        src = str((existing or {}).get("source") or "")
        keep = (
            existing
            and not args.force
            and src in KEEP_SOURCES
            and (existing.get("outline_text") or existing.get("outline"))
        )
        if keep:
            summary = existing
            print(f"[keep] {chapter} source={summary.get('source')}")
        else:
            pages = load_ppt_ocr_pages(asr_root, lids)
            lines = headings_from_ppt_pages(pages, chapter)
            if len(lines) < 2:
                print(
                    f"[skip] {chapter}: ppt headings={len(lines)} "
                    f"(ocr_pages={len(pages)}; need backfill_ppt_ocr?)"
                )
                continue
            source = "classroom_ppt"
            notes = ""
            outline_text = "\n".join(lines)
            if client:
                outline_text, notes = llm_tidy_outline(client, chapter, lines)
                source = "manual_llm"
            summary = outline_to_summary(chapter, outline_text, source, notes)
            sum_path.write_text(
                json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(
                f"[extract] {chapter}: sections={len(summary.get('sections') or [])} "
                f"source={source} lids={lids} ppt_pages={len(pages)}"
            )

        leaves = collect_leaves_from_lectures(out_dir, lids, chapter)
        doc = build_chapter_preview(chapter, summary, leaves, lids)
        ch_path = out_dir / f"chapter_{slug}.json"
        ch_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        chapter_docs.append((chapter, doc))
        upserts.append(
            {
                "lecture_id": f"chapter:{chapter}",
                "chapter": chapter,
                "chapter_id": chapter,
                "root_zh": (doc.get("meta") or {}).get("root_zh"),
                "n_nodes": doc.get("n_nodes"),
                "max_depth": doc.get("max_depth"),
                "orphan_count": 0,
                "path": f"mindmaps/chapter_{slug}.json",
                "scope": "chapter",
                "lecture_ids": lids,
                "source": "summary+kg",
            }
        )

    taught_set = {c for c, _ in chapter_docs}
    slim_cat = classroom_catalog(taught_set)
    course_doc = build_course_from_chapters(
        "离散数学", chapter_docs, catalog=slim_cat, max_chapter_depth=2
    )
    (out_dir / "course.json").write_text(
        json.dumps(course_doc, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    index_path = out_dir / "index.json"
    index = (
        json.loads(index_path.read_text(encoding="utf-8"))
        if index_path.is_file()
        else {"courseId": args.course, "title": "思维导图", "items": []}
    )
    non_ch = [
        it
        for it in (index.get("items") or [])
        if it.get("scope") not in ("chapter", "course")
        and str(it.get("lecture_id") or "") != "course"
        and not str(it.get("lecture_id") or "").startswith("chapter:")
    ]
    index["items"] = non_ch
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    upserts.append(
        {
            "lecture_id": "course",
            "chapter": "离散数学",
            "root_zh": "离散数学",
            "n_nodes": course_doc.get("n_nodes"),
            "max_depth": course_doc.get("max_depth"),
            "orphan_count": 0,
            "path": "mindmaps/course.json",
            "scope": "course",
            "source": "kg",
        }
    )
    update_mindmap_index(index_path, course_id=args.course, items_upsert=upserts)

    dst = ROOT / "web/teachkg-showcase/public/data/courses" / args.course
    (dst / "mindmaps").mkdir(parents=True, exist_ok=True)
    (dst / "summaries").mkdir(parents=True, exist_ok=True)

    keep_slugs = {chapter_file_slug(c) for c, _ in chapter_docs}
    for folder in (sum_dir, out_dir, dst / "mindmaps", dst / "summaries"):
        if not folder.is_dir():
            continue
        for p in folder.glob("chapter_*.json"):
            slug = p.name.removeprefix("chapter_").removesuffix(".json")
            if slug not in keep_slugs:
                p.unlink()
                print("removed stale", p.name)

    cat_out = out_dir.parent / "chapter_catalog.json"
    cat_out.write_text(json.dumps(slim_cat, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.copy2(cat_out, dst / "chapter_catalog.json")
    for ch, _ in chapter_docs:
        slug = chapter_file_slug(ch)
        shutil.copy2(sum_dir / f"chapter_{slug}.json", dst / "summaries" / f"chapter_{slug}.json")
        shutil.copy2(
            out_dir / f"chapter_{slug}.json", dst / "mindmaps" / f"chapter_{slug}.json"
        )
    shutil.copy2(out_dir / "course.json", dst / "mindmaps" / "course.json")
    shutil.copy2(index_path, dst / "mindmaps" / "index.json")
    shutil.copy2(index_path, dst / "mindmap_showcase.json")

    print(
        f"\ndone: {len(chapter_docs)} chapters from classroom PPT/manual → summaries + preview"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
