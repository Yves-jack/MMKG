"""校对后去掉上一段结尾重复的单测。"""

from __future__ import annotations

from teachkg.stage0_segmentation.multimodal_correct import strip_prev_ending_overlap


def test_strip_sentence_overlap():
    prev = "因此全称肯定命题A的标准翻译应为：任意的x，S(x)蕴含P(x)。"
    cur = (
        "因此全称肯定命题A的标准翻译应为：任意的x，S(x)蕴含P(x)。"
        "在后续翻译过程中，全称量词通常与蕴含配对使用。"
    )
    cleaned, stripped = strip_prev_ending_overlap(cur, prev)
    assert "后续翻译" in cleaned
    assert "标准翻译" in stripped
    assert cleaned.startswith("在后续")


def test_strip_with_whitespace_diff():
    prev = "所有S都是P。"
    cur = "所有 S 都是 P。 第一种是特称肯定命题。"
    cleaned, stripped = strip_prev_ending_overlap(cur, prev, min_chars=4)
    assert "特称肯定" in cleaned
    assert "所有" in stripped


def test_no_overlap_keeps_text():
    prev = "上一段讲了合取。"
    cur = "接下来介绍析取联结词。"
    cleaned, stripped = strip_prev_ending_overlap(cur, prev)
    assert cleaned == cur
    assert stripped == ""


def test_full_duplicate_not_emptied():
    prev = "很容易证明。"
    cur = "很容易证明。"
    cleaned, stripped = strip_prev_ending_overlap(cur, prev, min_chars=4)
    assert cleaned == cur
    assert stripped == ""


def test_empty_prev():
    cleaned, stripped = strip_prev_ending_overlap("本段内容。", "（无）")
    assert cleaned == "本段内容。"
    assert stripped == ""
