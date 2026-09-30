"""离散数学批处理共用的完成判据（Stage1/2/3）。

供 ``run_lisan_full_batch.py`` / ``run_stage1_lisan_batch.py`` 判断
哪些讲次可跳过、哪些仍在 todo。
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COURSE_ID = "离散数学(图论+数理逻辑与集合论)"


def all_lectures(course_id: str = COURSE_ID) -> list[str]:
    """从 ``cues.jsonl`` 列出全部数字讲次 ID（排序）。

    Args:
        course_id: 课程 ID。

    Returns:
        如 ``["1","2",...,"44"]``；无文件返回空列表。
    """
    cues = ROOT / "data" / "segments" / course_id / "cues.jsonl"
    lecs: set[str] = set()
    if not cues.is_file():
        return []
    for line in cues.read_text(encoding="utf-8").splitlines():
        if line.strip():
            lecs.add(str(json.loads(line).get("lecture_id", "")).strip())
    return sorted((x for x in lecs if x.isdigit()), key=int)


def cue_counts(course_id: str = COURSE_ID) -> dict[str, int]:
    """统计 Stage0 ``cues.jsonl`` 中每讲的 cue 条数。

    Args:
        course_id: 课程 ID。

    Returns:
        ``{lecture_id: count}``。
    """
    path = ROOT / "data" / "segments" / course_id / "cues.jsonl"
    counts: dict[str, int] = {}
    if not path.is_file():
        return counts
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        lid = str(json.loads(line).get("lecture_id", "")).strip()
        if lid:
            counts[lid] = counts.get(lid, 0) + 1
    return counts


def filtered_counts(course_id: str = COURSE_ID) -> dict[str, int]:
    """统计 Stage1 ``filtered_cues.jsonl`` 中每讲的 cue 条数。

    Args:
        course_id: 课程 ID。

    Returns:
        ``{lecture_id: count}``。
    """
    path = ROOT / "data" / "processed" / course_id / "filtered_cues.jsonl"
    counts: dict[str, int] = {}
    if not path.is_file():
        return counts
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        lid = str(json.loads(line).get("lecture_id", "")).strip()
        if lid:
            counts[lid] = counts.get(lid, 0) + 1
    return counts


def triplet_sources_by_lecture(course_id: str = COURSE_ID) -> dict[str, set[str]]:
    """汇总每讲在 ``triplets.jsonl`` 中出现过的 ``extract_source``。

    Args:
        course_id: 课程 ID。

    Returns:
        ``{lecture_id: {"textbook", "lecture_delta", ...}}``。
    """
    path = ROOT / "data" / "kg" / course_id / "triplets.jsonl"
    out: dict[str, set[str]] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        lid = str(row.get("lecture_id", "")).strip()
        if not lid:
            continue
        out.setdefault(lid, set()).add(str(row.get("extract_source", "") or ""))
    return out


def stage1_done(course_id: str = COURSE_ID, *, min_coverage: float = 0.8) -> set[str]:
    """判断哪些讲次可视为 Stage1 完成。

    条件（同时满足）：
    1. ``triplets`` 中有 ``extract_source=textbook``；
    2. ``filtered_cues`` 条数 ≥ ``min_coverage * cues``；
    3. 有课堂侧边（delta/completion/cross_cue/llm_only），
       或 filtered 已全覆盖 cues（短讲可只有教材边）。

    Args:
        course_id: 课程 ID。
        min_coverage: filtered 相对 Stage0 cues 的最低覆盖率。

    Returns:
        已完成讲次 ID 集合。
    """
    cues = cue_counts(course_id)
    filtered = filtered_counts(course_id)
    sources = triplet_sources_by_lecture(course_id)
    done: set[str] = set()
    for lid, n_cues in cues.items():
        if "textbook" not in sources.get(lid, set()):
            continue
        n_filt = filtered.get(lid, 0)
        if n_cues <= 0 or n_filt < max(1, int(n_cues * min_coverage)):
            continue
        classroom = sources.get(lid, set()) & {
            "lecture_delta",
            "kg_completion",
            "cross_cue",
            "llm_only",
        }
        if classroom or n_filt >= n_cues:
            done.add(lid)
    return done


def kg_done(course_id: str = COURSE_ID) -> set[str]:
    """已有 ``lecture_{id}/kg.json`` 的讲次集合。

    Args:
        course_id: 课程 ID。

    Returns:
        讲次 ID 集合。
    """
    kg = ROOT / "data" / "kg" / course_id
    if not kg.is_dir():
        return set()
    return {
        d.name.replace("lecture_", "", 1)
        for d in kg.glob("lecture_*")
        if (d / "kg.json").is_file()
    }


def mmkg_done(course_id: str = COURSE_ID) -> set[str]:
    """已有 ``lecture_{id}/mmkg.json`` 的讲次集合（全流程完成判据）。

    Args:
        course_id: 课程 ID。

    Returns:
        讲次 ID 集合。
    """
    kg = ROOT / "data" / "kg" / course_id
    if not kg.is_dir():
        return set()
    return {
        d.name.replace("lecture_", "", 1)
        for d in kg.glob("lecture_*")
        if (d / "mmkg.json").is_file()
    }


def skipped_lectures(course_id: str = COURSE_ID) -> set[str]:
    """已标记为无授课内容、无需 Stage2/3 的讲次集合。"""
    from teachkg.lecture_skip import list_skipped

    return list_skipped(course_id, root=ROOT)


def pipeline_settled(course_id: str = COURSE_ID) -> set[str]:
    """全流程已结案：有 mmkg，或已 skip（考试/空抽等）。"""
    return mmkg_done(course_id) | skipped_lectures(course_id)
