"""Stage 1 alignment package.

Import pipelines from ``teachkg.stage1_alignment.pipeline`` to avoid circular
imports with ``teachkg.textbook_kg.convert``.
"""

from __future__ import annotations

__all__ = ["Stage1AlignmentPipeline", "Stage1PreparePipeline"]


def __getattr__(name: str):
    if name in __all__:
        from teachkg.stage1_alignment.pipeline import (
            Stage1AlignmentPipeline,
            Stage1PreparePipeline,
        )

        return {
            "Stage1AlignmentPipeline": Stage1AlignmentPipeline,
            "Stage1PreparePipeline": Stage1PreparePipeline,
        }[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
