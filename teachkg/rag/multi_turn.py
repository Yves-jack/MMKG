"""多轮对话：检索 query 改写与历史上下文构建。"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

_PRONOUN = re.compile(r"(它|它们|这个|那个|这些|那些|前者|后者|上述|刚才)")
_FOLLOWUP_HINT = re.compile(
    r"(它|它们|这个|那个|这些|那些|前者|后者|上述|刚才|还有|另外|怎么理解|为何|为什么|区别|对比|异同|联系|关系)",
)
_STANDALONE_PREFIX = re.compile(r"^(什么|何为|何谓|请介绍|请解释|请说明|定义|简述|概述)")
_SHORT_OPENER = re.compile(r"^(那|这|还|另|它)")
_LECTURE_HINT = re.compile(r"(?:第\s*[0-9一二三四五六七八九十]+\s*讲|lecture\s*[0-9]+)", re.I)
_ENTITY_FRAGMENT = re.compile(r"[\u4e00-\u9fff]{2,}(?:/[\w-]+)?")


@dataclass
class ConversationTurn:
    question: str
    answer: str
    retrieval_query: str = ""
    hits: list[dict[str, Any]] | None = None
    retrieval_analysis: dict[str, Any] | None = None


@dataclass
class MultiTurnRetrievalAnalysis:
    """单轮问题的多轮检索决策分析。"""

    use_multi_turn_retrieval: bool
    score: float
    threshold: float
    signals: list[str] = field(default_factory=list)
    reason: str = ""
    original_question: str = ""
    retrieval_query: str = ""
    context_terms: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _extract_topic_terms(text: str, *, max_terms: int = 8) -> list[str]:
    seen: set[str] = set()
    terms: list[str] = []
    for m in _ENTITY_FRAGMENT.finditer(text):
        term = m.group(0).split("/")[0].strip()
        if len(term) < 2 or term in seen:
            continue
        seen.add(term)
        terms.append(term)
        if len(terms) >= max_terms:
            break
    return terms


def _term_overlap(a: list[str], b: list[str]) -> list[str]:
    sb = set(b)
    return [t for t in a if t in sb]


def analyze_multi_turn_retrieval(
    question: str,
    history: list[tuple[str, str]] | list[ConversationTurn],
    *,
    max_context_turns: int = 2,
    score_threshold: float = 2.0,
) -> MultiTurnRetrievalAnalysis:
    """
    分析当前问题是否应启用多轮检索改写。

    基于可解释信号打分，而非单一正则。
    """
    q = question.strip()
    analysis = MultiTurnRetrievalAnalysis(
        use_multi_turn_retrieval=False,
        score=0.0,
        threshold=score_threshold,
        original_question=q,
        retrieval_query=q,
    )

    if not q:
        analysis.reason = "问题为空"
        analysis.signals.append("empty_question")
        return analysis

    if not history:
        analysis.reason = "无对话历史，使用单轮检索"
        analysis.signals.append("no_history")
        return analysis

    turns: list[tuple[str, str]] = []
    for item in history[-max_context_turns:]:
        if isinstance(item, ConversationTurn):
            turns.append((item.question, item.answer))
        else:
            turns.append(item)

    last_q, last_a = turns[-1]
    score = 0.0
    signals: list[str] = []

    current_terms = _extract_topic_terms(q)
    last_terms = _extract_topic_terms(f"{last_q} {last_a[:400]}")
    overlap = _term_overlap(current_terms, last_terms)

    if _STANDALONE_PREFIX.search(q):
        score -= 3.0
        signals.append("standalone_definition_question")

    if _PRONOUN.search(q):
        score += 3.0
        signals.append("contains_pronoun_or_reference")

    if _SHORT_OPENER.search(q) and len(q) <= 20:
        score += 2.0
        signals.append("short_followup_opener")

    if _FOLLOWUP_HINT.search(q) and not _STANDALONE_PREFIX.search(q):
        score += 1.0
        signals.append("followup_intent_keywords")

    if len(current_terms) >= 2 and not _PRONOUN.search(q):
        score -= 2.0
        signals.append("self_contained_explicit_entities")

    if current_terms and last_terms and not overlap and not _PRONOUN.search(q):
        if "short_followup_opener" not in signals:
            score -= 2.0
            signals.append("topic_shift_no_overlap")

    if _LECTURE_HINT.search(q) and not _PRONOUN.search(q):
        score -= 1.5
        signals.append("explicit_lecture_scope")

    if len(q) <= 10 and not _STANDALONE_PREFIX.search(q):
        score += 1.0
        signals.append("very_short_utterance")

    use = score >= score_threshold
    analysis.score = round(score, 2)
    analysis.signals = signals

    if not use:
        if "standalone_definition_question" in signals:
            analysis.reason = "独立定义型问句，当前问题已含完整检索意图"
        elif "self_contained_explicit_entities" in signals:
            analysis.reason = "问题已包含明确实体/概念，无需拼接历史"
        elif "topic_shift_no_overlap" in signals:
            analysis.reason = "话题已切换且无语义指代，按新问题检索"
        elif "explicit_lecture_scope" in signals:
            analysis.reason = "问题已指定讲次范围，按单轮检索"
        elif "no_history" in signals:
            analysis.reason = "无对话历史"
        else:
            analysis.reason = f"多轮信号不足（score={analysis.score:.1f} < {score_threshold}）"
        return analysis

    context_terms = _extract_topic_terms(last_q) or _extract_topic_terms(last_a[:300])
    if overlap:
        context_terms = list(dict.fromkeys(overlap + context_terms))[:6]

    parts = [last_q, q]
    if context_terms:
        parts.append(" ".join(context_terms))

    analysis.use_multi_turn_retrieval = True
    analysis.context_terms = context_terms
    analysis.retrieval_query = " ".join(p for p in parts if p).strip()

    if "contains_pronoun_or_reference" in signals:
        analysis.reason = "含指代词/回指，需结合上一轮上下文检索"
    elif "short_followup_opener" in signals:
        analysis.reason = "短追问（那/还/它…），需延续上一轮主题"
    elif overlap:
        analysis.reason = f"与上轮主题重叠（{', '.join(overlap[:3])}），启用多轮检索"
    else:
        analysis.reason = "追问信号充分，拼接历史 query 检索"

    return analysis


def is_followup_question(question: str) -> bool:
    """兼容旧接口：是否可能为追问。"""
    return bool(_PRONOUN.search(question.strip()) or _SHORT_OPENER.search(question.strip()))


def build_retrieval_query(
    question: str,
    history: list[tuple[str, str]] | list[ConversationTurn],
    *,
    max_context_turns: int = 2,
    always_include_last_question: bool = False,
    score_threshold: float = 2.0,
) -> tuple[str, dict[str, Any]]:
    """将多轮历史融入检索 query，返回 (retrieval_query, meta)。"""
    if always_include_last_question and history:
        analysis = analyze_multi_turn_retrieval(
            question, history, max_context_turns=max_context_turns, score_threshold=-999
        )
        analysis.use_multi_turn_retrieval = True
        if not analysis.retrieval_query or analysis.retrieval_query == question.strip():
            turns = [
                (item.question, item.answer) if isinstance(item, ConversationTurn) else item
                for item in history[-max_context_turns:]
            ]
            last_q = turns[-1][0]
            analysis.retrieval_query = f"{last_q} {question.strip()}".strip()
        analysis.reason = "强制拼接上一轮问题"
        analysis.signals.append("forced_rewrite")
    else:
        analysis = analyze_multi_turn_retrieval(
            question, history, max_context_turns=max_context_turns, score_threshold=score_threshold
        )

    meta = analysis.to_dict()
    meta["rewritten"] = analysis.use_multi_turn_retrieval
    if analysis.use_multi_turn_retrieval:
        meta["retrieval_query"] = analysis.retrieval_query
    return analysis.retrieval_query, meta


def format_conversation_history(
    history: list[tuple[str, str]] | list[ConversationTurn],
    *,
    max_turns: int = 4,
) -> str:
    if not history:
        return ""
    lines: list[str] = []
    for item in history[-max_turns:]:
        if isinstance(item, ConversationTurn):
            q, a = item.question, item.answer
        else:
            q, a = item
        lines.append(f"用户：{q}\n助手：{a}")
    return "\n\n".join(lines)


def format_retrieval_analysis(analysis: dict[str, Any] | MultiTurnRetrievalAnalysis) -> str:
    """格式化多轮检索决策，便于日志/UI 展示。"""
    data = analysis.to_dict() if isinstance(analysis, MultiTurnRetrievalAnalysis) else analysis
    if not data:
        return ""
    mode = "多轮检索" if data.get("use_multi_turn_retrieval") or data.get("rewritten") else "单轮检索"
    lines = [f"[检索模式] {mode} — {data.get('reason', '')}"]
    if data.get("use_multi_turn_retrieval") or data.get("rewritten"):
        lines.append(f"[检索 query] {data.get('retrieval_query', '')}")
    score = data.get("score")
    if score is not None and data.get("signals"):
        lines.append(f"[信号] score={score}, {', '.join(data['signals'])}")
    return "\n".join(lines)
