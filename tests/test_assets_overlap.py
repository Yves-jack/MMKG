from teachkg.assets.overlap import (
    containment_ratio,
    link_entities_by_overlap,
    overlap_ratio,
    score_evidence_to_entity,
)


def test_overlap_ratio_basic():
    assert overlap_ratio("谓词逻辑将原子命题分解", "谓词逻辑将原子命题分解为个体") > 0.4
    assert overlap_ratio("完全无关的句子", "谓词逻辑") < 0.2


def test_name_boost_in_score():
    s = score_evidence_to_entity(
        "谓词逻辑将简单命题分为主语和谓语",
        "谓词逻辑/Predicate Logic",
        ["谓词逻辑就是把一个简单的命题更精细地分成主语和谓语两部分"],
    )
    assert s >= 0.35


def test_link_entities_by_overlap_top():
    idx = {
        "谓词逻辑/Predicate Logic": ["谓词逻辑将简单命题分为主语和谓语"],
        "命题逻辑/propositional logic": ["命题逻辑是谓词逻辑的基础"],
        "无关实体/x": ["今天天气很好"],
    }
    hits = link_entities_by_overlap(
        "谓词逻辑将简单命题分为主语和谓语两部分",
        idx,
        min_score=0.1,
        top_k=2,
    )
    assert hits
    assert "谓词逻辑" in hits[0][0]


def test_containment():
    assert containment_ratio("主语和谓语", "把命题分成主语和谓语两部分") > 0.5
