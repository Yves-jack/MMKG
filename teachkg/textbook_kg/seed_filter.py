"""LLM 种子筛选：别名与向量候选统一按同样严格标准筛选。"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)


def _zh(name: str) -> str:
    return name.split("/")[0].strip()


def format_embedding_seeds(embedding_seeds: set[str]) -> str:
    """仅格式化向量候选（兼容旧调用）。"""
    lines = [f"{i}. {name}" for i, name in enumerate(sorted(embedding_seeds), start=1)]
    return "\n".join(lines) if lines else "(无候选)"


def format_candidate_seeds(
    alias_seeds: set[str],
    embedding_seeds: set[str],
) -> str:
    """别名与向量候选一并列出，供 LLM 统一筛选。"""
    lines: list[str] = []
    idx = 1
    for name in sorted(alias_seeds):
        lines.append(f"{idx}. [alias] {name}")
        idx += 1
    for name in sorted(embedding_seeds - set(alias_seeds)):
        lines.append(f"{idx}. [embedding] {name}")
        idx += 1
    return "\n".join(lines) if lines else "(无候选)"


def parse_keep_list(raw: str, allowed: set[str]) -> list[str]:
    """解析模型输出，仅保留落在 allowed 中的实体全名。"""
    text = (raw or "").strip()
    if not text:
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

    names: list[str] = []
    if isinstance(payload, dict):
        keep = payload.get("keep", payload.get("seeds", []))
        if isinstance(keep, list):
            names = [str(x).strip() for x in keep if str(x).strip()]
        elif isinstance(keep, str) and keep.strip():
            names = [keep.strip()]
    elif isinstance(payload, list):
        names = [str(x).strip() for x in payload if str(x).strip()]

    if not names:
        for line in text.splitlines():
            m = re.match(
                r"^\s*(?:\d+[\.\)]\s*)?(?:\[(?:alias|embedding)\]\s*)?(.+?)\s*$",
                line,
            )
            if m:
                names.append(m.group(1).strip().strip('"').strip("'"))

    by_zh: dict[str, str] = {}
    for a in allowed:
        by_zh.setdefault(_zh(a), a)

    kept: list[str] = []
    seen: set[str] = set()
    for name in names:
        hit = None
        if name in allowed:
            hit = name
        else:
            hit = by_zh.get(_zh(name))
        if hit and hit not in seen:
            seen.add(hit)
            kept.append(hit)
    return kept


@dataclass
class SeedLLMFilter:
    """子图扩展前的种子 LLM 筛选（默认关闭，由配置启用）。

    别名与向量候选统一严格筛选，宁少勿滥。
    """

    enabled: bool = False
    prompt: str = "stage1/seed_filter.txt"
    temperature: float = 0.1
    llm_model: str | None = None
    min_candidates: int = 1
    # True：筛空时退回全部候选；False：筛空则无种子
    fallback_keep_all_on_empty: bool = False
    # 兼容旧配置名
    fallback_to_alias_on_empty: bool | None = None
    course_context: str = ""
    llm_client: LLMClient | None = None
    api_key: str | None = None
    base_url: str | None = None
    last_note: str = field(default="", repr=False)
    last_raw: str = field(default="", repr=False)

    def _empty_fallback(self) -> bool:
        if self.fallback_to_alias_on_empty is not None:
            return bool(self.fallback_to_alias_on_empty)
        return bool(self.fallback_keep_all_on_empty)

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
        *,
        alias_seeds: set[str],
        embedding_seeds: set[str],
        course_context: str | None = None,
    ) -> set[str]:
        """返回 LLM 保留的扩展种子（别名与向量同一标准）。"""
        alias_seeds = set(alias_seeds)
        embedding_seeds = set(embedding_seeds) - alias_seeds
        candidates = alias_seeds | embedding_seeds
        self.last_note = ""
        self.last_raw = ""

        if not self.enabled:
            return candidates
        if not extract_text.strip():
            return set()
        if not candidates:
            return set()
        if len(candidates) < max(1, int(self.min_candidates)):
            return candidates

        prompt = format_prompt(
            self.prompt,
            course_context=course_context or self.course_context or "",
            extract_text=extract_text.strip(),
            candidate_seeds=format_candidate_seeds(alias_seeds, embedding_seeds),
        )
        client = self._ensure_client()
        try:
            raw = client.chat(prompt, temperature=self.temperature)
        except Exception as exc:  # noqa: BLE001
            if self._empty_fallback():
                logger.warning(
                    "Seed LLM filter failed (%s); fallback keep all %d candidates",
                    exc,
                    len(candidates),
                )
                return candidates
            logger.warning("Seed LLM filter failed (%s); keep none", exc)
            return set()
        self.last_raw = raw or ""
        kept = set(parse_keep_list(self.last_raw, candidates))

        try:
            payload = json.loads(
                self.last_raw[self.last_raw.find("{") : self.last_raw.rfind("}") + 1]
            )
            if isinstance(payload, dict):
                self.last_note = str(payload.get("note", "") or "")
        except Exception:
            pass

        if not kept:
            if self._empty_fallback():
                logger.warning(
                    "Seed LLM filter returned empty; fallback keep all %d candidates",
                    len(candidates),
                )
                return candidates
            logger.warning(
                "Seed LLM filter returned empty; keep none (alias=%d emb=%d)",
                len(alias_seeds),
                len(embedding_seeds),
            )
            return set()

        kept_alias = kept & alias_seeds
        kept_emb = kept & embedding_seeds
        logger.info(
            "Seed LLM filter: alias=%d->%d emb=%d->%d total=%d",
            len(alias_seeds),
            len(kept_alias),
            len(embedding_seeds),
            len(kept_emb),
            len(kept),
        )
        return kept
