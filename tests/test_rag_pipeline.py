"""RAG 路由与证据加权单测。"""

from __future__ import annotations

from teachkg.rag.evidence import boost_grounded_hits, format_hit_for_context
from teachkg.rag.query_media import MediaBundle, MediaAttachment
from teachkg.rag.router import plan_route
from pathlib import Path


def test_route_default_text() -> None:
    plan = plan_route("什么是谓词逻辑？", MediaBundle())
    assert "text_hybrid" in plan.channels
    assert plan.use_vision_answer is False
    assert plan.reason == "default_text_hybrid"


def test_route_with_media_and_visual_cue(tmp_path: Path) -> None:
    img = tmp_path / "a.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")
    media = MediaBundle(
        attachments=[MediaAttachment(path=img, kind="image")],
        image_paths=[img],
        retrieval_extra="板书文字",
    )
    plan = plan_route("这张图讲的是什么？", media)
    assert plan.parse_user_media
    assert plan.use_vision_answer
    assert plan.attach_hit_images
    assert plan.reason == "user_media"


def test_boost_grounded_hits_prefers_ppt() -> None:
    hits = [
        {"id": "a", "score": 1.0, "payload": {"grounding": {}}},
        {
            "id": "b",
            "score": 0.9,
            "payload": {
                "grounding": {
                    "ppt_frame_path": "x.jpg",
                    "alignment": {"clip_image_text": 0.4},
                }
            },
        },
    ]
    out = boost_grounded_hits(hits, factor=1.2)
    assert out[0]["id"] == "b"
    assert out[0].get("grounding_boost", 1) > 1


def test_format_hit_still_works() -> None:
    text = format_hit_for_context(
        {
            "type": "edge",
            "score": 0.5,
            "text": "谓词逻辑依赖命题逻辑",
            "payload": {
                "subject": "谓词逻辑",
                "object": "命题逻辑",
                "abstract_relation": "depend_on",
                "grounding": {"cue_id": "c1", "ppt_frame_path": "p.jpg"},
            },
        }
    )
    assert "PPT证据" in text
    assert "谓词逻辑" in text
