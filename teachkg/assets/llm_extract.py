"""大模型抽取课堂定理/原理/方法，并用原文重叠关联图谱实体。"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

from teachkg.assets.formula_quality import formula_drop_reason, keep_generic_formulas
from teachkg.assets.relink import relink_cards
from teachkg.assets.overlap import build_entity_text_index, link_entities_by_overlap, primary_zh
from teachkg.assets.schema import (
    AssetCard,
    AssetConceptLink,
    AssetGrounding,
    empty_links,
    parse_cue_id_times,
    interpolate_evidence_time,
    validate_card,
)
from teachkg.utils.env import load_project_env
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config

logger = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).resolve().parents[2] / "prompts" / "stage1" / "asset_extract.txt"
ALLOWED_KINDS = {"theorem", "principle", "technique", "formula", "example"}


def _slug(text: str, *, max_len: int = 40) -> str:
    raw = re.sub(r"[^\w\u4e00-\u9fff]+", "_", text.strip(), flags=re.UNICODE)
    raw = re.sub(r"_+", "_", raw).strip("_").lower() or "item"
    if len(raw) > max_len:
        digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]
        raw = f"{raw[: max_len - 9]}_{digest}"
    return raw


def _extract_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    # 全角括号 → 半角
    text = text.replace("｛", "{").replace("｝", "}").replace("：", ":")

    def _try_load(s: str) -> dict[str, Any]:
        obj = json.loads(s)
        if not isinstance(obj, dict):
            raise json.JSONDecodeError("expected object", s, 0)
        return obj

    candidates = [text]
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        candidates.append(m.group(0))

    last_err: Exception | None = None
    for blob in candidates:
        for variant in (
            blob,
            blob.replace("'", '"'),
            re.sub(r"(\{|\,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', blob),
        ):
            fixed = re.sub(r",\s*}", "}", variant)
            fixed = re.sub(r",\s*]", "]", fixed)
            try:
                return _try_load(fixed)
            except json.JSONDecodeError as exc:
                last_err = exc
                continue
    assert last_err is not None
    raise last_err


_CN_HINT = re.compile(r"[\u4e00-\u9fff]{2,}")
_HINT_STOP = frozenset({"示例", "例子", "公式", "课堂", "如下", "例如", "比如"})


def _span_from_compact(src: str, compact_start: int, compact_len: int) -> str | None:
    i = 0
    orig_start: int | None = None
    orig_end: int | None = None
    for idx, ch in enumerate(src):
        if ch.isspace():
            continue
        if i == compact_start and orig_start is None:
            orig_start = idx
        i += 1
        if i == compact_start + compact_len:
            orig_end = idx + 1
            break
    if orig_start is None or orig_end is None:
        return None
    return src[orig_start:orig_end]


def _expand_span(
    src: str,
    start: int,
    end: int,
    *,
    max_len: int = 360,
    min_len: int = 120,
) -> str:
    """把命中片段扩到邻近句界；不够长则再向两侧补足，避免 recover 后只剩短句。"""
    if not src:
        return ""
    start = max(0, min(start, len(src)))
    end = max(start, min(end, len(src)))
    # 向左找句首
    left = start
    for i in range(start - 1, max(-1, start - 160), -1):
        if src[i] in "。！？!?；;\n":
            left = i + 1
            break
        left = i
    # 向右找句尾
    right = end
    for i in range(end, min(len(src), end + 280)):
        right = i + 1
        if src[i] in "。！？!?；;\n":
            break
    # 仍不够长：按字符窗口外扩（长叙述例子需要更宽窗口）
    while right - left < min_len and (left > 0 or right < len(src)):
        if left > 0:
            left = max(0, left - 40)
        if right - left < min_len and right < len(src):
            right = min(len(src), right + 80)
        if left == 0 and right == len(src):
            break
    span = src[left:right].strip()
    if len(span) > max_len:
        span = span[:max_len].rstrip()
    return span


def _fallback_span_from_hints(hints: str, src: str) -> str | None:
    """LLM 把名称当成 evidence 时，用名称里的词在口播原文里找回一段。"""
    hits: list[tuple[int, int]] = []
    for run in _CN_HINT.findall(hints or ""):
        i = 0
        while i < len(run):
            found: tuple[int, int] | None = None
            for length in range(len(run) - i, 1, -1):
                piece = run[i : i + length]
                if piece in _HINT_STOP:
                    continue
                j = src.find(piece)
                if j >= 0:
                    found = (j, j + length)
                    i += length
                    break
            if found:
                hits.append(found)
            else:
                i += 1
    uniq = sorted(set(hits), key=lambda x: x[0])
    if len(uniq) < 1:
        return None
    start = uniq[0][0]
    end = max(h[1] for h in uniq)
    span = _expand_span(src, start, end, max_len=360)
    if len(re.sub(r"\s+", "", span)) < 24:
        return None
    return span


def _ground_evidence(evidence: str, source: str, *, hints: str = "") -> str | None:
    """把 evidence 对齐回 asr 连续子串；对不上则尝试从名称找回。"""
    ev = (evidence or "").strip()
    src = source or ""
    if not ev or not src:
        return None
    if ev in src:
        return ev
    compact_ev = re.sub(r"\s+", "", ev)
    compact_src = re.sub(r"\s+", "", src)
    if compact_ev and compact_ev in compact_src:
        span = _span_from_compact(src, compact_src.find(compact_ev), len(compact_ev))
        return span or ev
    nlen = min(16, len(compact_ev))
    while nlen >= 8:
        for i in range(0, len(compact_ev) - nlen + 1):
            gram = compact_ev[i : i + nlen]
            j = compact_src.find(gram)
            if j < 0:
                continue
            span = _span_from_compact(src, j, nlen)
            if not span:
                continue
            # 短命中扩句，避免长叙述例子被截成「evidence too short」
            try:
                pos = src.find(span)
            except Exception:
                pos = -1
            if pos >= 0:
                expanded = _expand_span(src, pos, pos + len(span), max_len=360)
                if len(re.sub(r"\s+", "", expanded)) >= 24:
                    return expanded
            if len(re.sub(r"\s+", "", span)) >= 8:
                return span[:240]
        nlen -= 2
    return _fallback_span_from_hints(f"{hints} {ev}", src)


def _is_substring(evidence: str, source: str) -> bool:
    return _ground_evidence(evidence, source) is not None


def load_lecture_cues(
    cues_path: Path,
    lecture_id: str,
    *,
    text_source: str = "fluency",
) -> list[dict[str, Any]]:
    """加载讲次 cues 文本。默认优先 fluency_text（ASR 通畅稿）。

    fluency_text ≈ 校对后 asr 经 LLM-A 通畅，通常比 extract_text 更完整
    （extract 常经 B 精炼、例子被删）。缺 fluency 时回退 asr → extract。

    text_source:
      - fluency（默认）：fluency_text → asr_text → extract_text
      - asr：asr_text → extract_text
      - extract：extract_text → asr_text
      - fluency_only / asr_only / extract_only：不回退
    """
    rows: list[dict[str, Any]]
    if cues_path.suffix == ".jsonl":
        from teachkg.utils.io import load_jsonl

        rows = load_jsonl(cues_path)
    else:
        rows = json.loads(cues_path.read_text(encoding="utf-8"))
        if not isinstance(rows, list):
            raise ValueError(f"expected list cues: {cues_path}")
    out = []
    for r in rows:
        if str(r.get("lecture_id") or "") != str(lecture_id):
            continue
        s1 = r.get("stage1") if isinstance(r.get("stage1"), dict) else {}
        asr = str(r.get("asr_text") or "").strip()
        fluency = str(s1.get("fluency_text") or r.get("fluency_text") or "").strip()
        extract = str(s1.get("extract_text") or r.get("extract_text") or "").strip()
        src = (text_source or "fluency").strip().lower()
        if src in {"fluency_only"}:
            text = fluency
        elif src == "asr_only":
            text = asr
        elif src == "extract_only":
            text = extract
        elif src == "extract":
            text = extract or asr or fluency
        elif src == "asr":
            text = asr or extract or fluency
        else:
            # 默认 fluency：通畅稿优先（接近完整口播）
            text = fluency or asr or extract
        if not text:
            continue
        start = r.get("start_sec")
        end = r.get("end_sec")
        used = (
            "fluency"
            if text == fluency and fluency
            else ("asr" if text == asr and asr else "extract")
        )
        out.append(
            {
                "cue_id": str(r.get("cue_id") or "").strip(),
                "lecture_id": str(lecture_id),
                # 兼容旧字段名：调用方常用 extract_text 表示「本次抽取用正文」
                "extract_text": text,
                "asr_text": asr or text,
                "fluency_text": fluency or "",
                "text_source": used,
                "text_source_pref": src,
                "start_sec": float(start) if start is not None and str(start).strip() != "" else None,
                "end_sec": float(end) if end is not None and str(end).strip() != "" else None,
            }
        )
    return out


def load_lecture_kg(kg_path: Path) -> tuple[list[dict], list[dict]]:
    raw = json.loads(kg_path.read_text(encoding="utf-8"))
    entities = [e for e in (raw.get("entities") or []) if isinstance(e, dict)]
    edges = [e for e in (raw.get("edges") or []) if isinstance(e, dict)]
    return entities, edges


_PADDED_TECH_STEPS = {
    "明确输入与目标",
    "按方法步骤执行并检查结果",
}

# 学科无关：看结论形态，不绑具体定理名
_THEOREM_CONTENT = re.compile(
    r"(当且仅当|若.{0,30}则|对(任意|一切|所有).{0,24}(成立|为真|为假|均)|"
    r"充要条件|等价于|成立|为真|为假|证明|引理|推论|"
    r"不存在|存在|之和|两倍|等于|必有|必然|不可能)"
)
_THEOREM_NAME_DROP = re.compile(
    r"(标志着|诞生|成为一门|追溯|最新论文|Baseline|学科史|引发第.+危机)"
)
_FORMULA_CONTENT = re.compile(
    r"([=≡≈≠≤≥<>⊆⊂⊇∈∉∀∃∑∏→⇒⇔∧∨¬×·/]|\\sum|\\forall|\\exists|"
    r"\\subseteq|\\times|\\to|\\rightarrow|"
    r"n\s*[\(（]|deg|公式|等于|等于于|包含于|属于|"
    r"[A-Za-z]\s*[×\*]\s*[A-Za-z]|"
    r"[A-Za-z]\s*\(\s*[A-Za-z]|R\s*⊆|A\s*[×xX]\s*B)"
)
_PROC_IN_TEXT = re.compile(
    r"(首先|然后|接着|再|其次|最后|第一步|第二步|第三步|"
    r"步骤|依次|分别|先.{0,8}再|检查点|合并|取出|标记)"
)


def _sentence_breaks(text: str) -> int:
    return len(re.findall(r"[。！？!?；;\n]", text or ""))


def _compact_len(text: str) -> int:
    return len(re.sub(r"\s+", "", text or ""))


def _substantive_steps(steps: list[str]) -> list[str]:
    out: list[str] = []
    for s in steps or []:
        t = str(s or "").strip()
        if len(t) < 4:
            continue
        if t in _PADDED_TECH_STEPS:
            continue
        out.append(t)
    return out


def _step_grounded_in_source(step: str, compact_src: str) -> bool:
    """步骤是否能在原文找到支撑（连续片段或关键词命中）。"""
    if not compact_src:
        return False
    t = re.sub(r"^[\d\.、）\)\s]+", "", str(step or "").strip())
    t = re.sub(r"\s+", "", t)
    if len(t) < 4:
        return False
    # 连续子串：取 6–14 字滑动窗
    win = min(14, max(6, len(t) // 2))
    for i in range(0, max(1, len(t) - win + 1)):
        frag = t[i : i + win]
        if len(frag) >= 6 and frag in compact_src:
            return True
    # 关键词：去掉停用词后 ≥2 个命中
    toks = re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z]{3,}", t)
    stop = {
        "设置",
        "进行",
        "使用",
        "通过",
        "可以",
        "需要",
        "一个",
        "每个",
        "所有",
        "或者",
        "以及",
        "然后",
        "首先",
        "最后",
        "重复",
        "直到",
        "得到",
        "如果",
        "那么",
    }
    hits = 0
    for tok in toks:
        if tok in stop:
            continue
        if tok in compact_src:
            hits += 1
        if hits >= 2:
            return True
    return False


def _quality_drop_reason(
    kind: str,
    name: str,
    evidence: str,
    steps: list[str],
    source_text: str,
    *,
    latex: str = "",
    summary: str = "",
    statement: str = "",
) -> str | None:
    """返回丢弃原因；None 表示通过。"""
    zh = primary_zh(name)
    compact_src = re.sub(r"\s+", "", source_text or "")
    compact_ev = re.sub(r"\s+", "", evidence or "")

    # 禁止图谱兜底占位文案进入资源库
    if str(summary or "").strip().startswith("课堂提及的"):
        return "placeholder summary"

    # 原文依据硬门槛：必须有、足够长，且能对齐回 source（可高亮）
    if not compact_ev:
        return "missing evidence"
    if len(compact_ev) < 12:
        return "evidence too short"
    if compact_src and compact_ev not in compact_src:
        # 允许空白差异：再试一次去掉标点外的宽松包含由 _ground_evidence 处理；
        # 此处若 source 有内容却完全对不上，交给上层 grounded；质检阶段 source 常=evidence。
        if source_text and evidence and _ground_evidence(evidence, source_text) is None:
            return "evidence not in source text"

    if kind == "technique":
        # 方法必须是可执行的多步流程，禁止垫默认两步凑数
        substantive = _substantive_steps(steps)
        if len(substantive) < 2:
            return "technique needs >=2 substantive steps"
        # 原文须出现过程线索；禁止只点名算法
        if not _PROC_IN_TEXT.search(evidence or "") and not _PROC_IN_TEXT.search(
            source_text or ""
        ):
            return "technique source has no step cues"
        # ≥2 步须能在原文找到支撑，禁止补教科书常识步骤
        grounded_n = sum(
            1 for s in substantive if _step_grounded_in_source(s, compact_src)
        )
        if grounded_n < 2:
            return "technique steps not grounded in source"
        procedural = bool(
            re.search(
                r"(步骤|首先|然后|接着|再|最后|算法|方法|过程|流程|依次|分别)",
                evidence or "",
            )
            or re.search(r"(算法|方法|判定|构造|展开|翻译|证明)", zh)
        )
        if not procedural and sum(len(s) for s in substantive) < 16:
            return "technique not procedural"

    # 禁止自造「××原理」空壳：名称以原理/原则结尾，但原文无该措辞且主体未出现
    if kind == "principle":
        looks_coined = bool(re.search(r"(原理|原则)$", zh))
        has_principle_word = ("原理" in compact_src) or ("原则" in compact_src)
        stem = re.sub(r"(原理|原则)$", "", zh).strip()
        stem_hit = bool(stem) and len(stem) >= 2 and (
            stem in compact_src or stem in compact_ev
        )
        # 分类/扩展类空壳名一律丢
        if re.search(r"(分类|扩展|介绍|概述)(原理|原则)?$", zh):
            return "shell principle name"
        if looks_coined and not has_principle_word and not stem_hit:
            return "coined principle name not grounded in text"
        # 原理卡要有实质陈述，避免一句话空壳
        if _compact_len(evidence) < 24 and _compact_len(summary) < 12:
            return "principle evidence too thin"

    if kind == "theorem":
        # 「××定义」不当 theorem；真值条件需有判定措辞
        if re.search(r"定义$", zh):
            return "definition labeled as theorem"
        # 结论内容必须出现在 evidence，不能靠模型自填 statement
        if _THEOREM_NAME_DROP.search(evidence or "") and not _THEOREM_CONTENT.search(
            evidence or ""
        ):
            return "theorem name-drop without content"
        if not _THEOREM_CONTENT.search(evidence or ""):
            return "theorem missing conclusion content"
        if re.search(r"真值条件$", zh) and not re.search(
            r"(当且仅当|真假|为真|为假)", evidence or ""
        ):
            return "weak theorem without formal cue"
        if _compact_len(evidence) < 24:
            return "theorem evidence too thin"

    if kind == "formula":
        spec = formula_drop_reason(
            name,
            latex=latex,
            summary=summary,
            evidence=evidence,
        )
        if spec:
            return spec
        if not (evidence or "").strip() and not str(name).strip():
            return "formula empty"
        # 具体式子必须在 evidence/原文；latex  alone 不算（可被模型编造）
        latex_compact = re.sub(r"\s+", "", latex or "")
        latex_in_src = bool(
            latex_compact
            and len(latex_compact) >= 3
            and (
                latex_compact[: min(8, len(latex_compact))] in compact_src
                or latex_compact[: min(8, len(latex_compact))] in compact_ev
            )
        )
        has_concrete = bool(
            _FORMULA_CONTENT.search(evidence or "")
            or (compact_src and _FORMULA_CONTENT.search(source_text or ""))
            or latex_in_src
        )
        if not has_concrete:
            return "formula missing concrete expression"
        if (
            _compact_len(evidence) < 12
            and _compact_len(str(latex or "")) < 2
            and _compact_len(str(summary or "")) < 8
        ):
            return "formula too thin"
    if kind == "example":
        if len(zh) <= 1:
            return "example name too short"
        # 仅一两句随口提起的例子丢掉；保留较完整的演算/故事例
        ev_len = _compact_len(evidence)
        breaks = _sentence_breaks(evidence)
        if ev_len < 80:
            return "example evidence too short"
        if breaks < 2 and ev_len < 140:
            return "example merely mentioned"
    # 公式/例子允许短记号名（a,b,c...）；其余过短则丢
    if kind not in {"formula", "example"} and len(zh) <= 2:
        return "name too short"
    return None


def parse_llm_assets(
    raw: dict[str, Any],
    *,
    source_text: str,
    lecture_id: str,
    cue_id: str,
    timing_text: str | None = None,
) -> list[AssetCard]:
    cards: list[AssetCard] = []
    for row in raw.get("assets") or []:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind") or "").strip()
        name = str(row.get("name") or "").strip()
        evidence = str(row.get("evidence") or "").strip()
        if kind not in ALLOWED_KINDS or not name or not evidence:
            continue
        grounded = _ground_evidence(
            evidence,
            source_text,
            hints=f"{name} {row.get('summary') or ''}",
        )
        if not grounded:
            logger.warning("drop asset (evidence not in text): %s", name)
            continue
        if grounded != evidence:
            logger.info("recover evidence for %s", name)
            evidence = grounded
        summary = str(row.get("summary") or "").strip()
        statement = str(row.get("statement") or "").strip()
        steps = [str(s).strip() for s in (row.get("steps") or []) if str(s).strip()]
        if kind != "technique":
            steps = []
        latex = str(row.get("latex") or "").strip()
        reason = _quality_drop_reason(
            kind,
            name,
            evidence,
            steps,
            source_text,
            latex=latex,
            summary=summary,
            statement=statement,
        )
        if reason:
            logger.info("drop asset (%s): %s", reason, name)
            continue
        asset_id = f"llm_{kind[:4]}_{_slug(primary_zh(name))}_{_slug(cue_id)[-12:]}"
        grounding = AssetGrounding(lecture_id=str(lecture_id), cue_id=cue_id or None)
        s, e = parse_cue_id_times(cue_id)
        s, e = interpolate_evidence_time(
            evidence, timing_text or source_text, s, e
        )
        grounding.start_sec, grounding.end_sec = s, e
        card = AssetCard(
            asset_id=asset_id,
            kind=kind,
            name=name,
            aliases=[],
            summary=summary or name,
            statement=statement,
            steps=steps,
            concepts=[],
            grounding=grounding,
            source="llm",
            links=empty_links(),
            evidence=evidence,
            latex=latex,
        )
        errs = validate_card(card)
        if errs:
            logger.warning("invalid llm card %s: %s", asset_id, errs)
            continue
        cards.append(card)
    return cards


def attach_concepts_by_overlap(
    cards: list[AssetCard],
    entity_texts: dict[str, list[str]],
    *,
    min_score: float = 0.22,
    top_k: int = 2,
) -> int:
    linked = 0
    for card in cards:
        hits = link_entities_by_overlap(
            card.evidence,
            entity_texts,
            min_score=min_score,
            top_k=top_k,
        )
        # 名称命中优先：evidence 含实体中文主名的提到前面
        if hits:
            named = []
            rest = []
            ev = card.evidence or ""
            for name, score in hits:
                zh = primary_zh(name)
                if zh and zh in ev:
                    named.append((name, score + 0.15))
                else:
                    rest.append((name, score))
            ranked = sorted(named + rest, key=lambda x: (-x[1], x[0]))[:top_k]
            # 再滤一次最低分
            ranked = [(n, s) for n, s in ranked if s >= min_score]
            if ranked:
                role = "illustrates" if card.kind == "example" else (
                    "notation_of"
                    if card.kind == "formula"
                    and (
                        "..." in primary_zh(card.name)
                        or "…" in primary_zh(card.name)
                        or re.match(r"^[A-Za-z]", primary_zh(card.name) or "")
                    )
                    else "about"
                )
                card.concepts = [
                    AssetConceptLink(entity=name, role=role) for name, _s in ranked
                ]
                linked += 1
    return linked


def extract_assets_for_lecture(
    *,
    course_id: str,
    lecture_id: str,
    cues_path: Path,
    lecture_kg_path: Path,
    llm_cfg: dict[str, Any] | None = None,
    course_context: str = "",
    temperature: float = 0.1,
    min_overlap: float = 0.22,
) -> list[AssetCard]:
    load_project_env()
    cues = load_lecture_cues(Path(cues_path), str(lecture_id))
    if not cues:
        logger.warning("no cues with text for lecture %s", lecture_id)
        return []
    entities, edges = load_lecture_kg(Path(lecture_kg_path))
    entity_texts = build_entity_text_index(entities, edges)

    template = PROMPT_PATH.read_text(encoding="utf-8")
    client = LLMClient(**llm_settings_from_config(llm_cfg or {}))

    all_cards: list[AssetCard] = []
    for cue in cues:
        prompt = (
            template.replace("{course_context}", course_context or course_id)
            .replace("{lecture_id}", str(lecture_id))
            .replace("{cue_id}", cue["cue_id"])
            .replace("{extract_text}", cue["extract_text"])
        )
        try:
            raw_text = client.chat(prompt, temperature=temperature)
            data = _extract_json(raw_text)
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM asset extract failed cue=%s: %s", cue["cue_id"], exc)
            continue
        cards = parse_llm_assets(
            data,
            source_text=cue["extract_text"],
            lecture_id=str(lecture_id),
            cue_id=cue["cue_id"],
            timing_text=cue.get("asr_text") or cue["extract_text"],
        )
        all_cards.extend(cards)
        logger.info("cue %s -> %d assets", cue["cue_id"], len(cards))

    # 同名去重：保留 evidence 更长者
    by_key: dict[str, AssetCard] = {}
    for card in all_cards:
        key = f"{card.kind}\t{primary_zh(card.name)}"
        prev = by_key.get(key)
        if not prev or len(card.evidence) > len(prev.evidence):
            by_key[key] = card
    cards = list(by_key.values())
    n_linked = attach_concepts_by_overlap(
        cards, entity_texts, min_score=min_overlap, top_k=2
    )
    logger.info(
        "lecture %s llm assets=%d linked=%d entities=%d",
        lecture_id,
        len(cards),
        n_linked,
        len(entity_texts),
    )
    return cards


FORMULA_EXAMPLE_PROMPT = Path(__file__).resolve().parents[2] / "prompts" / "stage1" / "asset_extract_formula_example.txt"


def extract_formula_example_for_lecture(
    *,
    course_id: str,
    lecture_id: str,
    cues_path: Path,
    lecture_kg_path: Path,
    llm_cfg: dict[str, Any] | None = None,
    course_context: str = "",
    temperature: float = 0.1,
    min_overlap: float = 0.18,
) -> list[AssetCard]:
    """从 fluency/asr 抽公式/例子。禁止用 B 精炼后的 extract_text（例子常被删）。"""
    load_project_env()
    cues = load_lecture_cues(Path(cues_path), str(lecture_id), text_source="fluency")
    if not cues:
        logger.warning("no fluency/asr cues for lecture %s", lecture_id)
        return []
    entities, edges = load_lecture_kg(Path(lecture_kg_path))
    entity_texts = build_entity_text_index(entities, edges)
    template = FORMULA_EXAMPLE_PROMPT.read_text(encoding="utf-8")
    client = LLMClient(**llm_settings_from_config(llm_cfg or {}))

    all_cards: list[AssetCard] = []
    for cue in cues:
        text = cue["extract_text"]
        if len(re.sub(r"\s+", "", text)) < 20:
            continue
        prompt = (
            template.replace("{course_context}", course_context or course_id)
            .replace("{lecture_id}", str(lecture_id))
            .replace("{cue_id}", cue["cue_id"])
            .replace("{asr_text}", text)
        )
        try:
            raw_text = client.chat(prompt, temperature=temperature)
            data = _extract_json(raw_text)
        except Exception as exc:  # noqa: BLE001
            logger.warning("formula/example extract failed cue=%s: %s", cue["cue_id"], exc)
            continue
        cards = parse_llm_assets(
            data,
            source_text=text,
            lecture_id=str(lecture_id),
            cue_id=cue["cue_id"],
            timing_text=text,
        )
        cards = [c for c in cards if c.kind in {"formula", "example"}]
        if cue.get("start_sec") is not None:
            for c in cards:
                if c.grounding and c.grounding.start_sec is None:
                    c.grounding.start_sec = cue.get("start_sec")
                    c.grounding.end_sec = cue.get("end_sec")
        all_cards.extend(cards)
        logger.info("cue %s asr -> %d formula/example", cue["cue_id"], len(cards))

    by_key: dict[str, AssetCard] = {}
    for card in all_cards:
        key = f"{card.kind}\t{primary_zh(card.name)}"
        prev = by_key.get(key)
        if not prev or len(card.evidence or "") > len(prev.evidence or ""):
            by_key[key] = card
    cards = keep_generic_formulas(list(by_key.values()))
    n_linked = relink_cards(cards, entities, edges)
    logger.info(
        "lecture %s formula/example=%d linked=%d (source=asr_text)",
        lecture_id,
        len(cards),
        n_linked,
    )
    return cards
