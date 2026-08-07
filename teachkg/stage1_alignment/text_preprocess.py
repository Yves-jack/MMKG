"""Stage 1 三元组抽取前的 cue 文本预处理（规则清洗 + 可选 LLM 精炼）。"""

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

# 讲解/定义/推理等“知识陈述”信号（学科无关）
_EXPOSITORY_MARKERS = re.compile(
    r"(定义为|被定义为|称为|叫做|是指|指的是|亦即|即是|记作|表示为|"
    r"属于|包含于|依赖于|当且仅当|等价于|推出|蕴含|因此|所以|由此|"
    r"例如|比如|证明|定理|公理|引理|推论|公式|定义|"
    r"分为|包括|由.+组成|具有|满足|若.+则|如果.+那么|设.+表示)"
)

# 公式 / 逻辑符号 / LaTeX（学科无关的形式化信号）
_FORMAL_NOTATION = re.compile(
    r"(\$.+\$|\\[a-zA-Z]+|[∀∃⇒⇔→↔∈⊆⊂∪∩¬∧∨⊥⊤]|P\([A-Za-z]\)|[A-Za-z]_[0-9])"
)

# 课堂元话语：组织/互动，而非知识本体（类别级，避免场景硬编码）
_CLASSROOM_META = re.compile(
    r"(大家|你们|咱们|同学|老师|签到|出勤|作业|考试|测验|分数|成绩|课件|"
    r"教室|休息|准备好|截图|提交|手机|电脑|系统|bug|卷子|倒计时)",
    re.I,
)

_INTERACTIVE_Q = re.compile(r"[吗呢吧]$|[？?]$")

_FILLER_ONLY = re.compile(
    r"^(嗯+|好的|行|对|是|对吧|是吗|好|行吧|没事|没关系|哈哈|啊|呃+)[。.!！？?]*$"
)

_CJK_TOKEN = re.compile(r"[\u4e00-\u9fa5]{2,4}")
_FUNCTION_CJK = frozenset(
    {
        "我们",
        "你们",
        "咱们",
        "大家",
        "这个",
        "那个",
        "什么",
        "怎么",
        "哪里",
        "因为",
        "所以",
        "然后",
        "但是",
        "如果",
        "的话",
        "一个",
        "一些",
        "可以",
        "已经",
        "还是",
        "就是",
        "这样",
        "那样",
        "现在",
        "今天",
        "时候",
        "问题",
        "东西",
        "地方",
        "接下来",
        "下面",
        "首先",
        "其次",
    }
)


def _split_sentences(paragraph: str) -> list[str]:
    parts = re.split(r"(?<=[。！？!?；;])", paragraph)
    return [p for p in parts if p.strip()]


def _is_transition_sentence(sentence: str) -> bool:
    s = sentence.strip()
    if not s:
        return True
    return any(pat.match(s) for pat in _TRANSITION_SENTENCE_PATTERNS)


def _content_token_count(sentence: str) -> int:
    return sum(1 for tok in _CJK_TOKEN.findall(sentence) if tok not in _FUNCTION_CJK)


def sentence_knowledge_score(sentence: str) -> float:
    """启发式知识密度：越高越像可抽取的知识陈述。"""
    s = sentence.strip()
    if not s:
        return -10.0
    if _FILLER_ONLY.match(s):
        return -10.0

    compact = re.sub(r"\s+", "", s)
    # 去掉标点后再估长度，避免「短定义句」被误判为空洞
    compact_zh = re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", compact)
    if len(compact_zh) <= 2:
        return -10.0

    score = 0.0
    if _EXPOSITORY_MARKERS.search(s):
        score += 3.0
    # 「X是Y」类定义/归属（无「定义为」等标记时的兜底）
    if re.search(r"[\u4e00-\u9fa5]{2,}是[\u4e00-\u9fa5A-Za-z0-9].{2,}", s):
        score += 1.5
    if _FORMAL_NOTATION.search(s):
        score += 2.5

    tokens = _content_token_count(s)
    score += min(max(tokens, 1 if len(compact_zh) >= 8 else 0), 8) * 0.6
    if len(compact_zh) >= 12:
        score += 0.8
    if len(compact_zh) >= 24:
        score += 0.6

    meta_hits = len(_CLASSROOM_META.findall(s))
    if meta_hits:
        score -= min(meta_hits, 4) * 1.2
    # 有课堂元话语、却无定义/形式化信号 → 更可能是组织闲聊
    if meta_hits and not _EXPOSITORY_MARKERS.search(s) and not _FORMAL_NOTATION.search(s):
        score -= 2.5
    if _INTERACTIVE_Q.search(s) and not _EXPOSITORY_MARKERS.search(s):
        score -= 1.5
    # 互动指代多、内容词少 → 更像课堂闲聊
    if meta_hits >= 2 and tokens <= 2:
        score -= 2.0
    return score


def _is_low_knowledge_sentence(sentence: str, *, min_score: float = 1.0) -> bool:
    return sentence_knowledge_score(sentence) < min_score


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


def remove_non_knowledge(text: str, *, min_score: float = 1.0) -> str:
    """按知识密度过滤句子：保留讲解/定义/形式化陈述，丢掉课堂闲聊与组织话。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    kept_paragraphs: list[str] = []
    for paragraph in paragraphs:
        sentences = _split_sentences(paragraph)
        units = sentences if sentences else [paragraph]
        kept = [s for s in units if not _is_low_knowledge_sentence(s, min_score=min_score)]
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

    if opts.get("remove_non_knowledge", True):
        min_score = float(opts.get("knowledge_min_score", 1.0))
        out = remove_non_knowledge(out, min_score=min_score)

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
    llm_prompt: str = "stage1/cue_text_preprocess.txt"
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
                "remove_non_knowledge": True,
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

        def _from_payload(payload: object) -> str | None:
            if not isinstance(payload, dict):
                return None
            out = str(payload.get("output", payload.get("text", ""))).strip()
            if out == "无内容保留":
                return ""
            if out:
                return out
            return None

        try:
            parsed = _from_payload(json.loads(text))
            if parsed is not None:
                return parsed
        except json.JSONDecodeError:
            pass
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = _from_payload(json.loads(text[start : end + 1]))
                if parsed is not None:
                    return parsed
            except json.JSONDecodeError:
                pass
        if text == "无内容保留":
            return ""
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
        # 空串表示模型判定无知识；不要回退成原文
        return self._parse_llm_output(raw)

    def process(self, asr_text: str, course_context: str = "") -> str:
        if not self.enabled:
            return asr_text.strip()
        text = rule_preprocess_cue_text(asr_text, options=self.rule_options)
        if not text:
            return ""
        if self.llm_enabled:
            try:
                text = self._llm_refine(text, course_context)
            except Exception as exc:  # noqa: BLE001
                logger.warning("LLM cue text preprocess failed, use rule-only text: %s", exc)
                return rule_preprocess_cue_text(asr_text, options=self.rule_options)
            if not text:
                return ""
        return rule_preprocess_cue_text(text, options=self.rule_options)
