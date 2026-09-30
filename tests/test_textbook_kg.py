"""教材 KG 子图检索与混合抽取单元测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from teachkg.stage1_alignment.triplet_extract import (
    Triplet,
    TripletExtractor,
    filter_triplets,
    is_overly_specific_entity,
    is_overly_specific_triplet,
    is_placeholder_entity,
    filter_delta_triplets,
)
from teachkg.textbook_kg import (
    TextbookKG,
    TextbookSubgraphRetriever,
    build_alias_map,
    clean_text,
    extract_entities_from_text,
    format_subgraph_for_prompt,
    relation_to_triplet,
    relations_to_triplets,
)
from teachkg.textbook_kg.alias import is_weak_alias
from teachkg.textbook_kg.entity_registry import EntityRegistry
from teachkg.textbook_kg.loader import TextbookRelation
from teachkg.textbook_kg.theorem_edges import augment_textbook_kg, expand_theorem_relations
from teachkg.textbook_kg.lecture_assign import CueAssignMeta, max_edges_for_cue

TEXTBOOK_PATH = (
    Path(__file__).resolve().parents[1]
    / "data/textbook/CS2501-离散数学（数理逻辑与集合论）"
)


@pytest.fixture(scope="module")
def textbook_kg() -> TextbookKG:
    if not TEXTBOOK_PATH.is_dir():
        pytest.skip("textbook data not available")
    return TextbookKG.load(TEXTBOOK_PATH)


def test_clean_text_strips_punctuation():
    assert clean_text("命题逻辑 (Propositional Logic)") == "命题逻辑propositionallogic"


def test_alias_keeps_long_and_short_matches():
    entities = [
        "命题逻辑/propositional logic",
        "逻辑/logic",
    ]
    alias_map = build_alias_map(entities)
    text = "今天复习命题逻辑的基本概念"
    matched = extract_entities_from_text(text, alias_map)
    assert "命题逻辑/propositional logic" in matched
    assert "逻辑/logic" in matched
    # 可选：仍支持最长优先压制短别名
    longest_only = extract_entities_from_text(
        text, alias_map, prefer_longest_only=True
    )
    assert "命题逻辑/propositional logic" in longest_only
    assert "逻辑/logic" not in longest_only


def test_weak_short_alias_not_used_as_seed():
    assert is_weak_alias("上")
    assert is_weak_alias("证明")
    assert not is_weak_alias("命题逻辑")
    entities = [
        "上/top element",
        "点/point",
        "真/true",
        "谓词逻辑/Predicate Logic",
        "关系/relation",
    ]
    alias_map = build_alias_map(entities)
    # 单字别名不应再进入 alias_map
    assert "上" not in alias_map
    assert "点" not in alias_map
    text = "真点上都要加快速度。接下来讲谓词逻辑。"
    matched = extract_entities_from_text(text, alias_map)
    assert "谓词逻辑/Predicate Logic" in matched
    assert "上/top element" not in matched
    assert "点/point" not in matched
    assert "真/true" not in matched
    # 「没关系」不应命中「关系」
    assert "关系/relation" not in extract_entities_from_text(
        "没关系，反正最后成绩公平。", alias_map
    )


def test_retrieve_prunes_unanchored_hub_edges(textbook_kg: TextbookKG):
    retriever = TextbookSubgraphRetriever(
        textbook_kg,
        max_hops=2,
        max_edges_per_cue=18,
        cue_min_relation_score=4.0,
        require_text_anchor=True,
        embedding_link_enabled=False,
    )
    cue = "谓词逻辑将命题细分为主语和谓语，论域是个体变项的变化范围。"
    result = retriever.retrieve(cue)
    assert result.seed_entities
    assert result.relations
    # 实体集应来自选中边，而非整片 2-hop 邻域
    assert result.entity_count <= len(result.seed_entities) + 2 * len(result.relations)
    cue_clean = clean_text(cue)
    both_miss = 0
    for rel in result.relations:
        parts_s = [clean_text(p) for p in rel.subject.split("/")]
        parts_o = [clean_text(p) for p in rel.object.split("/")]
        s_hit = any(p and p in cue_clean for p in parts_s)
        o_hit = any(p and p in cue_clean for p in parts_o)
        seed_touch = rel.subject in result.seed_entities or rel.object in result.seed_entities
        if not (s_hit or o_hit or seed_touch):
            both_miss += 1
    assert both_miss == 0


def test_load_textbook_kg(textbook_kg: TextbookKG):
    assert len(textbook_kg.entities) > 1000
    assert len(textbook_kg.relations) > 2000
    assert textbook_kg.alias_map


def test_retrieve_subgraph_on_predicate_logic(textbook_kg: TextbookKG):
    retriever = TextbookSubgraphRetriever(textbook_kg, max_hops=1, max_edges_per_cue=20)
    cue = (
        "谓词逻辑将命题细分为主语和谓语，个体词表示思维对象，"
        "论域是所有个体变项的变化范围。"
    )
    result = retriever.retrieve(cue)
    assert result.seed_entities
    assert result.relations
    assert result.entity_count >= len(result.seed_entities)


def test_relation_to_triplet_has_textbook_source():
    rel = TextbookRelation(
        subject="谓词逻辑/Predicate Logic",
        predicate="depend_on",
        object="命题逻辑/propositional logic",
        description="谓词逻辑依赖命题逻辑。",
        context="命题逻辑是谓词逻辑的基础。",
    )
    triplet = relation_to_triplet(rel)
    assert triplet.extract_source == "textbook"
    assert triplet.abstract_relation == "depend_on"
    assert triplet.concrete_relation
    assert "基础" in triplet.description or "依赖" in triplet.concrete_relation


def test_format_subgraph_for_prompt(textbook_kg: TextbookKG):
    rel = textbook_kg.relations[0]
    payload = format_subgraph_for_prompt(
        textbook_kg,
        seed_entities={rel.subject},
        entities={rel.subject, rel.object},
        relations=[rel],
    )
    assert rel.subject in payload
    assert "relations" in payload


def test_hybrid_extract_dedupes_textbook(textbook_kg: TextbookKG):
    rel = TextbookRelation(
        subject="谓词逻辑/Predicate Logic",
        predicate="depend_on",
        object="命题逻辑/propositional logic",
        description="谓词逻辑依赖命题逻辑。",
        context="命题逻辑是谓词逻辑的基础。",
    )
    textbook_triplets = relations_to_triplets([rel])
    extractor = TripletExtractor(mock=True, validate_enabled=False)
    result = extractor.extract_hybrid(
        "命题逻辑是谓词逻辑的基础。",
        "数理逻辑",
        textbook_subgraph_json="{}",
        textbook_triplets=textbook_triplets,
        dedupe_against_textbook=True,
    )
    assert all(t.extract_source == "lecture_delta" for t in result.triplets)
    assert all(t.dedupe_key not in {x.dedupe_key for x in textbook_triplets} for t in result.triplets)


def test_relation_to_triplet_uses_description_concrete():
    rel = TextbookRelation(
        subject="谓词逻辑/Predicate Logic",
        predicate="depend_on",
        object="命题逻辑/propositional logic",
        description="命题逻辑是谓词逻辑的基础。",
        context="命题逻辑是谓词逻辑的基础。",
    )
    triplet = relation_to_triplet(rel)
    assert triplet.concrete_relation in {"是基础", "依赖"}
    assert "基础" in triplet.description


def test_theorem_edges_expand():
    if not TEXTBOOK_PATH.is_dir():
        pytest.skip("textbook data not available")
    kg = TextbookKG.load(TEXTBOOK_PATH)
    extra = expand_theorem_relations(kg)
    assert len(extra) > 100
    augmented = augment_textbook_kg(kg)
    assert len(augmented.relations) > len(kg.relations)


def test_entity_registry_synonym_lookup(textbook_kg: TextbookKG):
    registry = EntityRegistry.from_textbook_kg(textbook_kg)
    hit = registry.lookup("命题逻辑/propositional logic")
    assert hit
    assert registry.canonicalize("命题逻辑/propositional logic") == hit


def test_max_edges_for_short_cue():
    assert max_edges_for_cue(30) <= max_edges_for_cue(300)


def test_placeholder_entity_rejected():
    assert is_placeholder_entity("a,b,c.../a,b,c...")
    assert is_placeholder_entity("p,q,r.../p,q,r...")
    assert not is_placeholder_entity("个体常项/individual constant")

    bad = Triplet(
        subject="个体常项/individual constant",
        object="a,b,c.../a,b,c...",
        abstract_relation="related_with",
        concrete_relation="表示为",
        statement_direction="subject_to_object",
    )
    kept = filter_delta_triplets([bad], "个体常项表示为a,b,c", conceptual_focus=True)
    assert kept == []


def test_overly_specific_entity_rejected():
    assert is_overly_specific_entity("公理50/axiom 50")
    assert is_overly_specific_entity("第一个命题/first proposition")
    assert is_overly_specific_entity("定理3.2.1/theorem")
    assert not is_overly_specific_entity("谓词逻辑/predicate logic")
    assert not is_overly_specific_entity("公理/axiom")

    bad = Triplet(
        subject="公理50/axiom 50",
        object="公理/axiom",
        abstract_relation="belong_to",
        concrete_relation="属于",
        statement_direction="subject_to_object",
    )
    assert is_overly_specific_triplet(bad)
    kept = filter_triplets([bad], "公理50是公理系统的一部分", conceptual_focus=True)
    assert kept == []


def test_pipeline_hybrid_mock():
    from teachkg.config import TeachKGConfig
    from teachkg.schemas import BoundaryType, VideoSegment
    from teachkg.stage1_alignment.pipeline import CueCheckResult, PreparedCue, Stage1PreparePipeline

    if not TEXTBOOK_PATH.is_dir():
        pytest.skip("textbook data not available")

    cfg_path = Path(__file__).resolve().parents[1] / "configs/teaching.yaml"
    config = TeachKGConfig.from_yaml(cfg_path)
    config.raw.setdefault("stage1", {})["textbook_kg"] = {
        **config.get("stage1", "textbook_kg", default={}),
        "enabled": True,
        "subgraph": {
            **config.get("stage1", "textbook_kg", "subgraph", default={}),
            "lecture_dedupe_textbook": True,
            "max_edges_per_cue": 18,
            "max_edges_per_lecture": 60,
        },
    }
    config.raw["stage1"]["use_existing_artifacts"] = False

    pipeline = Stage1PreparePipeline(
        config, project_root=Path(__file__).resolve().parents[1], mock=True
    )
    assert pipeline.textbook_retriever is not None
    assert pipeline.textbook_lecture_dedupe is True

    cues = [
        VideoSegment(
            segment_id="test_a",
            course_id="数理逻辑",
            lecture_id="10",
            source_video="",
            start_sec=0.0,
            end_sec=10.0,
            boundary_type=BoundaryType.MERGED,
            asr_text="谓词逻辑中，论域是个体变项的取值范围，命题逻辑是谓词逻辑的基础。",
            clip_path="a.mp4",
        ),
        VideoSegment(
            segment_id="test_b",
            course_id="数理逻辑",
            lecture_id="10",
            source_video="",
            start_sec=10.0,
            end_sec=20.0,
            boundary_type=BoundaryType.MERGED,
            asr_text="个体词表示思维对象，论域也称为个体域。",
            clip_path="b.mp4",
        ),
    ]
    prepared = [
        PreparedCue(cue=c, check=CueCheckResult(passed=True), extract_text=c.asr_text)
        for c in cues
    ]
    pipeline._extract_hybrid_lecture(prepared, "数理逻辑", "数理逻辑")

    total_tb = sum(
        int(p.triplet_validation.get("assigned_textbook_edges", 0)) for p in prepared
    )
    pool = prepared[0].triplet_validation.get("lecture_textbook_pool", 0)
    assert pool > 0
    assert total_tb <= pool
    assert all("textbook" in {t.extract_source for t in p.triplets} for p in prepared)
