from teachkg.utils.prompts import load_prompt, resolve_prompt_name


def test_resolve_legacy_teaching_alias():
    assert resolve_prompt_name("teaching/subgraph_extract.txt") == "stage1/subgraph_extract.txt"
    assert resolve_prompt_name("asr_correct.txt") == "stage0/asr_correct.txt"


def test_load_prompt_by_stage_path():
    text = load_prompt("stage0/asr_correct.txt")
    assert "ASR" in text or "校对" in text


def test_load_prompt_via_legacy_alias():
    text = load_prompt("teaching/cue_text_preprocess.txt")
    assert "知识" in text or "过滤" in text
