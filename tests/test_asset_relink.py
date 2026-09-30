from teachkg.assets.relink import relink_cards, score_card_entity
from teachkg.assets.schema import AssetCard, empty_links


def _card(kind: str, name: str, evidence: str = "", **kw) -> AssetCard:
    return AssetCard(
        asset_id=f"t_{name}",
        kind=kind,
        name=name,
        evidence=evidence,
        source="llm",
        links=empty_links(),
        **kw,
    )


def test_name_first_not_same_lecture_hub():
    cards = [
        _card("example", "亚里士多德三段论示例", "人终有一死，苏格拉底是人"),
    ]
    entities = [
        {"id": "哥尼斯堡七桥问题/Seven Bridges", "name": "哥尼斯堡七桥问题/Seven Bridges"},
        {"id": "谓词逻辑/Predicate Logic", "name": "谓词逻辑/Predicate Logic"},
        {"id": "三段论/syllogism", "name": "三段论/syllogism"},
    ]
    edges = [
        {
            "subject": "三段论/syllogism",
            "object": "谓词逻辑/Predicate Logic",
            "abstract_relation": "belong_to",
        }
    ]
    relink_cards(cards, entities, edges)
    ents = {c.entity for c in cards[0].concepts}
    assert "三段论/syllogism" in ents
    assert "哥尼斯堡七桥问题/Seven Bridges" not in ents
    assert "谓词逻辑/Predicate Logic" not in ents


def test_drop_placeholder_and_subsumed():
    cards = [
        _card("example", "一元谓词例子:苏格拉底/柏拉图是人", "苏格拉底是人，柏拉图是人"),
        _card("formula", "谓词表示约定", "谓词通常用英文单词表示", latex=r"\text{Man}"),
        _card("formula", "握手定理", "所有结点度之和等于2m"),
    ]
    entities = [
        {"id": "a,b,c.../a,b,c...", "name": "a,b,c.../a,b,c..."},
        {"id": "谓词/predicate", "name": "谓词/predicate"},
        {"id": "一元谓词/unary predicate", "name": "一元谓词/unary predicate"},
        {"id": "握手定理/Handshaking Lemma", "name": "握手定理/Handshaking Lemma"},
        {"id": "完全图/complete graph", "name": "完全图/complete graph"},
    ]
    relink_cards(cards, entities, [])
    u = {c.entity for c in cards[0].concepts}
    assert "一元谓词/unary predicate" in u
    assert "谓词/predicate" not in u
    assert all("a,b,c" not in c.entity for c in cards[1].concepts)
    h = {c.entity for c in cards[2].concepts}
    assert "握手定理/Handshaking Lemma" in h
    assert "完全图/complete graph" not in h


def test_spo_from_hierarchy_edge():
    cards = [
        _card("formula", "完全图边数公式", "无向完全图边数为 n(n-1)/2"),
    ]
    entities = [
        {"id": "完全图/complete graph", "name": "完全图/complete graph"},
        {"id": "图/Graph", "name": "图/Graph"},
    ]
    edges = [
        {
            "subject": "完全图/complete graph",
            "object": "图/Graph",
            "abstract_relation": "belong_to",
        }
    ]
    relink_cards(cards, entities, edges)
    # 「图」被「完全图」包含，应只留完全图，故不一定有 SPO
    names = {c.entity for c in cards[0].concepts}
    assert "完全图/complete graph" in names
    assert score_card_entity(cards[0], "a,b,c.../a,b,c...", []) == 0.0


def test_example_title_aligns_seven_bridges():
    cards = [_card("example", "七桥问题抽象成的图", "把七座桥抽象成图")]
    entities = [
        {"id": "哥尼斯堡七桥问题/Seven Bridges", "name": "哥尼斯堡七桥问题/Seven Bridges"},
        {"id": "密码学/cryptography", "name": "密码学/cryptography"},
        {"id": "陆地/land", "name": "陆地/land"},
    ]
    relink_cards(cards, entities, [])
    ents = {c.entity for c in cards[0].concepts}
    assert "哥尼斯堡七桥问题/Seven Bridges" in ents
    assert "密码学/cryptography" not in ents
    assert "陆地/land" not in ents
