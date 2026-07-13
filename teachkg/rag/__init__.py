"""RAG 子模块包。避免在 __init__ 中 eager import，防止与 stage3 index_builder 循环依赖。"""

__all__ = ["BM25Index", "MMKGRAG", "format_hit_for_context", "build_retrieval_query"]


def __getattr__(name: str):
    if name == "BM25Index":
        from teachkg.rag.bm25 import BM25Index

        return BM25Index
    if name in ("MMKGRAG", "format_hit_for_context"):
        from teachkg.rag.mmkg_rag import MMKGRAG, format_hit_for_context

        return MMKGRAG if name == "MMKGRAG" else format_hit_for_context
    if name == "build_retrieval_query":
        from teachkg.rag.multi_turn import build_retrieval_query

        return build_retrieval_query
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
