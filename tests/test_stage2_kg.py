from teachkg.stage2_kg_build.entity_merge import build_entity_merge_map, merge_triplets_to_kg


def _row(sub: str, obj: str, rel: str = "belong_to", concrete: str = "属于", cue: str = "c1"):
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
    }


def test_entity_merge_by_chinese_name():
    merge_map = build_entity_merge_map(
        ["命题逻辑/propositional logic", "命题逻辑/Propositional Logic"]
    )
    assert len(merge_map) == 1
    assert merge_map["命题逻辑/Propositional Logic"] == "命题逻辑/propositional logic"


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
