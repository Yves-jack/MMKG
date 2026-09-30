"""Stage 3 三元组 / 局部子图抽取（并入 Stage 1 流水线）。"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from teachkg.schemas import VideoSegment
from teachkg.stage1_alignment.knowledge_points import format_knowledge_points
from teachkg.utils.text import count_text_words
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)

_PARSE_DEFAULT_CAP = object()

_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)

VALID_ABSTRACT_RELATIONS = frozenset({
    "belong_to",
    "part_of",
    "depend_on",
    "synonym_of",
    "property_of",
    "related_with",
})

# 增量抽取来源：严格原文 / KG补全 / 跨段
EXTRACT_SOURCE_LECTURE_DELTA = "lecture_delta"
EXTRACT_SOURCE_KG_COMPLETION = "kg_completion"

_SUBJECT_ALIASES = ("subject", "head", "h", "source")
_OBJECT_ALIASES = ("object", "tail", "t", "target")

# 通用实体卫生：带标签符号、公式应用、数理逻辑特殊符号
_LABELED_SYMBOL_RE = re.compile(r"^[A-Za-z]\s*[:：]")
_FORMULA_APPLICATION_RE = re.compile(r"\w+\([^)]+\)")
_MATH_LOGIC_SYMBOL_RE = re.compile(
    r"[∀∃∈∉⊆⊇⊂⊃→←↔⇒⇔∧∨¬⊢⊨°²³√∫∑∏λ]|"
    r"\{[^{}]*[，,][^{}]*\}"
)

MIN_CONCRETE_RELATION_EFFECTIVE_LEN = 1
MAX_CONCRETE_RELATION_EFFECTIVE_LEN = 8

# 无占位符时的 depend_on「基础」类短词（兼容旧数据）
_BASE_CONCRETE_RELATIONS = frozenset({
    "基础为",
    "是基础",
    "作为基础",
})

_CONCRETE_SLOT_MARKERS = ("...", "…")

VALID_STATEMENT_DIRECTIONS = frozenset({
    "subject_to_object",
    "object_to_subject",
})

VALIDATION_VERDICT_PASS = "pass"
VALIDATION_VERDICT_REVISE = "revise"
VALIDATION_VERDICT_DISCARD = "discard"
VALIDATION_VERDICTS = frozenset({
    VALIDATION_VERDICT_PASS,
    VALIDATION_VERDICT_REVISE,
    VALIDATION_VERDICT_DISCARD,
})

REVISE_ACTION_FIX = "fix"
REVISE_ACTION_REEXTRACT = "re_extract"
REVISE_ACTIONS = frozenset({REVISE_ACTION_FIX, REVISE_ACTION_REEXTRACT})

_STATEMENT_DIRECTION_ALIASES = {
    "subject_to_object": "subject_to_object",
    "object_to_subject": "object_to_subject",
    "subject_first": "subject_to_object",
    "object_first": "object_to_subject",
    "forward": "subject_to_object",
    "reverse": "object_to_subject",
    "s_to_o": "subject_to_object",
    "o_to_s": "object_to_subject",
    "主体到客体": "subject_to_object",
    "客体到主体": "object_to_subject",
}


def entity_label(entity: str) -> str:
    """取实体中文主名（斜杠前）。"""
    return _entity_primary_name(entity)


def normalize_statement_direction(raw: str) -> str:
    key = raw.strip()
    if not key:
        return ""
    lowered = key.lower().replace(" ", "_").replace("-", "_")
    return _STATEMENT_DIRECTION_ALIASES.get(key) or _STATEMENT_DIRECTION_ALIASES.get(lowered, "")


def infer_statement_direction(abstract_relation: str) -> str:
    """未显式给出转写方向时的默认值。"""
    if abstract_relation == "property_of":
        return "object_to_subject"
    return "subject_to_object"


# property_of：concrete ↔ 唯一合法 statement_direction（只改拼读，不改 A→B 角色）
PROPERTY_OF_CONCRETE_DIR: dict[str, str] = {
    "表示": "subject_to_object",
    "用…表示": "object_to_subject",
    "用...表示": "object_to_subject",
    "具有": "object_to_subject",
    "具有属性": "object_to_subject",
    "具有性质": "object_to_subject",
    "是…的属性": "subject_to_object",
    "是...的属性": "subject_to_object",
    "是…的性质": "subject_to_object",
    "是...的性质": "subject_to_object",
}

_HAS_PROPERTY_CONCRETES = frozenset({"具有", "具有属性", "具有性质"})

# 记号串作属性侧时，课堂常说「Y 用 X 表示」，优先客→主 + 用…表示
_NOTATION_SUBJECT_RE = re.compile(
    r"(?:^[a-zA-Z](?:,[a-zA-Z]){1,}(?:\.\.\.|…)?(?:/[a-zA-Z].*)?$)"
    r"|(?:\.\.\.|…)"
)


def norm_concrete_relation(concrete: str) -> str:
    return (concrete or "").strip().replace("...", "…")


def is_has_property_concrete(concrete: str) -> bool:
    """concrete 是否为「具有*」族（具有 / 具有性质 / 具有约束 / 具有…性质 …）。"""
    c = norm_concrete_relation(concrete)
    if not c:
        return False
    if c in _HAS_PROPERTY_CONCRETES:
        return True
    return c.startswith("具有")


def _looks_like_notation_subject(subject: str) -> bool:
    s = (subject or "").strip()
    if not s:
        return False
    primary = s.split("/", 1)[0].strip()
    if _NOTATION_SUBJECT_RE.search(primary) or _NOTATION_SUBJECT_RE.search(s):
        return True
    # a,b,c... / x,y,z... / P,Q,R...
    return bool(re.match(r"^[A-Za-z](,[A-Za-z])+\.\.\.?$", primary.replace("…", "...")))


def align_property_of_fields(
    *,
    subject: str,
    object_: str,
    concrete_relation: str,
    statement_direction: str,
    abstract_relation: str = "property_of",
) -> tuple[str, str, str, str, list[str]]:
    """纠偏 property_of 的角色反置与 concrete↔direction 错配。

    约定：`A —property_of→ B` = A 是 B 的属性；箭头/拼读跟 statement_direction。
    - 「具有*」+ 主→客：通常把拥有者放在了 S（中文「S具有O」），交换 S/O 并改为客→主。
    - 「表示」+ 客→主：改 concrete 为「用…表示」（保留客→主，贴合「Y用X表示」）。
    - 记号串 S +「表示」：统一为「用…表示」+ 客→主。
    - 其余：按 PROPERTY_OF_CONCRETE_DIR 对齐 direction。
    """
    changes: list[str] = []
    if (abstract_relation or "").strip() != "property_of":
        return subject, object_, concrete_relation, statement_direction, changes

    concrete = norm_concrete_relation(concrete_relation)
    direction = normalize_statement_direction(statement_direction) or infer_statement_direction(
        "property_of"
    )

    if is_has_property_concrete(concrete) and direction == "subject_to_object":
        subject, object_ = object_, subject
        direction = "object_to_subject"
        changes.append("swap_roles_for_具有")

    # 记号约定：课堂多说「概念用记号表示」→ 用…表示 + 客→主
    if concrete == "表示" and (
        direction == "object_to_subject" or _looks_like_notation_subject(subject)
    ):
        concrete = "用…表示"
        direction = "object_to_subject"
        changes.append("表示→用…表示")

    expect = PROPERTY_OF_CONCRETE_DIR.get(concrete)
    if expect is None and is_has_property_concrete(concrete):
        expect = "object_to_subject"
    if expect and direction != expect:
        direction = expect
        changes.append("align_direction_to_concrete")

    out_concrete = concrete if concrete else concrete_relation
    return subject, object_, out_concrete, direction, changes


def _join_natural(head: str, relation: str, tail: str) -> str:
    relation = relation.strip()
    if not relation:
        return f"{head}{tail}"
    return f"{head}{relation}{tail}"


def concrete_relation_effective_len(concrete: str) -> int:
    """计算 concrete_relation 有效长度（... / … 占位符不计入）。"""
    effective = concrete.strip()
    for marker in _CONCRETE_SLOT_MARKERS:
        effective = effective.replace(marker, "")
    return len(effective)


def _concrete_has_slot(concrete: str) -> bool:
    return any(marker in concrete for marker in _CONCRETE_SLOT_MARKERS)


def expand_concrete_relation(concrete: str, slot: str) -> str:
    """将 concrete 中的 ... 替换为槽位实体（head 对侧实体）。"""
    expanded = concrete
    for marker in _CONCRETE_SLOT_MARKERS:
        expanded = expanded.replace(marker, slot)
    return expanded


def triplet_to_statement(triplet: Triplet) -> str:
    """按 statement_direction 拼自然句；concrete 含 ... 时嵌入 tail 实体。"""
    subject = entity_label(triplet.subject)
    obj = entity_label(triplet.object)
    concrete = triplet.concrete_relation.strip()
    direction = triplet.statement_direction or infer_statement_direction(triplet.abstract_relation)

    if direction == "object_to_subject":
        head, tail = obj, subject
    else:
        head, tail = subject, obj

    if _concrete_has_slot(concrete):
        return f"{head}{expand_concrete_relation(concrete, tail)}"

    if triplet.abstract_relation == "depend_on" and concrete in _BASE_CONCRETE_RELATIONS:
        return f"{obj}是{subject}的基础"
    return _join_natural(head, concrete, tail)


def _pick_field(data: dict[str, Any], aliases: tuple[str, ...]) -> str:
    for key in aliases:
        val = data.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def infer_attribute_category(abstract_relation: str) -> str:
    if abstract_relation == "property_of":
        return "内禀属性"
    return "关系属性"


def _entity_primary_name(entity: str) -> str:
    """取实体中文主名（斜杠前）。"""
    return entity.split("/")[0].strip()


def _entity_name_parts(entity: str) -> tuple[str, str]:
    if "/" in entity:
        zh, en = entity.split("/", 1)
        return zh.strip(), en.strip()
    return entity.strip(), ""


def _entity_has_formula_or_symbol(text: str) -> bool:
    return bool(
        _FORMULA_APPLICATION_RE.search(text) or _MATH_LOGIC_SYMBOL_RE.search(text)
    )


_OVERLY_SPECIFIC_ENTITY_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^公理\s*\d"),
    re.compile(r"^定理\s*[\d\.一二三四五六七八九十]+"),
    re.compile(r"^第[一二三四五六七八九十\d]+个?(命题|定理|公理|例题|步骤)"),
    re.compile(r"^例题\s*\d"),
    re.compile(r"^命题\s*\d"),
    re.compile(r"^步骤\s*\d"),
    re.compile(r"^公式\s*\d"),
)

_GENERIC_CONCEPT_HEADS = frozenset({
    "公理",
    "定理",
    "命题",
    "例题",
    "公式",
    "步骤",
    "证明",
})


def is_placeholder_entity(entity: str) -> bool:
    """符号占位/字母串不应作为知识实体（如 a,b,c...、p,q,r）。"""
    primary, english = _entity_name_parts(entity)
    for part in (primary, english):
        if not part:
            continue
        if "..." in part or part.endswith("…"):
            return True
        compact = part.replace(" ", "")
        if re.match(r"^[a-z](,[a-z])+\.{0,3}$", compact, re.I):
            return True
    if primary and not re.search(r"[\u4e00-\u9fff]", primary):
        compact = primary.replace(" ", "")
        if re.match(r"^[a-z,\.\s]+$", primary, re.I) and len(compact) <= 8:
            return True
    return False


def is_awkward_delta_triplet(triplet: Triplet) -> bool:
    """增量边自然语句重复实体或关系方向明显异常。"""
    sub = entity_label(triplet.subject)
    obj = entity_label(triplet.object)
    texts = (
        triplet.context,
        triplet.description,
        triplet_to_statement(triplet),
    )
    for text in texts:
        if not text:
            continue
        for label in (sub, obj):
            if len(label) >= 2 and text.count(label) >= 2:
                return True
    if triplet.abstract_relation == "part_of" and sub and obj:
        if len(sub) > len(obj) and obj in sub:
            return True
    return False


def is_redundant_delta_triplet(triplet: Triplet) -> bool:
    """增量边冗余：同义自环、占位实体等。"""
    if is_placeholder_entity(triplet.subject) or is_placeholder_entity(triplet.object):
        return True
    sub = entity_label(triplet.subject)
    obj = entity_label(triplet.object)
    if triplet.abstract_relation == "synonym_of" and sub == obj:
        return True
    return False


def delta_semantic_key(triplet: Triplet) -> tuple[str, str, str]:
    return (entity_label(triplet.subject), triplet.abstract_relation, entity_label(triplet.object))


def filter_delta_triplets(
    triplets: list[Triplet],
    asr_text: str = "",
    *,
    conceptual_focus: bool = False,
    allow_model_written_context: bool = False,
) -> list[Triplet]:
    """增量三元组过滤 + 语义去重。"""
    out: list[Triplet] = []
    seen: set[tuple[str, str, str]] = set()
    for t in triplets:
        if is_redundant_delta_triplet(t):
            continue
        # KG 补全的自写 context 常复述实体名，不宜用 awkward 双计规则误杀
        if not allow_model_written_context and is_awkward_delta_triplet(t):
            continue
        reason = validate_triplet(
            t,
            asr_text,
            conceptual_focus=conceptual_focus,
            allow_model_written_context=allow_model_written_context,
        )
        if reason:
            continue
        key = delta_semantic_key(t)
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


def is_overly_specific_entity(entity: str) -> bool:
    """编号/序数/例题占位类实体，偏具体而非概念。"""
    primary, _ = _entity_name_parts(entity)
    if not primary:
        return True
    for pat in _OVERLY_SPECIFIC_ENTITY_PATTERNS:
        if pat.search(primary):
            return True
    if re.match(r"^(公理|定理|命题|例题|公式|步骤)", primary) and re.search(r"\d", primary):
        return True
    if re.match(r"^第[一二三四五六七八九十\d]+", primary):
        return True
    return False


def is_overly_specific_triplet(triplet: Triplet) -> bool:
    """具体实例挂到泛化类名、或编号实体参与的关系。"""
    if is_overly_specific_entity(triplet.subject) or is_overly_specific_entity(triplet.object):
        return True
    subj = entity_label(triplet.subject)
    obj = entity_label(triplet.object)
    if subj == obj:
        return True
    if re.search(r"\d", subj) and obj in _GENERIC_CONCEPT_HEADS:
        return True
    if re.search(r"\d", obj) and subj in _GENERIC_CONCEPT_HEADS:
        return True
    return False


def is_bad_entity(entity: str) -> bool:
    """通用实体卫生：拒绝对象名过短、带标签符号、公式应用或数理符号串。"""
    primary, english = _entity_name_parts(entity)
    if not primary:
        return True
    if len(primary) == 1 and primary.isalnum():
        return True
    if _LABELED_SYMBOL_RE.match(primary):
        return True
    for part in (primary, english):
        if part and _entity_has_formula_or_symbol(part):
            return True
    return False


def _normalize_ws(text: str) -> str:
    return re.sub(r"\s+", "", text)


def context_in_source(context: str, source: str) -> bool:
    if not context or not source:
        return True
    if context in source:
        return True
    return _normalize_ws(context) in _normalize_ws(source)


def _normalize_abstract_relation(raw: str) -> str:
    key = raw.strip().lower().replace(" ", "_")
    if key in VALID_ABSTRACT_RELATIONS:
        return key
    mapping = {
        "定义为": "property_of",
        "定义": "property_of",
        "具有属性": "property_of",
        "属性": "property_of",
        "属于": "belong_to",
        "包含": "part_of",
        "组成": "part_of",
        "划分为": "part_of",
        "依赖于": "depend_on",
        "依赖": "depend_on",
        "是基础": "depend_on",
        "等价于": "synonym_of",
        "同义": "synonym_of",
        "又称": "synonym_of",
        "别名": "synonym_of",
        "相关": "related_with",
        "推出": "depend_on",
        "蕴含": "depend_on",
    }
    return mapping.get(raw.strip(), key)


def validate_triplet(
    triplet: Triplet,
    asr_text: str = "",
    *,
    conceptual_focus: bool = False,
    allow_model_written_context: bool = False,
) -> str | None:
    """结构校验（字段完整、格式合法）；语义质量由 LLM 校验负责。"""
    if is_bad_entity(triplet.subject) or is_bad_entity(triplet.object):
        return "bad_entity"
    if conceptual_focus and is_placeholder_entity(triplet.subject):
        return "placeholder_entity"
    if conceptual_focus and is_placeholder_entity(triplet.object):
        return "placeholder_entity"
    if conceptual_focus and is_overly_specific_triplet(triplet):
        return "overly_specific"
    if triplet.subject.strip() == triplet.object.strip():
        return "self_loop"
    if not triplet.abstract_relation or not triplet.concrete_relation:
        return "missing_relation"
    eff_len = concrete_relation_effective_len(triplet.concrete_relation)
    if eff_len < MIN_CONCRETE_RELATION_EFFECTIVE_LEN:
        return "concrete_empty"
    if eff_len > MAX_CONCRETE_RELATION_EFFECTIVE_LEN:
        return "concrete_too_long"
    if "。" in triplet.concrete_relation or "，" in triplet.concrete_relation:
        return "concrete_is_sentence"
    if triplet.statement_direction not in VALID_STATEMENT_DIRECTIONS:
        return "bad_statement_direction"
    # KG 补全边允许模型自写 context；严格原文边须可在原文定位
    relax_context = (
        allow_model_written_context
        or (triplet.extract_source or "").strip() == EXTRACT_SOURCE_KG_COMPLETION
    )
    if (
        triplet.context
        and asr_text
        and not relax_context
        and not context_in_source(triplet.context, asr_text)
    ):
        return "context_not_in_source"
    return None


@dataclass
class Triplet:
    subject: str
    object: str
    abstract_relation: str = ""
    concrete_relation: str = ""
    statement_direction: str = ""
    attribute_category: str = ""
    description: str = ""
    context: str = ""
    extract_source: str = ""
    cross_cue_span: str = ""
    subject_entity_ref: str = ""  # textbook | new
    object_entity_ref: str = ""
    related_knowledge_points: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.abstract_relation and self.abstract_relation not in VALID_ABSTRACT_RELATIONS:
            self.abstract_relation = _normalize_abstract_relation(self.abstract_relation)
            if self.abstract_relation not in VALID_ABSTRACT_RELATIONS:
                self.abstract_relation = ""
        direction = normalize_statement_direction(self.statement_direction)
        if not direction and self.abstract_relation:
            direction = infer_statement_direction(self.abstract_relation)
        self.statement_direction = direction
        if self.abstract_relation == "property_of":
            s, o, c, d, _ = align_property_of_fields(
                subject=self.subject,
                object_=self.object,
                concrete_relation=self.concrete_relation,
                statement_direction=self.statement_direction,
                abstract_relation=self.abstract_relation,
            )
            self.subject, self.object = s, o
            self.concrete_relation = c
            self.statement_direction = d
        if not self.attribute_category:
            if self.abstract_relation:
                self.attribute_category = infer_attribute_category(self.abstract_relation)
            else:
                self.attribute_category = "关系属性"

    @property
    def head(self) -> str:
        return self.subject

    @property
    def tail(self) -> str:
        return self.object

    @property
    def relation(self) -> str:
        if self.abstract_relation and self.concrete_relation:
            return f"{self.abstract_relation}|{self.concrete_relation}"
        return self.abstract_relation or self.concrete_relation

    @property
    def predicate(self) -> str:
        return self.abstract_relation

    def to_dict(self) -> dict[str, Any]:
        data = {
            "subject": self.subject,
            "object": self.object,
            "abstract_relation": self.abstract_relation,
            "concrete_relation": self.concrete_relation,
            "statement_direction": self.statement_direction,
            "natural_statement": triplet_to_statement(self),
            "head": self.subject,
            "tail": self.object,
            "relation": self.relation,
            "attribute_category": self.attribute_category,
            "description": self.description,
            "context": self.context,
        }
        if self.extract_source:
            data["extract_source"] = self.extract_source
        if self.cross_cue_span:
            data["cross_cue_span"] = self.cross_cue_span
        if self.subject_entity_ref:
            data["subject_entity_ref"] = self.subject_entity_ref
        if self.object_entity_ref:
            data["object_entity_ref"] = self.object_entity_ref
        if self.related_knowledge_points:
            data["related_knowledge_points"] = list(self.related_knowledge_points)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Triplet | None:
        subject = _pick_field(data, _SUBJECT_ALIASES)
        obj = _pick_field(data, _OBJECT_ALIASES)
        if not subject or not obj:
            return None

        abstract_rel = str(data.get("abstract_relation", "")).strip()
        concrete_rel = str(data.get("concrete_relation", "")).strip()

        if not abstract_rel and not concrete_rel:
            legacy = _pick_field(data, ("predicate", "relation", "r", "rel"))
            if legacy:
                norm = _normalize_abstract_relation(legacy)
                if norm in VALID_ABSTRACT_RELATIONS:
                    abstract_rel = norm
                else:
                    concrete_rel = legacy

        if abstract_rel:
            abstract_rel = _normalize_abstract_relation(abstract_rel)
            if abstract_rel not in VALID_ABSTRACT_RELATIONS:
                return None

        if not abstract_rel or not concrete_rel:
            return None

        attr_cat = str(data.get("attribute_category", "")).strip()
        if attr_cat not in ("内禀属性", "关系属性"):
            attr_cat = infer_attribute_category(abstract_rel)

        direction_raw = str(
            data.get("statement_direction", data.get("read_direction", data.get("rewrite_direction", "")))
        ).strip()

        kps_raw = data.get("related_knowledge_points") or data.get("knowledge_points") or []
        related_kps: list[str] = []
        if isinstance(kps_raw, list):
            related_kps = [str(x).strip() for x in kps_raw if str(x).strip()]
        elif isinstance(kps_raw, str) and kps_raw.strip():
            related_kps = [kps_raw.strip()]

        return cls(
            subject=subject,
            object=obj,
            abstract_relation=abstract_rel,
            concrete_relation=concrete_rel,
            statement_direction=direction_raw,
            attribute_category=attr_cat,
            description=str(data.get("description", "")).strip(),
            context=str(data.get("context", "")).strip(),
            extract_source=str(data.get("extract_source", "")).strip(),
            cross_cue_span=str(data.get("cross_cue_span", "")).strip(),
            subject_entity_ref=str(data.get("subject_entity_ref", "")).strip(),
            object_entity_ref=str(data.get("object_entity_ref", "")).strip(),
            related_knowledge_points=related_kps,
        )

    @property
    def dedupe_key(self) -> tuple[str, str, str, str]:
        return (self.subject, self.abstract_relation, self.concrete_relation, self.object)

    @property
    def spo_dedupe_key(self) -> tuple[str, str, str]:
        """与教材子图去重用：忽略 concrete_relation。"""
        return (self.subject, self.abstract_relation, self.object)

    @property
    def spo_label_key(self) -> tuple[str, str, str]:
        """中文主名 + 抽象关系，兼容「谓词」vs「谓词/predicate」。"""
        return (
            entity_label(self.subject),
            self.abstract_relation,
            entity_label(self.object),
        )


@dataclass
class ValidationVerdict:
    """单条三元组校验裁决。"""

    verdict: str
    reason: str = ""
    action: str = ""
    suggestion: str = ""

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"verdict": self.verdict}
        if self.reason:
            data["reason"] = self.reason
        if self.action:
            data["action"] = self.action
        if self.suggestion:
            data["suggestion"] = self.suggestion
        return data


@dataclass
class ValidatedTriplet:
    triplet: Triplet
    verdict: ValidationVerdict

    def to_dict(self) -> dict[str, Any]:
        return {
            "triplet": self.triplet.to_dict(),
            **self.verdict.to_dict(),
        }


@dataclass
class TripletValidationResult:
    passed: list[Triplet] = field(default_factory=list)
    revise: list[ValidatedTriplet] = field(default_factory=list)
    discarded: list[ValidatedTriplet] = field(default_factory=list)
    retry: dict[str, Any] = field(default_factory=dict)

    @property
    def counts(self) -> dict[str, int]:
        return {
            VALIDATION_VERDICT_PASS: len(self.passed),
            VALIDATION_VERDICT_REVISE: len(self.revise),
            VALIDATION_VERDICT_DISCARD: len(self.discarded),
        }

    def to_dict(self) -> dict[str, Any]:
        data = {
            "counts": self.counts,
            "revise": [item.to_dict() for item in self.revise],
            "discard": [item.to_dict() for item in self.discarded],
        }
        if self.retry:
            data["retry"] = self.retry
        return data


def parse_triplet_response(raw: str) -> list[Triplet]:
    """从 LLM 回复中解析三元组列表。"""
    text = (raw or "").strip()
    if not text or "无三元组提取" in text:
        return []

    block = _JSON_BLOCK_RE.search(text)
    if block:
        text = block.group(1).strip()

    payload: Any
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                payload = json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                logger.warning("Failed to parse triplet JSON: %s", text[:200])
                return []
        else:
            logger.warning("Failed to parse triplet JSON: %s", text[:200])
            return []

    items: list[Any]
    if isinstance(payload, dict):
        triples_val = payload.get("triples") or payload.get("triplets") or payload.get("relations") or []
        if triples_val == "无三元组提取":
            return []
        items = triples_val if isinstance(triples_val, list) else []
    elif isinstance(payload, list):
        items = payload
    else:
        return []

    triplets: list[Triplet] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        triplet = Triplet.from_dict(item)
        if triplet:
            triplets.append(triplet)
    return triplets


def filter_triplets(
    triplets: list[Triplet],
    asr_text: str = "",
    *,
    conceptual_focus: bool = False,
    allow_model_written_context: bool = False,
) -> list[Triplet]:
    """解析后校验与过滤。"""
    out: list[Triplet] = []
    for t in triplets:
        reason = validate_triplet(
            t,
            asr_text,
            conceptual_focus=conceptual_focus,
            allow_model_written_context=allow_model_written_context,
        )
        if reason:
            logger.debug("Triplet rejected (%s): %s", reason, t.dedupe_key)
            continue
        out.append(t)
    return out


def dedupe_triplets(triplets: list[Triplet]) -> list[Triplet]:
    seen: set[tuple[str, str, str, str]] = set()
    out: list[Triplet] = []
    for t in triplets:
        if t.dedupe_key in seen:
            continue
        seen.add(t.dedupe_key)
        out.append(t)
    return out


def is_cross_cue_extract_source(source: str) -> bool:
    """识别跨段边来源：legacy `cross_cue` 或「第N讲的第a段到第b段」。"""
    s = (source or "").strip()
    if not s:
        return False
    if s == "cross_cue" or s.startswith("cross_cue"):
        return True
    return "讲的第" in s and "段到第" in s and s.endswith("段")


def lecture_ordinal_from_id(lecture_id: str) -> str:
    """L1 / lecture_01 / 1 → 用于「第N讲」的序号字符串。"""
    m = re.search(r"(\d+)", str(lecture_id or "").strip())
    if m:
        return str(int(m.group(1)))
    return str(lecture_id or "?").strip() or "?"


def format_cross_cue_source_span(
    lecture_id: str,
    start_seg_1based: int,
    end_seg_1based: int,
) -> str:
    """跨段边来源字段：第N讲的第a段到第b段。"""
    n = lecture_ordinal_from_id(lecture_id)
    a = max(1, int(start_seg_1based))
    b = max(a, int(end_seg_1based))
    return f"第{n}讲的第{a}段到第{b}段"


def build_char_half_windows(
    lengths: Sequence[int],
    *,
    char_budget: int = 1500,
) -> list[tuple[int, int]]:
    """按字数阈值建窗，半窗滑动（下一窗从中间字符所在段落起）。

    返回 inclusive 起止下标列表 ``[(start, end), ...]``。
    - 仅含至少 2 段的窗口（单段无跨段意义；首段超阈值也会再拼一段）
    - 一旦某窗已覆盖最后一段，停止再滑（后续小窗必为子集）
    """
    n = len(lengths)
    if n < 2:
        return []
    budget = max(1, int(char_budget or 1500))
    windows: list[tuple[int, int]] = []
    start = 0
    guard = 0
    while start < n - 1 and guard < n * 4:
        guard += 1
        end = start
        total = 0
        while end < n:
            total += max(0, int(lengths[end]))
            end += 1
            # 至少 2 段后，达到字数阈值即可停
            if end - start >= 2 and total >= budget:
                break
        # [start, end) → inclusive last
        last = end - 1
        if last <= start:
            # 单段不成跨段；已无后续可拼则结束
            break
        windows.append((start, last))

        # 已含最后一段：再滑只会得到被包含的小窗，停止
        if last >= n - 1:
            break

        mid_target = total // 2
        acc = 0
        mid_idx = start
        for i in range(start, end):
            acc += max(0, int(lengths[i]))
            if acc >= mid_target:
                mid_idx = i
                break
        next_start = mid_idx if mid_idx > start else start + 1
        if next_start <= start:
            next_start = start + 1
        # 下一窗还需至少还能再拼一段
        if next_start >= n - 1:
            break
        start = next_start
    return windows


def resolve_hybrid_delta_cap(
    text: str,
    *,
    words_per_item: int = 20,
    min_items: int = 1,
    max_items: int | None = None,
) -> int | None:
    """按文本长度计算增量条数上限；返回 None 表示不设上限。

    - words_per_item>0：每 N 词 +1，再与 max_items 取较小（max_items 为正时）
    - words_per_item<=0：不按长度动态限制；若 max_items>0 则用其作固定上限，否则不封顶
    """
    max_n = int(max_items) if max_items is not None and int(max_items) > 0 else None
    if words_per_item is None or int(words_per_item) <= 0:
        return max_n
    k = max(int(min_items), count_text_words(text) // int(words_per_item))
    if max_n is not None:
        k = min(k, max_n)
    return k


def hybrid_delta_limit_instruction(cap: int | None, *, words_per_item: int = 20) -> str:
    if cap is None:
        return (
            "本段**不设条数上限，要求抽全**：逐句扫完并对照触发清单；"
            "一句多关系拆多条；教材边少时更要充分抽取；"
            "仍禁止编造，且勿与教材子图全名 SPO 重复；不要只抽前几条或过早输出空列表"
        )
    wp = int(words_per_item) if words_per_item and int(words_per_item) > 0 else 20
    return (
        f"本段建议最多输出 **{cap}** 条概念增量"
        f"（随课堂文本长度动态：约每 {wp} 词 +1；在上限内仍尽量抽全，禁止编造）"
    )


def build_textbook_spo_keys(
    textbook_triplets: Sequence[Triplet],
    *,
    match: str = "exact_fullname",
) -> set[tuple[str, str, str]]:
    """教材边 SPO 键集合。

    match:
      - exact_fullname：仅全名 SPO（默认，去重更松）
      - label：全名 + 中文主名（更严，易误伤近义表述）
    """
    keys: set[tuple[str, str, str]] = set()
    use_label = str(match or "exact_fullname").lower() in {"label", "zh", "label_or_full"}
    for t in textbook_triplets:
        keys.add(t.spo_dedupe_key)
        if use_label:
            keys.add(t.spo_label_key)
    return keys


def overlaps_textbook_spo(
    triplet: Triplet,
    textbook_spo_keys: set[tuple[str, str, str]],
    *,
    match: str = "exact_fullname",
) -> bool:
    if triplet.spo_dedupe_key in textbook_spo_keys:
        return True
    use_label = str(match or "exact_fullname").lower() in {"label", "zh", "label_or_full"}
    if use_label and triplet.spo_label_key in textbook_spo_keys:
        return True
    return False


def filter_deltas_against_textbook(
    deltas: list[Triplet],
    textbook_triplets: Sequence[Triplet],
    *,
    match: str = "exact_fullname",
) -> list[Triplet]:
    """去掉与教材子图同 SPO 的增量（忽略 concrete_relation）。"""
    if not deltas or not textbook_triplets:
        return list(deltas)
    keys = build_textbook_spo_keys(textbook_triplets, match=match)
    return [t for t in deltas if not overlaps_textbook_spo(t, keys, match=match)]


def load_course_context(workspace_dir: Path, course_id: str, cue: VideoSegment | None = None) -> str:
    """从 workspace/syllabus/ 或 cue 源视频路径推断课程背景。"""
    candidates: list[Path] = []

    if cue and cue.source_video:
        src = Path(cue.source_video)
        if len(src.parents) >= 3:
            candidates.append(src.parents[2] / "syllabus")

    if workspace_dir.is_dir():
        for ws in workspace_dir.iterdir():
            if ws.is_dir():
                candidates.append(ws / "syllabus")
        candidates.append(workspace_dir / course_id / "syllabus")

    parts: list[str] = []
    seen: set[Path] = set()
    for syllabus_dir in candidates:
        if not syllabus_dir.is_dir() or syllabus_dir in seen:
            continue
        seen.add(syllabus_dir)
        for path in sorted(syllabus_dir.glob("*")):
            if path.is_file() and path.suffix.lower() in {".txt", ".md", ".json"}:
                try:
                    content = path.read_text(encoding="utf-8").strip()
                except OSError:
                    continue
                if content:
                    parts.append(f"## {path.name}\n{content[:4000]}")

    if not parts:
        return course_id
    return "\n\n".join(parts)[:8000]


@dataclass
class TripletExtractResult:
    triplets: list[Triplet] = field(default_factory=list)
    validation: TripletValidationResult | None = None
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error


def _triplets_validation_payload(triplets: list[Triplet]) -> list[dict[str, Any]]:
    """供 LLM 校验的精简三元组列表。"""
    return [
        {
            "index": i,
            "subject": t.subject,
            "object": t.object,
            "abstract_relation": t.abstract_relation,
            "concrete_relation": t.concrete_relation,
            "statement_direction": t.statement_direction,
            "natural_statement": triplet_to_statement(t),
            "context": t.context,
        }
        for i, t in enumerate(triplets)
    ]


def _normalize_validation_verdict(item: dict[str, Any]) -> ValidationVerdict | None:
    """解析单条校验结果，兼容旧版 pass:true/false。"""
    raw_verdict = str(item.get("verdict", "")).strip().lower()
    reason = str(item.get("reason", "")).strip()
    action = str(item.get("action", "")).strip().lower()
    suggestion = str(item.get("suggestion", "")).strip()

    if raw_verdict in VALIDATION_VERDICTS:
        verdict = raw_verdict
    elif "pass" in item or "passed" in item:
        passed = bool(item.get("pass", item.get("passed", False)))
        verdict = VALIDATION_VERDICT_PASS if passed else VALIDATION_VERDICT_DISCARD
    else:
        return None

    if verdict == VALIDATION_VERDICT_REVISE:
        if action not in REVISE_ACTIONS:
            action = REVISE_ACTION_FIX
    else:
        action = ""

    return ValidationVerdict(
        verdict=verdict,
        reason=reason,
        action=action,
        suggestion=suggestion if verdict == VALIDATION_VERDICT_REVISE else "",
    )


def parse_validation_response(raw: str, count: int) -> dict[int, ValidationVerdict]:
    """解析校验回复 → {index: ValidationVerdict}。"""
    text = (raw or "").strip()
    if not text:
        return {}

    block = _JSON_BLOCK_RE.search(text)
    if block:
        text = block.group(1).strip()

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return {}
        try:
            payload = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return {}

    items = payload.get("results", []) if isinstance(payload, dict) else []
    out: dict[int, ValidationVerdict] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        idx = item.get("index")
        if not isinstance(idx, int):
            continue
        verdict = _normalize_validation_verdict(item)
        if verdict:
            out[idx] = verdict
    return out


def build_revision_feedback(
    revise: list[ValidatedTriplet],
    discarded: list[ValidatedTriplet],
    *,
    max_items: int = 12,
) -> str:
    """将校验 revise/discard 条目格式化为重抽提示反馈。"""
    lines: list[str] = []
    for label, items in (("需修改或重抽", revise), ("已舍弃", discarded)):
        for item in items:
            if len(lines) >= max_items:
                break
            t = item.triplet
            v = item.verdict
            stmt = triplet_to_statement(t)
            extra = []
            if v.action:
                extra.append(f"action={v.action}")
            if v.reason:
                extra.append(f"原因={v.reason}")
            if v.suggestion:
                extra.append(f"建议={v.suggestion}")
            suffix = f"（{'; '.join(extra)}）" if extra else ""
            lines.append(f"- [{label}] {stmt}{suffix}")
    if not lines:
        return "（无）"
    return "\n".join(lines)


def merge_validation_results(*results: TripletValidationResult) -> TripletValidationResult:
    """合并多轮校验结果（passed 去重，revise/discard 追加）。"""
    merged = TripletValidationResult()
    seen: set[tuple[str, str, str, str]] = set()
    for result in results:
        for t in result.passed:
            key = t.dedupe_key
            if key in seen:
                continue
            seen.add(key)
            merged.passed.append(t)
        merged.revise.extend(result.revise)
        merged.discarded.extend(result.discarded)
        if result.retry:
            merged.retry.update(result.retry)
    return merged


def _structural_discard_reason(triplet: Triplet, asr_text: str) -> str:
    return validate_triplet(triplet, asr_text) or "bad_entity"


def _split_validation_verdicts(
    triplets: list[Triplet],
    verdicts: dict[int, ValidationVerdict],
    *,
    default_verdict: str = VALIDATION_VERDICT_REVISE,
    default_action: str = REVISE_ACTION_REEXTRACT,
    default_reason: str = "missing_verdict",
) -> TripletValidationResult:
    result = TripletValidationResult()
    for i, triplet in enumerate(triplets):
        verdict = verdicts.get(i)
        if verdict is None:
            verdict = ValidationVerdict(
                verdict=default_verdict,
                reason=default_reason,
                action=default_action,
            )
        if verdict.verdict == VALIDATION_VERDICT_PASS:
            result.passed.append(triplet)
        elif verdict.verdict == VALIDATION_VERDICT_REVISE:
            result.revise.append(ValidatedTriplet(triplet=triplet, verdict=verdict))
        else:
            result.discarded.append(ValidatedTriplet(triplet=triplet, verdict=verdict))
    return result


# LLM 不可用时的结构回退（与 validate_triplet 一致，不做领域语义规则）
def rule_validate_triplet_semantics(triplet: Triplet, asr_text: str = "") -> str | None:
    return validate_triplet(triplet, asr_text)


@dataclass
class TripletValidator:
    """首轮：整 cue 批量校验；补救后：单条校验。"""

    llm_client: LLMClient | None = None
    api_key: str | None = None
    base_url: str | None = None
    llm_model: str | None = None
    prompt_name: str = "stage1/triplet_validate.txt"
    retry_prompt_name: str | None = None
    temperature: float = 0.0
    mock: bool = False

    def __post_init__(self) -> None:
        if self.llm_client is None:
            settings = llm_settings_from_config(
                {},
                api_key=self.api_key,
                base_url=self.base_url,
                model=self.llm_model,
            )
            self.llm_client = LLMClient(**settings)
        if not self.retry_prompt_name:
            self.retry_prompt_name = self.prompt_name

    def _validate_with_llm(
        self,
        triplets: list[Triplet],
        asr_text: str,
        *,
        prompt_name: str | None = None,
    ) -> dict[int, ValidationVerdict]:
        payload = _triplets_validation_payload(triplets)
        prompt = format_prompt(
            prompt_name or self.prompt_name,
            asr_text=asr_text,
            triplets_json=json.dumps(payload, ensure_ascii=False, indent=2),
        )
        raw = self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]
        return parse_validation_response(raw, len(triplets))

    def _structural_only_result(
        self,
        triplets: list[Triplet],
        asr_text: str,
        *,
        allow_model_written_context: bool = False,
    ) -> TripletValidationResult:
        passed = [
            t
            for t in triplets
            if validate_triplet(
                t,
                asr_text,
                allow_model_written_context=allow_model_written_context,
            )
            is None
        ]
        discarded = [
            ValidatedTriplet(
                triplet=t,
                verdict=ValidationVerdict(
                    verdict=VALIDATION_VERDICT_DISCARD,
                    reason=validate_triplet(
                        t,
                        asr_text,
                        allow_model_written_context=allow_model_written_context,
                    )
                    or "bad_entity",
                ),
            )
            for t in triplets
            if validate_triplet(
                t,
                asr_text,
                allow_model_written_context=allow_model_written_context,
            )
            is not None
        ]
        return TripletValidationResult(passed=passed, discarded=discarded)

    def validate_batch(
        self,
        triplets: list[Triplet],
        asr_text: str,
        *,
        prompt_name: str | None = None,
        allow_model_written_context: bool = False,
    ) -> TripletValidationResult:
        """首轮校验：单次 LLM 调用，校验本 cue 抽取出的全部三元组。"""
        if not triplets:
            return TripletValidationResult()
        if self.mock:
            return self._structural_only_result(
                triplets,
                asr_text,
                allow_model_written_context=allow_model_written_context,
            )
        try:
            verdicts = self._validate_with_llm(
                triplets,
                asr_text,
                prompt_name=prompt_name or self.prompt_name,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM batch triplet validation failed, fallback to structural only: %s", exc)
            return self._structural_only_result(
                triplets,
                asr_text,
                allow_model_written_context=allow_model_written_context,
            )
        return _split_validation_verdicts(triplets, verdicts)

    def validate_single(
        self,
        triplet: Triplet,
        asr_text: str,
        *,
        prompt_name: str | None = None,
        allow_model_written_context: bool = False,
    ) -> TripletValidationResult:
        """补救后校验：单次 LLM 调用，仅校验一条 fix / re_extract 结果。"""
        structural_reason = validate_triplet(
            triplet,
            asr_text,
            allow_model_written_context=allow_model_written_context,
        )
        if structural_reason:
            return TripletValidationResult(
                discarded=[
                    ValidatedTriplet(
                        triplet=triplet,
                        verdict=ValidationVerdict(
                            verdict=VALIDATION_VERDICT_DISCARD,
                            reason=structural_reason,
                        ),
                    )
                ],
            )
        if self.mock:
            return TripletValidationResult(passed=[triplet])
        try:
            verdicts = self._validate_with_llm(
                [triplet],
                asr_text,
                prompt_name=prompt_name or self.retry_prompt_name,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM single triplet validation failed, fallback to structural only: %s", exc)
            return TripletValidationResult(passed=[triplet])
        return _split_validation_verdicts([triplet], verdicts)

    def validate(self, triplets: list[Triplet], asr_text: str) -> TripletValidationResult:
        """兼容入口：多条 → 批量；单条 → 单条。"""
        if len(triplets) <= 1:
            if not triplets:
                return TripletValidationResult()
            return self.validate_single(triplets[0], asr_text)
        return self.validate_batch(triplets, asr_text)

    def filter(self, triplets: list[Triplet], asr_text: str) -> list[Triplet]:
        return self.validate_batch(triplets, asr_text).passed


@dataclass
class TripletExtractor:
    llm_client: LLMClient | None = None
    api_key: str | None = None
    base_url: str | None = None
    llm_model: str | None = None
    prompt_name: str = "stage1/subgraph_extract.txt"
    hybrid_prompt_name: str = "stage1/subgraph_hybrid_extract.txt"
    temperature: float = 0.1
    max_triplets_per_cue: int = 12
    mock: bool = False
    validate_enabled: bool = True
    validate_prompt: str = "stage1/triplet_validate.txt"
    retry_validate_prompt: str | None = None
    validate_client: LLMClient | None = None
    validate_model: str | None = None
    validate_temperature: float = 0.0
    retry_enabled: bool = True
    retry_fix_enabled: bool = True
    retry_reextract_enabled: bool = True
    retry_fix_fallback_reextract: bool = True
    max_fix_attempts: int = 3  # 每条 revise 最多 fix 次数（非整批上限）
    max_reextract_attempts: int = 3  # 每条 revise 最多 re_extract 次数
    # fix/re_extract 失败时：若原边通过结构校验则保留，避免「抽全后又被校验清零」
    retry_keep_original_on_fail: bool = True
    fix_prompt: str = "stage1/triplet_fix.txt"
    reextract_prompt: str = "stage1/triplet_reextract.txt"
    conceptual_focus: bool = False
    max_hybrid_delta_per_cue: int | None = None
    hybrid_delta_words_per_item: int = 20
    hybrid_delta_min_per_cue: int = 1
    # exact_fullname：仅全名 SPO 去重；label：全名+中文主名（更严）
    dedupe_textbook_match: str = "exact_fullname"
    # 第二轮补漏：对照已抽增量再扫一遍课堂文本
    hybrid_completeness_pass: bool = True
    hybrid_completeness_prompt_name: str = "stage1/subgraph_hybrid_extract_complete.txt"
    # KG 补全（知识点完整性；允许模型自写 context）
    kg_completion_enabled: bool = False
    kg_completion_prompt_name: str = "stage1/subgraph_kg_completion.txt"
    kg_completion_validate_prompt: str = "stage1/triplet_validate_kg_completion.txt"
    kg_completion_max_triples: int | None = None
    # 跨段抽取（单段之外的额外 pass；不改单段结果）
    cross_cue_extract_enabled: bool = False
    cross_cue_prompt_name: str = "stage1/subgraph_cross_cue_extract.txt"
    cross_cue_max_triples: int = 6
    # 字数滑动窗：累计字符阈值；半窗从中间字符所在段起（不再用相邻对 window）
    cross_cue_char_budget: int = 1500

    def _llm_extract_raw(
        self,
        text: str,
        course_context: str,
    ) -> str:
        prompt = format_prompt(
            self.prompt_name,
            course_context=course_context or "（无）",
            asr_text=text,
        )
        return self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]

    def _parse_and_filter(
        self,
        raw: str,
        text: str,
        *,
        conceptual_focus: bool | None = None,
        max_count: int | None | object = _PARSE_DEFAULT_CAP,
        allow_model_written_context: bool = False,
    ) -> list[Triplet]:
        cf = self.conceptual_focus if conceptual_focus is None else conceptual_focus
        triplets = filter_triplets(
            dedupe_triplets(parse_triplet_response(raw)),
            text,
            conceptual_focus=cf,
            allow_model_written_context=allow_model_written_context,
        )
        if max_count is _PARSE_DEFAULT_CAP:
            cap: int | None = int(self.max_triplets_per_cue)
        else:
            cap = None if max_count is None else int(max_count)  # type: ignore[arg-type]
        if cap is not None and cap > 0 and len(triplets) > cap:
            triplets = triplets[:cap]
        return triplets

    def _fix_triplet(self, item: ValidatedTriplet, text: str) -> Triplet | None:
        v = item.verdict
        prompt = format_prompt(
            self.fix_prompt,
            asr_text=text,
            triplet_json=json.dumps(self._triplet_retry_payload(item), ensure_ascii=False, indent=2),
            reason=v.reason or "（无）",
            suggestion=v.suggestion or "（无）",
        )
        try:
            raw = self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Triplet fix LLM failed: %s", exc)
            return None
        fixed = self._parse_and_filter(raw, text)
        return fixed[0] if fixed else None

    def _triplet_retry_payload(self, item: ValidatedTriplet) -> dict[str, Any]:
        return {
            "subject": item.triplet.subject,
            "object": item.triplet.object,
            "abstract_relation": item.triplet.abstract_relation,
            "concrete_relation": item.triplet.concrete_relation,
            "statement_direction": item.triplet.statement_direction,
            "natural_statement": triplet_to_statement(item.triplet),
            "context": item.triplet.context,
        }

    def _reextract_triplet(
        self,
        item: ValidatedTriplet,
        text: str,
        course_context: str,
    ) -> Triplet | None:
        v = item.verdict
        hint = v.suggestion.strip()
        hint_line = f"重抽提示：{hint}" if hint else ""
        prompt = format_prompt(
            self.reextract_prompt,
            course_context=course_context or "（无）",
            asr_text=text,
            triplet_json=json.dumps(self._triplet_retry_payload(item), ensure_ascii=False, indent=2),
            reason=v.reason or "（无）",
            hint_line=hint_line,
        )
        try:
            raw = self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Triplet re-extract LLM failed: %s", exc)
            return None
        candidates = self._parse_and_filter(raw, text)
        return candidates[0] if candidates else None

    def _try_recover_triplet(
        self,
        item: ValidatedTriplet,
        text: str,
        course_context: str,
        *,
        passed: list[Triplet],
        passed_keys: set[tuple[str, str, str, str]],
        retry_results: list[TripletValidationResult],
        retry_meta: dict[str, Any],
        action_override: str | None = None,
    ) -> bool:
        """单条补救（fix 或 re_extract），成功则写入 passed。返回是否救回。"""
        action = (action_override or item.verdict.action or REVISE_ACTION_FIX).strip().lower()
        if action == REVISE_ACTION_FIX and self.retry_fix_enabled:
            retry_meta["fix_attempted"] += 1
            candidate = self._fix_triplet(item, text)
            kind = "fix"
        elif action == REVISE_ACTION_REEXTRACT and self.retry_reextract_enabled:
            retry_meta["reextract_attempted"] += 1
            candidate = self._reextract_triplet(item, text, course_context)
            kind = "reextract"
        else:
            return False

        if not candidate:
            retry_meta[f"{kind}_failed"] += 1
            return False

        recovered = self.validator.validate_single(candidate, text)
        retry_results.append(recovered)
        if recovered.passed:
            triplet = recovered.passed[0]
            if triplet.dedupe_key not in passed_keys:
                passed.append(triplet)
                passed_keys.add(triplet.dedupe_key)
            retry_meta[f"{kind}_passed"] += 1
            return True

        retry_meta[f"{kind}_failed"] += 1
        return False

    def _keep_original_if_structural(
        self,
        item: ValidatedTriplet,
        text: str,
        *,
        passed: list[Triplet],
        passed_keys: set[tuple[str, str, str, str]],
        retry_meta: dict[str, Any],
    ) -> bool:
        """补救失败时保留结构合法的原边，避免增量被整批清零。"""
        if not self.retry_keep_original_on_fail:
            return False
        trip = item.triplet
        if trip.dedupe_key in passed_keys:
            return False
        if validate_triplet(trip, text, conceptual_focus=self.conceptual_focus):
            return False
        passed.append(trip)
        passed_keys.add(trip.dedupe_key)
        retry_meta["kept_original"] = int(retry_meta.get("kept_original") or 0) + 1
        return True

    def _run_retry(
        self,
        text: str,
        course_context: str,
        validation: TripletValidationResult,
        *,
        max_passed: int | None | object = _PARSE_DEFAULT_CAP,
    ) -> TripletValidationResult:
        """对 revise 条目逐条执行 fix 或单条 re_extract（每条独立尝试上限）。"""
        retry_meta: dict[str, Any] = {
            "fix_attempted": 0,
            "fix_passed": 0,
            "fix_failed": 0,
            "reextract_attempted": 0,
            "reextract_passed": 0,
            "reextract_failed": 0,
            "kept_original": 0,
        }
        passed = list(validation.passed)
        passed_keys = {t.dedupe_key for t in passed}
        retry_results: list[TripletValidationResult] = [validation]

        for item in validation.revise:
            action = (item.verdict.action or REVISE_ACTION_FIX).strip().lower()
            if action not in REVISE_ACTIONS:
                action = REVISE_ACTION_FIX
            # 每条 revise 先尝试 1 次主动作；失败再走 fallback / 保留原边
            # max_*_attempts 保留为同条额外重试次数（默认 3 → 实际最多试 1 次主动作以免爆炸）
            per_item_cap = 1
            recovered = False
            for _ in range(per_item_cap):
                if self._try_recover_triplet(
                    item,
                    text,
                    course_context,
                    passed=passed,
                    passed_keys=passed_keys,
                    retry_results=retry_results,
                    retry_meta=retry_meta,
                    action_override=action,
                ):
                    recovered = True
                    break
            if recovered:
                continue
            if (
                action == REVISE_ACTION_FIX
                and self.retry_fix_fallback_reextract
                and self.retry_reextract_enabled
            ):
                if self._try_recover_triplet(
                    item,
                    text,
                    course_context,
                    passed=passed,
                    passed_keys=passed_keys,
                    retry_results=retry_results,
                    retry_meta=retry_meta,
                    action_override=REVISE_ACTION_REEXTRACT,
                ):
                    recovered = True
            if not recovered:
                self._keep_original_if_structural(
                    item,
                    text,
                    passed=passed,
                    passed_keys=passed_keys,
                    retry_meta=retry_meta,
                )

        merged = merge_validation_results(*retry_results)
        if max_passed is _PARSE_DEFAULT_CAP:
            cap: int | None = int(self.max_triplets_per_cue)
        else:
            cap = None if max_passed is None else int(max_passed)  # type: ignore[arg-type]
        merged.passed = passed if cap is None or cap <= 0 else passed[:cap]
        merged.retry = retry_meta
        return merged

    def _format_delta_json_for_prompt(self, triplets: Sequence[Triplet]) -> str:
        if not triplets:
            return "（无）"
        rows = [
            {
                "subject": t.subject,
                "object": t.object,
                "abstract_relation": t.abstract_relation,
                "concrete_relation": t.concrete_relation,
            }
            for t in triplets
        ]
        return json.dumps(rows, ensure_ascii=False, indent=2)

    def _hybrid_completeness_extract(
        self,
        text: str,
        course_context: str,
        *,
        textbook_subgraph_json: str,
        known_entities_text: str,
        already: list[Triplet],
        textbook_spo_keys: set[tuple[str, str, str]],
        dedupe_against_textbook: bool,
        knowledge_points: list[str] | None = None,
    ) -> list[Triplet]:
        """第二轮补漏：在已有增量基础上再扫课堂文本。"""
        if self.mock or not self.hybrid_completeness_pass:
            return []
        prompt = format_prompt(
            self.hybrid_completeness_prompt_name,
            course_context=course_context or "（无）",
            textbook_subgraph_json=textbook_subgraph_json or "（无）",
            known_entities=known_entities_text or "（无）",
            knowledge_points=format_knowledge_points(
                [str(x).strip() for x in (knowledge_points or []) if str(x).strip()]
            ),
            asr_text=text,
            already_extracted_json=self._format_delta_json_for_prompt(already),
        )
        try:
            raw = self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Hybrid completeness LLM failed: %s", exc)
            return []

        extra = self._parse_and_filter(
            raw,
            text,
            conceptual_focus=self.conceptual_focus,
            max_count=None,
        )
        seen = {t.spo_dedupe_key for t in already}
        out: list[Triplet] = []
        for triplet in extra:
            triplet.extract_source = EXTRACT_SOURCE_LECTURE_DELTA
            if triplet.spo_dedupe_key in seen:
                continue
            if dedupe_against_textbook and overlaps_textbook_spo(
                triplet, textbook_spo_keys, match=self.dedupe_textbook_match
            ):
                continue
            seen.add(triplet.spo_dedupe_key)
            out.append(triplet)
        if out:
            logger.info(
                "Hybrid completeness pass added %d delta(s) (had %d)",
                len(out),
                len(already),
            )
        return out

    def extract_cross_cue(
        self,
        *,
        window_segments: list[tuple[str, str]],
        source_span: str,
        course_context: str,
        already: list[Triplet],
        known_entities_text: str = "",
        max_triples: int | None = None,
        # 兼容旧调用（相邻对）；优先使用 window_segments
        prev_text: str = "",
        next_text: str = "",
        prev_cue_id: str = "",
        next_cue_id: str = "",
    ) -> list[Triplet]:
        """字数窗跨段增量：不依赖原文 context，不替代单段抽取。"""
        segs = list(window_segments or [])
        if len(segs) < 2 and (prev_text or "").strip() and (next_text or "").strip():
            segs = [
                (prev_cue_id or "prev", (prev_text or "").strip()),
                (next_cue_id or "next", (next_text or "").strip()),
            ]
            if not source_span:
                source_span = f"{prev_cue_id}→{next_cue_id}"
        cleaned: list[tuple[str, str]] = []
        for cue_id, text in segs:
            t = (text or "").strip()
            if t:
                cleaned.append((str(cue_id or ""), t))
        if len(cleaned) < 2:
            return []
        if self.mock:
            return []
        cap = int(max_triples if max_triples is not None else self.cross_cue_max_triples)
        if cap <= 0:
            cap = 6
        span = (source_span or "").strip() or "跨段窗口"
        window_parts = [
            f"### 第{i}段\n{txt}" for i, (_cid, txt) in enumerate(cleaned, 1)
        ]
        window_text = "\n\n".join(window_parts)
        joined = "\n".join(txt for _, txt in cleaned)
        already_json = self._format_delta_json_for_prompt(already)
        prompt = format_prompt(
            self.cross_cue_prompt_name,
            course_context=course_context or "（无）",
            known_entities=known_entities_text or "（无）",
            already_extracted_json=already_json,
            source_span=span,
            window_text=window_text,
            max_triples=str(cap),
            # 旧 prompt 占位兼容（若仍引用）
            prev_cue_id=cleaned[0][0],
            next_cue_id=cleaned[-1][0],
            prev_text=cleaned[0][1],
            next_text=cleaned[-1][1],
        )
        try:
            raw = self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.warning("Cross-cue extract LLM failed: %s", exc)
            return []

        # 用拼接文本做结构过滤；跨段边强制清空 context，故不会因摘录校验失败
        parsed = self._parse_and_filter(
            raw,
            joined,
            conceptual_focus=self.conceptual_focus,
            max_count=cap,
        )
        seen = {t.spo_dedupe_key for t in already}
        out: list[Triplet] = []
        for triplet in parsed:
            triplet.context = ""
            triplet.extract_source = "cross_cue"
            triplet.cross_cue_span = span
            if not (triplet.description or "").strip():
                triplet.description = f"跨段衔接（{span}）"
            if triplet.spo_dedupe_key in seen:
                continue
            seen.add(triplet.spo_dedupe_key)
            out.append(triplet)
        if out:
            logger.info(
                "Cross-cue extract %s added %d",
                span,
                len(out),
            )
        return out

    def __post_init__(self) -> None:
        if self.llm_client is None:
            settings = llm_settings_from_config(
                {},
                api_key=self.api_key,
                base_url=self.base_url,
                model=self.llm_model,
            )
            self.llm_client = LLMClient(**settings)
        if self.validate_client is None:
            if self.validate_model:
                base = self.llm_client
                self.validate_client = LLMClient(
                    api_key=base.api_key,
                    base_url=base.base_url,
                    model=self.validate_model,
                    max_retry=base.max_retry,
                    retry_pause_sec=base.retry_pause_sec,
                )
            else:
                self.validate_client = self.llm_client
        self.validator = TripletValidator(
            llm_client=self.validate_client,
            prompt_name=self.validate_prompt,
            retry_prompt_name=self.retry_validate_prompt or self.validate_prompt,
            temperature=self.validate_temperature,
            mock=self.mock,
        )

    def extract(
        self,
        asr_text: str,
        course_context: str = "",
    ) -> TripletExtractResult:
        text = asr_text.strip()
        if not text:
            return TripletExtractResult(triplets=[], error="empty_text")

        if self.mock:
            return TripletExtractResult(
                triplets=[
                    Triplet(
                        subject="命题/proposition",
                        object="陈述句/declarative sentence",
                        abstract_relation="belong_to",
                        concrete_relation="属于",
                        statement_direction="subject_to_object",
                        attribute_category="关系属性",
                        description="命题属于陈述句的一种特殊形式。",
                        context="命题是一个非真即假的陈述句。",
                    )
                ],
            )

        try:
            raw = self._llm_extract_raw(text, course_context)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Triplet LLM call failed")
            return TripletExtractResult(triplets=[], error=str(exc))

        triplets = self._parse_and_filter(raw, text)
        validation: TripletValidationResult | None = None
        if self.validate_enabled and triplets:
            validation = self.validator.validate_batch(triplets, text)
            if self.retry_enabled and (validation.revise or validation.discarded):
                validation = self._run_retry(text, course_context, validation)
            triplets = validation.passed
            counts = validation.counts
            logger.info(
                "Triplet validation: pass=%d revise=%d discard=%d",
                counts[VALIDATION_VERDICT_PASS],
                counts[VALIDATION_VERDICT_REVISE],
                counts[VALIDATION_VERDICT_DISCARD],
            )
            if validation.retry:
                logger.info("Triplet retry: %s", validation.retry)
        return TripletExtractResult(triplets=triplets, validation=validation)

    def extract_hybrid(
        self,
        asr_text: str,
        course_context: str,
        *,
        textbook_subgraph_json: str,
        textbook_triplets: list[Triplet],
        dedupe_against_textbook: bool = True,
        known_entities_text: str = "",
        knowledge_points: list[str] | None = None,
    ) -> TripletExtractResult:
        """教材子图约束下的严格原文增量抽取（lecture_delta）。"""
        text = asr_text.strip()
        if not text:
            return TripletExtractResult(triplets=[], error="empty_text")

        textbook_spo_keys = (
            build_textbook_spo_keys(
                textbook_triplets, match=self.dedupe_textbook_match
            )
            if dedupe_against_textbook
            else set()
        )
        kps = [str(x).strip() for x in (knowledge_points or []) if str(x).strip()]

        if self.mock:
            delta = [
                Triplet(
                    subject="课堂例题/classroom example",
                    object="教材概念/textbook concept",
                    abstract_relation="related_with",
                    concrete_relation="举例说明",
                    statement_direction="subject_to_object",
                    attribute_category="关系属性",
                    description="课堂对教材概念的例题说明。",
                    context=text[:80],
                    extract_source="lecture_delta",
                )
            ]
            if dedupe_against_textbook:
                delta = [
                    t
                    for t in delta
                    if not overlaps_textbook_spo(
                        t, textbook_spo_keys, match=self.dedupe_textbook_match
                    )
                ]
            return TripletExtractResult(triplets=delta)

        # 增量提示词不设条数上限（忽略动态/固定封顶配置）
        cap = None
        prompt = format_prompt(
            self.hybrid_prompt_name,
            course_context=course_context or "（无）",
            textbook_subgraph_json=textbook_subgraph_json or "（无）",
            known_entities=known_entities_text or "（无）",
            knowledge_points=format_knowledge_points(kps),
            asr_text=text,
            max_delta_instruction=hybrid_delta_limit_instruction(
                None, words_per_item=self.hybrid_delta_words_per_item
            ),
            max_delta="",
        )
        try:
            raw = self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.exception("Hybrid triplet LLM call failed")
            return TripletExtractResult(triplets=[], error=str(exc))

        logger.info("Hybrid delta cap for cue text: words≈%d cap=%s", count_text_words(text), cap)
        triplets = self._parse_and_filter(
            raw,
            text,
            conceptual_focus=self.conceptual_focus,
            max_count=None,
        )
        if not triplets and (raw or "").strip():
            logger.warning(
                "Hybrid first-pass parsed 0 triples from non-empty LLM output (%d chars)",
                len(raw),
            )
        else:
            logger.info("Hybrid first-pass after parse/filter: %d", len(triplets))
        for triplet in triplets:
            triplet.extract_source = EXTRACT_SOURCE_LECTURE_DELTA

        if dedupe_against_textbook:
            before = len(triplets)
            triplets = [
                t
                for t in triplets
                if not overlaps_textbook_spo(
                    t, textbook_spo_keys, match=self.dedupe_textbook_match
                )
            ]
            if before != len(triplets):
                logger.info(
                    "Hybrid textbook SPO dedupe: %d -> %d", before, len(triplets)
                )

        # 第二轮补漏：对照已抽结果再扫全文，保证抽全
        if self.hybrid_completeness_pass:
            extras = self._hybrid_completeness_extract(
                text,
                course_context,
                textbook_subgraph_json=textbook_subgraph_json or "",
                known_entities_text=known_entities_text or "",
                already=triplets,
                textbook_spo_keys=textbook_spo_keys,
                dedupe_against_textbook=dedupe_against_textbook,
                knowledge_points=kps,
            )
            if extras:
                triplets = dedupe_triplets(triplets + extras)
            logger.info(
                "Hybrid before validate: %d (completeness added %d)",
                len(triplets),
                len(extras) if extras else 0,
            )

        validation: TripletValidationResult | None = None
        if self.validate_enabled and triplets:
            validation = self.validator.validate_batch(triplets, text)
            logger.info(
                "Hybrid validate: pass=%d revise=%d discard=%d",
                len(validation.passed),
                len(validation.revise),
                len(validation.discarded),
            )
            if self.retry_enabled and (validation.revise or validation.discarded):
                validation = self._run_retry(
                    text, course_context, validation, max_passed=None
                )
                logger.info(
                    "Hybrid after retry: pass=%d kept_original=%s",
                    len(validation.passed),
                    (validation.retry or {}).get("kept_original"),
                )
            triplets = validation.passed
            for triplet in triplets:
                triplet.extract_source = EXTRACT_SOURCE_LECTURE_DELTA
            if dedupe_against_textbook:
                triplets = [
                    t
                    for t in triplets
                    if not overlaps_textbook_spo(
                        t, textbook_spo_keys, match=self.dedupe_textbook_match
                    )
                ]

        if self.conceptual_focus:
            triplets = [t for t in triplets if not is_overly_specific_triplet(t)]
        before_delta_filter = len(triplets)
        triplets = filter_delta_triplets(
            triplets,
            text,
            conceptual_focus=self.conceptual_focus,
        )
        if before_delta_filter != len(triplets):
            logger.info(
                "Hybrid filter_delta_triplets: %d -> %d",
                before_delta_filter,
                len(triplets),
            )
        if dedupe_against_textbook:
            triplets = filter_deltas_against_textbook(
                triplets,
                textbook_triplets,
                match=self.dedupe_textbook_match,
            )

        return TripletExtractResult(triplets=triplets, validation=validation)


    def extract_kg_completion(
        self,
        asr_text: str,
        course_context: str,
        *,
        textbook_subgraph_json: str,
        textbook_triplets: list[Triplet],
        already: list[Triplet] | None = None,
        dedupe_against_textbook: bool = True,
        known_entities_text: str = "",
        knowledge_points: list[str] | None = None,
    ) -> TripletExtractResult:
        """知识点完整性 KG 补全（隐含/未点名结构边）；extract_source=kg_completion。"""
        if not self.kg_completion_enabled:
            return TripletExtractResult(triplets=[])
        text = asr_text.strip()
        if not text:
            return TripletExtractResult(triplets=[], error="empty_text")

        textbook_spo_keys = (
            build_textbook_spo_keys(
                textbook_triplets, match=self.dedupe_textbook_match
            )
            if dedupe_against_textbook
            else set()
        )
        kps = [str(x).strip() for x in (knowledge_points or []) if str(x).strip()]
        prior = list(already or [])

        if self.mock:
            return TripletExtractResult(triplets=[])

        cap = self.kg_completion_max_triples
        if cap is not None and int(cap) > 0:
            max_delta_instruction = f"本步最多输出 {int(cap)} 条补全三元组。"
        else:
            max_delta_instruction = "本步条数不设硬上限；只补真正缺失的结构边。"

        prompt = format_prompt(
            self.kg_completion_prompt_name,
            course_context=course_context or "（无）",
            textbook_subgraph_json=textbook_subgraph_json or "（无）",
            known_entities=known_entities_text or "（无）",
            knowledge_points=format_knowledge_points(kps),
            asr_text=text,
            already_extracted_json=self._format_delta_json_for_prompt(prior),
            max_delta_instruction=max_delta_instruction,
        )
        try:
            raw = self.llm_client.chat(prompt, temperature=self.temperature)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            logger.exception("KG completion LLM call failed")
            return TripletExtractResult(triplets=[], error=str(exc))

        triplets = self._parse_and_filter(
            raw,
            text,
            conceptual_focus=self.conceptual_focus,
            max_count=cap if cap is not None and int(cap) > 0 else None,
            allow_model_written_context=True,
        )
        seen = {t.spo_dedupe_key for t in prior}
        out: list[Triplet] = []
        for triplet in triplets:
            triplet.extract_source = EXTRACT_SOURCE_KG_COMPLETION
            if triplet.spo_dedupe_key in seen:
                continue
            if dedupe_against_textbook and overlaps_textbook_spo(
                triplet, textbook_spo_keys, match=self.dedupe_textbook_match
            ):
                continue
            seen.add(triplet.spo_dedupe_key)
            out.append(triplet)

        validation: TripletValidationResult | None = None
        if self.validate_enabled and out:
            validation = self.validator.validate_batch(
                out,
                text,
                prompt_name=self.kg_completion_validate_prompt,
                allow_model_written_context=True,
            )
            logger.info(
                "KG completion validate: pass=%d revise=%d discard=%d",
                len(validation.passed),
                len(validation.revise),
                len(validation.discarded),
            )
            # 补全边不做 fix/re_extract 重试；仅保留 pass
            out = list(validation.passed)
            for triplet in out:
                triplet.extract_source = EXTRACT_SOURCE_KG_COMPLETION

        if self.conceptual_focus:
            out = [t for t in out if not is_overly_specific_triplet(t)]
        before_filter = len(out)
        out = filter_delta_triplets(
            out,
            text,
            conceptual_focus=self.conceptual_focus,
            allow_model_written_context=True,
        )
        if before_filter and before_filter != len(out):
            logger.info(
                "KG completion filter_delta_triplets: %d -> %d",
                before_filter,
                len(out),
            )
        if dedupe_against_textbook:
            before_dedupe = len(out)
            out = filter_deltas_against_textbook(
                out,
                textbook_triplets,
                match=self.dedupe_textbook_match,
            )
            if before_dedupe and before_dedupe != len(out):
                logger.info(
                    "KG completion textbook SPO dedupe: %d -> %d",
                    before_dedupe,
                    len(out),
                )
        if out:
            logger.info("KG completion added %d triple(s)", len(out))
        elif before_filter:
            logger.info("KG completion kept 0 after post-validate filters")
        return TripletExtractResult(triplets=out, validation=validation)



def loose_triplet_key(subject: str, relation: str, object_: str) -> tuple[str, tuple[str, str]]:
    """无序实体对 + 关系，用于语义近邻去重。"""
    return (
        relation,
        tuple(sorted([entity_label(subject), entity_label(object_)])),
    )


def _statement_tokens(text: str) -> set[str]:
    from teachkg.textbook_kg.alias import clean_text

    stop = {"", "的", "是", "在", "与", "和", "为", "有", "对", "于"}
    return {t for t in clean_text(text).split() if t not in stop and len(t) >= 2}


def statement_jaccard(a: str, b: str) -> float:
    sa, sb = _statement_tokens(a), _statement_tokens(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def is_near_duplicate_of_merged(
    row: dict[str, Any],
    merged: list[Triplet],
    *,
    jaccard_threshold: float = 0.72,
) -> bool:
    """LLM fallback 与已有 hybrid 边语义重复则跳过。"""
    rel = str(row.get("abstract_relation") or row.get("relation", "").split("|")[0])
    loose = loose_triplet_key(row.get("subject", ""), rel, row.get("object", ""))
    stmt = str(row.get("natural_statement") or row.get("description") or "")
    for t in merged:
        if loose == loose_triplet_key(t.subject, t.abstract_relation, t.object):
            return True
        if rel == t.abstract_relation and statement_jaccard(stmt, triplet_to_statement(t)) >= jaccard_threshold:
            return True
    return False


def rank_llm_fallback_candidates(
    rows: list[dict[str, Any]],
    *,
    cue_text: str,
    merged: list[Triplet],
    existing_keys: set[tuple[str, str, str, str]],
    textbook_spo_keys: set[tuple[str, str, str]] | None = None,
    max_candidates: int = 50,
) -> list[dict[str, Any]]:
    """按 cue 相关度排序 LLM 基线候选，优先补口语化但语义不重复的概念边。"""
    from teachkg.textbook_kg.alias import clean_text

    cue_clean = clean_text(cue_text)
    spo_keys = textbook_spo_keys or set()

    def score_row(row: dict[str, Any]) -> float:
        triplet = Triplet.from_dict(row)
        if not triplet or triplet.dedupe_key in existing_keys:
            return -1.0
        if overlaps_textbook_spo(triplet, spo_keys):
            return -1.0
        if is_near_duplicate_of_merged(row, merged):
            return -1.0
        if is_overly_specific_triplet(triplet):
            return -1.0
        if is_placeholder_entity(triplet.subject) or is_placeholder_entity(triplet.object):
            return -1.0
        reason = validate_triplet(triplet, cue_text, conceptual_focus=True)
        if reason:
            return -1.0
        score = 0.0
        for part in (triplet.subject, triplet.object):
            label = entity_label(part)
            if label and label in cue_clean:
                score += 3.0
        stmt = str(row.get("natural_statement") or row.get("description") or "")
        for tok in _statement_tokens(stmt):
            if tok in cue_clean:
                score += 0.5
        if merged:
            max_j = max(statement_jaccard(stmt, triplet_to_statement(t)) for t in merged)
            if max_j >= 0.85:
                return -1.0
            if max_j >= 0.55:
                score += 1.0
        return score

    ranked = sorted(rows, key=score_row, reverse=True)
    return [r for r in ranked if score_row(r) >= 0][:max_candidates]


def build_flat_triplet_records(
    cue: VideoSegment,
    triplets: list[Triplet],
    *,
    course_id: str,
    ppt_frame_path: str = "",
    ppt_page_index: int | None = None,
    extract_source: str = "",
    extract_mode: str = "",
    ground_textbook: bool = True,
    source_text: str | None = None,
) -> list[dict[str, Any]]:
    """将 cue 级三元组展开为带溯源的 flat 记录。"""
    # 优先用实际抽取文本（预处理/OCR 拼接），避免溯源与抽取不一致
    src_excerpt = (source_text if source_text is not None else cue.asr_text) or ""
    src_excerpt = str(src_excerpt)[:500]
    records: list[dict[str, Any]] = []
    for t in triplets:
        rec: dict[str, Any] = {
            **t.to_dict(),
            "cue_id": cue.cue_id,
            "course_id": course_id,
            "lecture_id": cue.lecture_id,
            "start_sec": round(cue.start_sec, 3),
            "end_sec": round(cue.end_sec, 3),
            "source_text": src_excerpt,
        }
        source = t.extract_source or extract_source
        if is_cross_cue_extract_source(source):
            # 跨段隐含边：不挂 clip / PPT / 原文摘录（时间戳仅作讲次归属，不绑媒体）
            rec["grounding"] = "cross_cue_implicit"
            rec["source_text"] = ""
            rec["context"] = ""
            rec.pop("clip_path", None)
            if source:
                rec["extract_source"] = source
            if extract_mode:
                rec["extract_mode"] = extract_mode
            records.append(rec)
            continue
        if cue.clip_path:
            rec["clip_path"] = cue.clip_path
        if source == "textbook" and not ground_textbook:
            rec["textbook_origin"] = True
            rec["grounding"] = "textbook_via_cue"
        elif source == "textbook":
            rec["grounding"] = "textbook"
        if ppt_frame_path:
            if source == "textbook":
                rec["evidence_ppt_frame_path"] = ppt_frame_path
            else:
                rec["ppt_frame_path"] = ppt_frame_path
        if ppt_page_index is not None:
            if source == "textbook":
                rec["evidence_ppt_page_index"] = ppt_page_index
            else:
                rec["ppt_page_index"] = ppt_page_index
        if source:
            rec["extract_source"] = source
        if extract_mode:
            rec["extract_mode"] = extract_mode
        records.append(rec)
    return records
