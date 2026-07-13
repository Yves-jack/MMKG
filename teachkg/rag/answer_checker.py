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
_VERDICT_RANK = {"unsupported": 3, "partial": 2, "supported": 1}

_REFUSAL_PATTERNS = re.compile(
    r"依据现有(?:知识)?图谱无法确定|未直接给出|没有直接给出|未提及|未提供|未包含|"
    r"未在(?:检索|知识|片段).*?(?:直接|明确)|片段中未|知识片段中未|"
    r"只能确认.*?但未说明|如需.*?建议|请(?:参考|查阅)",
    re.I,
)
_SUBSTANTIVE_QUESTION = re.compile(
    r"什么是|是什么|怎样的|有什么区别|有什么特点|分别表示|组成要素|含义是什么|"
    r"真值表|如何表示|各起什么作用|辖域|包含关系",
    re.I,
)
_TRUTH_TABLE_QUESTION = re.compile(r"真值表", re.I)
_DEFINITION_QUESTION = re.compile(r"什么是|是什么|含义", re.I)
_TRUTH_TABLE_ANSWER = re.compile(
    r"真[时为].*?假|假[时为].*?真|P\s*为真|为真时|TT|FF|真值表\s*[：:]|"
    r"\\begin\{array\}|行[：:]|两真|两假|一真一假",
    re.I,
)


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
        if grounding.get("context"):
            cite["context"] = str(grounding["context"])[:200]
        if grounding.get("lecture_id") is not None:
            cite["lecture_id"] = grounding["lecture_id"]
        if grounding.get("cue_id"):
            cite["cue_id"] = grounding["cue_id"]
        elif hit.get("type") == "edge":
            for prov in payload.get("provenance") or []:
                if prov.get("cue_id"):
                    cite["cue_id"] = prov.get("cue_id")
                    if prov.get("lecture_id") is not None:
                        cite["lecture_id"] = prov.get("lecture_id")
                    if prov.get("context"):
                        cite["context"] = str(prov["context"])[:200]
                    break
        if grounding.get("lecture_id") is not None and cite.get("lecture_id") is None:
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


def _max_verdict(a: str, b: str) -> str:
    return a if _VERDICT_RANK.get(a, 0) >= _VERDICT_RANK.get(b, 0) else b


def apply_strict_check_rules(
    *,
    question: str,
    answer: str,
    result: dict[str, Any],
    min_confidence: float = 0.75,
) -> dict[str, Any]:
    """规则后处理：在 LLM 校验结果上收紧 verdict。"""
    out = dict(result)
    verdict = str(out.get("verdict", "partial"))
    reason_parts: list[str] = []
    unsupported = list(out.get("unsupported_claims") or [])

    if _REFUSAL_PATTERNS.search(answer):
        if _SUBSTANTIVE_QUESTION.search(question):
            verdict = _max_verdict(verdict, "unsupported")
            unsupported.append("回答含回避式表述且未实质回答问题")
            reason_parts.append("含「无法确定/未直接给出」等回避表述")

    if _TRUTH_TABLE_QUESTION.search(question) and not _TRUTH_TABLE_ANSWER.search(answer):
        verdict = _max_verdict(verdict, "partial")
        unsupported.append("未给出真值表具体行/真假对应")
        reason_parts.append("问真值表但未给出具体真值对应")

    if _DEFINITION_QUESTION.search(question) and _REFUSAL_PATTERNS.search(answer):
        verdict = _max_verdict(verdict, "unsupported")
        reason_parts.append("定义类问题但回答回避")

    if verdict == "supported" and float(out.get("confidence", 1.0)) < min_confidence:
        verdict = "partial"
        reason_parts.append(f"置信度 {out.get('confidence')} 低于阈值 {min_confidence}")

    if reason_parts:
        base_reason = str(out.get("reason", "")).strip()
        suffix = "；".join(reason_parts)
        out["reason"] = f"{base_reason}（严格规则：{suffix}）" if base_reason else f"严格规则：{suffix}"

    out["verdict"] = verdict
    out["unsupported_claims"] = unsupported
    out["strict_applied"] = bool(reason_parts)
    return out


def check_answer(
    *,
    question: str,
    answer: str,
    retrieved_context: str,
    llm_client: LLMClient,
    mock: bool = False,
    strict: bool = False,
    min_confidence: float = 0.75,
) -> dict[str, Any]:
    """校验回答与检索证据的一致性。"""
    if mock:
        result = {
            "verdict": "supported",
            "confidence": 1.0,
            "supported_claims": [answer[:80]] if answer else [],
            "unsupported_claims": [],
            "reason": "[mock] 跳过 LLM 校验",
        }
        if strict:
            result = apply_strict_check_rules(
                question=question, answer=answer, result=result, min_confidence=min_confidence
            )
        return result

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
        result = _parse_check_json(raw)
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        logger.warning("Answer check JSON parse failed: %s", exc)
        result = {
            "verdict": "partial",
            "confidence": 0.3,
            "supported_claims": [],
            "unsupported_claims": [],
            "reason": f"校验解析失败: {exc}",
            "raw": raw[:500],
        }

    if strict:
        result = apply_strict_check_rules(
            question=question, answer=answer, result=result, min_confidence=min_confidence
        )
    return result
