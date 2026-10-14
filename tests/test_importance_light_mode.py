"""轻量课堂分 mode=light：mention+structure + 跨讲 IDF（无板书）。"""

from __future__ import annotations

import math

from teachkg.textbook_kg.importance_feedback import compute_importance_feedback
from teachkg.textbook_kg.importance_signals import (
    compose_fragment_light_score,
    default_channel_weights_light,
)


def test_default_channel_weights_light():
    w = default_channel_weights_light()
    assert abs(w["mention_time"] - 0.75) < 1e-9
    assert abs(w["structure_graph"] - 0.25) < 1e-9
    assert abs(w["board_ppt"] - 0.0) < 1e-9
    assert w["discourse_role"] == 0.0
    assert w["app_feedback"] == 0.0


def test_fragment_light_log1p_composition():
    """log1p 合成：提及 1≈0.52；计数增大则单调上升。"""
    s1, m1, z1 = compose_fragment_light_score(1, 0)
    s11, _, _ = compose_fragment_light_score(1, 1)
    s32, _, _ = compose_fragment_light_score(3, 2)
    assert abs(s1 - 0.75 * math.log1p(1)) < 1e-9
    assert abs(z1) < 1e-12
    assert abs(m1 - s1) < 1e-12
    assert s1 < s11 < s32


def _trip(sub: str, obj: str, lid: str, *, board: bool = False, ctx: str | None = None) -> dict:
    t = {
        "subject": sub,
        "object": obj,
        "relation": "related_with",
        "abstract_relation": "related_with",
        "start_sec": 0,
        "end_sec": 10,
        "cue_id": f"c-{lid}-{sub}-{obj}-{id(ctx)}",
        "lecture_id": lid,
        "context": ctx
        or f"定义：{sub.split('/')[0]}与{obj.split('/')[0]}",
    }
    if board:
        t["evidence_ppt_frame_path"] = f"ppt/{lid}.jpg"
    return t


def test_light_mode_uses_lecture_idf_without_board():
    hub = "公理/axiom"
    rare = "相继式/sequent"
    filler = "填充词/filler"
    other = "真值/truth value"

    lec1 = [
        _trip(filler, other, "1", board=False, ctx="例如填充词与真值"),
        _trip(hub, other, "1", board=True),
        _trip(rare, other, "1", board=True),
        _trip(rare, other, "1", board=True, ctx="定义：相继式再次出现与真值"),
    ]
    lecture_df = {hub: 5, rare: 1, other: 5, filler: 1}
    prior = {hub: 0.9, rare: 0.1, other: 0.5, filler: 0.01}

    with_idf = compute_importance_feedback(
        textbook_importance=prior,
        triplets=lec1,
        mode="light",
        lecture_df=lecture_df,
        n_lectures=5,
        idf_power=1.0,
    )
    no_idf = compute_importance_feedback(
        textbook_importance=prior,
        triplets=lec1,
        mode="light",
        lecture_df=lecture_df,
        n_lectures=1,
        idf_power=1.0,
    )

    assert (with_idf.meta or {}).get("mode") == "light"
    assert (with_idf.meta or {}).get("entity_weight") == "lecture_idf"
    assert abs(float(with_idf.channel_weights.get("board_ppt") or 0)) < 1e-9
    assert abs(float(with_idf.channel_weights.get("mention_time") or 0) - 0.75) < 1e-9
    assert abs(float(with_idf.channel_weights.get("structure_graph") or 0) - 0.25) < 1e-9
    assert hub in with_idf.scores and rare in with_idf.scores
    for name, s in with_idf.scores.items():
        assert abs(s - float(with_idf.classroom_norm.get(name, -1))) < 1e-9
        parts = with_idf.contributions.get(name) or {}
        assert float(parts.get("board_ppt") or 0) == 0.0

    ratio_idf = with_idf.scores[rare] / max(with_idf.scores[hub], 1e-12)
    ratio_plain = no_idf.scores[rare] / max(no_idf.scores[hub], 1e-12)
    assert ratio_idf > ratio_plain
