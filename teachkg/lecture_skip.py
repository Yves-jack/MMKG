"""无授课内容讲次（考试/行政/空抽）的统一跳过标记。

典型场景：整讲 ASR 只有签到/考试闲聊，Stage1 抽不到三元组。
批处理应记为 *skipped*（完成态），而不是 *failed* 反复重跑。

标记路径：``data/processed/{course}/skip_lectures/lecture_{id}.json``
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class LectureSkipInfo:
    course_id: str
    lecture_id: str
    reason: str
    detail: str = ""
    source: str = "auto"  # auto | config | manual
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        if not d.get("created_at"):
            d["created_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return d


def skip_dir(course_id: str, *, root: Path = ROOT) -> Path:
    return root / "data" / "processed" / course_id / "skip_lectures"


def skip_marker_path(course_id: str, lecture_id: str, *, root: Path = ROOT) -> Path:
    return skip_dir(course_id, root=root) / f"lecture_{lecture_id}.json"


def is_skipped(course_id: str, lecture_id: str, *, root: Path = ROOT) -> bool:
    return skip_marker_path(course_id, lecture_id, root=root).is_file()


def list_skipped(course_id: str, *, root: Path = ROOT) -> set[str]:
    d = skip_dir(course_id, root=root)
    if not d.is_dir():
        return set()
    out: set[str] = set()
    for p in d.glob("lecture_*.json"):
        lid = p.stem.replace("lecture_", "", 1)
        if lid:
            out.add(lid)
    return out


def write_skip_marker(
    course_id: str,
    lecture_id: str,
    *,
    reason: str,
    detail: str = "",
    source: str = "auto",
    root: Path = ROOT,
    extra: dict[str, Any] | None = None,
) -> Path:
    path = skip_marker_path(course_id, lecture_id, root=root)
    path.parent.mkdir(parents=True, exist_ok=True)
    info = LectureSkipInfo(
        course_id=course_id,
        lecture_id=str(lecture_id),
        reason=reason,
        detail=detail,
        source=source,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    payload = info.to_dict()
    if extra:
        payload.update(extra)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def load_skip_marker(
    course_id: str, lecture_id: str, *, root: Path = ROOT
) -> dict[str, Any] | None:
    path = skip_marker_path(course_id, lecture_id, root=root)
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def count_triplets(
    course_id: str, lecture_id: str, *, root: Path = ROOT
) -> int:
    path = root / "data" / "kg" / course_id / "triplets.jsonl"
    if not path.is_file():
        return 0
    lid = str(lecture_id)
    n = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if str(row.get("lecture_id", "")).strip() == lid:
            n += 1
    return n


def stage1_triplet_sum(
    course_id: str, lecture_id: str, *, root: Path = ROOT
) -> tuple[int, int]:
    """从 filtered_cues 汇总该讲 stage1.triplet_count。

    Returns:
        (cue_count, triplet_sum)
    """
    path = root / "data" / "processed" / course_id / "filtered_cues.jsonl"
    if not path.is_file():
        return 0, 0
    lid = str(lecture_id)
    cues = 0
    trips = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if str(row.get("lecture_id", "")).strip() != lid:
            continue
        cues += 1
        s1 = row.get("stage1") or {}
        try:
            trips += int(s1.get("triplet_count") or 0)
        except (TypeError, ValueError):
            pass
    return cues, trips


def detect_empty_knowledge(
    course_id: str,
    lecture_id: str,
    *,
    root: Path = ROOT,
) -> LectureSkipInfo | None:
    """Stage1 之后：若该讲无三元组则判定为可跳过。

    优先看 ``triplets.jsonl``；若文件尚无该讲行，再看 filtered_cues 的
    ``stage1.triplet_count`` 合计。
    """
    n_trips = count_triplets(course_id, lecture_id, root=root)
    if n_trips > 0:
        return None
    n_cues, trip_sum = stage1_triplet_sum(course_id, lecture_id, root=root)
    # 尚无 Stage1 产物时不要误判（应继续跑 Stage1）
    if n_cues == 0 and n_trips == 0:
        # 也可能 Stage1 全 reject / 已从 filtered 清掉 —— 再查 rejected
        rj = root / "data" / "processed" / course_id / "rejected_cues.jsonl"
        has_any = False
        if rj.is_file():
            lid = str(lecture_id)
            for line in rj.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                if str(row.get("lecture_id", "")).strip() == lid:
                    has_any = True
                    break
        if not has_any:
            return None
        return LectureSkipInfo(
            course_id=course_id,
            lecture_id=str(lecture_id),
            reason="no_knowledge_content",
            detail="Stage1 无通过 cue，且 triplets.jsonl 无该讲记录",
            source="auto",
        )
    if trip_sum > 0:
        # filtered 有计数但尚未写入 triplets —— 不跳过
        return None
    return LectureSkipInfo(
        course_id=course_id,
        lecture_id=str(lecture_id),
        reason="no_knowledge_content",
        detail=f"Stage1 cues={n_cues} triplet_sum=0；triplets.jsonl 无该讲边",
        source="auto",
    )


def config_skip_lectures(cfg: dict[str, Any] | None) -> set[str]:
    """从配置 ``batch.skip_lectures`` 读取显式跳过列表。"""
    if not cfg:
        return set()
    batch = cfg.get("batch") or {}
    raw = batch.get("skip_lectures") or []
    if isinstance(raw, (str, int)):
        raw = [raw]
    return {str(x).strip() for x in raw if str(x).strip()}


def auto_skip_empty_enabled(cfg: dict[str, Any] | None) -> bool:
    if not cfg:
        return True
    batch = cfg.get("batch") or {}
    return bool(batch.get("auto_skip_empty", True))


def ensure_config_skips(
    course_id: str,
    lecture_ids: Iterable[str],
    *,
    root: Path = ROOT,
) -> list[Path]:
    """为配置中声明的讲次写入 skip 标记（若尚无）。"""
    written: list[Path] = []
    for lid in lecture_ids:
        if is_skipped(course_id, lid, root=root):
            continue
        written.append(
            write_skip_marker(
                course_id,
                lid,
                reason="config_skip_lectures",
                detail="配置 batch.skip_lectures 显式跳过",
                source="config",
                root=root,
            )
        )
    return written
