"""Stage 2 public API with optional components loaded on demand."""

from __future__ import annotations

from typing import Any

__all__ = [
    "EntityMergeResult",
    "EntityTriageConfig",
    "Stage2KGPipeline",
    "TriageDecision",
    "TriageResult",
    "merge_triplets_to_kg",
    "triage_triplets",
]


def __getattr__(name: str) -> Any:
    if name in {"EntityMergeResult", "merge_triplets_to_kg"}:
        from teachkg.stage2_kg_build import entity_merge

        return getattr(entity_merge, name)
    if name in {
        "EntityTriageConfig",
        "TriageDecision",
        "TriageResult",
        "triage_triplets",
    }:
        from teachkg.stage2_kg_build import entity_triage

        return getattr(entity_triage, name)
    if name == "Stage2KGPipeline":
        from teachkg.stage2_kg_build.pipeline import Stage2KGPipeline

        return Stage2KGPipeline
    raise AttributeError(name)
