"""Stage 3 三元组 / 局部子图抽取（并入 Stage 1 流水线）。"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from teachkg.schemas import VideoSegment
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)

_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)

VALID_ABSTRACT_RELATIONS = frozenset({
    "belong_to",
    "part_of",
    "depend_on",
    "synonym_of",
    "property_of",
    "related_with",
})

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


def validate_triplet(triplet: Triplet, asr_text: str = "") -> str | None:
    """结构校验（字段完整、格式合法）；语义质量由 LLM 校验负责。"""
    if is_bad_entity(triplet.subject) or is_bad_entity(triplet.object):
        return "bad_entity"
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
    if triplet.context and asr_text and not context_in_source(triplet.context, asr_text):
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

    def __post_init__(self) -> None:
        if self.abstract_relation and self.abstract_relation not in VALID_ABSTRACT_RELATIONS:
            self.abstract_relation = _normalize_abstract_relation(self.abstract_relation)
            if self.abstract_relation not in VALID_ABSTRACT_RELATIONS:
                self.abstract_relation = ""
        direction = normalize_statement_direction(self.statement_direction)
        if not direction and self.abstract_relation:
            direction = infer_statement_direction(self.abstract_relation)
        self.statement_direction = direction
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
        return {
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

        return cls(
            subject=subject,
            object=obj,
            abstract_relation=abstract_rel,
            concrete_relation=concrete_rel,
            statement_direction=direction_raw,
            attribute_category=attr_cat,
            description=str(data.get("description", "")).strip(),
            context=str(data.get("context", "")).strip(),
        )

    @property
    def dedupe_key(self) -> tuple[str, str, str, str]:
        return (self.subject, self.abstract_relation, self.concrete_relation, self.object)


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


def filter_triplets(triplets: list[Triplet], asr_text: str = "") -> list[Triplet]:
    """解析后校验与过滤。"""
    out: list[Triplet] = []
    for t in triplets:
        reason = validate_triplet(t, asr_text)
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
    prompt_name: str = "teaching/triplet_validate.txt"
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
        self, triplets: list[Triplet], asr_text: str
    ) -> TripletValidationResult:
        passed = [t for t in triplets if validate_triplet(t, asr_text) is None]
        discarded = [
            ValidatedTriplet(
                triplet=t,
                verdict=ValidationVerdict(
                    verdict=VALIDATION_VERDICT_DISCARD,
                    reason=_structural_discard_reason(t, asr_text),
                ),
            )
            for t in triplets
            if validate_triplet(t, asr_text) is not None
        ]
        return TripletValidationResult(passed=passed, discarded=discarded)

    def validate_batch(self, triplets: list[Triplet], asr_text: str) -> TripletValidationResult:
        """首轮校验：单次 LLM 调用，校验本 cue 抽取出的全部三元组。"""
        if not triplets:
            return TripletValidationResult()
        if self.mock:
            return self._structural_only_result(triplets, asr_text)
        try:
            verdicts = self._validate_with_llm(triplets, asr_text, prompt_name=self.prompt_name)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM batch triplet validation failed, fallback to structural only: %s", exc)
            return self._structural_only_result(triplets, asr_text)
        return _split_validation_verdicts(triplets, verdicts)

    def validate_single(self, triplet: Triplet, asr_text: str) -> TripletValidationResult:
        """补救后校验：单次 LLM 调用，仅校验一条 fix / re_extract 结果。"""
        structural_reason = validate_triplet(triplet, asr_text)
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
                prompt_name=self.retry_prompt_name,
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
    prompt_name: str = "teaching/subgraph_extract.txt"
    temperature: float = 0.1
    max_triplets_per_cue: int = 12
    mock: bool = False
    validate_enabled: bool = True
    validate_prompt: str = "teaching/triplet_validate.txt"
    retry_validate_prompt: str | None = None
    validate_client: LLMClient | None = None
    validate_model: str | None = None
    validate_temperature: float = 0.0
    retry_enabled: bool = True
    retry_fix_enabled: bool = True
    retry_reextract_enabled: bool = True
    retry_fix_fallback_reextract: bool = True
    max_fix_attempts: int = 3
    max_reextract_attempts: int = 3
    fix_prompt: str = "teaching/triplet_fix.txt"
    reextract_prompt: str = "teaching/triplet_reextract.txt"

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

    def _parse_and_filter(self, raw: str, text: str) -> list[Triplet]:
        triplets = filter_triplets(dedupe_triplets(parse_triplet_response(raw)), text)
        if len(triplets) > self.max_triplets_per_cue:
            triplets = triplets[: self.max_triplets_per_cue]
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
    ) -> bool:
        """单条补救（fix 或 re_extract），成功则写入 passed。返回是否救回。"""
        action = item.verdict.action
        if action == REVISE_ACTION_FIX and self.retry_fix_enabled:
            if retry_meta["fix_attempted"] >= self.max_fix_attempts:
                return False
            retry_meta["fix_attempted"] += 1
            candidate = self._fix_triplet(item, text)
            kind = "fix"
        elif action == REVISE_ACTION_REEXTRACT and self.retry_reextract_enabled:
            if retry_meta["reextract_attempted"] >= self.max_reextract_attempts:
                return False
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

    def _run_retry(
        self,
        text: str,
        course_context: str,
        validation: TripletValidationResult,
    ) -> TripletValidationResult:
        """对 revise 条目逐条执行 fix 或单条 re_extract。"""
        retry_meta: dict[str, Any] = {
            "fix_attempted": 0,
            "fix_passed": 0,
            "fix_failed": 0,
            "reextract_attempted": 0,
            "reextract_passed": 0,
            "reextract_failed": 0,
        }
        passed = list(validation.passed)
        passed_keys = {t.dedupe_key for t in passed}
        retry_results: list[TripletValidationResult] = [validation]

        for item in validation.revise:
            recovered = self._try_recover_triplet(
                item,
                text,
                course_context,
                passed=passed,
                passed_keys=passed_keys,
                retry_results=retry_results,
                retry_meta=retry_meta,
            )
            if recovered:
                continue
            if (
                item.verdict.action == REVISE_ACTION_FIX
                and self.retry_fix_fallback_reextract
                and self.retry_reextract_enabled
            ):
                fallback = ValidatedTriplet(
                    triplet=item.triplet,
                    verdict=ValidationVerdict(
                        verdict=VALIDATION_VERDICT_REVISE,
                        action=REVISE_ACTION_REEXTRACT,
                        reason=item.verdict.reason,
                        suggestion=item.verdict.suggestion or "fix 失败，单条重抽",
                    ),
                )
                self._try_recover_triplet(
                    fallback,
                    text,
                    course_context,
                    passed=passed,
                    passed_keys=passed_keys,
                    retry_results=retry_results,
                    retry_meta=retry_meta,
                )

        merged = merge_validation_results(*retry_results)
        merged.passed = passed[: self.max_triplets_per_cue]
        merged.retry = retry_meta
        return merged

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


def build_flat_triplet_records(
    cue: VideoSegment,
    triplets: list[Triplet],
    *,
    course_id: str,
    ppt_frame_path: str = "",
    ppt_page_index: int | None = None,
) -> list[dict[str, Any]]:
    """将 cue 级三元组展开为带溯源的 flat 记录。"""
    records: list[dict[str, Any]] = []
    for t in triplets:
        rec: dict[str, Any] = {
            **t.to_dict(),
            "cue_id": cue.cue_id,
            "course_id": course_id,
            "lecture_id": cue.lecture_id,
            "start_sec": round(cue.start_sec, 3),
            "end_sec": round(cue.end_sec, 3),
            "clip_path": cue.clip_path,
            "source_text": cue.asr_text[:500],
        }
        if ppt_frame_path:
            rec["ppt_frame_path"] = ppt_frame_path
        if ppt_page_index is not None:
            rec["ppt_page_index"] = ppt_page_index
        records.append(rec)
    return records
