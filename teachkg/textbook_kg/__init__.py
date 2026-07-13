"""教材知识图谱：加载、子图检索与混合抽取辅助。"""

from teachkg.textbook_kg.alias import build_alias_map, clean_text, extract_entities_from_text
from teachkg.textbook_kg.convert import (
    format_subgraph_for_prompt,
    relation_to_triplet,
    relations_to_triplets,
)
from teachkg.textbook_kg.loader import TextbookEntity, TextbookKG, TextbookRelation
from teachkg.textbook_kg.subgraph import SubgraphResult, TextbookSubgraphRetriever

__all__ = [
    "TextbookEntity",
    "TextbookKG",
    "TextbookRelation",
    "TextbookSubgraphRetriever",
    "SubgraphResult",
    "build_alias_map",
    "clean_text",
    "extract_entities_from_text",
    "format_subgraph_for_prompt",
    "relation_to_triplet",
    "relations_to_triplets",
]
