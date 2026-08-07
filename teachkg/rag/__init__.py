"""RAG 子模块包。避免在 __init__ 中 eager import，防止与 stage3 index_builder 循环依赖。"""

__all__ = [
    "BM25Index",
    "MMKGRAG",
    "format_hit_for_context",
    "build_retrieval_query",
    "plan_route",
    "boost_grounded_hits",
]


def __getattr__(name: str):
    if name == "BM25Index":
        from teachkg.rag.bm25 import BM25Index

        return BM25Index
    if name in ("MMKGRAG", "format_hit_for_context"):
        from teachkg.rag import mmkg_rag as m

        return m.MMKGRAG if name == "MMKGRAG" else m.format_hit_for_context
    if name == "build_retrieval_query":
        from teachkg.rag.multi_turn import build_retrieval_query

        return build_retrieval_query
    if name == "plan_route":
        from teachkg.rag.router import plan_route

        return plan_route
    if name == "boost_grounded_hits":
        from teachkg.rag.evidence import boost_grounded_hits

        return boost_grounded_hits
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
