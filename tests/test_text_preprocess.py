from teachkg.stage1_alignment.text_preprocess import (
    CueTextPreprocessor,
    default_light_rule_options,
    remove_classroom_admin,
    remove_example_label_lines,
    remove_intro_framing,
    remove_non_knowledge,
    rule_preprocess_cue_text,
    sentence_knowledge_score,
)


SAMPLE_CUE = """上课。由于两个班级合并上课，我们换到了更大的教室。本学期离散数学课程将在这里进行。

命题逻辑是谓词逻辑的基础，其最小单元是不可再分的原子命题，即非真即假的陈述句。例如：
- P：今天是周二
- Q：今天有离散课

谓词逻辑将原子命题进一步划分为个体和谓词。"""


def test_remove_classroom_admin():
    out = remove_classroom_admin(SAMPLE_CUE)
    assert "换到了更大的教室" not in out
    assert "命题逻辑是谓词逻辑的基础" in out


def test_remove_classroom_admin_keeps_knowledge_in_same_paragraph():
    text = "谓词逻辑能够表达更丰富的语义。今天我们要介绍的就是谓词逻辑。谓词逻辑将简单命题进一步细分为主语和谓语两部分。"
    out = remove_classroom_admin(text)
    assert "今天我们要介绍" not in out
    assert "细分为主语和谓语" in out


def test_remove_intro_framing_drops_pure_intro():
    text = (
        "今天我们来介绍谓词逻辑。"
        "先给大家一个整体印象。"
        "谓词逻辑将命题细分为主语和谓语。"
        "为什么要学这个呢？"
    )
    out = remove_intro_framing(text)
    assert "今天我们来介绍" not in out
    assert "整体印象" not in out
    assert "为什么要学" not in out
    assert "细分为主语和谓语" in out


def test_remove_intro_framing_keeps_intro_with_definition():
    text = "今天我们来介绍合取：合取定义为两个命题同时为真时才为真。"
    out = remove_intro_framing(text)
    assert "合取定义为" in out


def test_remove_example_labels():
    out = remove_example_label_lines(SAMPLE_CUE)
    assert "P：今天是周二" not in out
    assert "Q：今天有离散课" not in out
    assert "命题逻辑" in out


def test_rule_preprocess_cue_text():
    out = rule_preprocess_cue_text(SAMPLE_CUE)
    assert "上课" not in out
    assert "P：今天是周二" not in out
    assert "命题逻辑是谓词逻辑的基础" in out
    assert "谓词逻辑将原子命题" in out


def test_rule_preprocess_removes_intro_with_examples():
    text = (
        "本节课主要内容是命题逻辑。\n\n"
        "今天我们来学习原子命题。例如：\n"
        "- P：今天是周二\n\n"
        "原子命题是不可再分的、非真即假的陈述句。"
    )
    out = rule_preprocess_cue_text(
        text,
        options={
            "remove_markdown_noise": True,
            "remove_classroom_admin": True,
            "remove_intro_framing": True,
            "remove_non_knowledge": False,
            "remove_example_labels": True,
            "dedupe_paragraphs": True,
        },
    )
    assert "本节课主要内容" not in out
    assert "今天我们来学习" not in out
    assert "P：今天是周二" not in out
    assert "不可再分" in out


def test_preprocessor_disabled_returns_raw():
    p = CueTextPreprocessor(enabled=False)
    assert p.process(SAMPLE_CUE) == SAMPLE_CUE.strip()


def test_preprocessor_mock_two_pass_uses_rules_only():
    p = CueTextPreprocessor(
        enabled=True,
        llm_enabled=True,
        llm_two_pass=True,
        focus_pass=False,
        mock=True,
        rule_options={
            "remove_markdown_noise": True,
            "remove_classroom_admin": True,
            "remove_intro_framing": False,
            "remove_non_knowledge": False,
            "remove_example_labels": True,
            "dedupe_paragraphs": True,
        },
    )
    out = p.process(SAMPLE_CUE, "离散数学")
    assert "P：今天是周二" not in out
    assert "命题逻辑" in out
    dbg = p.process_debug(SAMPLE_CUE, "离散数学")
    assert dbg["after_fluency"]
    assert dbg["final"]


def test_preprocessor_a_only_sets_final_to_fluency():
    p = CueTextPreprocessor(
        enabled=True,
        llm_enabled=True,
        llm_two_pass=True,
        focus_pass=False,
        focus_lecture_level=False,
        mock=True,
        rule_options=default_light_rule_options(),
    )
    fluent = p.process_pass_a(SAMPLE_CUE, "离散数学")
    final = p.process(SAMPLE_CUE, "离散数学")
    assert fluent == final
    assert "命题逻辑" in final


def test_preprocessor_lecture_focus_mock():
    p = CueTextPreprocessor(
        enabled=True,
        llm_enabled=True,
        llm_two_pass=True,
        focus_pass=True,
        focus_lecture_level=True,
        mock=True,
        rule_options={
            "remove_markdown_noise": True,
            "remove_classroom_admin": True,
            "remove_intro_framing": False,
            "remove_non_knowledge": False,
            "remove_example_labels": True,
            "dedupe_paragraphs": True,
        },
    )
    a = p.process_pass_a(SAMPLE_CUE, "离散数学")
    assert "命题逻辑" in a
    focus = p.process_lecture_focus(
        [("c1", a), ("c2", "图论起源于七桥问题，本段仅作引入。")],
        course_context="离散数学",
        lecture_id="1",
    )
    assert focus.outline
    assert "c1" in focus.cue_texts and "c2" in focus.cue_texts


def test_build_lecture_cues_block():
    from teachkg.stage1_alignment.text_preprocess import build_lecture_cues_block

    block = build_lecture_cues_block([("a", "hello"), ("b", "")])
    assert "<<<CUE id=a>>>" in block
    assert "<<<CUE id=b>>>" in block
    assert "（空）" in block


def test_preprocessor_mock_llm_uses_rules_only():
    p = CueTextPreprocessor(enabled=True, llm_enabled=True, mock=True)
    out = p.process(SAMPLE_CUE, "数理逻辑")
    assert "P：今天是周二" not in out
    assert "命题逻辑" in out


def test_knowledge_score_prefers_exposition_over_chatter():
    knowledge = "谓词逻辑将命题细分为主语和谓语，论域是个体变项的变化范围。"
    chatter = "大家先准备好手机，签到一下，休息五分钟再开始。"
    assert sentence_knowledge_score(knowledge) > sentence_knowledge_score(chatter)
    assert sentence_knowledge_score(knowledge) >= 1.0
    assert sentence_knowledge_score(chatter) < 1.0


def test_remove_non_knowledge_keeps_teaching_drops_interaction():
    text = (
        "大家先到齐了吗？谁还没来？我们稍等一下。"
        "集合的并运算定义为取同时属于任一集合的元素。"
        "好的，课件打开了吧？"
    )
    out = remove_non_knowledge(text)
    assert "集合的并运算定义为" in out
    assert "谁还没来" not in out
    assert "课件打开了吧" not in out


def test_rule_preprocess_drops_low_knowledge_only_cue():
    text = "大家稍等一下。谁带电脑了？我们休息五分钟再开始。"
    out = rule_preprocess_cue_text(text)
    assert out == ""
