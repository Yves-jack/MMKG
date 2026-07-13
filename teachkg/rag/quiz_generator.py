"""基于 MMKG 上下文生成练习题。"""

from __future__ import annotations

import json
import re
from typing import Any

from teachkg.utils.llm_client import LLMClient
from teachkg.utils.prompts import format_prompt


def build_quiz_context(mmkg: dict[str, Any], *, max_edges: int = 20) -> str:
    lines: list[str] = []
    for edge in (mmkg.get("edges") or [])[:max_edges]:
        stmt = edge.get("natural_statement") or f"{edge.get('subject')} {edge.get('abstract_relation')} {edge.get('object')}"
        lines.append(f"- {stmt}")
    return "\n".join(lines)


def _parse_quiz_json(raw: str) -> dict[str, Any]:
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            data = json.loads(text[start : end + 1])
        else:
            raise
    if not isinstance(data.get("questions"), list):
        data["questions"] = []
    return data


def generate_quiz(
    mmkg: dict[str, Any],
    *,
    n_questions: int = 5,
    lecture_id: int | str | None = None,
    llm_client: LLMClient | None = None,
    mock: bool = False,
) -> dict[str, Any]:
    context = build_quiz_context(mmkg)
    prompt = format_prompt(
        "teaching/quiz_generate.txt",
        n_questions=str(n_questions),
        context=context,
        lecture_id=str(lecture_id or "all"),
    )
    if mock:
        return {"questions": [{"type": "mock", "stem": "示例题", "answer": "A"}]}
    client = llm_client or LLMClient()
    raw = client.chat(prompt, temperature=0.4)
    try:
        return _parse_quiz_json(raw)
    except (json.JSONDecodeError, ValueError, TypeError):
        return {"raw": raw, "questions": []}
