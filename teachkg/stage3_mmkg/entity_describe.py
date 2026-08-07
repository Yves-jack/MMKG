"""Stage 4：LLM 实体描述生成（参考 AutoEduKG entity_define）。"""

from __future__ import annotations

import logging
from typing import Any

from teachkg.utils.llm_client import LLMClient, LLMClient as LLMClientType
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)


def _collect_entity_contexts(
    entity_id: str,
    triplets: list[dict[str, Any]],
    *,
    max_chars: int = 2000,
) -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for row in triplets:
        sub = str(row.get("subject", "")).strip()
        obj = str(row.get("object", "")).strip()
        if entity_id not in {sub, obj}:
            continue
        ctx = str(row.get("context", "")).strip()
        if not ctx or ctx in seen:
            continue
        seen.add(ctx)
        parts.append(f"- {ctx}")
    text = "\n".join(parts)
    if len(text) > max_chars:
        text = text[: max_chars - 3] + "..."
    return text or "（无上下文）"


def describe_entity(
    entity_id: str,
    contexts: str,
    course_context: str,
    llm_client: LLMClientType,
    *,
    mock: bool = False,
) -> str:
    if mock:
        return f"{entity_id.split('/')[0]}是{course_context or '本课程'}中的重要概念。"

    prompt = format_prompt(
        "stage3/entity_define.txt",
        course_context=course_context or "（无）",
        entity_name=entity_id,
        contexts=contexts,
    )
    raw = llm_client.chat(prompt, temperature=0.1)
    parsed = LLMClient.parse_json_response(raw)
    definition = str(parsed.get("definition", "")).strip()
    if definition:
        return definition
    return raw.strip()[:500]


def enrich_entity_descriptions(
    mmkg: dict[str, Any],
    triplets: list[dict[str, Any]],
    *,
    course_context: str = "",
    llm_client: LLMClientType | None = None,
    mock: bool = False,
) -> dict[str, Any]:
    if llm_client is None and not mock:
        llm_client = LLMClient()

    entities_out: list[dict[str, Any]] = []
    described = 0
    for ent in mmkg.get("entities") or []:
        entity_id = ent.get("id") or ent.get("name", "")
        item = dict(ent)
        if item.get("description"):
            entities_out.append(item)
            continue
        contexts = _collect_entity_contexts(entity_id, triplets)
        try:
            definition = describe_entity(
                entity_id,
                contexts,
                course_context,
                llm_client,  # type: ignore[arg-type]
                mock=mock,
            )
            item["description"] = definition
            item["description_source"] = "llm_entity_define"
            described += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("Entity define failed for %s: %s", entity_id, exc)
            item["description_error"] = str(exc)
        entities_out.append(item)

    stats = dict(mmkg.get("stats") or {})
    stats["entity_descriptions"] = {
        "generated": described,
        "total_entities": len(entities_out),
    }

    out = dict(mmkg)
    out["entities"] = entities_out
    out["stats"] = stats
    return out
