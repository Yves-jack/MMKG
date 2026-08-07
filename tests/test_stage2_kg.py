from teachkg.stage2_kg_build.entity_merge import (
    build_entity_merge_map,
    build_synonym_merge_map,
    merge_triplets_to_kg,
    prefer_formal_name,
)


def _row(sub: str, obj: str, rel: str = "belong_to", concrete: str = "属于", cue: str = "c1", **extra):
    return {
        "subject": sub,
        "object": obj,
        "abstract_relation": rel,
        "concrete_relation": concrete,
        "statement_direction": "subject_to_object",
        "attribute_category": "关系属性",
        "natural_statement": f"{sub}{concrete}{obj}",
        "description": "",
        "context": "ctx",
        "cue_id": cue,
        "lecture_id": "1",
        **extra,
    }


def test_entity_merge_by_chinese_name():
    merge_map = build_entity_merge_map(
        ["命题逻辑/propositional logic", "命题逻辑/Propositional Logic"]
    )
    assert len(merge_map) == 1
    # 并列时取字典序更小者（P < p）
    assert merge_map["命题逻辑/propositional logic"] == "命题逻辑/Propositional Logic"


def test_prefer_formal_prefers_textbook_and_shorter_zh():
    tb = {"论域/domain of discourse"}
    assert (
        prefer_formal_name(
            "个体域/domain of individuals",
            "论域/domain of discourse",
            textbook_entity_names=tb,
        )
        == "论域/domain of discourse"
    )
    assert (
        prefer_formal_name("命题函数/propositional function", "谓词/predicate")
        == "谓词/predicate"
    )


def test_synonym_of_merges_into_formal_canonical_with_aliases():
    rows = [
        _row(
            "谓词/predicate",
            "命题函数/propositional function",
            rel="synonym_of",
            concrete="等同于",
            extract_source="lecture_delta",
        ),
        _row(
            "命题函数/propositional function",
            "公式/formula",
            rel="part_of",
            concrete="是…的成分",
            extract_source="lecture_delta",
        ),
        _row(
            "谓词/predicate",
            "原子公式/atomic formula",
            rel="part_of",
            concrete="构成",
            extract_source="textbook",
        ),
    ]
    result = merge_triplets_to_kg(rows, merge_synonym_of=True)
    assert "命题函数/propositional function" not in result.entities
    assert "谓词/predicate" in result.entities
    assert "命题函数/propositional function" in result.entities["谓词/predicate"].aliases
    assert all(e.abstract_relation != "synonym_of" for e in result.edges)
    # 原挂在别名上的边并入正式名
    objs = {(e.subject, e.object) for e in result.edges}
    assert ("谓词/predicate", "公式/formula") in objs
    assert ("谓词/predicate", "原子公式/atomic formula") in objs


def test_merge_synonym_of_can_be_disabled():
    rows = [
        _row(
            "A/a",
            "B/b",
            rel="synonym_of",
            concrete="同义",
        ),
    ]
    result = merge_triplets_to_kg(rows, merge_synonym_of=False)
    assert len(result.edges) == 1
    assert result.edges[0].abstract_relation == "synonym_of"


def test_merge_triplets_dedupes_edges_and_drops_self_loop():
    rows = [
        _row("命题/proposition", "陈述句/sentence"),
        _row("命题/proposition", "陈述句/sentence", cue="c2"),
        _row("命题/proposition", "命题/proposition"),
    ]
    result = merge_triplets_to_kg(rows)
    assert result.stats["input_triplet_count"] == 3
    assert len(result.edges) == 1
    assert len(result.edges[0].provenance) == 2


def test_drop_related_with_when_specific_exists():
    rows = [
        _row("三段论/syllogism", "亚里士多德/Aristotle", rel="related_with", concrete="由...提出"),
        _row("三段论/syllogism", "亚里士多德/Aristotle", rel="depend_on", concrete="源于"),
    ]
    result = merge_triplets_to_kg(rows, drop_related_with_when_specific=True)
    assert len(result.edges) == 1
    assert result.edges[0].abstract_relation == "depend_on"


def test_merge_triplets_preserves_provenance_fields():
    rows = [
        {
            **_row("命题/proposition", "陈述句/sentence"),
            "source_text": "字幕片段",
            "clip_path": "data/clips/c1.mp4",
            "extract_source": "lecture_delta",
        }
    ]
    result = merge_triplets_to_kg(rows)
    prov = result.edges[0].provenance[0]
    assert prov["source_text"] == "字幕片段"
    assert prov["clip_path"].endswith("c1.mp4")
    assert prov["extract_source"] == "lecture_delta"


def test_min_subgraph_size_filters_isolated_pair():
    rows = [
        _row("A/a", "B/b"),
        _row("C/c", "D/d"),
        _row("D/d", "E/e"),
        _row("E/e", "C/c"),
    ]
    result = merge_triplets_to_kg(rows, min_subgraph_size=3)
    assert len(result.entities) == 3
    assert len(result.edges) == 3


def test_build_synonym_merge_map_transitive():
    rows = [
        _row("A/a", "B/b", rel="synonym_of", concrete="即"),
        _row("B/b", "C/c", rel="synonym_of", concrete="又称"),
    ]
    m = build_synonym_merge_map(rows)
    # 最短中文主名 A 应成为根
    assert m.get("B/b") == "A/a"
    assert m.get("C/c") == "A/a"