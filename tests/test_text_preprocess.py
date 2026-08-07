from teachkg.stage1_alignment.text_preprocess import (
    CueTextPreprocessor,
    remove_classroom_admin,
    remove_example_label_lines,
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


def test_preprocessor_disabled_returns_raw():
    p = CueTextPreprocessor(enabled=False)
    assert p.process(SAMPLE_CUE) == SAMPLE_CUE.strip()


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
