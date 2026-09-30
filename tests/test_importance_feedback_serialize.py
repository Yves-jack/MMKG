"""classroom_norm 缺省语义：无课堂证据不写 0。"""

from __future__ import annotations

from teachkg.textbook_kg.importance_feedback import ImportanceFeedbackResult


def _result_with_mixed_classroom() -> ImportanceFeedbackResult:
    return ImportanceFeedbackResult(
        scores={"有信号/A": 0.8, "仅先验/B": 0.5},
        base_norm={"有信号/A": 0.4, "仅先验/B": 0.7},
        classroom_norm={"有信号/A": 0.9, "仅先验/B": 0.0},
        classroom_raw={"有信号/A": 1.2},
        alpha=0.45,
        contributions={
            "有信号/A": {"prior": 0.2, "mention_time": 0.3},
            "仅先验/B": {"prior": 0.5, "mention_time": 0.0},
        },
    )


def test_entity_records_omits_missing_classroom_norm():
    recs = _result_with_mixed_classroom().entity_records()
    assert "classroom_norm" in recs["有信号/A"]
    assert recs["有信号/A"]["classroom_norm"] == 0.9
    assert "classroom_norm" not in recs["仅先验/B"]


def test_to_dict_omits_missing_classroom_norm():
    d = _result_with_mixed_classroom().to_dict()
    assert d["entities"]["有信号/A"]["classroom_norm"] == 0.9
    assert "classroom_norm" not in d["entities"]["仅先验/B"]
    top_by_name = {row["name"]: row for row in d["top"]}
    assert top_by_name["有信号/A"]["classroom_norm"] == 0.9
    assert "classroom_norm" not in top_by_name["仅先验/B"]
    assert "classroom_raw" not in top_by_name["仅先验/B"]


def test_classroom_map_only_positives():
    m = _result_with_mixed_classroom().classroom_map()
    assert m == {"有信号/A": 0.9}
