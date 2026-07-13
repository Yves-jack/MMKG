"""Stage 3 MMKG 子模块包。延迟导入，避免 index_builder ↔ rag 循环依赖。"""

__all__ = [
    "MMKGIndex",
    "Stage3MMKGPipeline",
    "attach_multimodal_evidence",
    "build_and_save_index",
]


def __getattr__(name: str):
    if name in ("MMKGIndex", "build_and_save_index"):
        from teachkg.stage3_mmkg.index_builder import MMKGIndex, build_and_save_index

        return MMKGIndex if name == "MMKGIndex" else build_and_save_index
    if name == "Stage3MMKGPipeline":
        from teachkg.stage3_mmkg.pipeline import Stage3MMKGPipeline

        return Stage3MMKGPipeline
    if name == "attach_multimodal_evidence":
        from teachkg.stage3_mmkg.evidence_attach import attach_multimodal_evidence

        return attach_multimodal_evidence
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
