from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class BoundaryType(str, Enum):
    PPT = "ppt"
    ASR_ALIGNED = "asr_aligned"  # 历史句级对齐单元（已弃用，保留兼容旧数据）
    ASR_FIXED = "asr_fixed"
    SCENE = "scene"
    SEMANTIC = "semantic"
    MERGED = "merged"
    FIXED = "fixed"


@dataclass
class SubtitleCue:
    start_sec: float
    end_sec: float
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "start_sec": self.start_sec,
            "end_sec": self.end_sec,
            "text": self.text,
        }


@dataclass
class VideoSegment:
    """Stage 0 输出：视频切片单元（cues.jsonl）；asr_text 来自 corrected 语义段。"""

    segment_id: str
    course_id: str
    lecture_id: str
    source_video: str
    start_sec: float
    end_sec: float
    boundary_type: BoundaryType
    asr_text: str = ""
    ppt_video: str = ""
    clip_path: str = ""
    keywords: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def cue_id(self) -> str:
        return self.segment_id

    @property
    def duration_sec(self) -> float:
        return self.end_sec - self.start_sec

    def to_dict(self) -> dict[str, Any]:
        return {
            "cue_id": self.segment_id,
            "segment_id": self.segment_id,
            "course_id": self.course_id,
            "lecture_id": self.lecture_id,
            "source_video": self.source_video,
            "ppt_video": self.ppt_video,
            "start_sec": round(self.start_sec, 3),
            "end_sec": round(self.end_sec, 3),
            "duration_sec": round(self.duration_sec, 3),
            "boundary_type": self.boundary_type.value,
            "asr_text": self.asr_text,
            "clip_path": self.clip_path,
            "keywords": self.keywords,
            "extra": self.extra,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VideoSegment":
        seg_id = data.get("segment_id") or data.get("cue_id", "")
        return cls(
            segment_id=seg_id,
            course_id=data.get("course_id", ""),
            lecture_id=data.get("lecture_id", ""),
            source_video=data.get("source_video", ""),
            start_sec=float(data["start_sec"]),
            end_sec=float(data["end_sec"]),
            boundary_type=BoundaryType(data.get("boundary_type", "merged")),
            asr_text=data.get("asr_text", ""),
            ppt_video=data.get("ppt_video", ""),
            clip_path=data.get("clip_path", ""),
            keywords=data.get("keywords", []),
            extra=data.get("extra", {}),
        )
