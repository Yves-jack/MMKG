"""OpenAI 兼容 LLM 客户端（默认 DashScope 兼容端点）。"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "deepseek-v3"
DEFAULT_MAX_RETRY = 3
DEFAULT_RETRY_PAUSE_SEC = 2.0


def resolve_llm_api_key(explicit: str | None = None) -> str | None:
    if explicit:
        return explicit
    for key in ("DASHSCOPE_API_KEY", "LLM_API_KEY", "SJTU_LLM_API_KEY", "ASR_API_KEY"):
        value = os.environ.get(key)
        if value:
            return value
    return None


def resolve_llm_base_url(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    for key in ("LLM_BASE_URL", "DASHSCOPE_BASE_URL", "ASR_BASE_URL"):
        value = os.environ.get(key)
        if value:
            return value
    return DEFAULT_BASE_URL


def resolve_llm_model(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    return os.environ.get("LLM_MODEL", DEFAULT_MODEL)


def llm_settings_from_config(
    config: dict[str, Any] | None,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """合并全局 llm 配置与局部覆盖。"""
    cfg = config or {}
    return {
        "api_key": api_key or cfg.get("api_key"),
        "base_url": base_url or cfg.get("base_url"),
        "model": model or cfg.get("model") or cfg.get("llm_model"),
        "max_retry": cfg.get("max_retry", DEFAULT_MAX_RETRY),
        "retry_pause_sec": cfg.get("retry_pause_sec", DEFAULT_RETRY_PAUSE_SEC),
    }


@dataclass
class LLMClient:
    """OpenAI SDK + DashScope 兼容端点，user 单轮消息，带重试。"""

    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    max_retry: int = DEFAULT_MAX_RETRY
    retry_pause_sec: float = DEFAULT_RETRY_PAUSE_SEC
    _client: Any = field(default=None, repr=False, init=False)

    def __post_init__(self) -> None:
        self.api_key = resolve_llm_api_key(self.api_key)
        self.base_url = resolve_llm_base_url(self.base_url)
        self.model = resolve_llm_model(self.model)

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI

            if not self.api_key:
                raise RuntimeError(
                    "LLM API key required (SJTU_LLM_API_KEY / LLM_API_KEY / DASHSCOPE_API_KEY)"
                )
            self._client = OpenAI(api_key=self.api_key, base_url=self.base_url)
        return self._client

    def chat(self, prompt: str, *, temperature: float | None = None) -> str:
        """调用 chat.completions，失败时重试（同 AutoEduKG llm_max_retry）。"""
        last_err: Exception | None = None
        for attempt in range(1, self.max_retry + 1):
            try:
                kwargs: dict[str, Any] = {
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                }
                if temperature is not None:
                    kwargs["temperature"] = temperature
                response = self._get_client().chat.completions.create(**kwargs)
                return (response.choices[0].message.content or "").strip()
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                logger.warning("LLM call failed (%d/%d): %s", attempt, self.max_retry, exc)
                if attempt < self.max_retry:
                    time.sleep(self.retry_pause_sec)
        raise RuntimeError(f"LLM call failed after {self.max_retry} retries: {last_err}") from last_err

    @staticmethod
    def parse_json_response(text: str) -> dict[str, Any]:
        """解析 LLM 返回的 JSON（移植 AutoEduKG json_parse 容错逻辑）。"""
        if not (text or "").strip():
            return {}

        pattern = re.compile(r"\{[\s\S]+\}")
        match = pattern.search(text)
        json_output = match.group(0) if match else text.strip()

        try:
            return json.loads(json_output)
        except json.JSONDecodeError:
            pass

        fixed = json_output
        fixed = re.sub(r"\\+([{}()])", lambda m: m.group(1), fixed)
        fixed = re.sub(r"\\\\+", r"\\", fixed)
        fixed = re.sub(r"\\", r"\\\\", fixed)
        fixed = re.sub(r'\\+"', r'"', fixed)
        fixed = re.sub(r"\\+n", r"\\n", fixed)
        fixed = re.sub(r"\\ne", r"\\\\ne", fixed)
        fixed = re.sub(r"\\no", r"\\\\no", fixed)
        fixed = re.sub(r"\t", r"\\\\t", fixed)
        fixed = re.sub(r"\\+c", r"\\\\c", fixed)
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            logger.debug("Failed to parse LLM JSON response")
            return {}
