"""片段知识点提取：供教材边筛与流水线展示。

主要入口：:class:`KnowledgePointExtractor`；解析辅助见
:func:`parse_knowledge_points` / :func:`normalize_related_knowledge_points`。
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)


def parse_knowledge_points(raw: str) -> list[str]:
    """解析模型输出为去重后的知识点短语列表。"""
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
        for key in ("knowledge_points", "points", "kps", "concepts"):
            val = payload.get(key)
            if isinstance(val, list):
                names = [str(x).strip() for x in val if str(x).strip()]
                break
            if isinstance(val, str) and val.strip():
                names = [val.strip()]
                break
    elif isinstance(payload, list):
        names = [str(x).strip() for x in payload if str(x).strip()]

    if not names:
        for line in text.splitlines():
            m = re.match(r"^\s*(?:\d+[\.\)]\s*|[-*•]\s*)(.+?)\s*$", line)
            if m:
                item = m.group(1).strip().strip('"').strip("'")
                if item and item not in {"[", "]", "{", "}"}:
                    names.append(item)

    out: list[str] = []
    seen: set[str] = set()
    for name in names:
        key = re.sub(r"\s+", "", name)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(name)
    return out


def format_knowledge_points(points: list[str]) -> str:
    """格式化为编号列表，供 prompt 占位符使用。

    Args:
        points: 知识点短语列表。

    Returns:
        多行 ``1. xxx``；空列表时返回 ``"(无)"``。
    """
    if not points:
        return "(无)"
    return "\n".join(f"{i}. {p}" for i, p in enumerate(points, start=1))


def normalize_related_knowledge_points(
    raw: Any,
    allowed: list[str] | None = None,
) -> list[str]:
    """将边筛返回的关联知识点规范为字符串列表。

    Args:
        raw: 模型返回的 str / list，或其它类型（非列表/字符串则视为空）。
        allowed: 若提供，则只保留能映射到该列表中的项（精确去空白匹配，
            失败时再做子串弱匹配）。

    Returns:
        去重后的知识点列表（顺序尽量保持输入顺序）。
    """
    items: list[str] = []
    if isinstance(raw, str) and raw.strip():
        items = [raw.strip()]
    elif isinstance(raw, (list, tuple)):
        items = [str(x).strip() for x in raw if str(x).strip()]
    if not items:
        return []

    if not allowed:
        out: list[str] = []
        seen: set[str] = set()
        for name in items:
            key = re.sub(r"\s+", "", name)
            if key in seen:
                continue
            seen.add(key)
            out.append(name)
        return out

    by_norm = {re.sub(r"\s+", "", p): p for p in allowed}
    out = []
    seen = set()
    for name in items:
        key = re.sub(r"\s+", "", name)
        mapped = by_norm.get(key)
        if mapped is None:
            # 子串/包含弱匹配
            for ak, av in by_norm.items():
                if key in ak or ak in key:
                    mapped = av
                    break
        if mapped is None:
            continue
        mk = re.sub(r"\s+", "", mapped)
        if mk in seen:
            continue
        seen.add(mk)
        out.append(mapped)
    return out


@dataclass
class KnowledgePointExtractor:
    """从片段文本提取知识点列表（可选 LLM）。

    Attributes:
        enabled: 为 False 时 :meth:`extract` 直接返回空列表。
        prompt: prompts 目录下的模板名。
        temperature: LLM 采样温度。
        llm_model / api_key / base_url: 覆盖全局 LLM 配置；均可空。
        course_context: 默认课程上下文，可被 ``extract(..., course_context=)`` 覆盖。
        last_note / last_raw: 最近一次调用的模型 note 与原始输出（调试用）。
    """

    enabled: bool = False
    prompt: str = "stage1/knowledge_point_extract.txt"
    temperature: float = 0.1
    llm_model: str | None = None
    course_context: str = ""
    llm_client: LLMClient | None = None
    api_key: str | None = None
    base_url: str | None = None
    last_note: str = field(default="", repr=False)
    last_raw: str = field(default="", repr=False)

    def _ensure_client(self) -> LLMClient:
        """懒创建 :class:`LLMClient`。"""
        if self.llm_client is None:
            settings = llm_settings_from_config(
                {},
                api_key=self.api_key,
                base_url=self.base_url,
                model=self.llm_model,
            )
            self.llm_client = LLMClient(**settings)
        return self.llm_client

    def extract(
        self,
        extract_text: str,
        *,
        course_context: str | None = None,
    ) -> list[str]:
        """对单段文本调用 LLM 抽取知识点。

        Args:
            extract_text: 送入模型的课堂文本（通常为预处理后文本）。
            course_context: 覆盖默认课程上下文；``None`` 时用 ``self.course_context``。

        Returns:
            去重后的知识点短语；未启用、空文本或解析失败时可能为空列表。
        """
        self.last_note = ""
        self.last_raw = ""
        if not self.enabled:
            return []
        text = (extract_text or "").strip()
        if not text:
            return []

        prompt = format_prompt(
            self.prompt,
            course_context=course_context or self.course_context or "",
            extract_text=text,
        )
        client = self._ensure_client()
        raw = client.chat(prompt, temperature=self.temperature)
        self.last_raw = raw or ""
        points = parse_knowledge_points(self.last_raw)

        try:
            payload = json.loads(
                self.last_raw[self.last_raw.find("{") : self.last_raw.rfind("}") + 1]
            )
            if isinstance(payload, dict):
                self.last_note = str(payload.get("note", "") or "")
        except Exception:
            pass

        logger.info("Knowledge-point extract: text_chars=%d -> %d points", len(text), len(points))
        return points
