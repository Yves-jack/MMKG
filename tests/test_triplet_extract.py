from teachkg.schemas import VideoSegment
from teachkg.stage1_alignment.triplet_extract import (
    Triplet,
    TripletValidator,
    TripletExtractor,
    TripletValidationResult,
    ValidatedTriplet,
    ValidationVerdict,
    build_revision_feedback,
    build_flat_triplet_records,
    VALIDATION_VERDICT_PASS,
    VALIDATION_VERDICT_REVISE,
    VALIDATION_VERDICT_DISCARD,
    REVISE_ACTION_FIX,
    concrete_relation_effective_len,
    dedupe_triplets,
    expand_concrete_relation,
    filter_triplets,
    infer_attribute_category,
    infer_statement_direction,
    is_bad_entity,
    normalize_statement_direction,
    parse_triplet_response,
    parse_validation_response,
    rule_validate_triplet_semantics,
    triplet_to_statement,
    validate_triplet,
    _split_validation_verdicts,
)


def test_parse_both_relations_required():
    raw = """{
  "triples": [
    {
      "subject": "命题/proposition",
      "object": "陈述句/declarative sentence",
      "abstract_relation": "belong_to",
      "concrete_relation": "属于",
      "statement_direction": "subject_to_object",
      "attribute_category": "关系属性",
      "description": "命题属于陈述句。",
      "context": "命题是一个非真即假的陈述句。"
    }
  ]
}"""
    items = parse_triplet_response(raw)
    assert len(items) == 1
    assert items[0].abstract_relation == "belong_to"
    assert items[0].concrete_relation == "属于"
    assert items[0].statement_direction == "subject_to_object"


def test_reject_bad_entities():
    assert is_bad_entity("P")
    assert is_bad_entity("Q：今天有离散课")
    assert is_bad_entity("P(x)/P(x)")
    assert is_bad_entity("Big(x)/Big(x)")
    assert is_bad_entity("Embrace(x,y)/Embrace(x,y)")
    assert is_bad_entity("个体函数father(x)/individual function father(x)")
    assert is_bad_entity("P(father(John))/P(father(John))")
    assert is_bad_entity("Man(Plato)/Man(Plato)")
    assert not is_bad_entity("命题/proposition")
    assert not is_bad_entity("一元谓词/unary predicate")
    assert not is_bad_entity("x的父亲/father of x")


def test_concrete_relation_effective_len_ignores_slot():
    assert concrete_relation_effective_len("是...的基础") == 4
    assert concrete_relation_effective_len("是...的最小单元") == 6
    assert concrete_relation_effective_len("又称") == 2


def test_filter_rejects_effective_long_concrete():
    source = "命题是一个非真即假的陈述句。"
    bad = Triplet(
        subject="命题/proposition",
        object="陈述句/declarative sentence",
        abstract_relation="belong_to",
        concrete_relation="是..." + "x" * 10,
        statement_direction="subject_to_object",
        context=source,
    )
    assert validate_triplet(bad, source) == "concrete_too_long"


def test_filter_rejects_long_concrete_and_bad_context():
    source = "命题是一个非真即假的陈述句。"
    good = Triplet(
        subject="命题/proposition",
        object="陈述句/declarative sentence",
        abstract_relation="belong_to",
        concrete_relation="属于",
        statement_direction="subject_to_object",
        context=source,
    )
    bad_long = Triplet(
        subject="命题/proposition",
        object="陈述句/declarative sentence",
        abstract_relation="belong_to",
        concrete_relation="x" * 30,
        statement_direction="subject_to_object",
        context=source,
    )
    bad_ctx = Triplet(
        subject="命题/proposition",
        object="陈述句/declarative sentence",
        abstract_relation="belong_to",
        concrete_relation="属于",
        statement_direction="subject_to_object",
        context="完全不在原文里",
    )
    assert validate_triplet(good, source) is None
    assert validate_triplet(bad_long, source) == "concrete_too_long"
    assert validate_triplet(bad_ctx, source) == "context_not_in_source"

    filtered = filter_triplets([good, bad_long, bad_ctx], source)
    assert len(filtered) == 1


def test_filter_accepts_prompt_style_concrete_with_slot():
    source = "原子命题是命题逻辑不可再分的最小单元"
    t = Triplet(
        subject="原子命题/atomic proposition",
        object="命题逻辑/propositional logic",
        abstract_relation="part_of",
        concrete_relation="是...的最小单元",
        statement_direction="subject_to_object",
        context=source,
    )
    assert validate_triplet(t, source) is None


def test_filter_rejects_predicate_application_entities():
    source = "形容词和名词都处理为一元谓词。Big(x): x是大的"
    bad = Triplet(
        subject="Big(x)/Big(x)",
        object="一元谓词/unary predicate",
        abstract_relation="belong_to",
        concrete_relation="是",
        statement_direction="subject_to_object",
        context=source,
    )
    assert validate_triplet(bad, source) == "bad_entity"
    assert filter_triplets([bad], source) == []


def test_rule_validate_rejects_example_symbol_entity():
    bad = Triplet(
        subject="Embrace(x,y)/Embrace(x,y)",
        object="谓词/predicate",
        abstract_relation="belong_to",
        concrete_relation="是",
        statement_direction="subject_to_object",
        context="Embrace(x,y): x抱住了y",
    )
    assert rule_validate_triplet_semantics(bad, "Embrace(x,y): x抱住了y") == "bad_entity"


def test_filter_rejects_p_q_entities():
    raw = """{"triples": [{
      "subject": "P", "object": "原子命题",
      "abstract_relation": "belong_to", "concrete_relation": "举例",
      "statement_direction": "subject_to_object",
      "context": "例如 P"
    }]}"""
    items = filter_triplets(parse_triplet_response(raw), "例如 P")
    assert items == []


def test_infer_attribute_category():
    assert infer_attribute_category("property_of") == "内禀属性"
    assert infer_attribute_category("belong_to") == "关系属性"


def test_infer_statement_direction_defaults():
    assert infer_statement_direction("property_of") == "object_to_subject"
    assert infer_statement_direction("belong_to") == "subject_to_object"


def test_normalize_statement_direction_aliases():
    assert normalize_statement_direction("客体到主体") == "object_to_subject"
    assert normalize_statement_direction("forward") == "subject_to_object"


def test_expand_concrete_relation():
    assert expand_concrete_relation("是...的基础", "谓词逻辑") == "是谓词逻辑的基础"


def test_dedupe_triplets():
    a = Triplet("A", "B", abstract_relation="belong_to", concrete_relation="属于", statement_direction="subject_to_object")
    b = Triplet("A", "B", abstract_relation="belong_to", concrete_relation="属于", statement_direction="subject_to_object")
    c = Triplet("A", "C", abstract_relation="part_of", concrete_relation="组成", statement_direction="subject_to_object")
    assert len(dedupe_triplets([a, b, c])) == 2


def test_build_flat_triplet_records():
    cue = VideoSegment(
        segment_id="c1",
        course_id="test",
        lecture_id="1",
        source_video="v.mp4",
        start_sec=1.0,
        end_sec=2.0,
        boundary_type="merged",
        asr_text="hello",
        clip_path="clip.mp4",
    )
    triplets = [
        Triplet(
            subject="谓词逻辑/predicate logic",
            object="离散数学/discrete mathematics",
            abstract_relation="belong_to",
            concrete_relation="属于",
            statement_direction="subject_to_object",
            attribute_category="关系属性",
        )
    ]
    rows = build_flat_triplet_records(
        cue,
        triplets,
        course_id="test",
        ppt_frame_path="frame.jpg",
        ppt_page_index=0,
    )
    assert rows[0]["abstract_relation"] == "belong_to"
    assert rows[0]["statement_direction"] == "subject_to_object"
    assert rows[0]["natural_statement"] == "谓词逻辑属于离散数学"


def test_triplet_to_statement_subject_to_object():
    t = Triplet(
        subject="苏格拉底/Socrates",
        object="个体常项/individual constant",
        abstract_relation="belong_to",
        concrete_relation="属于",
        statement_direction="subject_to_object",
    )
    assert triplet_to_statement(t) == "苏格拉底属于个体常项"


def test_triplet_to_statement_object_to_subject_with_container_verb():
    t = Triplet(
        subject="原子命题/atomic proposition",
        object="命题逻辑/propositional logic",
        abstract_relation="part_of",
        concrete_relation="包含",
        statement_direction="object_to_subject",
    )
    assert triplet_to_statement(t) == "命题逻辑包含原子命题"


def test_triplet_to_statement_depend_on_ellipsis():
    t = Triplet(
        subject="谓词逻辑/predicate logic",
        object="命题逻辑/propositional logic",
        abstract_relation="depend_on",
        concrete_relation="是...的基础",
        statement_direction="object_to_subject",
    )
    assert triplet_to_statement(t) == "命题逻辑是谓词逻辑的基础"


def test_triplet_to_statement_part_of_ellipsis():
    t = Triplet(
        subject="原子命题/atomic proposition",
        object="命题逻辑/propositional logic",
        abstract_relation="part_of",
        concrete_relation="是...的最小单元",
        statement_direction="subject_to_object",
    )
    assert triplet_to_statement(t) == "原子命题是命题逻辑的最小单元"


def test_triplet_to_statement_depend_on_legacy_base():
    t = Triplet(
        subject="谓词逻辑/predicate logic",
        object="命题逻辑/propositional logic",
        abstract_relation="depend_on",
        concrete_relation="是基础",
        statement_direction="object_to_subject",
    )
    assert triplet_to_statement(t) == "命题逻辑是谓词逻辑的基础"


def test_triplet_to_statement_property_of_object_first():
    t = Triplet(
        subject="非真即假/either true or false",
        object="命题/proposition",
        abstract_relation="property_of",
        concrete_relation="具有",
        statement_direction="object_to_subject",
    )
    assert triplet_to_statement(t) == "命题具有非真即假"


def test_triplet_infers_direction_when_missing():
    t = Triplet(
        subject="非真即假/either true or false",
        object="命题/proposition",
        abstract_relation="property_of",
        concrete_relation="具有",
    )
    assert t.statement_direction == "object_to_subject"
    assert triplet_to_statement(t) == "命题具有非真即假"


def test_parse_validation_response_three_verdicts():
    raw = """{
  "results": [
    {"index": 0, "verdict": "pass"},
    {"index": 1, "verdict": "revise", "action": "fix", "reason": "关系类型错误", "suggestion": "改为synonym_of"},
    {"index": 2, "verdict": "discard", "reason": "context不支持"}
  ]
}"""
    verdicts = parse_validation_response(raw, 3)
    assert verdicts[0].verdict == VALIDATION_VERDICT_PASS
    assert verdicts[1].verdict == VALIDATION_VERDICT_REVISE
    assert verdicts[1].action == REVISE_ACTION_FIX
    assert verdicts[1].suggestion == "改为synonym_of"
    assert verdicts[2].verdict == VALIDATION_VERDICT_DISCARD


def test_parse_validation_response_legacy_pass_field():
    raw = """{
  "results": [
    {"index": 0, "pass": true},
    {"index": 1, "pass": false, "reason": "bad"}
  ]
}"""
    verdicts = parse_validation_response(raw, 2)
    assert verdicts[0].verdict == VALIDATION_VERDICT_PASS
    assert verdicts[1].verdict == VALIDATION_VERDICT_DISCARD
    assert verdicts[1].reason == "bad"


def test_split_validation_verdicts():
    trips = [
        Triplet("A", "B", abstract_relation="belong_to", concrete_relation="属于", statement_direction="subject_to_object"),
        Triplet("C", "D", abstract_relation="part_of", concrete_relation="组成", statement_direction="subject_to_object"),
        Triplet("E", "F", abstract_relation="synonym_of", concrete_relation="即", statement_direction="subject_to_object"),
    ]
    from teachkg.stage1_alignment.triplet_extract import ValidationVerdict

    verdicts = {
        0: ValidationVerdict(verdict=VALIDATION_VERDICT_PASS),
        1: ValidationVerdict(verdict=VALIDATION_VERDICT_REVISE, action=REVISE_ACTION_FIX, reason="fix me"),
        2: ValidationVerdict(verdict=VALIDATION_VERDICT_DISCARD, reason="drop"),
    }
    result = _split_validation_verdicts(trips, verdicts)
    assert len(result.passed) == 1
    assert len(result.revise) == 1
    assert len(result.discarded) == 1
    assert result.counts == {"pass": 1, "revise": 1, "discard": 1}


def test_build_revision_feedback():
    trip = Triplet(
        subject="谓词/predicate",
        object="个体/individual",
        abstract_relation="related_with",
        concrete_relation="描述",
        statement_direction="subject_to_object",
    )
    from teachkg.stage1_alignment.triplet_extract import ValidationVerdict

    revise = [
        ValidatedTriplet(
            triplet=trip,
            verdict=ValidationVerdict(
                verdict=VALIDATION_VERDICT_REVISE,
                action=REVISE_ACTION_FIX,
                reason="应为property_of",
                suggestion="调换主客体",
            ),
        )
    ]
    text = build_revision_feedback(revise, [])
    assert "谓词" in text
    assert "应为property_of" in text


def test_triplet_extractor_defaults_single_reextract_prompt():
    extractor = TripletExtractor(mock=True)
    assert extractor.reextract_prompt == "teaching/triplet_reextract.txt"


def test_rule_validate_fallback_matches_structural():
    good = Triplet(
        subject="谓词逻辑/predicate logic",
        object="命题逻辑/propositional logic",
        abstract_relation="depend_on",
        concrete_relation="是...的基础",
        statement_direction="object_to_subject",
        context="命题逻辑是谓词逻辑的基础",
    )
    assert rule_validate_triplet_semantics(good, "命题逻辑是谓词逻辑的基础") is None


def test_triplet_validator_mock_validate_batch_structural():
    good = Triplet(
        subject="命题/proposition",
        object="陈述句/declarative sentence",
        abstract_relation="belong_to",
        concrete_relation="属于",
        statement_direction="subject_to_object",
        context="命题是一个非真即假的陈述句。",
    )
    bad = Triplet(
        subject="P(x)/P(x)",
        object="命题形式/propositional form",
        abstract_relation="synonym_of",
        concrete_relation="是",
        statement_direction="subject_to_object",
        context="P(x)是命题形式",
    )
    validator = TripletValidator(mock=True)
    result = validator.validate_batch([good, bad], "命题是一个非真即假的陈述句。P(x)是命题形式")
    assert len(result.passed) == 1
    assert len(result.discarded) == 1


def test_triplet_validator_mock_validate_single():
    good = Triplet(
        subject="命题/proposition",
        object="陈述句/declarative sentence",
        abstract_relation="belong_to",
        concrete_relation="属于",
        statement_direction="subject_to_object",
        context="命题是一个非真即假的陈述句。",
    )
    validator = TripletValidator(mock=True)
    assert len(validator.validate_single(good, "命题是一个非真即假的陈述句。").passed) == 1
    bad = Triplet(
        subject="P(x)/P(x)",
        object="命题形式/propositional form",
        abstract_relation="synonym_of",
        concrete_relation="是",
        statement_direction="subject_to_object",
        context="P(x)是命题形式",
    )
    single = validator.validate_single(bad, "P(x)是命题形式")
    assert not single.passed
    assert single.discarded[0].verdict.reason == "bad_entity"


def test_validate_compat_routes_single_vs_batch():
    validator = TripletValidator(mock=True)
    t = Triplet(
        "命题/proposition",
        "陈述句/declarative sentence",
        abstract_relation="belong_to",
        concrete_relation="属于",
        statement_direction="subject_to_object",
        context="命题是陈述句",
    )
    assert len(validator.validate([t], "命题是陈述句").passed) == 1
    assert len(validator.validate([t, t], "命题是陈述句").passed) == 2


def test_format_prompt_handles_braces_in_values(tmp_path, monkeypatch):
    from teachkg.utils import prompts

    prompt_file = tmp_path / "test.txt"
    prompt_file.write_text("ASR:\n{asr_text}\nJSON:\n{triplets_json}\n示例: {{\"ok\": true}}", encoding="utf-8")
    monkeypatch.setattr(prompts, "PROMPT_DIR", tmp_path)
    out = prompts.format_prompt(
        "test.txt",
        asr_text="映射 P: D → {T,F}",
        triplets_json='{"x": "{T,F}"}',
    )
    assert "映射 P: D → {T,F}" in out
    assert '{"x": "{T,F}"}' in out
    assert '示例: {"ok": true}' in out
