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
    AssetEdgeLink,
    AssetGrounding,
    AssetLibrary,
    empty_links,
    fill_grounding_times,
    interpolate_evidence_time,
    refine_grounding_times,
    sort_cards_by_appearance,
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


def test_formula_example_and_cue_times():
    card = AssetCard(
        asset_id="frm_abc",
        kind="formula",
        name="a,b,c...",
        latex="a,b,c,\\ldots",
        concepts=[AssetConceptLink(entity="个体常项/individual constant", role="notation_of")],
        edges=[
            AssetEdgeLink(
                subject="a,b,c...",
                predicate="property_of",
                object="个体常项/individual constant",
                role="notation_of",
            )
        ],
        grounding=AssetGrounding(
            lecture_id="1",
            cue_id="数理逻辑_1_981600_1224300",
        ),
        source="llm",
        links=empty_links(),
    )
    assert validate_card(card) == []
    d = card.to_dict()
    assert d["kind"] == "formula"
    assert "start_sec" not in (d.get("grounding") or {})
    loaded = AssetCard.from_dict({**d, "grounding": {**d["grounding"]}})
    assert loaded.grounding and loaded.grounding.start_sec == 981.6
    assert loaded.grounding.end_sec == 1224.3

    n = fill_grounding_times([card])
    assert n == 1
    assert card.grounding.start_sec == 981.6


def test_interpolate_evidence_time_mid_cue():
    from teachkg.assets.schema import interpolate_evidence_time, refine_grounding_times

    src = "前面铺垫讲解很长很长。" + "当x=1,y=2时，1+2=2就是一个命题，值为假" + "。后面还有别的内容。"
    start, end = interpolate_evidence_time(
        "当x=1,y=2时，1+2=2就是一个命题，值为假",
        src,
        100.0,
        200.0,
        lead_sec=0.8,
    )
    assert start is not None and end is not None
    assert 100.0 < start < 180.0
    assert start < end <= 200.0

    card = AssetCard(
        asset_id="ex_mid",
        kind="example",
        name="假命题赋值",
        evidence="当x=1,y=2时，1+2=2就是一个命题，值为假",
        grounding=AssetGrounding(
            lecture_id="1",
            cue_id="数理逻辑_1_100000_200000",
            start_sec=100.0,
            end_sec=200.0,
        ),
        source="llm",
        links=empty_links(),
    )
    n = refine_grounding_times(
        [card],
        [{"cue_id": "数理逻辑_1_100000_200000", "start_sec": 100.0, "end_sec": 200.0, "asr_text": src}],
    )
    assert n == 1
    assert card.grounding and card.grounding.start_sec > 100.0

    ex = AssetCard.from_dict(
        {
            "asset_id": "ex_map",
            "kind": "example",
            "name": "地图着色",
            "source": "llm",
            "concepts": [{"entity": "四色问题", "role": "illustrates"}],
        }
    )
    assert validate_card(ex) == []


def test_ground_evidence_from_asr_not_extract():
    from teachkg.assets.llm_extract import _ground_evidence, parse_llm_assets

    asr = (
        "亚里士多德的著名三段论：人终有一死，苏格拉底是人，推出苏格拉底会死。"
        "小弟弟抱红气球。"
    )
    extract = "谓词逻辑把原子命题分成个体和谓词。"
    # 口播里有例子，预处理文本没有
    assert "苏格拉底" not in extract
    span = _ground_evidence("苏格拉底三段论示例", asr, hints="苏格拉底三段论")
    assert span and "苏格拉底" in span
    assert _ground_evidence("苏格拉底三段论示例", extract, hints="苏格拉底三段论") is None

    cards = parse_llm_assets(
        {
            "assets": [
                {
                    "kind": "example",
                    "name": "亚里士多德三段论:苏格拉底必死",
                    "summary": "用苏格拉底说明需要拆个体与谓词",
                    "evidence": "亚里士多德三段论:苏格拉底必死",
                }
            ]
        },
        source_text=asr,
        lecture_id="1",
        cue_id="数理逻辑_1_339500_773000",
    )
    assert len(cards) == 1
    assert cards[0].kind == "example"
    assert "苏格拉底" in (cards[0].evidence or "")


def test_index_includes_zh_and_edge_endpoints():
    lib = AssetLibrary(
        course_id="t",
        cards=[
            AssetCard(
                asset_id="frm_x",
                kind="formula",
                name="记号",
                concepts=[AssetConceptLink(entity="个体变项/individual variable", role="notation_of")],
                source="curated",
                links=empty_links(),
            )
        ],
    )
    idx = lib.to_dict()["index_by_entity"]
    assert "frm_x" in idx["个体变项/individual variable"]
    assert "frm_x" in idx["个体变项"]


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


def test_generic_formula_filter():
    from teachkg.assets.formula_quality import formula_drop_reason, keep_generic_formulas

    assert formula_drop_reason("全称量词∀的基本形式", latex=r"(\forall x)P(x)") is None
    assert formula_drop_reason("完全图边数公式", latex=r"n(n-1)/2") is None
    assert formula_drop_reason("握手定理公式", latex=r"\sum deg(v)=2m") is None
    assert formula_drop_reason("个体记号约定", latex="a,b,c") is None
    assert formula_drop_reason("假言推理（分离规则）", latex=r"(p\to q)\land p \to q") is None

    assert formula_drop_reason("Embrace(x,y) 表示抱住", latex=r"Embrace(x,y)")
    assert formula_drop_reason("LittleBrother(x) 表示小弟弟")
    assert formula_drop_reason("A点谓词", latex=r"\forall a\forall b")
    assert formula_drop_reason("牛顿流数法中的导数积分关系")
    assert formula_drop_reason("所有人终有一死的量词公式", latex=r"\forall x(P(x)\to Q(x))")
    assert formula_drop_reason(
        "P(x,y)定义为x+y=2",
        evidence="例如，P(x,y)定义为x+y=2",
    )

    cards = [
        AssetCard(asset_id="a", kind="formula", name="握手定理", latex=r"\sum d(v)=2m", summary="短"),
        AssetCard(
            asset_id="b",
            kind="formula",
            name="握手定理公式",
            latex=r"\sum d(v)=2m",
            summary="所有结点度之和等于边数的两倍",
        ),
        AssetCard(asset_id="c", kind="example", name="七桥问题"),
        AssetCard(asset_id="d", kind="formula", name="Embrace(x,y) 表示抱住", latex="Embrace(x,y)"),
    ]
    kept = keep_generic_formulas(cards)
    names = {c.name for c in kept}
    assert "握手定理公式" in names
    assert "握手定理" not in names
    assert "七桥问题" in names
    assert "Embrace(x,y) 表示抱住" not in names
    assert formula_drop_reason("删去顶点 G−v", latex="G-v")
    assert formula_drop_reason("加边 G+eij", latex=r"G+e_{ij},\quad e_{ij}=(v_i,v_j)")
    assert formula_drop_reason("空图记号 N_n", latex="N_n")


def test_sort_cards_by_appearance_follows_lecture_time():
    late = AssetCard(
        asset_id="thm_late",
        kind="theorem",
        name="后出现",
        grounding=AssetGrounding(lecture_id="1", start_sec=200.0),
        source="llm",
        links=empty_links(),
    )
    early = AssetCard(
        asset_id="thm_early",
        kind="theorem",
        name="先出现",
        grounding=AssetGrounding(lecture_id="1", start_sec=10.0),
        source="llm",
        links=empty_links(),
    )
    next_lec = AssetCard(
        asset_id="thm_l2",
        kind="theorem",
        name="第二讲",
        grounding=AssetGrounding(lecture_id="2", start_sec=1.0),
        source="llm",
        links=empty_links(),
    )
    untimed = AssetCard(
        asset_id="thm_none",
        kind="theorem",
        name="无时间",
        grounding=AssetGrounding(lecture_id="1"),
        source="llm",
        links=empty_links(),
    )
    ordered = sort_cards_by_appearance([late, next_lec, untimed, early])
    assert [c.asset_id for c in ordered] == [
        "thm_early",
        "thm_late",
        "thm_none",
        "thm_l2",
    ]
