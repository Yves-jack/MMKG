"""资产库构建单测。"""

from __future__ import annotations

from teachkg.assets.build import (
    _is_junk_theorem,
    attach_lecture_grounding,
    merge_cards,
)
from teachkg.assets.schema import (
    AssetCard,
    AssetConceptLink,
    AssetGrounding,
    empty_links,
    validate_card,
)


def test_validate_card_ok():
    card = AssetCard(
        asset_id="tech_x",
        kind="technique",
        name="测试方法/test",
        concepts=[AssetConceptLink(entity="论域/domain of discourse", role="about")],
        source="curated",
        links=empty_links(),
    )
    assert validate_card(card) == []


def test_junk_theorem_filter():
    assert _is_junk_theorem("未知", "很长的内容也不要")
    assert not _is_junk_theorem("演绎定理", r"\vdash A")


def test_merge_curated_overrides_textbook():
    tb = AssetCard(
        asset_id="tech_x",
        kind="technique",
        name="旧/old",
        source="textbook",
        links=empty_links(),
    )
    cu = AssetCard(
        asset_id="tech_x",
        kind="technique",
        name="新/new",
        source="curated",
        links=empty_links(),
    )
    merged = merge_cards([tb], [cu])
    assert len(merged) == 1
    assert merged[0].name == "新/new"
    assert merged[0].source == "curated"


def test_attach_lecture_grounding():
    card = AssetCard(
        asset_id="tech_y",
        kind="technique",
        name="有限论域量词展开/x",
        concepts=[AssetConceptLink(entity="论域/domain of discourse", role="about")],
        source="curated",
        links=empty_links(),
    )
    n = attach_lecture_grounding(
        [card],
        {"论域/domain of discourse": ["3", "1"]},
    )
    assert n == 1
    assert card.grounding == AssetGrounding(lecture_id="3")
