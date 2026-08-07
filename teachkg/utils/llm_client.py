"""OpenAI 兼容 LLM 客户端（默认 DashScope 兼容端点）。"""

from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "deepseek-v4-flash-0731"
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


def file_to_data_url(path: str | Path) -> str:
    """本地文件 → data URL（供多模态 chat content）。"""
    image_path = Path(path)
    mime_type, _ = mimetypes.guess_type(str(image_path))
    if not mime_type or not mime_type.startswith("image/"):
        mime_type = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".bmp": "image/bmp",
        }.get(image_path.suffix.lower(), "image/png")
    encoded = base64.b64encode(image_path.read_bytes()).decode("utf-8")
    return f"data:{mime_type};base64,{encoded}"


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

    def chat(
        self,
        prompt: str,
        *,
        temperature: float | None = None,
        model: str | None = None,
    ) -> str:
        """调用 chat.completions，失败时重试（同 AutoEduKG llm_max_retry）。"""
        return self.chat_messages(
            [{"role": "user", "content": prompt}],
            temperature=temperature,
            model=model,
        )

    def chat_messages(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float | None = None,
        model: str | None = None,
    ) -> str:
        """通用 messages 调用（支持多模态 content 列表）。"""
        last_err: Exception | None = None
        for attempt in range(1, self.max_retry + 1):
            try:
                kwargs: dict[str, Any] = {
                    "model": model or self.model,
                    "messages": messages,
                }
                if temperature is not None:
                    kwargs["temperature"] = temperature
                response = self._get_client().chat.completions.create(**kwargs)
                return (response.choices[0].message.content or "").strip()
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                logger.warning("LLM call failed (%d/%d): %s", attempt, self.max_retry, exc)
                if attempt < self.max_retry:
                    # 连接类错误拉长退避，减轻瞬时 SSL / 超时连挂
                    pause = self.retry_pause_sec * (1.6 ** (attempt - 1))
                    time.sleep(pause)
        raise RuntimeError(f"LLM call failed after {self.max_retry} retries: {last_err}") from last_err

    def chat_multimodal(
        self,
        prompt: str,
        *,
        image_paths: Sequence[str | Path] | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> str:
        """文本 + 本地图片的多模态对话（OpenAI vision content 格式）。"""
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for raw in image_paths or []:
            path = Path(raw)
            if not path.is_file():
                logger.warning("skip missing image for multimodal chat: %s", path)
                continue
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": file_to_data_url(path)},
                }
            )
        if len(content) == 1:
            return self.chat(prompt, temperature=temperature, model=model)
        return self.chat_messages(
            [{"role": "user", "content": content}],
            temperature=temperature,
            model=model,
        )

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
