"""导出知识图谱构建过程展示页数据（分步 + 多模态）。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from teachkg.utils.io import load_jsonl, pretty_json_path, save_json, save_jsonl
from teachkg.stage1_alignment.triplet_extract import is_cross_cue_extract_source


def zh(name: str) -> str:
    return (name or "").split("/")[0].strip()


@lru_cache(maxsize=64)
def load_raw_asr_cues(course_id: str, lecture_id: str) -> tuple[dict, ...]:
    """Stage0 原始 ASR 细粒度 cue（校对分组前）。"""
    path = ROOT / "data/segments" / course_id / "asr_work" / str(lecture_id) / "raw_cues.json"
    if not path.is_file():
        return ()
    raw = json.loads(path.read_text(encoding="utf-8"))
    cues = raw.get("cues") if isinstance(raw, dict) else raw
    if not isinstance(cues, list):
        return ()
    return tuple(cues)


def raw_asr_text_for_window(
    course_id: str,
    lecture_id: str,
    start_sec: float | None,
    end_sec: float | None,
) -> str:
    """按校对后时间窗拼接原始 ASR（与 multimodal_correct 分组输入一致，空格连接）。"""
    if start_sec is None or end_sec is None:
        return ""
    parts: list[str] = []
    for cue in load_raw_asr_cues(course_id, str(lecture_id)):
        try:
            s = float(cue.get("start_sec") or 0)
            e = float(cue.get("end_sec") or 0)
        except (TypeError, ValueError):
            continue
        if e <= float(start_sec) or s >= float(end_sec):
            continue
        text = str(cue.get("text") or "").strip()
        if text:
            parts.append(text)
    return " ".join(parts)


_SENT_BOUND = set("。！？!?；;\n")
_CLAUSE_BOUND = set("。！？!?；;\n，,、")
_FILLER_TERMS = frozenset(
    {
        "我们",
        "你们",
        "他们",
        "这个",
        "那个",
        "一个",
        "就是",
        "那么",
        "所以",
        "因为",
        "但是",
        "然后",
        "现在",
        "今天",
        "这里",
        "那里",
        "什么",
        "怎么",
        "这样",
        "那样",
        "可以",
        "没有",
        "已经",
        "还是",
        "或者",
        "如果",
        "虽然",
        "因此",
        "其实",
        "当然",
        "大家",
        "老师",
        "同学",
        "课程",
        "学期",
        "班级",
        "教室",
        "部分",
        "内容",
        "问题",
        "时候",
        "开始",
        "进行",
        "完成",
        "介绍",
        "讲解",
        "回顾",
        "例如",
        "比如",
        "以上",
        "以下",
        "通过",
        "根据",
        "由于",
        "目前",
        "本学期",
        "提出",
        "表示",
        "描述",
        "表达",
        "推理",
        "证明",
        "定义",
        "概念",
        "基本",
        "原理",
        "形式",
        "需求",
        "对象",
        "字母",
        "小写",
        "结构",
        "逻辑",
        "语义",
        "数学",
        "生活",
        "日常",
    }
)
_SHORT_KEY_TERMS = frozenset({"论域", "真值", "量词", "谓词", "命题", "永真"})
_SUPPLEMENT_LINE_RE = re.compile(
    r"^(?:"
    r"[-•]\s|"
    r"\d+[\.、．]\s*|"
    r"\$\$|"
    r"例如：|"
    r"因此：|"
    r"于是：|"
    r"即：|"
    r".{0,8}：\s*$"
    r")"
)


@lru_cache(maxsize=4)
def load_key_term_lexicon(course_hint: str = "shuliluoji") -> tuple[str, ...]:
    """教材实体中文名（长到短），用作「修正专有名词」词典。"""
    del course_hint  # 预留按课程切换
    textbook_dirs = [
        ROOT / "data/textbook/CS2501-离散数学（数理逻辑与集合论）",
        ROOT / "data/textbook",
    ]
    names: set[str] = set()
    for base in textbook_dirs:
        entity_path = base / "entity_final.json"
        if not entity_path.is_file():
            for p in base.glob("*/entity_final.json"):
                entity_path = p
                break
        if not entity_path.is_file():
            continue
        try:
            rows = json.loads(entity_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            zh_name = str(row.get("name") or "").split("/")[0].strip()
            if _accept_key_term(zh_name):
                names.add(zh_name)
        if names:
            break
    names.update(
        {
            "谓词逻辑",
            "命题逻辑",
            "原子命题",
            "个体常项",
            "个体变项",
            "个体词",
            "论域",
            "永真式",
            "三段论",
            "一阶谓词逻辑",
            "命题演算",
            "联结词",
            "量词",
            "真值",
            "苏格拉底",
            "亚里士多德",
            "柏拉图",
            "全称命题",
            "特称命题",
            "简单命题",
            "推理形式",
        }
    )
    return tuple(sorted((n for n in names if _accept_key_term(n)), key=len, reverse=True))


def _accept_key_term(name: str) -> bool:
    s = (name or "").strip()
    if not s or s in _FILLER_TERMS:
        return False
    if not any("\u4e00" <= c <= "\u9fff" for c in s):
        return False
    # 丢掉课程全名碎片、连接尾巴（如「逻辑与」）
    if s.endswith(("与", "和", "的", "及", "或", "等")):
        return False
    if s.startswith(("与", "和", "的", "及")):
        return False
    if len(s) >= 3:
        return len(s) <= 16
    return s in _SHORT_KEY_TERMS


def _iter_sentence_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    i = 0
    n = len(text)
    while i < n:
        while i < n and text[i] in " \t":
            i += 1
        if i >= n:
            break
        j = i
        while j < n and text[j] not in _SENT_BOUND:
            j += 1
        if j < n and text[j] in _SENT_BOUND:
            j += 1
        if j == i:
            j = i + 1
        spans.append((i, j))
        i = j
    return spans


def _expand_to_clause(text: str, start: int, end: int) -> tuple[int, int]:
    """把区间扩成整句；跨度过大则退化为半句（逗号/顿号界）。"""
    n = len(text)
    start = max(0, min(start, n))
    end = max(start, min(end, n))

    left = start
    while left > 0 and text[left - 1] not in _SENT_BOUND:
        left -= 1
    if start - left > 48:
        left = start
        while left > 0 and text[left - 1] not in _CLAUSE_BOUND:
            left -= 1

    right = end
    while right < n and text[right] not in _SENT_BOUND:
        right += 1
    if right < n and text[right] in _SENT_BOUND:
        right += 1
    elif right - end > 48:
        right = end
        while right < n and text[right] not in _CLAUSE_BOUND:
            right += 1
        if right < n and text[right] in _CLAUSE_BOUND:
            right += 1

    while left < right and text[left] in " \t":
        left += 1
    return left, right


def _sentence_novelty(sent: str, raw: str) -> float:
    """校对句相对原始 ASR 的新颖比例（1=几乎全新）。"""
    if not sent.strip():
        return 0.0
    if not raw.strip():
        return 1.0
    sm = SequenceMatcher(None, raw, sent, autojunk=False)
    matched = sum(blk.size for blk in sm.get_matching_blocks())
    return 1.0 - (matched / max(len(sent), 1))


def _looks_like_supplement_line(sent: str) -> bool:
    s = (sent or "").strip()
    if not s:
        return False
    return bool(_SUPPLEMENT_LINE_RE.match(s))


def _merge_mark_ranges(
    marks: list[tuple[int, int, str]],
    text: str = "",
) -> list[tuple[int, int, str]]:
    """合并重叠/紧邻高亮；add 优先于 change。"""
    if not marks:
        return []
    priority = {"add": 2, "change": 1}
    marks = sorted(marks, key=lambda x: (x[0], -priority.get(x[2], 0), -(x[1] - x[0])))
    merged: list[tuple[int, int, str]] = []
    for a, b, kind in marks:
        if a >= b:
            continue
        if not merged:
            merged.append((a, b, kind))
            continue
        pa, pb, pk = merged[-1]
        gap = text[pb:a] if text else ""
        adjacent_add = (
            kind == "add"
            and pk == "add"
            and a >= pb
            and (a - pb <= 2 or (gap and all(ch in " \t\n" for ch in gap)))
        )
        if a < pb or adjacent_add:
            new_kind = pk if priority.get(pk, 0) >= priority.get(kind, 0) else kind
            merged[-1] = (pa, max(pb, b), new_kind)
        else:
            merged.append((a, b, kind))
    return merged


def _looks_like_asr_mishear(raw_part: str, term: str) -> bool:
    """
    判断 raw_part 是否像「讲到了该术语但 ASR 听错」。
    要求：去标点后长度接近、有序字符覆盖率高、整体相似度够，避免「逻辑」误配「命题逻辑」。
    """
    r = re.sub(r"[\s，。！？；;、,.!?:：…—\-（）()【】\[\]\"“”‘’]+", "", (raw_part or "").strip())
    t = (term or "").strip()
    if not r or not t or r == t:
        return False
    if t in r:
        return False
    # 片段过短（相对术语）则不算听错，多半只是共享词根
    if len(r) < max(2, len(t) - 1):
        return False
    if abs(len(r) - len(t)) > max(2, len(t) // 3):
        return False
    matched = sum(b.size for b in SequenceMatcher(None, r, t).get_matching_blocks())
    recall = matched / max(len(t), 1)
    if recall < 0.7:
        return False
    return SequenceMatcher(None, r, t).ratio() >= 0.6


def _asr_has_misheard_form(raw: str, term: str) -> bool:
    """在整段 ASR 中滑动窗口，寻找术语的听错形态（窗口长度贴近术语）。"""
    r = (raw or "").replace(" ", "")
    t = (term or "").strip()
    if not r or not t or t in r:
        return False
    if len(t) > 8:
        return False  # 过长短语不作「听错修正」
    L = len(t)
    for wlen in range(max(2, L - 1), L + 2):
        if wlen > len(r):
            break
        for i in range(0, len(r) - wlen + 1):
            if _looks_like_asr_mishear(r[i : i + wlen], t):
                return True
    return False


def _term_hits_in(text: str, terms: tuple[str, ...]) -> list[tuple[int, int, str]]:
    """最长优先、不重叠地找出 text 中的术语命中。"""
    hits: list[tuple[int, int, str]] = []
    covered = [False] * len(text)
    for term in terms:
        start = 0
        while True:
            i = text.find(term, start)
            if i < 0:
                break
            j = i + len(term)
            if not any(covered[i:j]):
                hits.append((i, j, term))
                for k in range(i, j):
                    covered[k] = True
            start = i + 1
    return hits


def corrected_diff_spans(raw_text: str, corrected_text: str) -> list[dict]:
    """
    高亮两类差异：
    - change：口述讲到了关键术语，但 ASR 识别错误，由 PPT 校对改正；
    - add：原始 ASR 未讲到、由 PPT/板书补入的内容（整句或半句）。
    """
    raw = raw_text or ""
    corr = corrected_text or ""
    if not corr:
        return []

    terms = load_key_term_lexicon()
    marks: list[tuple[int, int, str]] = []

    if not raw.strip():
        for a, b in _iter_sentence_spans(corr):
            if corr[a:b].strip():
                marks.append((a, b, "add"))
    else:
        sm = SequenceMatcher(None, raw, corr, autojunk=False)
        opcodes = list(sm.get_opcodes())

        # 1) 补充：口述未覆盖的大段/PPT 体例 → 扩成整句或半句
        for tag, i1, i2, j1, j2 in opcodes:
            if tag == "equal" or j2 <= j1:
                continue
            raw_part = raw[i1:i2]
            corr_part = corr[j1:j2]
            # 纯插入，或长替换且校对侧新颖 → 候选补充
            is_pure_insert = tag == "insert" or not raw_part.strip()
            long_novel_replace = (
                tag == "replace"
                and len(corr_part) >= 12
                and _sentence_novelty(corr_part, raw) >= 0.45
            )
            if not (is_pure_insert or long_novel_replace):
                continue
            if len(corr_part.strip()) < 6 and not _looks_like_supplement_line(corr_part):
                continue
            a, b = _expand_to_clause(corr, j1, j2)
            chunk = corr[a:b].strip()
            if len(re.sub(r"[\s\-:：、，。！？；;\n]", "", chunk)) < 6:
                continue
            if _sentence_novelty(chunk, raw) < 0.32 and not _looks_like_supplement_line(chunk):
                continue
            marks.append((a, b, "add"))

        for a, b in _iter_sentence_spans(corr):
            sent = corr[a:b]
            if _looks_like_supplement_line(sent) and len(sent.strip()) >= 2:
                marks.append((a, b, "add"))

        marks = _merge_mark_ranges(marks, corr)

        add_cover = [False] * len(corr)
        for a, b, kind in marks:
            if kind != "add":
                continue
            for k in range(a, min(b, len(corr))):
                add_cover[k] = True

        # 2) 修正：replace 块里「ASR 听错 → 正确术语」
        for tag, i1, i2, j1, j2 in opcodes:
            if tag != "replace" or j2 <= j1:
                continue
            raw_part = raw[i1:i2]
            corr_part = corr[j1:j2]
            if not raw_part.strip() or not corr_part.strip():
                continue
            # 整段就是一个术语
            if corr_part.strip() in terms and _looks_like_asr_mishear(raw_part, corr_part.strip()):
                if not any(add_cover[j1:j2]):
                    marks.append((j1, j2, "change"))
                continue
            # 替换块内的术语命中：需像听错而非凭空插入
            for oi, oj, term in _term_hits_in(corr_part, terms):
                abs_i, abs_j = j1 + oi, j1 + oj
                if any(add_cover[abs_i:abs_j]):
                    continue
                if len(term) > 8:
                    continue
                if term in raw.replace(" ", ""):
                    continue
                if _looks_like_asr_mishear(raw_part, term):
                    marks.append((abs_i, abs_j, "change"))

        # 3) 全局：校对出现、ASR 无全称、但 ASR 有听错形态 → 修正
        raw_compact = raw.replace(" ", "")
        for i, j, term in _term_hits_in(corr, terms):
            if any(add_cover[i:j]):
                continue
            if len(term) > 8:
                continue
            if term in raw_compact:
                continue
            if _asr_has_misheard_form(raw, term):
                marks.append((i, j, "change"))

    marks = _merge_mark_ranges(marks, corr)
    cleaned: list[tuple[int, int, str]] = []
    for a, b, kind in marks:
        piece = corr[a:b].strip()
        if kind == "add" and len(re.sub(r"[\s\-:：、，。！？；;\n]", "", piece)) < 6:
            continue
        if kind == "change" and piece not in terms and not _accept_key_term(piece):
            continue
        cleaned.append((a, b, kind))
    marks = cleaned

    if not marks:
        return [{"kind": "same", "text": corr}]

    spans: list[dict] = []
    cursor = 0
    for a, b, kind in marks:
        if a > cursor:
            spans.append({"kind": "same", "text": corr[cursor:a]})
        spans.append({"kind": kind, "text": corr[a:b]})
        cursor = b
    if cursor < len(corr):
        spans.append({"kind": "same", "text": corr[cursor:]})
    return [s for s in spans if s.get("text")]


def rel_path(path: str | None, html_dir: Path) -> str:
    if not path:
        return ""
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    if not p.exists():
        return ""
    return Path(os.path.relpath(p, html_dir)).as_posix()


def resolve_cue_media(cue: dict, trips: list[dict], html_dir: Path, course_id: str) -> tuple[str, str]:
    """解析片段视频与 PPT 截图路径（相对 html_dir）。

    优先级：
    - clip：cue.clip_path → 三元组 clip_path
    - ppt：Stage0 OCR 按主归属页 → cue.extra.ppt_frame_path → 三元组（旧路径易滞后）
    """
    clip = rel_path(cue.get("clip_path"), html_dir)
    if not clip:
        for t in trips or []:
            clip = rel_path(t.get("clip_path"), html_dir)
            if clip:
                break

    # 片段与 PPT 截图对齐后，优先按时间主归属页取帧，避免旧三元组帧残留
    ppt = _resolve_ppt_from_stage0(cue, html_dir, course_id)
    if not ppt:
        extra = cue.get("extra") if isinstance(cue.get("extra"), dict) else {}
        ppt = rel_path(extra.get("ppt_frame_path"), html_dir)
    if not ppt:
        for t in trips or []:
            ppt = rel_path(
                t.get("ppt_frame_path") or t.get("evidence_ppt_frame_path"),
                html_dir,
            )
            if ppt:
                break
    return clip, ppt


def _resolve_ppt_from_stage0(cue: dict, html_dir: Path, course_id: str) -> str:
    """当 cue.extra 未挂 ppt 帧时，按主归属 PPT 页对齐 OCR 截图。"""
    lecture_id = str(cue.get("lecture_id") or "").strip()
    if not lecture_id or not course_id:
        return ""
    try:
        start = float(cue.get("start_sec") or 0)
        end = float(cue.get("end_sec") or start)
    except (TypeError, ValueError):
        return ""

    segments_dir = ROOT / "data" / "segments"
    seg_txt = segments_dir / course_id / "ppt_change" / f"{lecture_id}_seg.txt"
    ocr_dir = segments_dir / course_id / "asr_work" / lecture_id / "ocr"
    if not seg_txt.is_file() or not ocr_dir.is_dir():
        return ""

    try:
        from teachkg.schemas import SubtitleCue
        from teachkg.stage0_segmentation.ppt_page_utils import primary_page_for_cue
        from teachkg.stage1_alignment.stage0_frame import (
            load_ppt_pages,
            stage0_ocr_frame_path,
        )
        from teachkg.utils.time import parse_time_nodes_file
    except Exception:
        return ""

    try:
        nodes = parse_time_nodes_file(str(seg_txt))
        duration = max(float(nodes[-1]) + 60.0, end + 1.0) if nodes else end + 1.0
    except Exception:
        duration = max(end + 1.0, start + 1.0)

    pages = load_ppt_pages(segments_dir, course_id, lecture_id, duration)
    if not pages:
        return ""

    primary = primary_page_for_cue(
        SubtitleCue(start_sec=start, end_sec=end, text=str(cue.get("asr_text") or "")),
        pages,
    )
    if primary is None:
        return ""
    frame_path = stage0_ocr_frame_path(
        segments_dir, course_id, lecture_id, primary.index
    )
    return rel_path(str(frame_path), html_dir)

def edge_from_trip(t: dict, *, stage: str, idx: int) -> dict:
    pred = t.get("abstract_relation") or t.get("predicate") or t.get("label") or ""
    action = (t.get("correction_action") or "").strip()
    raw_source = str(t.get("extract_source") or stage or "")
    # 跨段边：展示/高亮统一用 cross_cue；原文来源（第N讲的第a段到第b段）另存
    if is_cross_cue_extract_source(raw_source) or stage == "cross_cue":
        source = "cross_cue"
    else:
        source = raw_source or stage
    if action == "revise":
        source = "textbook_revised"
    elif action == "drop":
        source = "filtered"
    # 跨段边不挂课堂原文摘录
    context = (
        ""
        if source == "cross_cue"
        else (
            t.get("classroom_evidence")
            or t.get("context")
            or t.get("source_text")
            or ""
        )
    )
    out = {
        "id": f"{stage}-{idx}",
        "from": t.get("subject") or t.get("head"),
        "to": t.get("object") or t.get("tail"),
        "label": pred,
        "title": t.get("natural_statement")
        or t.get("description")
        or t.get("concrete_relation")
        or "",
        "statement": t.get("natural_statement") or "",
        "description": t.get("description") or "",
        "context": context,
        "relation": pred,
        "source": source,
        "subject_ref": t.get("subject_entity_ref") or "",
        "object_ref": t.get("object_entity_ref") or "",
        "concrete": t.get("concrete_relation") or "",
        "concrete_relation": t.get("concrete_relation") or "",
        "statement_direction": t.get("statement_direction") or "",
        "attribute_category": t.get("attribute_category") or "",
        "correction_action": action or None,
    }
    if source == "cross_cue" and raw_source and raw_source != "cross_cue":
        out["extract_source"] = raw_source
        if not out["title"]:
            out["title"] = raw_source
        elif raw_source not in str(out["title"]):
            out["title"] = f"{out['title']}（{raw_source}）"
    return out


def _corr_endpoint(name: str | None) -> str:
    return (name or "").strip()


def _corr_pred(row: dict | None) -> str:
    if not isinstance(row, dict):
        return ""
    return (
        row.get("abstract_relation")
        or row.get("predicate")
        or row.get("label")
        or row.get("relation")
        or ""
    ).strip()


def _corr_snap(row: dict | None) -> dict:
    """修正对比用的边快照。"""
    if not isinstance(row, dict):
        return {"from": "", "to": "", "label": "", "concrete": "", "direction": ""}
    return {
        "from": _corr_endpoint(row.get("subject") or row.get("from") or row.get("head")),
        "to": _corr_endpoint(row.get("object") or row.get("to") or row.get("tail")),
        "label": _corr_pred(row),
        "concrete": (row.get("concrete_relation") or row.get("concrete") or "").strip(),
        "direction": (row.get("statement_direction") or "").strip(),
    }


def _corr_snap_diff(before: dict, after: dict) -> list[str]:
    changes: list[str] = []
    mapping = [
        ("from", "主体"),
        ("to", "客体"),
        ("label", "关系"),
        ("concrete", "具体关系"),
        ("direction", "方向"),
    ]
    for key, label in mapping:
        if (before.get(key) or "") != (after.get(key) or ""):
            changes.append(label)
    return changes


def _corr_line(snap: dict) -> str:
    """边箭头跟 SPO（主→客）。"""
    sub = (snap.get("from") or "").split("/")[0] or "?"
    obj = (snap.get("to") or "").split("/")[0] or "?"
    pred = snap.get("label") or "?"
    concrete = snap.get("concrete") or ""
    mid = f"{pred}" + (f"·{concrete}" if concrete else "")
    direction = (snap.get("direction") or "").strip() or "subject_to_object"
    if direction == "undirected" or pred in {"synonym_of", "related_with"}:
        return f"{sub} —[{mid}]— {obj}"
    return f"{sub} —[{mid}]→ {obj}"


def _index_corr_actions(actions: list) -> dict[tuple[str, str, str], dict]:
    out: dict[tuple[str, str, str], dict] = {}
    for act in actions:
        if not isinstance(act, dict):
            continue
        orig = act.get("original") or {}
        key = (
            _corr_endpoint(orig.get("subject")),
            _corr_pred(orig),
            _corr_endpoint(orig.get("object")),
        )
        if key[0] or key[2]:
            out[key] = act
    return out


def edge_from_filtered_rel(rel: dict, *, idx: int) -> dict:
    """边筛/未写入的教材候选边（灰色展示）。"""
    return {
        "id": f"filtered-{idx}",
        "from": rel.get("subject") or "",
        "to": rel.get("object") or "",
        "label": rel.get("abstract_relation") or rel.get("predicate") or "",
        "title": rel.get("description") or "",
        "statement": "",
        "description": rel.get("description") or "",
        "context": rel.get("classroom_evidence") or rel.get("context") or "",
        "relation": rel.get("abstract_relation") or rel.get("predicate") or "",
        "source": "filtered",
        "subject_ref": "",
        "object_ref": "",
        "concrete": "",
    }


def _spo_key(subject: str, relation: str, obj: str) -> tuple[str, str, str]:
    return (str(subject or ""), str(relation or ""), str(obj or ""))


def resolve_filtered_textbook_edges(
    cue: dict,
    tb_edges: list[dict],
    retriever,
) -> list[dict]:
    """优先用落盘 filtered_relations；否则用规则候选池 − 已写入边重算。"""
    sg = (cue.get("stage1") or {}).get("textbook_subgraph") or {}
    stored = sg.get("filtered_relations")
    if isinstance(stored, list) and stored:
        return [edge_from_filtered_rel(r, idx=i) for i, r in enumerate(stored) if r]

    if retriever is None:
        return []
    extract = _resolve_extract_text(cue)
    seeds = as_name_set(sg.get("seed_entities"))
    if not extract or not seeds:
        return []

    alias0, emb0 = retriever.find_seed_entities_by_source(extract)
    pool = alias0 | emb0
    alias = as_name_set(sg.get("alias_seeds")) or (seeds & alias0)
    emb = as_name_set(sg.get("embedding_seeds")) or (seeds - alias)
    result = retriever.retrieve_from_seeds(
        seeds,
        extract,
        candidate_seed_pool=pool or seeds,
        alias_seeds=alias,
        embedding_seeds=emb,
    )
    kept = {
        _spo_key(e.get("from"), e.get("relation") or e.get("label"), e.get("to"))
        for e in tb_edges
    }
    candidates = list(result.candidate_relations or result.relations)
    out: list[dict] = []
    for i, rel in enumerate(candidates):
        key = _spo_key(rel.subject, rel.predicate, rel.object)
        if key in kept:
            continue
        out.append(
            edge_from_filtered_rel(
                {
                    "subject": rel.subject,
                    "object": rel.object,
                    "abstract_relation": rel.predicate,
                    "description": rel.description,
                    "context": rel.context,
                },
                idx=i,
            )
        )
    return out


def nodes_from_names(
    names: set[str],
    *,
    kind: str = "entity",
    importance: dict[str, float] | None = None,
    importance_base: dict[str, float] | None = None,
) -> list[dict]:
    from teachkg.textbook_kg.importance_feedback import importance_to_node_size

    def lookup(maps: dict[str, float] | None, name: str) -> float | None:
        if not maps:
            return None
        score = maps.get(name)
        if score is not None:
            return float(score)
        score = maps.get(zh(name))
        if score is not None:
            return float(score)
        for k, v in maps.items():
            if zh(k) == zh(name):
                return float(v)
        return None

    out = []
    for name in sorted(names):
        if not name:
            continue
        score = lookup(importance, name)
        base = lookup(importance_base, name)
        node = {
            "id": name,
            "label": zh(name),
            "title": name,
            "kind": kind,
        }
        if score is not None:
            node["importance"] = round(float(score), 4)
            node["size"] = round(importance_to_node_size(float(score)), 2)
            tip = [name, f"反馈后: {float(score):.3f}"]
            if base is not None:
                node["importance_base"] = round(float(base), 4)
                delta = float(score) - float(base)
                node["importance_delta"] = round(delta, 4)
                tip.append(f"教材先验: {float(base):.3f}")
                tip.append(f"变化 Δ: {delta:+.3f}")
            node["title"] = "\n".join(tip)
        elif base is not None:
            node["importance_base"] = round(float(base), 4)
            node["title"] = f"{name}\n教材先验: {float(base):.3f}"
        out.append(node)
    return out


def as_name_set(value) -> set[str]:
    if isinstance(value, list):
        return {str(x) for x in value if x}
    if isinstance(value, set):
        return {str(x) for x in value if x}
    return set()


def _resolve_extract_text(cue: dict) -> str:
    s1 = cue.get("stage1") or {}
    asr = (cue.get("asr_text") or "").strip()
    extract = (s1.get("extract_text") or "").strip()
    status = s1.get("text_preprocess_status") or ""
    if status == "empty_after_preprocess":
        return ""
    if not extract and status in {"unchanged", "changed"} and asr:
        return asr
    return extract


def _cross_cue_char_budget() -> int:
    """与 configs/teaching.yaml cross_cue_extract.char_budget 对齐，缺省 1500。"""
    path = ROOT / "configs" / "teaching.yaml"
    if not path.is_file():
        return 1500
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return 1500
    m = re.search(
        r"cross_cue_extract\s*:\s*(?:.*\n)*?\s*char_budget\s*:\s*(\d+)",
        text,
    )
    if m:
        return max(1, int(m.group(1)))
    return 1500


def build_cross_cue_window_items(
    cues: list[dict],
    trips_all: list[dict],
    *,
    lecture_id: str,
    importance: dict[str, float] | None = None,
    importance_base: dict[str, float] | None = None,
    char_budget: int | None = None,
) -> list[dict]:
    """讲次级跨段窗口展示项：拼多段文本 + 该窗跨段边（挂在片段列表末尾）。"""
    from teachkg.stage1_alignment.triplet_extract import (
        build_char_half_windows,
        format_cross_cue_source_span,
    )

    ordered: list[tuple[dict, str]] = []
    for cue in cues:
        text = _resolve_extract_text(cue)
        if not text:
            continue
        ordered.append((cue, text))
    if len(ordered) < 2:
        return []

    budget = max(1, int(char_budget if char_budget is not None else _cross_cue_char_budget()))
    lengths = [len(t) for _, t in ordered]
    windows = build_char_half_windows(lengths, char_budget=budget)
    if not windows:
        return []

    by_span: dict[str, list[dict]] = defaultdict(list)
    for t in trips_all:
        src = str(t.get("extract_source") or "")
        if is_cross_cue_extract_source(src):
            by_span[src].append(t)

    # 去重掉的候选：记在 cue.stage1.triplet_validation.cross_cue_window_logs
    deduped_by_span: dict[str, list[dict]] = defaultdict(list)
    for cue in cues:
        s1 = cue.get("stage1") or {}
        tv = s1.get("triplet_validation") or {}
        for log in tv.get("cross_cue_window_logs") or []:
            if not isinstance(log, dict):
                continue
            span_key = str(log.get("source_span") or "")
            for row in log.get("deduped_triples") or []:
                if isinstance(row, dict):
                    deduped_by_span[span_key].append(row)
        for row in tv.get("cross_cue_deduped") or []:
            if not isinstance(row, dict):
                continue
            span_key = str(row.get("extract_source") or "")
            if span_key:
                deduped_by_span[span_key].append(row)

    out: list[dict] = []
    for start_i, end_i in windows:
        span = format_cross_cue_source_span(lecture_id, start_i + 1, end_i + 1)
        segs = ordered[start_i : end_i + 1]
        parts: list[str] = []
        for offset, (_cue, txt) in enumerate(segs):
            seg_no = start_i + offset + 1
            parts.append(f"### 第{seg_no}段\n{txt}")
        window_text = "\n\n".join(parts)
        group = list(by_span.get(span, []))
        edges = [
            edge_from_trip(t, stage="cross_cue", idx=i) for i, t in enumerate(group)
        ]
        for e in edges:
            e["lecture_id"] = str(lecture_id)
            e["cue_label"] = span

        # 去重结果：灰边，默认隐藏
        seen_spo = {
            (
                str(e.get("from") or ""),
                str(e.get("relation") or e.get("label") or ""),
                str(e.get("to") or ""),
            )
            for e in edges
        }
        filtered_edges: list[dict] = []
        for i, row in enumerate(deduped_by_span.get(span, [])):
            fe = edge_from_trip(
                {
                    **row,
                    "extract_source": row.get("extract_source") or span,
                    "correction_action": "drop",
                },
                stage="cross_cue_deduped",
                idx=i,
            )
            fe["source"] = "filtered"
            fe["lecture_id"] = str(lecture_id)
            fe["cue_label"] = span
            reason = (
                row.get("dedupe_reason_zh")
                or row.get("dedupe_reason")
                or "去重"
            )
            fe["dedupe_reason"] = row.get("dedupe_reason") or ""
            fe["dedupe_reason_zh"] = reason
            fe["title"] = (
                f"{fe.get('title') or fe.get('description') or ''}（去重：{reason}）"
            ).strip("（）")
            spo = (
                str(fe.get("from") or ""),
                str(fe.get("relation") or fe.get("label") or ""),
                str(fe.get("to") or ""),
            )
            if not spo[0] or not spo[2] or spo in seen_spo:
                continue
            seen_spo.add(spo)
            filtered_edges.append(fe)

        all_edges = edges + filtered_edges
        names = {e.get("from") or "" for e in all_edges} | {
            e.get("to") or "" for e in all_edges
        }
        names.discard("")
        nodes = nodes_from_names(
            names,
            kind="delta",
            importance=importance,
            importance_base=importance_base,
        )
        for n in nodes:
            tip = str(n.get("title") or n.get("id") or "")
            if "跨段" not in tip:
                n["title"] = f"{tip}\n来源: 跨段衔接" if tip else "跨段衔接"

        first_cue, last_cue = segs[0][0], segs[-1][0]
        out.append(
            {
                "cue_id": f"__cross_cue__{start_i + 1}_{end_i + 1}",
                "lecture_id": str(lecture_id),
                "is_cross_cue": True,
                "cross_cue_span": span,
                "start_seg": start_i + 1,
                "end_seg": end_i + 1,
                "start_sec": first_cue.get("start_sec"),
                "end_sec": last_cue.get("end_sec"),
                "extract_text": window_text,
                "asr_text": "",
                "media": {},
                "stages": [
                    {
                        "id": "cross_cue",
                        "title": "跨段抽取",
                        "subtitle": span,
                        "blurb": (
                            "左栏为窗口内多段拼接文本，右栏为该窗跨段关系；"
                            "灰虚线=去重掉的候选（与本讲已有边或重叠窗重复）。"
                        ),
                        "focus": "graph",
                        "text": window_text,
                        "nodes": nodes,
                        "edges": all_edges,
                        "stats": {
                            "segments": end_i - start_i + 1,
                            "chars": sum(lengths[start_i : end_i + 1]),
                            "edges": len(edges),
                            "deduped": len(filtered_edges),
                        },
                    }
                ],
                "cross_cue_edges": edges,
                "cross_cue_deduped_edges": filtered_edges,
                "triplets": [],
            }
        )
    return out


def seed_nodes_for_display(
    sg: dict, tb: list[dict]
) -> tuple[list[dict], set[str], set[str], set[str], set[str]]:
    """返回 (nodes, kept_seeds, alias_kept, emb_kept, filtered_out)。"""
    alias = as_name_set(sg.get("alias_seeds"))
    emb = as_name_set(sg.get("embedding_seeds"))
    seeds = as_name_set(sg.get("seed_entities"))
    cand_alias = as_name_set(sg.get("seed_candidates_alias"))
    cand_emb = as_name_set(sg.get("seed_candidates_embedding"))
    if not seeds:
        seeds = alias | emb
    if not seeds and not cand_alias and not cand_emb:
        for t in tb:
            seeds.add(t.get("subject") or "")
            seeds.add(t.get("object") or "")
        seeds.discard("")
        alias = set(seeds)
        emb = set()
    elif alias or emb:
        alias &= seeds
        emb = (emb & seeds) - alias
        alias |= seeds - alias - emb
    else:
        alias = set(seeds)
        emb = set()

    # 候选 − 保留 = 被筛掉（灰）
    if not cand_alias and not cand_emb:
        filtered: set[str] = set()
    else:
        filtered = (cand_alias | cand_emb) - seeds
    filtered_alias = sorted(filtered & cand_alias)
    filtered_emb = sorted(filtered - set(filtered_alias))

    nodes = (
        nodes_from_names(alias, kind="seed_alias")
        + nodes_from_names(emb, kind="seed_embedding")
        + nodes_from_names(set(filtered_alias), kind="seed_filtered_alias")
        + nodes_from_names(set(filtered_emb), kind="seed_filtered_embedding")
    )
    for n in nodes:
        if str(n.get("kind", "")).startswith("seed_filtered"):
            src = "alias" if n["kind"] == "seed_filtered_alias" else "embedding"
            n["title"] = f"{n.get('id')}\n（已筛掉 · {src}）"
    return nodes, seeds, alias, emb, filtered


def entity_in_textbook(
    name: str,
    textbook_names: set[str] | None,
    textbook_keys: set[str] | None = None,
) -> bool:
    """判断实体是否已在教材母图中（全名 / 中文主名 / 清洗别名）。"""
    if not name:
        return False
    if textbook_names and name in textbook_names:
        return True
    if not textbook_keys:
        return False
    label = zh(name)
    if label and label in textbook_keys:
        return True
    from teachkg.textbook_kg.alias import clean_text

    for raw in (name, label):
        key = clean_text(raw or "")
        if key and key in textbook_keys:
            return True
    return False


def textbook_name_index_from_retriever(retriever) -> tuple[set[str], set[str]]:
    """教材实体全名集合 + 匹配键（中文主名 / 清洗别名）。"""
    kg = getattr(retriever, "kg", None)
    if kg is None:
        return set(), set()
    from teachkg.textbook_kg.alias import clean_text

    names = {str(n).strip() for n in (getattr(kg, "entities", {}) or {}) if str(n).strip()}
    keys: set[str] = set()
    for n in names:
        label = zh(n)
        if label:
            keys.add(label)
        cleaned = clean_text(n)
        if cleaned:
            keys.add(cleaned)

    alias_map = getattr(kg, "alias_map", None) or {}
    if isinstance(alias_map, dict):
        # alias_map: cleaned_alias → [canonical entity names]
        for alias, canons in alias_map.items():
            if isinstance(alias, str) and alias.strip():
                keys.add(alias.strip())
            if isinstance(canons, str) and canons.strip():
                names.add(canons.strip())
            elif isinstance(canons, (list, tuple)):
                for c in canons:
                    if c and str(c).strip():
                        names.add(str(c).strip())

    for n in list(names):
        label = zh(n)
        if label:
            keys.add(label)
        cleaned = clean_text(n)
        if cleaned:
            keys.add(cleaned)
    return names, keys


def _textbook_stage_nodes(
    textbook_nodes: set[str],
    alias_seeds: set[str],
    emb_seeds: set[str],
    seed_nodes: set[str],
    *,
    importance: dict[str, float] | None = None,
    importance_base: dict[str, float] | None = None,
) -> list[dict]:
    """教材子图节点：种子用 seed_*，其余扩展实体用 textbook。"""
    display = set(textbook_nodes) | set(seed_nodes)
    alias = (alias_seeds | (seed_nodes - emb_seeds)) & display
    emb = (emb_seeds & display) - alias
    # 无来源标注的剩余种子
    seed_rest = (seed_nodes & display) - alias - emb
    other = display - alias - emb - seed_rest
    return (
        nodes_from_names(
            alias, kind="seed_alias", importance=importance, importance_base=importance_base
        )
        + nodes_from_names(
            emb | seed_rest,
            kind="seed_embedding" if emb else "seed",
            importance=importance,
            importance_base=importance_base,
        )
        + nodes_from_names(
            other, kind="textbook", importance=importance, importance_base=importance_base
        )
    )


def annotate_graph_node_kinds(
    stages: list[dict],
    *,
    seed_nodes: set[str],
    tb_edges: list[dict],
    delta_edges: list[dict],
    fb_edges: list[dict],
    new_entities: set[str],
    textbook_names: set[str] | None = None,
    textbook_keys: set[str] | None = None,
) -> None:
    """按实体角色着色节点，避免 delta/merge 步全部显示为同一蓝色。

    增量边上的端点若已在教材母图中，视为教材实体（边新增），不算新增节点。
    """
    tb_endpoints = {e["from"] for e in tb_edges} | {e["to"] for e in tb_edges}
    fb_endpoints = {e["from"] for e in fb_edges} | {e["to"] for e in fb_edges}
    delta_endpoints = {e["from"] for e in delta_edges} | {e["to"] for e in delta_edges}

    for st in stages:
        stage_id = st.get("id")
        if stage_id not in {"delta", "merge"}:
            continue
        for n in st.get("nodes") or []:
            nid = n.get("id") or ""
            in_tb_kg = entity_in_textbook(nid, textbook_names, textbook_keys)
            if nid in new_entities and not in_tb_kg:
                n["kind"] = "new"
            elif nid in seed_nodes or nid in tb_endpoints or in_tb_kg:
                n["kind"] = "textbook"
            elif nid in fb_endpoints and nid not in tb_endpoints:
                n["kind"] = "fallback"
            elif nid in delta_endpoints:
                n["kind"] = "delta"
            else:
                n["kind"] = "entity"


def build_seed_retriever(course_id: str):
    """构建与 Stage1 一致的种子检索器（含 LLM 种子筛）。"""
    from teachkg.config import TeachKGConfig
    from teachkg.textbook_kg import seed_filter as seed_filter_mod
    from teachkg.textbook_kg import subgraph, theorem_edges
    from teachkg.textbook_kg.loader import TextbookKG

    cfg = TeachKGConfig.from_yaml(ROOT / "configs/teaching.yaml")
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    rcfg = tb.get("subgraph", {}) or {}
    filter_cfg = rcfg.get("seed_llm_filter", {}) or {}
    kg_path = ROOT / tb.get("path", "data/textbook")
    kg = TextbookKG.load(
        kg_path,
        entity_file=tb.get("entity_file", "entity_final.json"),
        relations_file=tb.get("relations_file", tb.get("relation_file", "relations_final.json")),
        importance_file=tb.get("importance_file", "entity_sorted_ppr.json"),
        importance_bundle_file=tb.get("importance_bundle_file", "importance_bundle.json"),
    )
    if rcfg.get("include_theorem_edges", True):
        kg = theorem_edges.augment_textbook_kg(kg)

    seed_llm_filter = None
    if filter_cfg.get("enabled", False):
        seed_llm_filter = seed_filter_mod.SeedLLMFilter(
            enabled=True,
            prompt=filter_cfg.get("prompt", "stage1/seed_filter.txt"),
            temperature=float(filter_cfg.get("temperature", 0.1) or 0.1),
            llm_model=filter_cfg.get("llm_model"),
            min_candidates=int(filter_cfg.get("min_candidates", 1) or 1),
            fallback_keep_all_on_empty=bool(
                filter_cfg.get("fallback_keep_all_on_empty", False)
            ),
            fallback_to_alias_on_empty=(
                filter_cfg["fallback_to_alias_on_empty"]
                if "fallback_to_alias_on_empty" in filter_cfg
                else None
            ),
            course_context=course_id,
        )

    return subgraph.TextbookSubgraphRetriever(
        kg,
        max_hops=int(rcfg.get("max_hops", 1)),
        max_edges_per_cue=rcfg.get("max_edges_per_cue"),
        max_seed_entities=int(rcfg.get("max_seed_entities", 40)),
        embedding_link_enabled=bool(rcfg.get("embedding_link_enabled", False)),
        embedding_link_top_k=rcfg.get("embedding_link_top_k"),
        embedding_link_words_per_seed=int(
            rcfg.get("embedding_link_words_per_seed", 25) or 0
        ),
        embedding_link_min_score=float(rcfg.get("embedding_link_min_score", 0.82)),
        embedder_model=str(
            rcfg.get("embedder_model", "shibing624/text2vec-base-multilingual")
        ),
        embedding_cache_enabled=bool(rcfg.get("embedding_cache_enabled", True)),
        textbook_base_path=kg_path,
        seed_llm_filter=seed_llm_filter,
        edge_llm_filter=None,
    )


def refresh_seed_splits(cues: list[dict], course_id: str) -> int:
    """旧产物缺少 alias/embedding 列表时，现场 resolve 并写回 stage1.textbook_subgraph。"""
    need = []
    for cue in cues:
        sg = (cue.get("stage1") or {}).get("textbook_subgraph") or {}
        if isinstance(sg.get("alias_seeds"), list) or isinstance(
            sg.get("embedding_seeds"), list
        ):
            continue
        need.append(cue)
    if not need:
        return 0

    print(f"refreshing seed splits for {len(need)} cue(s)…")
    retriever = build_seed_retriever(course_id)
    updated = 0
    for cue in need:
        extract = _resolve_extract_text(cue)
        s1 = dict(cue.get("stage1") or {})
        sg = dict(s1.get("textbook_subgraph") or {})
        if not extract:
            sg["seed_entities"] = []
            sg["alias_seeds"] = []
            sg["embedding_seeds"] = []
        else:
            expand, alias, emb = retriever.resolve_seed_sets(extract)
            sg["seed_entities"] = sorted(expand)
            sg["alias_seeds"] = sorted(expand & alias)
            sg["embedding_seeds"] = sorted(expand - alias)
            print(
                f"  {cue.get('cue_id')}: alias={len(sg['alias_seeds'])} "
                f"emb={len(sg['embedding_seeds'])} total={len(expand)}"
            )
        s1["textbook_subgraph"] = sg
        cue["stage1"] = s1
        updated += 1
    return updated


def build_cue_payload(
    cue: dict,
    trips: list[dict],
    html_dir: Path,
    *,
    retriever=None,
    importance: dict[str, float] | None = None,
    importance_base: dict[str, float] | None = None,
    course_id: str | None = None,
) -> dict:
    s1 = cue.get("stage1") or {}
    sg = s1.get("textbook_subgraph") or {}
    ents = as_name_set(sg.get("entities"))
    if isinstance(sg.get("relations"), list):
        for rel in sg["relations"]:
            if isinstance(rel, dict):
                ents.add(rel.get("subject") or "")
                ents.add(rel.get("object") or "")
    ents.discard("")

    tb = [t for t in trips if t.get("extract_source") == "textbook"]
    delta = [t for t in trips if t.get("extract_source") == "lecture_delta"]
    fb = [t for t in trips if t.get("extract_source") == "llm_fallback"]
    # 跨段边：不进入段级 delta/merge 展示，单独挂在 item.cross_cue_edges，供讲次/课堂级并入
    cross = [
        t
        for t in trips
        if is_cross_cue_extract_source(str(t.get("extract_source") or ""))
    ]

    asr = (cue.get("asr_text") or "").strip()
    extract = _resolve_extract_text(cue)
    status = s1.get("text_preprocess_status") or ""
    lecture_id = str(cue.get("lecture_id") or "")
    cid = str(
        course_id
        or cue.get("course_id")
        or (str(cue.get("cue_id") or "").split("_", 1)[0] if cue.get("cue_id") else "")
    )
    raw_asr = raw_asr_text_for_window(
        cid,
        lecture_id,
        cue.get("start_sec"),
        cue.get("end_sec"),
    )
    if not raw_asr:
        raw_asr = asr
    corrected_spans = corrected_diff_spans(raw_asr, asr)

    seed_nodes_list, seed_nodes, alias_seeds, emb_seeds, filtered_seeds = (
        seed_nodes_for_display(sg, tb)
    )
    ents |= seed_nodes | filtered_seeds
    cand_alias = as_name_set(sg.get("seed_candidates_alias"))
    cand_emb = as_name_set(sg.get("seed_candidates_embedding"))
    alias_total = (
        max(len(cand_alias), len(alias_seeds))
        if cand_alias
        else len(alias_seeds)
        + sum(1 for n in seed_nodes_list if n.get("kind") == "seed_filtered_alias")
    )
    emb_total = (
        max(len(cand_emb), len(emb_seeds))
        if cand_emb
        else len(emb_seeds)
        + sum(1 for n in seed_nodes_list if n.get("kind") == "seed_filtered_embedding")
    )

    tb_edges = [edge_from_trip(t, stage="textbook", idx=i) for i, t in enumerate(tb)]
    delta_edges = [edge_from_trip(t, stage="delta", idx=i) for i, t in enumerate(delta)]
    fb_edges = [edge_from_trip(t, stage="fallback", idx=i) for i, t in enumerate(fb)]
    cross_edges = [
        edge_from_trip(t, stage="cross_cue", idx=i) for i, t in enumerate(cross)
    ]
    filtered_edges = resolve_filtered_textbook_edges(cue, tb_edges, retriever)
    textbook_stage_edges = tb_edges + filtered_edges
    textbook_nodes = {e["from"] for e in textbook_stage_edges} | {
        e["to"] for e in textbook_stage_edges
    }

    # —— 教材子图修正（课堂反馈，叠加字段；不改 kg / 原教材 SPO）——
    # 教材步：kg 原边；修正步：stage1.textbook_correction 视图
    corr_meta = s1.get("textbook_correction") or {}
    corr_trips = list(corr_meta.get("corrected_triples") or [])
    corr_actions = list(corr_meta.get("actions") or [])
    # 仅当「从未跑过修正」时回退为教材边全 keep。
    # 已跑修正且 corrected_triples 为空 = 全部 drop，只画 drop 灰虚线，勿回填 keep。
    corr_ran = (
        "corrected_triples" in corr_meta
        or "stats" in corr_meta
        or bool(corr_actions)
    )
    if not corr_trips and not corr_meta.get("skipped") and not corr_ran:
        # 无修正记录时，修正阶段暂用当前 textbook 边（视为全 keep）
        corr_trips = [{**t, "correction_action": "keep"} for t in tb]
    corr_edges = [
        edge_from_trip(
            {
                **t,
                "extract_source": t.get("extract_source") or "textbook",
                "correction_action": t.get("correction_action") or "keep",
            },
            stage="correct",
            idx=i,
        )
        for i, t in enumerate(corr_trips)
    ]
    action_by_orig = _index_corr_actions(corr_actions)
    input_by_spo: dict[tuple[str, str, str], dict] = {}
    for row in corr_meta.get("input_triples") or []:
        if not isinstance(row, dict):
            continue
        input_by_spo[
            (
                _corr_endpoint(row.get("subject")),
                _corr_pred(row),
                _corr_endpoint(row.get("object")),
            )
        ] = row
    before_ghost_edges: list[dict] = []
    for e, t in zip(corr_edges, corr_trips):
        short = (t.get("correction_reason_short") or "").strip()
        detail = (t.get("correction_reason_detail") or "").strip()
        evidence = (t.get("correction_evidence") or "").strip()
        reason = (t.get("correction_reason") or "").strip()
        if not detail and reason:
            detail = reason
        action = (t.get("correction_action") or "keep").strip()
        after_snap = _corr_snap(t)
        before_src = (
            t.get("correction_from")
            if isinstance(t.get("correction_from"), dict)
            else None
        )
        matched_act: dict | None = None
        if action == "revise":
            from_key = None
            if isinstance(before_src, dict):
                from_key = (
                    _corr_endpoint(before_src.get("subject")),
                    _corr_pred(before_src),
                    _corr_endpoint(before_src.get("object")),
                )
            for act in corr_actions:
                if not isinstance(act, dict):
                    continue
                if str(act.get("action") or "").lower() != "revise":
                    continue
                rev = act.get("revised") or {}
                orig = act.get("original") or {}
                rev_match = (
                    _corr_endpoint(rev.get("subject")) == after_snap["from"]
                    and _corr_endpoint(rev.get("object")) == after_snap["to"]
                    and (_corr_pred(rev) or after_snap["label"]) == after_snap["label"]
                )
                orig_match = from_key is not None and (
                    _corr_endpoint(orig.get("subject")),
                    _corr_pred(orig),
                    _corr_endpoint(orig.get("object")),
                ) == from_key
                if rev_match or orig_match:
                    matched_act = act
                    break
        else:
            matched_act = action_by_orig.get(
                (after_snap["from"], after_snap["label"], after_snap["to"])
            )

        if matched_act:
            if action == "revise":
                before_src = matched_act.get("original") or before_src
            if not short:
                short = str(matched_act.get("reason") or "").strip()
            if not detail:
                detail = str(matched_act.get("reason_detail") or "").strip() or short
            if not evidence:
                evidence = str(matched_act.get("evidence") or "").strip()

        if action == "keep":
            before_snap = dict(after_snap)
        elif isinstance(before_src, dict):
            before_snap = _corr_snap(before_src)
            # correction_from / LLM original 常只有 SPO，用 matched original 补全
            if matched_act and isinstance(matched_act.get("original"), dict):
                full = _corr_snap(matched_act["original"])
                for k in ("concrete", "direction", "label"):
                    if not before_snap.get(k) and full.get(k):
                        before_snap[k] = full[k]
        else:
            before_snap = dict(after_snap)

        # 教材输入边有完整 concrete / direction：优先补全修正前快照
        before_key = (
            before_snap.get("from") or "",
            before_snap.get("label") or "",
            before_snap.get("to") or "",
        )
        input_row = input_by_spo.get(before_key) or {}
        if not input_row and isinstance(before_src, dict):
            input_row = (
                input_by_spo.get(
                    (
                        _corr_endpoint(before_src.get("subject")),
                        _corr_pred(before_src),
                        _corr_endpoint(before_src.get("object")),
                    )
                )
                or {}
            )
        if input_row:
            full_in = _corr_snap(input_row)
            for k in ("concrete", "direction", "label"):
                # direction/concrete：输入边为准（避免缺省成主→客造成假「方向变化」）
                if full_in.get(k) and (
                    not before_snap.get(k) or k in ("concrete", "direction")
                ):
                    if k in ("concrete", "direction") or not before_snap.get(k):
                        before_snap[k] = full_in[k]
            # 若 before 仍缺 label，用输入谓词
            if not before_snap.get("label") and full_in.get("label"):
                before_snap["label"] = full_in["label"]

        changes = (
            _corr_snap_diff(before_snap, after_snap)
            if action == "revise"
            else (["删除"] if action == "drop" else [])
        )
        e["correction_reason"] = short or reason
        e["correction_reason_detail"] = detail
        e["correction_evidence"] = evidence
        e["before"] = before_snap
        e["after"] = after_snap
        e["changes"] = changes
        # 左栏高亮：修正前关系依据 vs 课堂修正依据
        before_key = (
            before_snap.get("from") or "",
            before_snap.get("label") or "",
            before_snap.get("to") or "",
        )
        input_row = input_by_spo.get(before_key) or input_row or {}
        basis_before = (
            str(input_row.get("context") or "").strip()
            or str(
                (before_src or {}).get("context") if isinstance(before_src, dict) else ""
            ).strip()
            or str(t.get("context") or "").strip()
        )
        basis_after = (
            evidence
            or str((matched_act or {}).get("evidence") or "").strip()
            or str(t.get("context") or "").strip()
        )
        # keep：课堂依据即共同依据（便于左栏高亮为「相同」色）
        if action == "keep" and evidence:
            basis_before = evidence
            basis_after = evidence
        e["basis_before"] = basis_before
        e["basis_after"] = basis_after
        e["compare_text"] = (
            f"前：{_corr_line(before_snap)}\n后：{_corr_line(after_snap)}"
            if action == "revise"
            else (
                f"删除：{_corr_line(before_snap)}"
                if action == "drop"
                else f"保留：{_corr_line(after_snap)}"
            )
        )
        title_bits = [
            e.get("compare_text") or "",
            (changes and f"变化：{'、'.join(changes)}"),
            short and f"理由：{short}",
            detail and f"详述：{detail}",
            evidence and f"依据：{evidence}",
        ]
        e["title"] = "\n".join(b for b in title_bits if b)
        # 图上同时画「修订前」灰虚线，便于对照
        if action == "revise" and changes:
            before_ghost_edges.append(
                {
                    "id": f"correct-before-{e['id']}",
                    "from": before_snap.get("from") or "",
                    "to": before_snap.get("to") or "",
                    "label": before_snap.get("label") or "",
                    "concrete": before_snap.get("concrete") or "",
                    "relation": before_snap.get("label") or "",
                    "statement_direction": before_snap.get("direction") or "",
                    "source": "textbook_before",
                    "correction_action": "revise_before",
                    "before": before_snap,
                    "after": after_snap,
                    "changes": changes,
                    "compare_text": e["compare_text"],
                    "correction_reason": short or reason,
                    "correction_reason_detail": detail,
                    "correction_evidence": evidence,
                    "basis_before": basis_before,
                    "basis_after": basis_after,
                    "title": f"修订前\n{e['compare_text']}",
                    "pair_id": e["id"],
                }
            )
            e["pair_id"] = e["id"]
    # drop 边：从 actions 还原，展示为灰虚线
    drop_edges = []
    for i, act in enumerate(corr_actions):
        if not isinstance(act, dict):
            continue
        if str(act.get("action") or "").lower() != "drop":
            continue
        orig = act.get("original") or {}
        before_snap = _corr_snap(orig)
        short = str(act.get("reason") or "").strip()
        detail = str(act.get("reason_detail") or "").strip() or short
        evidence = str(act.get("evidence") or "").strip()
        before_key = (
            before_snap.get("from") or "",
            before_snap.get("label") or "",
            before_snap.get("to") or "",
        )
        input_row = input_by_spo.get(before_key) or {}
        if input_row:
            full_in = _corr_snap(input_row)
            for k in ("concrete", "direction", "label"):
                if full_in.get(k) and (
                    not before_snap.get(k) or k in ("concrete", "direction")
                ):
                    before_snap[k] = full_in[k]
        basis_before = str(input_row.get("context") or "").strip()
        basis_after = evidence
        compare_text = f"删除：{_corr_line(before_snap)}"
        title_bits = [
            compare_text,
            short and f"理由：{short}",
            detail and f"详述：{detail}",
            evidence and f"依据：{evidence}",
        ]
        drop_edges.append(
            {
                "id": f"correct-drop-{i}",
                "from": before_snap.get("from") or "",
                "to": before_snap.get("to") or "",
                "label": before_snap.get("label") or "related_with",
                "title": "\n".join(b for b in title_bits if b) or "课堂反馈删除",
                "source": "filtered",
                "relation": before_snap.get("label") or "related_with",
                "concrete": before_snap.get("concrete") or "",
                "correction_action": "drop",
                "correction_reason": short or "课堂反馈删除",
                "correction_reason_detail": detail,
                "correction_evidence": evidence,
                "basis_before": basis_before,
                "basis_after": basis_after,
                "before": before_snap,
                "after": None,
                "changes": ["删除"],
                "compare_text": compare_text,
            }
        )
    correct_stage_edges = corr_edges + before_ghost_edges + drop_edges
    correct_nodes = {e["from"] for e in correct_stage_edges if e.get("from")} | {
        e["to"] for e in correct_stage_edges if e.get("to")
    }
    corr_stats = corr_meta.get("stats") or {}

    new_entities = set()
    for t in delta:
        if t.get("subject_entity_ref") == "new":
            new_entities.add(t.get("subject") or "")
        if t.get("object_entity_ref") == "new":
            new_entities.add(t.get("object") or "")
    new_entities.discard("")

    clip, ppt = resolve_cue_media(cue, trips, html_dir, cid)

    stages = [
        {
            "id": "asr",
            "title": "课堂口述",
            "subtitle": "原始 ASR ↔ PPT 校对",
            "blurb": "左侧为原始转写；右侧为 PPT/板书校对。琥珀=口述讲到但 ASR 听错的术语；绿色=口述未讲、由 PPT 补入的整句/半句。",
            "nodes": [],
            "edges": [],
            "focus": "text",
            "text": asr,
            "raw_text": raw_asr,
            "corrected_text": asr,
            "corrected_spans": corrected_spans,
            "text_compare": True,
            "compare_mode": "asr",
            "stats": {
                "raw_chars": len(raw_asr),
                "corrected_chars": len(asr),
            },
        },
        {
            "id": "preprocess",
            "title": "文本预处理",
            "subtitle": "校对文本 ↔ extract_text",
            "blurb": "左为 PPT 校对后的口述文本，右为清洗后的可抽取文本（去寒暄与无关话术）。",
            "nodes": [],
            "edges": [],
            "focus": "text",
            "text": extract or "（预处理后为空）",
            "raw_text": asr,
            "corrected_text": extract or "（预处理后为空）",
            "text_compare": True,
            "compare_mode": "preprocess",
            "stats": {
                "status": status or "—",
                "before_chars": len(asr),
                "after_chars": len(extract),
            },
        },
        {
            "id": "seeds",
            "title": "种子实体",
            "subtitle": "原文高亮 ↔ 筛选后的扩展出发点",
            "blurb": "左：预处理文本中命中的种子；右：保留种子（绿/青=原文命中，琥珀=未匹配）。可展开已筛掉候选。",
            "nodes": seed_nodes_list,
            "edges": [],
            "focus": "text",
            "text": extract,
            "stats": {
                "alias": f"{len(alias_seeds)}/{alias_total}",
                "向量种子": f"{len(emb_seeds)}/{emb_total}",
            },
        },
        {
            "id": "textbook",
            "title": "教材子图写入",
            "subtitle": "保留边须有课堂原文依据",
            "blurb": (
                "左栏为处理原文：点边高亮其课堂依据。"
                "右栏：绿边=写入（含依据），灰边=边筛过滤；琥珀/青=种子，绿节点=扩展实体。"
            ),
            "nodes": _textbook_stage_nodes(
                textbook_nodes,
                alias_seeds,
                emb_seeds,
                seed_nodes,
                importance=importance,
                importance_base=importance_base,
            ),
            "edges": textbook_stage_edges,
            "focus": "graph",
            "text": extract,
            "stats": {
                "kept": len(tb_edges),
                "filtered": len(filtered_edges),
                "nodes": None,
            },
        },
        {
            "id": "correct",
            "title": "课堂修正教材",
            "subtitle": "保留 / 修订 / 删除",
            "blurb": (
                "严格对照处理原文：无原文依据则删除；"
                "左栏点边高亮依据，右栏绿=保留，琥珀粗=修订后，灰虚线=修订前/删除。"
            ),
            "nodes": _textbook_stage_nodes(
                correct_nodes,
                alias_seeds,
                emb_seeds,
                seed_nodes,
                importance=importance,
                importance_base=importance_base,
            ),
            "edges": correct_stage_edges,
            "focus": "graph",
            "text": extract,
            "stats": {
                "keep": corr_stats.get("keep", len(corr_edges)),
                "revise": corr_stats.get("revise", 0),
                "drop": corr_stats.get("drop", len(drop_edges)),
                "skipped": bool(corr_meta.get("skipped")),
            },
        },
        {
            "id": "delta",
            "title": "课堂增量",
            "subtitle": "教材未覆盖的概念关系",
            "blurb": "仅展示本段课堂增量边；粉色=教材中确无的新实体，绿色=教材已有实体（仅边新增）。",
            "nodes": nodes_from_names(
                {e["from"] for e in delta_edges} | {e["to"] for e in delta_edges},
                kind="delta",
                importance=importance,
                importance_base=importance_base,
            ),
            "edges": delta_edges,
            "focus": "graph",
            "text": extract,
            "stats": {
                "delta_edges": len(delta_edges),
                "new_entities": len(new_entities),
            },
            "new_entities": sorted(new_entities),
        },
        {
            "id": "merge",
            "title": "融合结果",
            "subtitle": "修正后教材 + 增量",
            "blurb": (
                "左栏课堂原文（悬停/点选划线看关系）；右栏完成本段知识子图。"
                "边色：绿=教材边（含课堂修订），蓝粗=课堂增量，灰虚线=过滤边；"
                "粉节点=教材中确无的新实体；增量边端点若已在教材母图则按教材节点着色。"
            ),
            # 节点必须覆盖修正后 SPO（revise 可能改实体名），不能只用原始 trips
            "nodes": nodes_from_names(
                (
                    {e.get("from") for e in corr_edges}
                    | {e.get("to") for e in corr_edges}
                    | {e.get("from") for e in delta_edges}
                    | {e.get("to") for e in delta_edges}
                    | {e.get("from") for e in fb_edges}
                    | {e.get("to") for e in fb_edges}
                )
                - {"", None},
                kind="final",
                importance=importance,
                importance_base=importance_base,
            ),
            "edges": corr_edges + delta_edges + fb_edges,
            "focus": "multimodal",
            "text": extract,
            "stats": {
                "textbook": len(corr_edges),
                "delta": len(delta_edges),
                "fallback": len(fb_edges),
                "total": len(corr_edges) + len(delta_edges) + len(fb_edges),
            },
        },
    ]
    for st in stages:
        if st["id"] in {"textbook", "correct"}:
            st["stats"]["nodes"] = len(st["nodes"])

    tb_names: set[str] = set()
    tb_keys: set[str] = set()
    if retriever is not None:
        tb_names, tb_keys = textbook_name_index_from_retriever(retriever)
    annotate_graph_node_kinds(
        stages,
        seed_nodes=seed_nodes,
        tb_edges=corr_edges or tb_edges,
        delta_edges=delta_edges,
        fb_edges=fb_edges,
        new_entities=new_entities,
        textbook_names=tb_names,
        textbook_keys=tb_keys,
    )

    # 段级 triplets 列表也不含跨段边（与 delta/merge 一致）
    segment_trips = [
        t
        for t in trips
        if not is_cross_cue_extract_source(str(t.get("extract_source") or ""))
    ]
    return {
        "cue_id": cue.get("cue_id"),
        "lecture_id": str(cue.get("lecture_id")),
        "start_sec": cue.get("start_sec"),
        "end_sec": cue.get("end_sec"),
        "asr_text": asr,
        "raw_asr_text": raw_asr,
        "extract_text": extract,
        "preprocess_status": s1.get("text_preprocess_status"),
        "media": {"clip": clip, "ppt": ppt},
        "stages": stages,
        # 仅讲次/课堂级图谱读取；段级流水线页不展示
        "cross_cue_edges": cross_edges,
        "triplets": [
            {
                "subject": zh(t.get("subject")),
                "object": zh(t.get("object")),
                "relation": t.get("abstract_relation"),
                "concrete": t.get("concrete_relation"),
                "source": t.get("extract_source"),
                "subject_ref": t.get("subject_entity_ref"),
                "object_ref": t.get("object_entity_ref"),
                "statement": t.get("natural_statement") or t.get("description"),
            }
            for t in segment_trips
        ],
    }


def collect_lecture_filtered_edges(
    cues: list[dict],
    trips: list[dict],
    *,
    lecture_id: str,
    retriever=None,
) -> list[dict]:
    """汇总一讲全部 cue 的教材过滤边（去重），灰色展示用。"""
    lec = str(lecture_id)
    by_cue: dict[str, list] = defaultdict(list)
    for t in trips:
        if str(t.get("lecture_id")) == lec:
            by_cue[str(t.get("cue_id"))].append(t)

    kept_spo: set[tuple[str, str, str]] = set()
    for t in trips:
        if str(t.get("lecture_id")) != lec:
            continue
        kept_spo.add(
            _spo_key(
                t.get("subject") or "",
                t.get("abstract_relation") or "",
                t.get("object") or "",
            )
        )

    seen: set[tuple[str, str, str]] = set()
    out: list[dict] = []
    for cue in cues:
        if str(cue.get("lecture_id")) != lec:
            continue
        cid = str(cue.get("cue_id"))
        tb = [
            t
            for t in by_cue.get(cid, [])
            if t.get("extract_source") == "textbook"
        ]
        tb_edges = [
            edge_from_trip(t, stage="textbook", idx=i) for i, t in enumerate(tb)
        ]
        for e in resolve_filtered_textbook_edges(cue, tb_edges, retriever):
            key = _spo_key(
                e.get("from") or "",
                e.get("relation") or e.get("label") or "",
                e.get("to") or "",
            )
            if not key[0] or not key[2] or key in seen or key in kept_spo:
                continue
            seen.add(key)
            edge = dict(e)
            edge["id"] = f"filtered-{lec}-{len(out)}"
            edge["lecture_id"] = lec
            out.append(edge)
    return out


def lecture_graph_from_trips(
    trips: list[dict],
    *,
    lecture_id: str,
    stage_id: str,
    importance: dict[str, float] | None = None,
    importance_base: dict[str, float] | None = None,
    filtered_edges: list[dict] | None = None,
    textbook_names: set[str] | None = None,
    textbook_keys: set[str] | None = None,
) -> tuple[list[dict], list[dict], dict[str, int]]:
    """讲次级去重图谱（按 SPO）；节点按教材/增量来源着色。

    增量边上的端点若匹配教材母图实体，计为教材节点（仅边新增），不算新增节点。
    """
    seen: set[tuple[str, str, str]] = set()
    edges: list[dict] = []
    new_entities: set[str] = set()
    for t in trips:
        key = _spo_key(
            t.get("subject") or "",
            t.get("abstract_relation") or "",
            t.get("object") or "",
        )
        if key in seen or not key[0] or not key[2]:
            continue
        seen.add(key)
        e = edge_from_trip(t, stage=stage_id, idx=len(edges))
        # edge_from_trip 已规范化 cross_cue；勿用原文 span 覆盖
        if e.get("source") != "cross_cue":
            e["source"] = t.get("extract_source") or "textbook"
        e["lecture_id"] = str(lecture_id)
        edges.append(e)
        if t.get("extract_source") == "lecture_delta":
            if t.get("subject_entity_ref") == "new":
                new_entities.add(t.get("subject") or "")
            if t.get("object_entity_ref") == "new":
                new_entities.add(t.get("object") or "")
    new_entities.discard("")

    filtered = []
    for e in filtered_edges or []:
        key = _spo_key(
            e.get("from") or "",
            e.get("relation") or e.get("label") or "",
            e.get("to") or "",
        )
        if key in seen or not key[0] or not key[2]:
            continue
        seen.add(key)
        edge = dict(e)
        edge["source"] = "filtered"
        edge["lecture_id"] = str(lecture_id)
        if not edge.get("id"):
            edge["id"] = f"filtered-{lecture_id}-{len(filtered)}"
        filtered.append(edge)
    edges.extend(filtered)

    tb_nodes: set[str] = set()
    delta_nodes: set[str] = set()
    filtered_nodes: set[str] = set()
    for e in edges:
        endpoints = {e.get("from") or "", e.get("to") or ""}
        endpoints.discard("")
        src = str(e.get("source") or "")
        if src == "lecture_delta":
            delta_nodes |= endpoints
        elif src == "filtered":
            filtered_nodes |= endpoints
        else:
            tb_nodes |= endpoints

    all_names = tb_nodes | delta_nodes | filtered_nodes
    nodes: list[dict] = []
    for name in sorted(all_names):
        in_tb_edge = name in tb_nodes
        in_delta = name in delta_nodes
        in_tb_kg = entity_in_textbook(name, textbook_names, textbook_keys)
        known_tb = in_tb_edge or in_tb_kg
        is_new = name in new_entities and not in_tb_kg
        in_filtered_only = name in filtered_nodes and not known_tb and not in_delta

        if is_new:
            kind = "new"
            origin_zh = "课堂新实体"
        elif known_tb and in_delta:
            # 教材已有实体，本讲又挂了增量边 → 混合（非「新增节点」）
            kind = "mixed"
            origin_zh = (
                "教材实体+增量边" if not in_tb_edge else "教材边+增量边"
            )
        elif in_delta:
            kind = "delta"
            origin_zh = "课堂增量引入"
        elif known_tb:
            kind = "textbook"
            origin_zh = "教材子图"
        elif in_filtered_only:
            kind = "seed_filtered"
            origin_zh = "仅过滤边"
        else:
            kind = "entity"
            origin_zh = "其他"

        built = nodes_from_names(
            {name},
            kind=kind,
            importance=importance,
            importance_base=importance_base,
        )
        if not built:
            continue
        node = built[0]
        tip = str(node.get("title") or name)
        if origin_zh not in tip:
            node["title"] = f"{tip}\n来源: {origin_zh}"
        nodes.append(node)

    n_tb = sum(1 for n in nodes if n.get("kind") == "textbook")
    n_delta = sum(1 for n in nodes if n.get("kind") == "delta")
    n_mixed = sum(1 for n in nodes if n.get("kind") == "mixed")
    n_new = sum(1 for n in nodes if n.get("kind") == "new")
    n_filtered = sum(
        1 for n in nodes if str(n.get("kind") or "").startswith("seed_filtered")
    )

    src_counts: dict[str, int] = defaultdict(int)
    for e in edges:
        src_counts[str(e.get("source") or "?")] += 1
    stats = {
        "edges": len(edges),
        "nodes": len(nodes),
        "textbook": src_counts.get("textbook", 0),
        "delta": src_counts.get("lecture_delta", 0),
        "filtered": src_counts.get("filtered", 0),
        "nodes_textbook": n_tb,
        "nodes_delta": n_delta,
        "nodes_mixed": n_mixed,
        "nodes_new": n_new,
        "nodes_filtered_only": n_filtered,
    }
    return nodes, edges, stats


def fuse_lecture_graphs(
    trips_a: list[dict],
    trips_b: list[dict],
    *,
    lec_a: str,
    lec_b: str,
    importance: dict[str, float] | None = None,
    importance_base: dict[str, float] | None = None,
    textbook_names: set[str] | None = None,
    textbook_keys: set[str] | None = None,
) -> tuple[list[dict], list[dict], dict[str, int]]:
    """两讲 SPO 融合：边按讲次；节点按教材独有 / 上课独有 / 两者共有。"""

    def index(trips: list[dict]) -> dict[tuple[str, str, str], dict]:
        out: dict[tuple[str, str, str], dict] = {}
        for t in trips:
            key = _spo_key(
                t.get("subject") or "",
                t.get("abstract_relation") or "",
                t.get("object") or "",
            )
            if key[0] and key[2] and key not in out:
                out[key] = t
        return out

    def entity_set(trips: list[dict]) -> set[str]:
        names: set[str] = set()
        for t in trips:
            s = (t.get("subject") or "").strip()
            o = (t.get("object") or "").strip()
            if s:
                names.add(s)
            if o:
                names.add(o)
        return names

    ia, ib = index(trips_a), index(trips_b)
    ents_a, ents_b = entity_set(trips_a), entity_set(trips_b)
    all_keys = set(ia) | set(ib)
    edges: list[dict] = []
    for i, key in enumerate(sorted(all_keys)):
        in_a = key in ia
        in_b = key in ib
        t = ia.get(key) or ib[key]
        if in_a and in_b:
            origin = "both"
        elif in_a:
            origin = f"lecture_{lec_a}"
        else:
            origin = f"lecture_{lec_b}"
        e = edge_from_trip(t, stage="session_merge", idx=i)
        e["source"] = origin
        e["lecture_id"] = (
            f"{lec_a}+{lec_b}" if origin == "both" else (lec_a if in_a else lec_b)
        )
        edges.append(e)

    tb_ents: set[str] = set()
    class_ents: set[str] = set()
    for t in trips_a + trips_b:
        endpoints = {
            (t.get("subject") or "").strip(),
            (t.get("object") or "").strip(),
        }
        endpoints.discard("")
        src = t.get("extract_source") or ""
        if src == "textbook":
            tb_ents |= endpoints
        elif src in {"lecture_delta", "llm_fallback"}:
            class_ents |= endpoints

    kind_a = f"lecture_{lec_a}"
    kind_b = f"lecture_{lec_b}"
    nodes: list[dict] = []
    n_tb_only = n_class_only = n_shared = 0
    for name in sorted(ents_a | ents_b):
        on_tb_edge = name in tb_ents
        on_class = name in class_ents
        in_tb_kg = entity_in_textbook(name, textbook_names, textbook_keys)
        known_tb = on_tb_edge or in_tb_kg

        if known_tb and on_class:
            kind = "shared"
            origin_zh = "教材+上课共有"
            n_shared += 1
        elif known_tb:
            kind = "tb_only"
            origin_zh = "教材独有"
            n_tb_only += 1
        elif on_class:
            kind = "class_only"
            origin_zh = "上课独有"
            n_class_only += 1
        else:
            kind = "entity"
            origin_zh = "其他"

        built = nodes_from_names(
            {name},
            kind=kind,
            importance=importance,
            importance_base=importance_base,
        )
        if not built:
            continue
        node = built[0]
        node["origin"] = kind
        tip = str(node.get("title") or name)
        if origin_zh not in tip:
            node["title"] = f"{tip}\n来源: {origin_zh}"
        nodes.append(node)

    stats = {
        "edges": len(edges),
        "nodes": len(nodes),
        f"only_{lec_a}": sum(1 for e in edges if e["source"] == kind_a),
        f"only_{lec_b}": sum(1 for e in edges if e["source"] == kind_b),
        "both": sum(1 for e in edges if e["source"] == "both"),
        "nodes_tb_only": n_tb_only,
        "nodes_class_only": n_class_only,
        "nodes_shared": n_shared,
        "from_a": len(ia),
        "from_b": len(ib),
    }
    return nodes, edges, stats


def load_or_compute_importance(
    course: str,
    triplets: list[dict],
    *,
    write: bool = True,
    lecture_id: str | None = None,
) -> dict[str, dict[str, float]]:
    """计算课堂反馈重要性（P2 分章先验 + P3 时长融合）。"""
    from teachkg.config import TeachKGConfig
    from teachkg.textbook_kg.chapter_map import resolve_lecture_chapters
    from teachkg.textbook_kg.importance_feedback import (
        build_lecture_df,
        cap_secondary_chapter_weights,
        compute_importance_feedback,
        configure_entity_weights,
        load_importance_prior,
        load_textbook_importance,
        save_feedback,
    )

    cfg = TeachKGConfig.from_yaml(ROOT / "configs/teaching.yaml")
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    fb_cfg = tb.get("importance_feedback", {}) or {}
    if not fb_cfg.get("enabled", True):
        return {"scores": {}, "base_norm": {}, "classroom_norm": {}}
    configure_entity_weights(fb_cfg)

    base_path = ROOT / tb.get("path", "data/textbook")
    chapter_order: list[str] = []
    bundle_path = base_path / tb.get("importance_bundle_file", "importance_bundle.json")
    if bundle_path.is_file():
        import json as _json

        chapter_order = list(
            _json.loads(bundle_path.read_text(encoding="utf-8")).get("chapter_order") or []
        )

    chapter_weights: list[tuple[str, float]] = []
    chapter = fb_cfg.get("chapter")
    if lecture_id:
        cues_path = ROOT / "data/processed" / course / "filtered_cues.jsonl"
        cues = []
        if cues_path.is_file():
            cues = [
                r
                for r in (
                    json.loads(l)
                    for l in cues_path.read_text(encoding="utf-8").splitlines()
                    if l.strip()
                )
                if str(r.get("lecture_id")) == str(lecture_id)
            ]
        chapter_weights = resolve_lecture_chapters(
            lecture_id,
            chapter_order=chapter_order,
            lecture_chapter_map=tb.get("lecture_chapter_map") or {},
            cues=cues,
            triplets=triplets,
            top_k=int(fb_cfg.get("multi_chapter_top_k", 2)),
            min_ratio=float(fb_cfg.get("multi_chapter_min_ratio", 0.35)),
        )
        chapter_weights = cap_secondary_chapter_weights(
            chapter_weights,
            secondary_cap=float(fb_cfg.get("secondary_chapter_cap", 0.25)),
        )
        chapter = chapter_weights[0][0] if chapter_weights else chapter

    prior, meta = load_importance_prior(
        base_path,
        importance_file=tb.get("importance_file", "entity_sorted_ppr.json"),
        bundle_file=tb.get("importance_bundle_file", "importance_bundle.json"),
        chapters=chapter_weights or ([(chapter, 1.0)] if chapter else None),
        chapter_mix=float(fb_cfg.get("chapter_mix", 0.7)),
        chapter_boost=float(fb_cfg.get("chapter_boost", 1.35)),
    )
    meta["lecture_id"] = lecture_id
    meta["resolved_chapter"] = chapter
    lecture_df, n_lectures = build_lecture_df(triplets)
    primary_top: set[str] = set()
    if chapter and bundle_path.is_file():
        table = load_textbook_importance(bundle_path, chapter=chapter)
        primary_top = {n for n, _ in sorted(table.items(), key=lambda x: -x[1])[:80]}
    result = compute_importance_feedback(
        textbook_importance=prior,
        triplets=triplets,
        alpha=float(fb_cfg.get("alpha", 0.45)),
        use_log_duration=bool(fb_cfg.get("use_log_duration", True)),
        classroom_hub_penalty=float(fb_cfg.get("classroom_hub_penalty", 0.15)),
        chapters=[c for c, _ in chapter_weights] if chapter_weights else ([chapter] if chapter else None),
        primary_chapter_top=primary_top,
        chapter_order=chapter_order,
        off_chapter_penalty=float(fb_cfg.get("off_chapter_penalty", 0.45)),
        adaptive_alpha_enabled=bool(fb_cfg.get("adaptive_alpha", True)),
        adaptive_alpha_min=float(fb_cfg.get("adaptive_alpha_min", 0.28)),
        adaptive_alpha_scope_classroom=bool(
            fb_cfg.get("adaptive_alpha_scope_classroom", True)
        ),
        lecture_df=lecture_df,
        n_lectures=n_lectures,
        idf_power=float(fb_cfg.get("lecture_idf_power", 1.0)),
        meta=meta,
    )
    if write:
        out = (
            ROOT
            / "data/kg"
            / course
            / fb_cfg.get("output_filename", "entity_importance_feedback.json")
        )
        save_feedback(out, result)
        print(
            f"wrote importance feedback → {out} "
            f"(n={len(result.scores)} chapter={chapter})"
        )
    return {
        "scores": result.scores,
        "base_norm": result.base_norm,
        "classroom_norm": result.classroom_norm,
    }


def lecture_extract_sections(cues: list[dict], lecture_id: str) -> tuple[str, list[dict]]:
    """按讲次收集预处理文本，返回 (拼接正文, text_sections)。"""
    lec = str(lecture_id)
    parts: list[str] = []
    for cue in cues:
        if str(cue.get("lecture_id") or "") != lec:
            continue
        extract = _resolve_extract_text(cue).strip()
        if extract:
            parts.append(extract)
    body = "\n\n".join(parts)
    sections = [
        {
            "heading": f"第 {lec} 讲",
            "lectureId": lec,
            "text": body,
        }
    ]
    return body, sections


def build_session_payload(
    course: str,
    lec_a: str,
    lec_b: str,
    trips_a: list[dict],
    trips_b: list[dict],
) -> dict:
    """一堂课（两讲，约 110 分钟）图谱融合展示。"""
    imp = load_or_compute_importance(
        course, trips_a + trips_b, write=True, lecture_id=lec_a
    )
    scores, base = imp["scores"], imp["base_norm"]

    cues_path = ROOT / "data/processed" / course / "filtered_cues.jsonl"
    all_cues = load_jsonl(cues_path) if cues_path.is_file() else []
    text_a, sections_a = lecture_extract_sections(all_cues, lec_a)
    text_b, sections_b = lecture_extract_sections(all_cues, lec_b)
    session_sections = sections_a + sections_b
    session_text = "\n\n".join(
        f"{s['heading']}\n\n{s['text']}".strip()
        for s in session_sections
        if (s.get("text") or "").strip()
    )
    print("building textbook retriever for lecture filtered-edge preview…")
    retriever = build_seed_retriever(course)
    filtered_a = collect_lecture_filtered_edges(
        all_cues, trips_a, lecture_id=lec_a, retriever=retriever
    )
    filtered_b = collect_lecture_filtered_edges(
        all_cues, trips_b, lecture_id=lec_b, retriever=retriever
    )
    print(
        f"filtered edges: lec{lec_a}={len(filtered_a)} lec{lec_b}={len(filtered_b)}"
    )
    tb_names, tb_keys = textbook_name_index_from_retriever(retriever)
    print(f"textbook entity index: {len(tb_names)} names / {len(tb_keys)} match keys")

    nodes_a, edges_a, stats_a = lecture_graph_from_trips(
        trips_a,
        lecture_id=lec_a,
        stage_id=f"lec_{lec_a}",
        importance=scores,
        importance_base=base,
        filtered_edges=filtered_a,
        textbook_names=tb_names,
        textbook_keys=tb_keys,
    )
    nodes_b, edges_b, stats_b = lecture_graph_from_trips(
        trips_b,
        lecture_id=lec_b,
        stage_id=f"lec_{lec_b}",
        importance=scores,
        importance_base=base,
        filtered_edges=filtered_b,
        textbook_names=tb_names,
        textbook_keys=tb_keys,
    )
    nodes_f, edges_f, stats_f = fuse_lecture_graphs(
        trips_a,
        trips_b,
        lec_a=lec_a,
        lec_b=lec_b,
        importance=scores,
        importance_base=base,
        textbook_names=tb_names,
        textbook_keys=tb_keys,
    )

    stages = [
        {
            "id": f"lecture_{lec_a}",
            "title": f"第 {lec_a} 讲图谱",
            "subtitle": "本堂课前半段",
            "blurb": (
                f"第 {lec_a} 讲全部 cue。"
                "边：绿=教材，蓝粗=增量，灰虚线=过滤；"
                "节点：绿=教材实体，青=教材实体+增量边，蓝=课堂新节点（教材中无），粉=entity_ref=new。"
            ),
            "nodes": nodes_a,
            "edges": edges_a,
            "focus": "graph",
            "text": text_a,
            "text_sections": sections_a,
            "stats": stats_a,
        },
        {
            "id": f"lecture_{lec_b}",
            "title": f"第 {lec_b} 讲图谱",
            "subtitle": "本堂课后半段",
            "blurb": (
                f"第 {lec_b} 讲全部 cue。"
                "边：绿=教材，蓝粗=增量，灰虚线=过滤；"
                "节点：绿=教材实体，青=教材实体+增量边，蓝=课堂新节点（教材中无），粉=entity_ref=new。"
            ),
            "nodes": nodes_b,
            "edges": edges_b,
            "focus": "graph",
            "text": text_b,
            "text_sections": sections_b,
            "stats": stats_b,
        },
        {
            "id": "session_merge",
            "title": "两讲融合",
            "subtitle": "一堂课完整知识图谱",
            "blurb": (
                f"将第 {lec_a}/{lec_b} 讲按 subject–关系–object 对齐融合。"
                "节点实心色：绿=教材独有，蓝=上课独有，金=两者共有；"
                f"边色仍按讲次：绿=两讲共有，蓝=仅第{lec_a}讲，粉=仅第{lec_b}讲。"
                "左栏文本用大标题区分两讲。"
            ),
            "nodes": nodes_f,
            "edges": edges_f,
            "focus": "graph",
            "text": session_text,
            "text_sections": session_sections,
            "stats": stats_f,
        },
    ]

    return {
        "brand": "VAT-KG",
        "product": "TeachKG Pipeline",
        "mode": "session",
        "course_id": course,
        "lecture_id": f"{lec_a}+{lec_b}",
        "lecture_ids": [lec_a, lec_b],
        "title": f"第 {lec_a}–{lec_b} 讲 · 一堂课图谱融合",
        "subtitle": "两段讲次分别构图，再按概念关系对齐；节点大小由教材先验+课堂反馈决定",
        "cue_count": 1,
        "importance_feedback": True,
        "items": [
            {
                "cue_id": f"session_{lec_a}_{lec_b}",
                "lecture_id": f"{lec_a}+{lec_b}",
                "start_sec": 0,
                "end_sec": 0,
                "asr_text": session_text,
                "extract_text": session_text,
                "preprocess_status": "",
                "media": {"clip": "", "ppt": ""},
                "stages": stages,
                "triplets": [],
            }
        ],
    }


def write_showcase_html(payload: dict, html_dir: Path, stem: str) -> tuple[Path, Path]:
    data_path = html_dir / f"{stem}.json"
    data_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    template = (ROOT / "web" / "pipeline-showcase" / "index.template.html").read_text(
        encoding="utf-8"
    )
    html = template.replace(
        "/*__PIPELINE_PAYLOAD__*/",
        f"window.PIPELINE_DATA = {json.dumps(payload, ensure_ascii=False)};",
    )
    out_html = html_dir / f"{stem}.html"
    out_html.write_text(html, encoding="utf-8")

    # 与 HTML 同目录放置 vis-network，保证 file:// 离线可开
    vendor_src = ROOT / "web" / "pipeline-showcase" / "vendor" / "vis-network.min.js"
    vendor_dst = html_dir / "vis-network.min.js"
    if vendor_src.is_file() and (
        not vendor_dst.is_file() or vendor_dst.stat().st_size != vendor_src.stat().st_size
    ):
        import shutil

        shutil.copy2(vendor_src, vendor_dst)
    return data_path, out_html


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--course-id", default="shuliluoji")
    parser.add_argument("--lecture-id", default="1")
    parser.add_argument(
        "--session-lectures",
        nargs=2,
        metavar=("LEC_A", "LEC_B"),
        help="导出一堂课两讲融合展示（例如 1 2），约 110 分钟整堂图谱",
    )
    parser.add_argument(
        "--no-refresh-seeds",
        action="store_true",
        help="不补算别名/向量种子拆分（旧产物可能无法区分）",
    )
    parser.add_argument(
        "--until-stage",
        choices=["asr", "preprocess", "seeds", "textbook", "correct", "delta", "merge"],
        default=None,
        help="只导出到指定步骤（如 seeds），后续教材/增量等跳过",
    )
    args = parser.parse_args()

    course = args.course_id
    html_dir = ROOT / "data" / "viz" / course
    html_dir.mkdir(parents=True, exist_ok=True)

    until = args.until_stage
    stage_order = ["asr", "preprocess", "seeds", "textbook", "correct", "delta", "merge"]

    def clip_stages(item: dict) -> dict:
        if not until:
            return item
        cut = stage_order.index(until)
        allowed = set(stage_order[: cut + 1])
        item = dict(item)
        item["stages"] = [s for s in item.get("stages") or [] if s.get("id") in allowed]
        return item

    if args.session_lectures:
        lec_a, lec_b = str(args.session_lectures[0]), str(args.session_lectures[1])
        trips_all = load_jsonl(ROOT / "data/kg" / course / "triplets.jsonl")
        trips_a = [r for r in trips_all if str(r.get("lecture_id")) == lec_a]
        trips_b = [r for r in trips_all if str(r.get("lecture_id")) == lec_b]
        if not trips_a or not trips_b:
            raise SystemExit(
                f"missing triplets for session lectures: "
                f"{lec_a}={len(trips_a)}, {lec_b}={len(trips_b)}"
            )
        payload = build_session_payload(course, lec_a, lec_b, trips_a, trips_b)
        stem = f"pipeline_build_session_{lec_a}_{lec_b}"
        data_path, out_html = write_showcase_html(payload, html_dir, stem)
        print("wrote", data_path)
        print("wrote", out_html)
        print(
            f"session={lec_a}+{lec_b} "
            f"trips={len(trips_a)}+{len(trips_b)} "
            f"fused_edges={payload['items'][0]['stages'][2]['stats']['edges']}"
        )
        return

    lec = str(args.lecture_id)
    cues_path = ROOT / "data/processed" / course / "filtered_cues.jsonl"
    all_cues = load_jsonl(cues_path)
    cues = [r for r in all_cues if str(r.get("lecture_id")) == lec]
    cues.sort(key=lambda r: float(r.get("start_sec") or 0))

    if not args.no_refresh_seeds and until not in {"asr", "preprocess", "seeds"}:
        n = refresh_seed_splits(cues, course)
        if n:
            by_id = {str(c.get("cue_id")): c for c in cues}
            merged = [
                by_id[str(row.get("cue_id"))]
                if str(row.get("cue_id")) in by_id
                else row
                for row in all_cues
            ]
            save_jsonl(cues_path, merged)
            save_json(pretty_json_path(cues_path), merged)
            print(f"updated seed splits in {cues_path} ({n} cues)")
    elif not args.no_refresh_seeds and until in {"asr", "preprocess", "seeds"}:
        print("skip refresh_seed_splits (until-stage uses cue 中已写回的种子)")

    need_retriever = until is None or until in {"textbook", "correct", "delta", "merge"}
    retriever = None
    if need_retriever:
        print("building textbook retriever for filtered-edge preview…")
        retriever = build_seed_retriever(course)

    trips_all = [
        r
        for r in load_jsonl(ROOT / "data/kg" / course / "triplets.jsonl")
        if str(r.get("lecture_id")) == lec
    ]
    imp = load_or_compute_importance(course, trips_all, write=False, lecture_id=lec)
    importance = imp["scores"]
    importance_base = imp["base_norm"]
    by_cue: dict[str, list] = defaultdict(list)
    for t in trips_all:
        by_cue[str(t.get("cue_id"))].append(t)

    items = []
    only_seeds = until in {"asr", "preprocess", "seeds"}
    for cue in cues:
        cid = str(cue.get("cue_id"))
        trips = by_cue.get(cid, [])
        s1 = cue.get("stage1") or {}
        extract = _resolve_extract_text(cue)
        status = s1.get("text_preprocess_status") or ""
        asr = (cue.get("asr_text") or "").strip()
        if status == "empty_after_preprocess" and not trips and not only_seeds:
            continue
        if not extract and not asr and not trips:
            continue
        if only_seeds and not extract and not asr:
            continue
        item = build_cue_payload(
            cue,
            [] if only_seeds else trips,
            html_dir,
            retriever=None if only_seeds else retriever,
            importance=importance,
            importance_base=importance_base,
            course_id=course,
        )
        items.append(clip_stages(item))

    # 片段列表末尾：跨段窗口（仅拼接文本 + 跨段图谱）
    cross_items: list[dict] = []
    if not only_seeds and until not in {
        "asr",
        "preprocess",
        "seeds",
        "textbook",
        "correct",
        "delta",
    }:
        ordered_cues = sorted(
            [c for c in cues if _resolve_extract_text(c)],
            key=lambda c: (float(c.get("start_sec") or 0), str(c.get("cue_id") or "")),
        )
        cross_items = build_cross_cue_window_items(
            ordered_cues,
            trips_all,
            lecture_id=lec,
            importance=importance,
            importance_base=importance_base,
        )

    subtitle = "从课堂口述到教材对齐子图；节点大小=教材先验+课堂反馈"
    if until == "seeds":
        subtitle = "文本到种子筛选（别名+向量统一严筛；向量上限随文本长度动态变化）"

    payload = {
        "brand": "VAT-KG",
        "product": "TeachKG Pipeline",
        "mode": "lecture",
        "course_id": course,
        "lecture_id": lec,
        "title": f"第 {lec} 讲 · 知识图谱构建过程"
        + (f"（至{until}）" if until else ""),
        "subtitle": subtitle,
        "cue_count": len(items),
        "cross_cue_window_count": len(cross_items),
        "importance_feedback": True,
        "until_stage": until,
        "items": items + cross_items,
    }
    stem = f"pipeline_build_lecture_{lec}"
    if until:
        stem = f"{stem}_until_{until}"
    data_path, out_html = write_showcase_html(payload, html_dir, stem)
    print("wrote", data_path)
    print("wrote", out_html)
    print(
        f"cues={len(items)} cross_windows={len(cross_items)} "
        f"triplets={len(trips_all)} until={until or 'all'}"
    )


if __name__ == "__main__":
    main()
