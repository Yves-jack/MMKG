"""Stage 1 三元组抽取前的 cue 文本预处理（参考 AutoEduKG markdown_process + chunk 清洗）。"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)

# 课堂管理 / 过渡寒暄（句子级，仅删纯过渡句）
_TRANSITION_SENTENCE_PATTERNS = (
    re.compile(r"^上课[。.]?$"),
    re.compile(r"^由于两个班级合并上课[，,].*$"),
    re.compile(r"^我们换到了更大的教室[。.]?$"),
    re.compile(r"^本学期.*将在这里进行[。.]?$"),
    re.compile(r"^目前两个班级.*进度一致[，,].*$"),
    re.compile(r"^今天我们要介绍的就是[^。]*[。.]?$"),
    re.compile(r"^接下来我们讲解[^。]*[。.]?$"),
)


def _split_sentences(paragraph: str) -> list[str]:
    parts = re.split(r"(?<=[。！？!?；;])", paragraph)
    return [p for p in parts if p.strip()]


def _is_transition_sentence(sentence: str) -> bool:
    s = sentence.strip()
    if not s:
        return True
    return any(pat.match(s) for pat in _TRANSITION_SENTENCE_PATTERNS)


def remove_classroom_admin(text: str) -> str:
    """删除课堂管理、寒暄句子（保留同段中的知识句）。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    kept_paragraphs: list[str] = []
    for paragraph in paragraphs:
        sentences = _split_sentences(paragraph)
        if not sentences:
            continue
        kept = [s for s in sentences if not _is_transition_sentence(s)]
        if kept:
            kept_paragraphs.append("".join(kept))
    return "\n\n".join(kept_paragraphs)


# 单字母命题变项例题行：- P：今天是周二
_EXAMPLE_LABEL_LINE = re.compile(
    r"^[\s\-*•]*[PQRpqr]\s*[：:]\s*.+$",
    re.MULTILINE,
)

# 纯编号残片：1. / 2. 且内容极短
_NUMBERED_FRAGMENT = re.compile(
    r"^[\s]*\d+[.、．]\s*[\s\-*•]*$",
    re.MULTILINE,
)

_IMAGE_MARKDOWN = re.compile(r"!\[[^\]]*\]\([^)]+\)")
_HTML_TAG = re.compile(r"<[^>]+>")
_PAGE_SPLIT = re.compile(r"<---\s*Page Split\s*--->", re.I)
_MULTI_SPACE = re.compile(r"[ \t]{2,}")
_MULTI_NEWLINE = re.compile(r"\n{3,}")


def _normalize_whitespace(text: str) -> str:
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.replace("\r\n", "\n").split("\n")]
    out = "\n".join(lines)
    return _MULTI_NEWLINE.sub("\n\n", out).strip()


def remove_example_label_lines(text: str) -> str:
    """删除 P/Q/R 标签例题行。"""
    return _EXAMPLE_LABEL_LINE.sub("", text)


def remove_markdown_noise(text: str) -> str:
    """去除图片标记、HTML、分页符等。"""
    text = _IMAGE_MARKDOWN.sub("", text)
    text = _HTML_TAG.sub("", text)
    text = _PAGE_SPLIT.sub("\n\n", text)
    return text


def dedupe_paragraphs(text: str) -> str:
    """合并重复段落。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    seen: set[str] = set()
    kept: list[str] = []
    for p in paragraphs:
        key = re.sub(r"\s+", "", p)
        if key in seen:
            continue
        seen.add(key)
        kept.append(p)
    return "\n\n".join(kept)


def rule_preprocess_cue_text(text: str, *, options: dict | None = None) -> str:
    """规则清洗 cue 文本，供三元组抽取使用。"""
    opts = options or {}
    out = text.strip()
    if not out:
        return ""

    out = _normalize_whitespace(out)

    if opts.get("remove_markdown_noise", True):
        out = remove_markdown_noise(out)

    if opts.get("remove_classroom_admin", True):
        out = remove_classroom_admin(out)

    if opts.get("remove_example_labels", True):
        out = remove_example_label_lines(out)
        out = _NUMBERED_FRAGMENT.sub("", out)

    if opts.get("dedupe_paragraphs", True):
        out = dedupe_paragraphs(out)

    out = _normalize_whitespace(out)
    return out


@dataclass
class CueTextPreprocessor:
    """cue 级文本预处理：规则清洗 + 可选 LLM 精炼（参考 AutoEduKG OCR/markdown_process）。"""

    enabled: bool = True
    rule_options: dict = field(default_factory=dict)
    llm_enabled: bool = False
    llm_prompt: str = "teaching/cue_text_preprocess.txt"
    llm_client: LLMClient | None = None
    api_key: str | None = None
    base_url: str | None = None
    llm_model: str | None = None
    temperature: float = 0.1
    mock: bool = False

    def __post_init__(self) -> None:
        if not self.rule_options:
            self.rule_options = {
                "remove_markdown_noise": True,
                "remove_classroom_admin": True,
                "remove_example_labels": True,
                "dedupe_paragraphs": True,
            }
        if self.llm_client is None:
            settings = llm_settings_from_config(
                {},
                api_key=self.api_key,
                base_url=self.base_url,
                model=self.llm_model,
            )
            self.llm_client = LLMClient(**settings)

    def _parse_llm_output(self, raw: str) -> str:
        text = (raw or "").strip()
        if not text:
            return ""
        try:
            payload = json.loads(text)
            if isinstance(payload, dict):
                out = str(payload.get("output", payload.get("text", ""))).strip()
                if out and out != "无内容保留":
                    return out
        except json.JSONDecodeError:
            pass
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                payload = json.loads(text[start : end + 1])
                if isinstance(payload, dict):
                    out = str(payload.get("output", "")).strip()
                    if out and out != "无内容保留":
                        return out
            except json.JSONDecodeError:
                pass
        return text

    def _llm_refine(self, text: str, course_context: str) -> str:
        if self.mock:
            return text
        prompt = format_prompt(
            self.llm_prompt,
            course_context=course_context or "（无）",
            asr_text=text,
        )
        raw = self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]
        refined = self._parse_llm_output(raw)
        return refined or text

    def process(self, asr_text: str, course_context: str = "") -> str:
        if not self.enabled:
            return asr_text.strip()
        text = rule_preprocess_cue_text(asr_text, options=self.rule_options)
        if not text:
            return ""
        if self.llm_enabled and text:
            try:
                text = self._llm_refine(text, course_context)
            except Exception as exc:  # noqa: BLE001
                logger.warning("LLM cue text preprocess failed, use rule-only text: %s", exc)
        return rule_preprocess_cue_text(text, options=self.rule_options)
