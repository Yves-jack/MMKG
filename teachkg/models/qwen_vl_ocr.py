"""Qwen VL OCR via DashScope OpenAI-compatible API."""

from __future__ import annotations

import base64
import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class OCRResult:
    text: str
    model: str
    image_path: str


class QwenVLOCRModel:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str = "qwen-vl-ocr",
        temperature: float = 0.0,
    ) -> None:
        self.api_key = api_key or os.environ.get("DASHSCOPE_API_KEY", "")
        self.base_url = base_url or os.environ.get(
            "DASHSCOPE_BASE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
        self.model = model
        self.temperature = temperature
        self._client = None

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI

            if not self.api_key:
                raise RuntimeError("DASHSCOPE_API_KEY is required for qwen-vl-ocr.")
            self._client = OpenAI(api_key=self.api_key, base_url=self.base_url)
        return self._client

    def extract_text(
        self,
        image_path: str | Path,
        prompt: str = "Extract all readable text from this image. Preserve layout when useful.",
    ) -> OCRResult:
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"Image file not found: {image_path}")

        image_url = self._image_data_url(image_path)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }
        ]

        completion = self._get_client().chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=self.temperature,
        )

        text = completion.choices[0].message.content or ""
        return OCRResult(text=text, model=self.model, image_path=str(image_path))

    @staticmethod
    def _image_data_url(image_path: Path) -> str:
        mime_type, _ = mimetypes.guess_type(str(image_path))
        if not mime_type or not mime_type.startswith("image/"):
            suffix = image_path.suffix.lower()
            mime_type = {
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".png": "image/png",
                ".webp": "image/webp",
                ".gif": "image/gif",
                ".bmp": "image/bmp",
            }.get(suffix, "image/png")

        image_base64 = base64.b64encode(image_path.read_bytes()).decode("utf-8")
        return f"data:{mime_type};base64,{image_base64}"
