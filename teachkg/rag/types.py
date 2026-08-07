"""RAG 流水线共享类型。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class RoutePlan:
    """模态感知路由决策（借鉴 UniversalRAG：先判模态再检索/生成）。"""

    channels: list[str] = field(default_factory=lambda: ["text_hybrid"])
    parse_user_media: bool = False
    boost_grounded_hits: bool = True
    attach_hit_images: bool = False
    use_vision_answer: bool = False
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "channels": list(self.channels),
            "parse_user_media": self.parse_user_media,
            "boost_grounded_hits": self.boost_grounded_hits,
            "attach_hit_images": self.attach_hit_images,
            "use_vision_answer": self.use_vision_answer,
            "reason": self.reason,
        }


@dataclass
class PipelineTrace:
    """各阶段可观测痕迹，便于调试与评测。"""

    stages: list[str] = field(default_factory=list)
    route: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def mark(self, stage: str, note: str = "") -> None:
        self.stages.append(stage)
        if note:
            self.notes.append(f"{stage}: {note}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "stages": list(self.stages),
            "route": dict(self.route),
            "notes": list(self.notes),
        }
