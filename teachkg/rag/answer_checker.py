"""RAG 答案校验：判断回答是否被检索证据支撑。"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from teachkg.utils.llm_client import LLMClient
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)

_VALID_VERDICTS = {"supported", "partial", "unsupported"}


def extract_evidence_citations(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """从检索命中提取可引用证据（cue / PPT 页 / 视频片段）。"""
    citations: list[dict[str, Any]] = []
    seen: set[str] = set()
    for hit in hits:
        payload = hit.get("payload") or {}
        grounding = payload.get("grounding") or {}
        cite: dict[str, Any] = {"hit_id": hit.get("id"), "type": hit.get("type")}
        if hit.get("type") == "edge":
            cite["statement"] = payload.get("natural_statement", "")
        if grounding.get("cue_id"):
            cite["cue_id"] = grounding["cue_id"]
        if grounding.get("lecture_id") is not None:
            cite["lecture_id"] = grounding["lecture_id"]
        if hit.get("lecture_id") is not None and cite.get("lecture_id") is None:
            cite["lecture_id"] = hit.get("lecture_id")
        if hit.get("type") == "edge" and not cite.get("cue_id"):
            for prov in payload.get("provenance") or []:
                if prov.get("cue_id"):
                    cite["cue_id"] = prov.get("cue_id")
                if prov.get("lecture_id") is not None:
                    cite["lecture_id"] = prov.get("lecture_id")
                if prov.get("ppt_page_index") is not None and "ppt_page" not in cite:
                    cite["ppt_page"] = prov.get("ppt_page_index")
                if prov.get("start_sec") is not None and prov.get("end_sec") is not None:
                    cite["time_range"] = [prov.get("start_sec"), prov.get("end_sec")]
                break
        if grounding.get("ppt_page_index") is not None:
            cite["ppt_page"] = grounding["ppt_page_index"]
        if grounding.get("clip_path"):
            cite["clip_path"] = grounding["clip_path"]
            cite["time_range"] = [grounding.get("start_sec"), grounding.get("end_sec")]
        key = json.dumps(cite, sort_keys=True, ensure_ascii=False)
        if key not in seen:
            seen.add(key)
            citations.append(cite)
    return citations


def format_citations_text(citations: list[dict[str, Any]], *, max_items: int = 3) -> str:
    """格式化引用脚注（含讲次 / cue / 视频时间戳 / PPT 页）。"""
    if not citations:
        return ""
    lines: list[str] = []
    for i, c in enumerate(citations[:max_items], 1):
        parts: list[str] = []
        if c.get("lecture_id") is not None:
            parts.append(f"第{c['lecture_id']}讲")
        if c.get("cue_id"):
            parts.append(str(c["cue_id"]))
        tr = c.get("time_range")
        if tr and tr[0] is not None and tr[1] is not None:
            parts.append(f"视频 {tr[0]}s–{tr[1]}s")
        if c.get("ppt_page") is not None:
            parts.append(f"PPT p.{c['ppt_page']}")
        if parts:
            lines.append(f"{i}. " + " · ".join(parts))
    if not lines:
        return ""
    return "【来源】\n" + "\n".join(lines)


def _parse_check_json(raw: str) -> dict[str, Any]:
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
    verdict = str(data.get("verdict", "partial")).lower()
    if verdict not in _VALID_VERDICTS:
        verdict = "partial"
    return {
        "verdict": verdict,
        "confidence": float(data.get("confidence", 0.5)),
        "supported_claims": list(data.get("supported_claims") or []),
        "unsupported_claims": list(data.get("unsupported_claims") or []),
        "reason": str(data.get("reason", "")),
    }


def check_answer(
    *,
    question: str,
    answer: str,
    retrieved_context: str,
    llm_client: LLMClient,
    mock: bool = False,
) -> dict[str, Any]:
    """校验回答与检索证据的一致性。"""
    if mock:
        return {
            "verdict": "supported",
            "confidence": 1.0,
            "supported_claims": [answer[:80]] if answer else [],
            "unsupported_claims": [],
            "reason": "[mock] 跳过 LLM 校验",
        }

    if not retrieved_context.strip():
        return {
            "verdict": "unsupported",
            "confidence": 0.9,
            "supported_claims": [],
            "unsupported_claims": ["无检索上下文"],
            "reason": "检索结果为空，无法支撑任何回答",
        }

    prompt = format_prompt(
        "teaching/rag_answer_check.txt",
        question=question,
        answer=answer,
        retrieved_context=retrieved_context,
    )
    raw = llm_client.chat(prompt, temperature=0.0)
    try:
        return _parse_check_json(raw)
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        logger.warning("Answer check JSON parse failed: %s", exc)
        return {
            "verdict": "partial",
            "confidence": 0.3,
            "supported_claims": [],
            "unsupported_claims": [],
            "reason": f"校验解析失败: {exc}",
            "raw": raw[:500],
        }
