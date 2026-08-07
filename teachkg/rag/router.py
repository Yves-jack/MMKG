"""模态感知路由：决定检索通道与是否启用视觉生成。"""

from __future__ import annotations

from teachkg.rag.query_media import MediaBundle
from teachkg.rag.types import RoutePlan


def plan_route(
    question: str,
    media: MediaBundle | None,
    *,
    multimodal_enabled: bool = True,
    vision_for_answer: bool = True,
    attach_hit_images: bool = True,
    boost_grounded_hits: bool = True,
) -> RoutePlan:
    """根据问题与附件选择通道，避免盲目全模态扫描。

    当前库侧仍以文本+图谱索引为主；路由控制：
    - 是否解析用户媒体增强 query
    - 是否对带 PPT/视频 grounding 的命中加权
    - 是否把证据图 + 用户图交给视觉模型作答
    """
    has_media = bool(media and media.has_media)
    has_images = bool(media and media.image_paths)
    q = (question or "").strip()

    # 显式视觉意图（板书/截图/PPT/视频）
    visual_cues = any(
        k in q
        for k in (
            "图片",
            "这张",
            "截图",
            "板书",
            "PPT",
            "ppt",
            "幻灯",
            "视频",
            "画面",
            "图中",
            "看图",
        )
    )

    plan = RoutePlan(
        channels=["text_hybrid", "graph_expand"],
        parse_user_media=multimodal_enabled and has_media,
        boost_grounded_hits=boost_grounded_hits,
        attach_hit_images=False,
        use_vision_answer=False,
        reason="text-only",
    )

    if not multimodal_enabled:
        plan.reason = "multimodal_disabled"
        return plan

    if has_media or visual_cues:
        plan.attach_hit_images = attach_hit_images
        plan.use_vision_answer = vision_for_answer and (has_images or attach_hit_images)
        plan.channels = ["media_augmented_text", "text_hybrid", "graph_expand"]
        plan.reason = "user_media" if has_media else "visual_language_cue"
        return plan

    # 默认：文本混合检索；仍可对 grounding 命中轻量加权，生成走文本 LLM
    plan.reason = "default_text_hybrid"
    return plan
