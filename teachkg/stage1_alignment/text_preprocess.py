"""Stage 1 三元组抽取前的 cue 文本预处理（轻规则 + 可选双阶段 LLM）。"""

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

# 介绍/引入/开场铺垫（不含实质定义时删除，与去例子一并凝练正文）
_INTRO_FRAMING = re.compile(
    r"("
    r"今天(我们)?(来|要|将|就)?(一起)?"
    r"(介绍|学习|讲解|讨论|看看|讲一下|讲一讲|来讲|来说)|"
    r"(本节课|这(一)?节课|这堂课)(的)?(主要)?内容|"
    r"(本节课|这(一)?节课|这堂课)(我们)?(会|将|要|来)|"
    r"首先(简单|大致)?(地)?(介绍|回顾|说一下|看一下|了解)|"
    r"先(给大家|跟大家)?(一个)?"
    r"(整体|大致|简单|初步)的?(印象|介绍|概述|认识)|"
    r"为什么要(学|讲|介绍|学习)|"
    r"(下面|接下来)(我们)?(来|开始|进入)(介绍|学习|讲解|进入)?|"
    r"(简单|大致|整体|粗略)介绍一下|"
    r"先从整体上|"
    r"(作为|当作)(一个)?引入|"
    r"(开场|引入部分|背景介绍|课前导入)"
    r")"
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


# 句中已有可抽取知识实质时，不把「介绍」套话整句删掉（留给 LLM 剔壳留核）
_STRONG_KNOWLEDGE = re.compile(
    r"(定义为|被定义为|称为|叫做|是指|指的是|亦即|即是|记作|表示为|"
    r"当且仅当|等价于|推出|蕴含|定理|公理|引理|推论|公式|分为|包括)"
)


def _is_intro_framing_sentence(sentence: str) -> bool:
    """纯介绍/引入铺垫：有引入话术且无明显知识实质。"""
    s = sentence.strip()
    if not s or not _INTRO_FRAMING.search(s):
        return False
    if _STRONG_KNOWLEDGE.search(s) or _FORMAL_NOTATION.search(s):
        return False
    return True


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
    compact_zh = re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", compact)
    if len(compact_zh) <= 2:
        return -10.0

    score = 0.0
    if _EXPOSITORY_MARKERS.search(s):
        score += 3.0
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
    if meta_hits and not _EXPOSITORY_MARKERS.search(s) and not _FORMAL_NOTATION.search(s):
        score -= 2.5
    if _INTERACTIVE_Q.search(s) and not _EXPOSITORY_MARKERS.search(s):
        score -= 1.5
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


def remove_intro_framing(text: str) -> str:
    """删除偏介绍/引入的铺垫句。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    kept_paragraphs: list[str] = []
    for paragraph in paragraphs:
        sentences = _split_sentences(paragraph)
        if not sentences:
            continue
        kept = [s for s in sentences if not _is_intro_framing_sentence(s)]
        if kept:
            kept_paragraphs.append("".join(kept))
    return "\n\n".join(kept_paragraphs)


def remove_non_knowledge(text: str, *, min_score: float = 1.0) -> str:
    """按知识密度过滤句子。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    kept_paragraphs: list[str] = []
    for paragraph in paragraphs:
        sentences = _split_sentences(paragraph)
        units = sentences if sentences else [paragraph]
        kept = [s for s in units if not _is_low_knowledge_sentence(s, min_score=min_score)]
        if kept:
            kept_paragraphs.append("".join(kept))
    return "\n\n".join(kept_paragraphs)


_EXAMPLE_LABEL_LINE = re.compile(
    r"^[\s\-*•]*[PQRpqr]\s*[：:]\s*.+$",
    re.MULTILINE,
)
_NUMBERED_FRAGMENT = re.compile(
    r"^[\s]*\d+[.、．]\s*[\s\-*•]*$",
    re.MULTILINE,
)
_IMAGE_MARKDOWN = re.compile(r"!\[[^\]]*\]\([^)]+\)")
_HTML_TAG = re.compile(r"<[^>]+>")
_PAGE_SPLIT = re.compile(r"<---\s*Page Split\s*--->", re.I)
_MULTI_NEWLINE = re.compile(r"\n{3,}")


def _normalize_whitespace(text: str) -> str:
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.replace("\r\n", "\n").split("\n")]
    out = "\n".join(lines)
    return _MULTI_NEWLINE.sub("\n\n", out).strip()


def remove_example_label_lines(text: str) -> str:
    return _EXAMPLE_LABEL_LINE.sub("", text)


def remove_markdown_noise(text: str) -> str:
    text = _IMAGE_MARKDOWN.sub("", text)
    text = _HTML_TAG.sub("", text)
    text = _PAGE_SPLIT.sub("\n\n", text)
    return text


def dedupe_paragraphs(text: str) -> str:
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


def default_light_rule_options() -> dict:
    """与 LLM-A（通畅）配套的轻规则：不做引入/非知识语义删减。"""
    return {
        "remove_markdown_noise": True,
        "remove_classroom_admin": True,
        "remove_intro_framing": False,
        "remove_non_knowledge": False,
        "remove_example_labels": True,
        "dedupe_paragraphs": True,
    }


def rule_preprocess_cue_text(text: str, *, options: dict | None = None) -> str:
    """规则清洗 cue 文本。"""
    opts = options or {}
    out = text.strip()
    if not out:
        return ""

    out = _normalize_whitespace(out)

    if opts.get("remove_markdown_noise", True):
        out = remove_markdown_noise(out)

    if opts.get("remove_classroom_admin", True):
        out = remove_classroom_admin(out)

    if opts.get("remove_intro_framing", True):
        out = remove_intro_framing(out)

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


def _extract_json_object(raw: str) -> dict | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(text[start : end + 1])
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def build_lecture_cues_block(cues: list[tuple[str, str]]) -> str:
    """拼接触次级 B 输入：[(cue_id, fluent_text), ...]。"""
    parts: list[str] = []
    for cue_id, text in cues:
        body = (text or "").strip() or "（空）"
        parts.append(f"<<<CUE id={cue_id}>>>\n{body}\n<<<END_CUE>>>")
    return "\n\n".join(parts)


@dataclass
class LectureFocusResult:
    outline: list[str] = field(default_factory=list)
    cue_texts: dict[str, str] = field(default_factory=dict)
    raw_response: str = ""


@dataclass
class CueTextPreprocessor:
    """cue 级文本预处理：轻规则 + 可选单段/双段 LLM。

    - ``llm_two_pass=False``：兼容旧单 prompt（通畅+提炼合一）
    - ``llm_two_pass=True`` 且 ``focus_pass=False``：只跑 A（通畅），结果即最终文本
    - ``llm_two_pass=True`` 且 ``focus_pass=True`` 且 ``focus_lecture_level=False``：A/B 均按 cue
    - ``llm_two_pass=True`` 且 ``focus_pass=True`` 且 ``focus_lecture_level=True``：A 按 cue，B 整讲拼接+大纲

    说明：PPT 翻页切分的片段上下文通常已够完整，默认不再做整讲拼接 B；
    存量集成时可只跑 A，把已有 ``extract_text`` 当作 B 结果写入。
    """

    enabled: bool = True
    rule_options: dict = field(default_factory=dict)
    llm_enabled: bool = False
    llm_two_pass: bool = False
    focus_pass: bool = True
    focus_lecture_level: bool = False
    llm_prompt: str = "stage1/cue_text_preprocess.txt"
    llm_fluency_prompt: str = "stage1/cue_text_fluency.txt"
    llm_focus_prompt: str = "stage1/cue_text_focus.txt"
    llm_focus_lecture_prompt: str = "stage1/cue_text_focus_lecture.txt"
    llm_client: LLMClient | None = None
    api_key: str | None = None
    base_url: str | None = None
    llm_model: str | None = None
    temperature: float = 0.1
    mock: bool = False

    def __post_init__(self) -> None:
        if not self.rule_options:
            self.rule_options = (
                default_light_rule_options()
                if self.llm_two_pass
                else {
                    "remove_markdown_noise": True,
                    "remove_classroom_admin": True,
                    "remove_intro_framing": True,
                    "remove_non_knowledge": True,
                    "remove_example_labels": True,
                    "dedupe_paragraphs": True,
                }
            )
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
        payload = _extract_json_object(text)
        if payload is not None:
            out = str(payload.get("output", payload.get("text", ""))).strip()
            if out == "无内容保留":
                return ""
            if out:
                return out
            return ""
        if text == "无内容保留":
            return ""
        return text

    def _llm_raw(self, prompt_name: str, **kwargs: str) -> str:
        if self.mock:
            return ""
        prompt = format_prompt(prompt_name, **kwargs)
        return self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]

    def _llm_call(self, prompt_name: str, text: str, course_context: str) -> str:
        if self.mock:
            return text
        raw = self._llm_raw(
            prompt_name,
            course_context=course_context or "（无）",
            asr_text=text,
        )
        return self._parse_llm_output(raw)

    def process_pass_a(self, asr_text: str, course_context: str = "") -> str:
        """轻规则 + LLM-A（通畅完整）。讲次级 B 之前调用；也可单独作为最终文本。"""
        if not self.enabled:
            return asr_text.strip()
        text = rule_preprocess_cue_text(asr_text, options=self.rule_options)
        if not text:
            return ""
        if not self.llm_enabled:
            return text
        try:
            if self.llm_two_pass:
                fluent = self._llm_call(self.llm_fluency_prompt, text, course_context)
                if not fluent:
                    return ""
                return rule_preprocess_cue_text(fluent, options=self.rule_options)
            refined = self._llm_call(self.llm_prompt, text, course_context)
            if not refined:
                return ""
            return rule_preprocess_cue_text(refined, options=self.rule_options)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM cue fluency failed, use rule-only text: %s", exc)
            return rule_preprocess_cue_text(asr_text, options=self.rule_options)

    def process_pass_b_cue(self, fluent_text: str, course_context: str = "") -> str:
        """按 cue 的 LLM-B（去非主线精炼）。输入应为 A 通畅结果。"""
        text = (fluent_text or "").strip()
        if not text:
            return ""
        if not self.enabled or not self.llm_enabled or not self.focus_pass:
            return rule_preprocess_cue_text(text, options=self.rule_options) if self.enabled else text
        if self.focus_lecture_level:
            return text
        try:
            focused = self._llm_call(self.llm_focus_prompt, text, course_context)
            if not focused:
                return ""
            return rule_preprocess_cue_text(focused, options=self.rule_options)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM cue focus failed, keep fluency text: %s", exc)
            return text

    def process_lecture_focus(
        self,
        cue_fluents: list[tuple[str, str]],
        *,
        course_context: str = "",
        lecture_id: str = "",
    ) -> LectureFocusResult:
        """整讲拼接 LLM-B：返回大纲 + 各 cue 精炼文本。"""
        result = LectureFocusResult()
        ordered_ids = [cid for cid, _ in cue_fluents]
        if not cue_fluents:
            return result

        if self.mock or not self.llm_enabled:
            result.outline = [f"（规则/mock）讲次 {lecture_id or '?'}"]
            result.cue_texts = {
                cid: rule_preprocess_cue_text(text, options=self.rule_options)
                for cid, text in cue_fluents
            }
            return result

        cues_block = build_lecture_cues_block(cue_fluents)
        try:
            raw = self._llm_raw(
                self.llm_focus_lecture_prompt,
                course_context=course_context or "（无）",
                lecture_id=str(lecture_id or "（未知）"),
                cues_block=cues_block,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM lecture focus failed, fallback to fluency texts: %s", exc)
            result.cue_texts = {cid: text for cid, text in cue_fluents}
            return result

        result.raw_response = raw or ""
        payload = _extract_json_object(raw) or {}
        outline_raw = payload.get("outline") or payload.get("lecture_outline") or []
        if isinstance(outline_raw, list):
            result.outline = [str(x).strip() for x in outline_raw if str(x).strip()]
        elif isinstance(outline_raw, str) and outline_raw.strip():
            result.outline = [outline_raw.strip()]

        cue_map: dict[str, str] = {}
        cues_payload = payload.get("cues") or payload.get("segments") or []
        if isinstance(cues_payload, list):
            for row in cues_payload:
                if not isinstance(row, dict):
                    continue
                cid = str(row.get("cue_id") or row.get("id") or "").strip()
                if not cid:
                    continue
                out = str(row.get("output") or row.get("text") or "").strip()
                if out == "无内容保留":
                    out = ""
                cue_map[cid] = rule_preprocess_cue_text(out, options=self.rule_options) if out else ""

        # 保证每个输入 cue 都有键；模型漏写时回退 fluent（避免整讲抽空）
        for cid, fluent in cue_fluents:
            if cid in cue_map:
                result.cue_texts[cid] = cue_map[cid]
            else:
                logger.warning("Lecture focus missing cue_id=%s; keep fluency text", cid)
                result.cue_texts[cid] = fluent

        # 模型多写的 id 忽略
        extra = set(cue_map) - set(ordered_ids)
        if extra:
            logger.debug("Lecture focus extra cue ids ignored: %s", sorted(extra)[:5])
        return result

    def process(self, asr_text: str, course_context: str = "") -> str:
        """单 cue 完整预处理。

        若启用讲次级 B，本方法只做 A（通畅）；B 请走 ``process_lecture_focus``。
        若 ``focus_pass=False``，A 通畅结果即为最终文本。
        """
        if not self.enabled:
            return asr_text.strip()
        text = rule_preprocess_cue_text(asr_text, options=self.rule_options)
        if not text:
            return ""
        if not self.llm_enabled:
            return text

        try:
            if self.llm_two_pass:
                fluent = self._llm_call(self.llm_fluency_prompt, text, course_context)
                if not fluent:
                    return ""
                fluent = rule_preprocess_cue_text(fluent, options=self.rule_options)
                if not fluent:
                    return ""
                # 讲次级 B 由外部批量调用；无 focus_pass 时 A 即最终
                if self.focus_lecture_level or not self.focus_pass:
                    return fluent
                focused = self._llm_call(self.llm_focus_prompt, fluent, course_context)
                if not focused:
                    return ""
                return rule_preprocess_cue_text(focused, options=self.rule_options)

            refined = self._llm_call(self.llm_prompt, text, course_context)
            if not refined:
                return ""
            return rule_preprocess_cue_text(refined, options=self.rule_options)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM cue text preprocess failed, use rule-only text: %s", exc)
            return rule_preprocess_cue_text(asr_text, options=self.rule_options)

    def process_debug(self, asr_text: str, course_context: str = "") -> dict[str, str]:
        """单 cue 调试（不含讲次级 B）。"""
        raw = asr_text.strip()
        rule_out = rule_preprocess_cue_text(raw, options=self.rule_options) if self.enabled else raw
        result = {
            "raw": raw,
            "after_rules": rule_out,
            "after_fluency": "",
            "after_focus": "",
            "final": "",
        }
        if not self.enabled:
            result["final"] = raw
            return result
        if not rule_out:
            return result
        if not self.llm_enabled:
            result["final"] = rule_out
            return result
        if self.llm_two_pass:
            fluent = self._llm_call(self.llm_fluency_prompt, rule_out, course_context)
            result["after_fluency"] = fluent
            if not fluent:
                return result
            fluent = rule_preprocess_cue_text(fluent, options=self.rule_options)
            if self.focus_lecture_level or not self.focus_pass:
                result["final"] = fluent
                return result
            focused = self._llm_call(self.llm_focus_prompt, fluent, course_context)
            result["after_focus"] = focused
            if not focused:
                return result
            result["final"] = rule_preprocess_cue_text(focused, options=self.rule_options)
            return result
        refined = self._llm_call(self.llm_prompt, rule_out, course_context)
        result["after_focus"] = refined
        result["final"] = (
            rule_preprocess_cue_text(refined, options=self.rule_options) if refined else ""
        )
        return result
