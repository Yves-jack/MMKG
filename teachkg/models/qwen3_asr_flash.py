"""Qwen3-ASR-Flash via DashScope OpenAI-compatible API."""

from __future__ import annotations

import base64
import mimetypes
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


@dataclass
class ASRFlashResult:
    transcript: str
    model: str
    audio_source: str
    language: str | None = None
    enable_itn: bool = False
    context_used: bool = False
    annotations: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, Any] | None = None


class Qwen3ASRFlashModel:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str = "qwen3-asr-flash",
        max_local_file_mb: int = 10,
    ) -> None:
        self.api_key = api_key or os.environ.get("DASHSCOPE_API_KEY", "")
        self.base_url = base_url or os.environ.get(
            "DASHSCOPE_BASE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
        self.model = model
        self.max_local_file_mb = max_local_file_mb
        self._client = None

    def transcribe(
        self,
        audio_path: str | Path,
        context: str = "",
        language: str | None = None,
        enable_itn: bool = False,
        stream: bool = False,
    ) -> ASRFlashResult:
        client = self._get_client()
        audio_source = str(audio_path)
        messages = self._build_messages(audio_source, context)
        asr_options: dict[str, Any] = {"enable_itn": enable_itn}
        if language and language != "auto":
            asr_options["language"] = language

        request_params: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": stream,
            "extra_body": {"asr_options": asr_options},
        }
        if stream:
            request_params["stream_options"] = {"include_usage": True}

        completion = client.chat.completions.create(**request_params)
        if stream:
            transcript, annotations, usage = self._collect_streaming_response(completion)
        else:
            transcript, annotations, usage = self._collect_response(completion)

        return ASRFlashResult(
            transcript=transcript,
            model=self.model,
            audio_source=audio_source,
            language=language if language != "auto" else None,
            enable_itn=enable_itn,
            context_used=bool(context.strip()),
            annotations=annotations,
            usage=usage,
        )

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI

            if not self.api_key:
                raise RuntimeError("DASHSCOPE_API_KEY is required for qwen3-asr-flash.")
            self._client = OpenAI(api_key=self.api_key, base_url=self.base_url)
        return self._client

    def _build_messages(self, audio_source: str, context: str) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        if context.strip():
            messages.append(
                {
                    "role": "system",
                    "content": [{"text": context.strip()}],
                }
            )
        messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {"data": self._audio_to_api_input(audio_source)},
                    }
                ],
            }
        )
        return messages

    def _audio_to_api_input(self, audio_source: str) -> str:
        parsed = urlparse(audio_source)
        if parsed.scheme in {"http", "https"}:
            return audio_source

        audio_path = Path(audio_source)
        if not audio_path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_source}")

        size_mb = audio_path.stat().st_size / (1024 * 1024)
        if size_mb > self.max_local_file_mb:
            raise ValueError(
                f"Local audio file is {size_mb:.2f} MB, above the "
                f"{self.max_local_file_mb} MB limit. Use a shorter chunk or public URL."
            )

        mime_type = mimetypes.guess_type(str(audio_path))[0] or "audio/wav"
        encoded = base64.b64encode(audio_path.read_bytes()).decode("utf-8")
        return f"data:{mime_type};base64,{encoded}"

    @staticmethod
    def _collect_response(completion: Any) -> tuple[str, list[dict[str, Any]], dict[str, Any] | None]:
        message = completion.choices[0].message
        transcript = message.content or ""
        annotations = Qwen3ASRFlashModel._dump_annotations(getattr(message, "annotations", None))
        usage = Qwen3ASRFlashModel._dump_usage(getattr(completion, "usage", None))
        return transcript, annotations, usage

    @staticmethod
    def _collect_streaming_response(
        completion: Any,
    ) -> tuple[str, list[dict[str, Any]], dict[str, Any] | None]:
        transcript = ""
        annotations: list[dict[str, Any]] = []
        usage: dict[str, Any] | None = None

        for chunk in completion:
            if getattr(chunk, "usage", None):
                usage = Qwen3ASRFlashModel._dump_usage(chunk.usage)
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if getattr(delta, "content", None):
                transcript += delta.content
            if getattr(delta, "annotations", None):
                annotations.extend(Qwen3ASRFlashModel._dump_annotations(delta.annotations))

        return transcript, annotations, usage

    @staticmethod
    def _dump_annotations(annotations: Any) -> list[dict[str, Any]]:
        if not annotations:
            return []
        dumped = []
        for annotation in annotations:
            if hasattr(annotation, "model_dump"):
                dumped.append(annotation.model_dump())
            elif isinstance(annotation, dict):
                dumped.append(annotation)
            else:
                dumped.append({"value": str(annotation)})
        return dumped

    @staticmethod
    def _dump_usage(usage: Any) -> dict[str, Any] | None:
        if usage is None:
            return None
        if hasattr(usage, "model_dump"):
            return usage.model_dump()
        if isinstance(usage, dict):
            return usage
        return {"value": str(usage)}
