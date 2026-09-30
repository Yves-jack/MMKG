"""LLM 边筛选：在规则剪枝后进一步收敛教材子图边，并附着课堂原文依据。"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field, replace
from typing import Any, Sequence

from teachkg.stage1_alignment.knowledge_points import normalize_related_knowledge_points
from teachkg.textbook_kg.loader import TextbookRelation
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)


def _zh(name: str) -> str:
    return name.split("/")[0].strip()


def edge_key(rel: TextbookRelation) -> tuple[str, str, str]:
    return (rel.subject, rel.predicate, rel.object)


def _clip_text(text: str, max_chars: int) -> str:
    s = " ".join((text or "").strip().split())
    if not s:
        return ""
    if len(s) <= max_chars:
        return s
    return s[: max(1, max_chars - 1)].rstrip() + "…"


def _normalize_ws(s: str) -> str:
    return "".join((s or "").split())


def evidence_in_text(evidence: str, source: str) -> bool:
    """依据必须是课堂原文的连续子串（允许空白差异）。"""
    ev = (evidence or "").strip()
    src = (source or "").strip()
    if not ev or not src:
        return False
    if ev in src:
        return True
    return _normalize_ws(ev) in _normalize_ws(src)


def format_candidate_edges(
    relations: Sequence[TextbookRelation],
    *,
    description_max_chars: int = 60,
) -> str:
    """格式化候选边；附带截断后的教材 description 供语义参考。"""
    lines: list[str] = []
    for i, rel in enumerate(relations, start=1):
        line = (
            f"{i}. {rel.subject} —[{rel.predicate}]→ {rel.object}"
            f"  ({_zh(rel.subject)} -{_zh(rel.predicate)}-> {_zh(rel.object)})"
        )
        desc = ""
        if description_max_chars > 0:
            desc = _clip_text(
                getattr(rel, "description", "") or "", description_max_chars
            )
        if desc:
            line += f"\n   描述: {desc}"
        lines.append(line)
    return "\n".join(lines) if lines else "(无候选边)"


def format_expansion_seeds(seeds: set[str]) -> str:
    if not seeds:
        return "(无)"
    return "\n".join(f"- {name}" for name in sorted(seeds))


def _resolve_index(item: Any, candidates: Sequence[TextbookRelation]) -> int | None:
    if isinstance(item, bool):
        return None
    if isinstance(item, int):
        return item if 1 <= item <= len(candidates) else None
    if isinstance(item, float) and item.is_integer():
        idx = int(item)
        return idx if 1 <= idx <= len(candidates) else None
    if isinstance(item, str) and item.strip().isdigit():
        idx = int(item.strip())
        return idx if 1 <= idx <= len(candidates) else None
    return None


def _extract_evidence_from_item(item: Any) -> str:
    if isinstance(item, dict):
        for key in ("evidence", "context", "quote", "span", "basis", "依据"):
            val = item.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        return ""
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        val = item[1]
        return str(val).strip() if val is not None else ""
    return ""


def _extract_related_kps_from_item(item: Any) -> Any:
    if isinstance(item, dict):
        for key in (
            "related_knowledge_points",
            "knowledge_points",
            "kps",
            "related_kps",
            "关联知识点",
        ):
            if key in item:
                return item.get(key)
    return None


def parse_keep_edges(
    raw: str,
    candidates: Sequence[TextbookRelation],
    *,
    extract_text: str = "",
    require_classroom_evidence: bool = False,
    min_evidence_chars: int = 4,
    knowledge_points: Sequence[str] | None = None,
) -> list[TextbookRelation]:
    """解析模型输出，仅返回落在 candidates 中的边（保持原对象或附着依据后的副本）。"""
    text = (raw or "").strip()
    if not text or not candidates:
        return []

    payload: Any = None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                payload = json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                payload = None

    keep_raw: list[Any] = []
    if isinstance(payload, dict):
        keep = payload.get("keep", payload.get("edges", []))
        if isinstance(keep, list):
            keep_raw = keep
        elif isinstance(keep, (int, str, dict)):
            keep_raw = [keep]
    elif isinstance(payload, list):
        keep_raw = payload

    key_to_rel = {edge_key(r): r for r in candidates}
    zh_pred_map: dict[tuple[str, str, str], TextbookRelation] = {}
    for rel in candidates:
        zh_pred_map[(_zh(rel.subject), rel.predicate, _zh(rel.object))] = rel

    line_re = re.compile(
        r"^\s*(?P<idx>\d+)[\.\)]\s*(?P<sub>.+?)\s*[—\-]+\[(?P<pred>[^\]]+)\]\s*[—\->→]+\s*(?P<obj>.+?)\s*$"
    )

    kept: list[TextbookRelation] = []
    seen: set[tuple[str, str, str]] = set()
    dropped_no_evidence = 0
    dropped_bad_evidence = 0
    allowed_kps = list(knowledge_points or [])

    def _attach(
        rel: TextbookRelation | None,
        evidence: str = "",
        related_kps: Any = None,
    ) -> None:
        nonlocal dropped_no_evidence, dropped_bad_evidence
        if rel is None:
            return
        key = edge_key(rel)
        if key in seen:
            return
        ev = (evidence or "").strip()
        kps = normalize_related_knowledge_points(related_kps, allowed_kps or None)
        if require_classroom_evidence:
            if len(ev) < max(1, int(min_evidence_chars)):
                dropped_no_evidence += 1
                return
            if extract_text and not evidence_in_text(ev, extract_text):
                dropped_bad_evidence += 1
                return
            rel = replace(
                rel,
                classroom_evidence=ev,
                context=ev,
                related_knowledge_points=kps,
            )
        elif ev and (not extract_text or evidence_in_text(ev, extract_text)):
            rel = replace(
                rel,
                classroom_evidence=ev,
                context=ev,
                related_knowledge_points=kps,
            )
        elif kps:
            rel = replace(rel, related_knowledge_points=kps)
        seen.add(key)
        kept.append(rel)

    def _rel_from_spo(sub: str, pred: str, obj: str) -> TextbookRelation | None:
        return key_to_rel.get((sub, pred, obj)) or zh_pred_map.get(
            (_zh(sub), pred, _zh(obj))
        )

    for item in keep_raw:
        if isinstance(item, (list, tuple)) and item:
            idx = _resolve_index(item[0], candidates)
            evidence = _extract_evidence_from_item(item)
            related_kps = item[2] if len(item) >= 3 else None
            if idx is not None:
                _attach(candidates[idx - 1], evidence, related_kps)
            continue

        if isinstance(item, dict):
            evidence = _extract_evidence_from_item(item)
            related_kps = _extract_related_kps_from_item(item)
            idx = None
            for key in ("i", "index", "id", "no", "序号"):
                if key in item:
                    idx = _resolve_index(item.get(key), candidates)
                    if idx is not None:
                        break
            if idx is not None:
                _attach(candidates[idx - 1], evidence, related_kps)
                continue
            sub = str(item.get("subject", "")).strip()
            pred = str(item.get("predicate", item.get("relation", ""))).strip()
            obj = str(item.get("object", "")).strip()
            if sub and pred and obj:
                _attach(_rel_from_spo(sub, pred, obj), evidence, related_kps)
            continue

        idx = _resolve_index(item, candidates)
        if idx is not None:
            _attach(candidates[idx - 1], "")
            continue

        if isinstance(item, str):
            s = item.strip()
            m = line_re.match(s)
            if m:
                idx = int(m.group("idx"))
                if 1 <= idx <= len(candidates):
                    _attach(candidates[idx - 1], "")
                    continue
                sub, pred, obj = (
                    m.group("sub").strip(),
                    m.group("pred").strip(),
                    m.group("obj").strip(),
                )
                _attach(_rel_from_spo(sub, pred, obj), "")
                continue
            for sep in ("—[", " -[", "-["):
                if sep in s and "]→" in s:
                    left, rest = s.split(sep, 1)
                    pred, right = (
                        rest.split("]→", 1) if "]→" in rest else rest.split("]->", 1)
                    )
                    _attach(
                        _rel_from_spo(left.strip(), pred.strip(), right.strip()),
                        "",
                    )
                    break

    if kept:
        if dropped_no_evidence or dropped_bad_evidence:
            logger.info(
                "Edge evidence gate: dropped_no_evidence=%d dropped_not_in_text=%d kept=%d",
                dropped_no_evidence,
                dropped_bad_evidence,
                len(kept),
            )
        return kept

    if not require_classroom_evidence:
        for line in text.splitlines():
            m = re.match(r"^\s*(\d+)\s*[\.\)]", line)
            if not m:
                continue
            idx = int(m.group(1))
            if 1 <= idx <= len(candidates):
                _attach(candidates[idx - 1], "")
    return kept

@dataclass
class EdgeLLMFilter:
    """规则剪枝后的边 LLM 筛选；可要求每条保留边附带课堂原文依据。"""

    enabled: bool = False
    prompt: str = "stage1/edge_filter.txt"
    temperature: float = 0.1
    llm_model: str | None = None
    min_candidates: int = 1
    fallback_keep_all_on_empty: bool = False
    description_max_chars: int = 60
    require_classroom_evidence: bool = True
    min_evidence_chars: int = 4
    course_context: str = ""
    llm_client: LLMClient | None = None
    api_key: str | None = None
    base_url: str | None = None
    last_note: str = field(default="", repr=False)
    last_raw: str = field(default="", repr=False)

    def _ensure_client(self) -> LLMClient:
        if self.llm_client is None:
            settings = llm_settings_from_config(
                {},
                api_key=self.api_key,
                base_url=self.base_url,
                model=self.llm_model,
            )
            self.llm_client = LLMClient(**settings)
        return self.llm_client

    def filter(
        self,
        extract_text: str,
        relations: Sequence[TextbookRelation],
        *,
        expansion_seeds: set[str] | None = None,
        knowledge_points: Sequence[str] | None = None,
        course_context: str | None = None,
    ) -> list[TextbookRelation]:
        """返回筛选后的边；关闭或跳过时返回原列表。要求依据时无依据则不保留。"""
        relations = list(relations)
        self.last_note = ""
        self.last_raw = ""
        if not self.enabled:
            return relations
        if not extract_text.strip() or not relations:
            return []
        if len(relations) < max(1, int(self.min_candidates)):
            return relations

        kps = [str(x).strip() for x in (knowledge_points or []) if str(x).strip()]
        prompt = format_prompt(
            self.prompt,
            course_context=course_context or self.course_context or "",
            extract_text=extract_text.strip(),
            expansion_seeds=format_expansion_seeds(set(expansion_seeds or [])),
            candidate_edges=format_candidate_edges(
                relations,
                description_max_chars=self.description_max_chars,
            ),
        )
        client = self._ensure_client()
        raw = client.chat(prompt, temperature=self.temperature)
        self.last_raw = raw or ""
        kept = parse_keep_edges(
            self.last_raw,
            relations,
            extract_text=extract_text,
            require_classroom_evidence=self.require_classroom_evidence,
            min_evidence_chars=self.min_evidence_chars,
            knowledge_points=kps,
        )

        try:
            payload = json.loads(
                self.last_raw[self.last_raw.find("{") : self.last_raw.rfind("}") + 1]
            )
            if isinstance(payload, dict):
                self.last_note = str(payload.get("note", "") or "")
        except Exception:
            pass

        if not kept and self.fallback_keep_all_on_empty:
            if self.require_classroom_evidence:
                logger.warning(
                    "Edge LLM filter returned empty under require_classroom_evidence; "
                    "refuse fallback keep-all (%d candidates)",
                    len(relations),
                )
                return []
            logger.warning(
                "Edge LLM filter returned empty; fallback keep all %d edges",
                len(relations),
            )
            return relations

        with_ev = sum(
            1 for r in kept if (getattr(r, "classroom_evidence", "") or "").strip()
        )
        with_kp = sum(
            1 for r in kept if getattr(r, "related_knowledge_points", None)
        )
        logger.info(
            "Edge LLM filter: candidates=%d -> keep=%d "
            "(with_classroom_evidence=%d with_related_kps=%d)",
            len(relations),
            len(kept),
            with_ev,
            with_kp,
        )
        return kept
