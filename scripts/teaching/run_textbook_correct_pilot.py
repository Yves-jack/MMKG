#!/usr/bin/env python3
"""试点：在教材子图与增量抽取之间，用课堂文本修正教材边（默认第 1 讲）。

原则（重要）：
- **不删除、不改写**原有教材三元组的 SPO / extract_source
- 反馈只以附加字段落盘：
  - `stage1.textbook_correction`：actions / corrected_triples 视图
  - 每条原教材边上的 `classroom_correction`：{action, reason, revised?}
- `data/kg/.../triplets.jsonl` 与教材母图文件一律不动
- **修正引擎与增量一致**：`triplet_validate` →（revise 时）`triplet_fix`；
  `re_extract` 在本步映射为 drop（禁止借修正抽全新增量）

示例：
  python scripts/teaching/run_textbook_correct_pilot.py --lecture 1 --write
  python scripts/teaching/run_textbook_correct_pilot.py --lecture 1 --dry-run
  python scripts/teaching/run_textbook_correct_pilot.py --lecture 1 --restore-only --write
  python scripts/teaching/run_textbook_correct_pilot.py --lecture 1 --cue-id shuliluoji_1_808300_888100 --write
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.stage1_alignment.triplet_extract import (
    REVISE_ACTION_FIX,
    REVISE_ACTION_REEXTRACT,
    Triplet,
    TripletExtractor,
    TripletValidator,
    ValidatedTriplet,
    ValidationVerdict,
    align_property_of_fields,
    is_placeholder_entity,
    norm_concrete_relation as _norm_concrete,
)
from teachkg.textbook_kg.edge_filter import evidence_in_text
from teachkg.utils.io import load_jsonl, pretty_json_path, save_json, save_jsonl
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config

logger = logging.getLogger("textbook_correct_pilot")

PRED_OK = {
    "belong_to",
    "part_of",
    "depend_on",
    "property_of",
    "synonym_of",
    "related_with",
}

# 反馈附加字段；写回时从「原边副本」中剥掉，避免污染恢复源
_FEEDBACK_KEYS = (
    "classroom_correction",
    "correction_action",
    "correction_reason",
    "correction_from",
)


def _spo_key(subject: str, predicate: str, object_: str) -> tuple[str, str, str]:
    return (
        (subject or "").strip(),
        (predicate or "").strip(),
        (object_ or "").strip(),
    )


def _trip_spo(t: dict) -> tuple[str, str, str]:
    return _spo_key(
        str(t.get("subject") or ""),
        str(t.get("predicate") or t.get("abstract_relation") or ""),
        str(t.get("object") or ""),
    )


def _trip_readout(t: dict) -> str:
    """按 statement_direction 拼读，便于核对 property_of 等易反方向。"""
    sub = (t.get("subject") or "").strip().split("/")[0] or "?"
    obj = (t.get("object") or "").strip().split("/")[0] or "?"
    concrete = (t.get("concrete_relation") or "").strip()
    pred = (t.get("predicate") or t.get("abstract_relation") or "").strip()
    mid = concrete or pred or "—"
    direction = (t.get("statement_direction") or "subject_to_object").strip()
    if direction == "object_to_subject":
        return f"{obj} {mid} {sub}"
    return f"{sub} {mid} {obj}"


def _trip_brief(t: dict) -> dict:
    brief = {
        "subject": (t.get("subject") or "").strip(),
        "predicate": (t.get("predicate") or t.get("abstract_relation") or "").strip(),
        "object": (t.get("object") or "").strip(),
        "description": (t.get("description") or "").strip(),
        "context": (t.get("context") or "").strip(),
        "concrete_relation": (t.get("concrete_relation") or "").strip(),
        "statement_direction": (t.get("statement_direction") or "subject_to_object").strip(),
        "attribute_category": (t.get("attribute_category") or "").strip(),
        "current_readout": _trip_readout(t),
    }
    if brief["predicate"] == "property_of":
        brief["property_of_hint"] = (
            "A-property_of->B 表示 A是B的属性（subject=属性侧, object=拥有者）；"
            "current_readout 须与课堂原句语义一致"
        )
    return brief


def _strip_feedback_fields(t: dict) -> dict:
    row = dict(t)
    for k in _FEEDBACK_KEYS:
        row.pop(k, None)
    return row


def _reason_fields(act: dict) -> dict[str, str]:
    reason = str(act.get("reason") or "").strip()
    detail = str(act.get("reason_detail") or act.get("detail") or "").strip()
    evidence = str(act.get("evidence") or "").strip()
    if not detail and reason:
        detail = reason
    return {
        "reason": reason,
        "reason_detail": detail,
        "evidence": evidence,
    }


def _format_reason_text(reason: str, detail: str, evidence: str) -> str:
    parts = [p for p in (detail or reason, evidence and f"依据：{evidence}") if p]
    return "；".join(parts) if parts else ""


def _original_spo(row: dict) -> dict:
    return {
        "subject": row.get("subject"),
        "predicate": row.get("predicate") or row.get("abstract_relation"),
        "object": row.get("object"),
    }


def _row_to_triplet(row: dict) -> Triplet | None:
    """教材边 → Triplet；清空 textbook context，避免因非课堂原文被结构校验误杀。"""
    pred = (row.get("abstract_relation") or row.get("predicate") or "").strip()
    concrete = (row.get("concrete_relation") or "").strip() or "相关"
    data = {
        "subject": row.get("subject"),
        "object": row.get("object"),
        "abstract_relation": pred,
        "concrete_relation": concrete,
        "statement_direction": row.get("statement_direction") or "subject_to_object",
        "attribute_category": row.get("attribute_category") or "",
        "description": row.get("description") or "",
        # 用课堂文本校验时不携带教材 context
        "context": "",
        "extract_source": "textbook",
    }
    return Triplet.from_dict(data)


def _pick_evidence(extract: str, *candidates: str) -> str:
    for c in candidates:
        c = (c or "").strip()
        if c and evidence_in_text(c, extract):
            return c
    # keep/revise 需要可定位依据：整段处理原文是其自身子串
    return (extract or "").strip() or "本段未讲授该关系"


def _revised_dict_from_triplet(fixed: Triplet, extract: str) -> dict:
    d = fixed.to_dict()
    ctx = str(d.get("context") or "").strip()
    if not evidence_in_text(ctx, extract):
        d["context"] = _pick_evidence(extract, ctx)
    return {
        "subject": d.get("subject"),
        "object": d.get("object"),
        "abstract_relation": d.get("abstract_relation"),
        "concrete_relation": d.get("concrete_relation"),
        "statement_direction": d.get("statement_direction"),
        "attribute_category": d.get("attribute_category"),
        "description": d.get("description") or "",
        "context": d.get("context") or "",
    }


# property_of concrete↔direction / 角色纠偏（与增量抽取共用 align_property_of_fields）


def _align_property_of_action(row: dict, brief: dict | None) -> dict:
    """纠正 property_of 上 concrete↔direction 的明显错配（如「表示」+客→主）。"""
    action = str(row.get("action") or "").strip().lower()
    if action not in {"keep", "revise"}:
        return row
    pred = ""
    concrete = ""
    direction = ""
    subject = ""
    object_ = ""
    rev = row.get("revised") if isinstance(row.get("revised"), dict) else None
    if action == "revise" and rev:
        pred = str(rev.get("abstract_relation") or rev.get("predicate") or "").strip()
        concrete = _norm_concrete(str(rev.get("concrete_relation") or ""))
        direction = str(rev.get("statement_direction") or "").strip()
        subject = str(rev.get("subject") or "").strip()
        object_ = str(rev.get("object") or "").strip()
    else:
        pred = str((brief or {}).get("predicate") or "").strip()
        concrete = _norm_concrete(str((brief or {}).get("concrete_relation") or ""))
        direction = str((brief or {}).get("statement_direction") or "").strip()
        subject = str((brief or {}).get("subject") or "").strip()
        object_ = str((brief or {}).get("object") or "").strip()
    if pred != "property_of":
        return row
    new_s, new_o, new_c, new_d, changes = align_property_of_fields(
        subject=subject,
        object_=object_,
        concrete_relation=concrete,
        statement_direction=direction,
        abstract_relation="property_of",
    )
    if not changes:
        return row

    src = brief or {}
    base_rev = dict(rev) if rev else {
        "subject": src.get("subject"),
        "object": src.get("object"),
        "abstract_relation": "property_of",
        "concrete_relation": concrete or src.get("concrete_relation"),
        "attribute_category": src.get("attribute_category") or "内禀属性",
        "description": src.get("description") or "",
        "context": str(row.get("evidence") or src.get("context") or "").strip(),
    }
    base_rev["abstract_relation"] = "property_of"
    base_rev["subject"] = new_s or base_rev.get("subject")
    base_rev["object"] = new_o or base_rev.get("object")
    base_rev["concrete_relation"] = new_c or base_rev.get("concrete_relation")
    base_rev["statement_direction"] = new_d
    out = dict(row)
    out["action"] = "revise"
    out["revised"] = base_rev
    note = f"规则纠偏：property_of {','.join(changes)}（concrete「{new_c}」→ {new_d}）。"
    detail = str(out.get("reason_detail") or "").strip()
    out["reason_detail"] = f"{detail} {note}".strip() if detail else note
    if not str(out.get("reason") or "").strip():
        out["reason"] = "property_of角色或方向与concrete不配"
    return out


def _brief_by_original(act: dict, briefs: list[dict]) -> dict | None:
    orig = act.get("original") or {}
    key = _spo_key(
        str(orig.get("subject") or ""),
        str(orig.get("predicate") or orig.get("abstract_relation") or ""),
        str(orig.get("object") or ""),
    )
    for t in briefs:
        if _spo_key(t["subject"], t["predicate"], t["object"]) == key:
            return t
    return None


def _build_actions_via_validate_fix(
    *,
    textbook: list[dict],
    extract: str,
    validator: TripletValidator,
    fixer: TripletExtractor,
) -> tuple[list[dict], dict]:
    """用 triplet_validate / triplet_fix 生成 keep|drop|revise actions。"""
    actions: list[dict] = []
    meta = {
        "engine": "triplet_validate_fix",
        "placeholder_dropped": 0,
        "validate_pass": 0,
        "validate_revise": 0,
        "validate_discard": 0,
        "fix_ok": 0,
        "fix_fail_drop": 0,
        "reextract_as_drop": 0,
    }

    pending_rows: list[dict] = []
    pending_trips: list[Triplet] = []

    for row in textbook:
        trip = _row_to_triplet(row)
        if trip is None:
            actions.append(
                {
                    "action": "drop",
                    "reason": "非法教材边字段",
                    "reason_detail": "无法解析为合法 Triplet（缺主体/客体/关系等）。",
                    "evidence": "本段未讲授该关系",
                    "original": _original_spo(row),
                }
            )
            continue
        if is_placeholder_entity(trip.subject) or is_placeholder_entity(trip.object):
            meta["placeholder_dropped"] += 1
            actions.append(
                {
                    "action": "drop",
                    "reason": "占位符号实体",
                    "reason_detail": (
                        "a,b,c... / x,y,z... 等字母串占位实体不入库；"
                        "与增量侧 is_placeholder_entity 一致。"
                    ),
                    "evidence": "本段未讲授该关系",
                    "original": _original_spo(row),
                }
            )
            continue
        pending_rows.append(row)
        pending_trips.append(trip)

    if not pending_trips:
        return actions, meta

    result = validator.validate_batch(pending_trips, extract)
    meta["validate_pass"] = len(result.passed)
    meta["validate_revise"] = len(result.revise)
    meta["validate_discard"] = len(result.discarded)

    # 按下标对齐：validate 内部保持输入顺序拆分
    by_spo_row = {_trip_spo(r): r for r in pending_rows}

    def _row_for_trip(t: Triplet) -> dict | None:
        key = _spo_key(t.subject, t.abstract_relation, t.object)
        row = by_spo_row.get(key)
        if row:
            return row
        # concrete 可能被默认填充，放宽匹配
        for r in pending_rows:
            if (r.get("subject") or "") == t.subject and (r.get("object") or "") == t.object:
                pred = (r.get("abstract_relation") or r.get("predicate") or "").strip()
                if pred == t.abstract_relation:
                    return r
        return None

    for t in result.passed:
        row = _row_for_trip(t) or {}
        actions.append(
            {
                "action": "keep",
                "reason": "校验通过",
                "reason_detail": "triplet_validate: pass（课堂原文支撑该教材边）。",
                "evidence": _pick_evidence(extract, row.get("context") or ""),
                "original": _original_spo(row) if row else {
                    "subject": t.subject,
                    "predicate": t.abstract_relation,
                    "object": t.object,
                },
            }
        )

    for item in result.discarded:
        t = item.triplet
        row = _row_for_trip(t) or {}
        reason = item.verdict.reason or "校验丢弃"
        actions.append(
            {
                "action": "drop",
                "reason": reason[:30],
                "reason_detail": f"triplet_validate: discard。{reason}",
                "evidence": "本段未讲授该关系",
                "original": _original_spo(row) if row else {
                    "subject": t.subject,
                    "predicate": t.abstract_relation,
                    "object": t.object,
                },
            }
        )

    for item in result.revise:
        t = item.triplet
        row = _row_for_trip(t) or {}
        orig = _original_spo(row) if row else {
            "subject": t.subject,
            "predicate": t.abstract_relation,
            "object": t.object,
        }
        v = item.verdict
        action = (v.action or REVISE_ACTION_FIX).strip().lower()
        if action == REVISE_ACTION_REEXTRACT:
            meta["reextract_as_drop"] += 1
            actions.append(
                {
                    "action": "drop",
                    "reason": (v.reason or "需重抽")[:30],
                    "reason_detail": (
                        "triplet_validate 建议 re_extract；教材修正步禁止抽全新增量，改为 drop。"
                        + (f" 原建议：{v.suggestion}" if v.suggestion else "")
                    ),
                    "evidence": "本段未讲授该关系",
                    "original": orig,
                }
            )
            continue

        # fix
        fixed = fixer._fix_triplet(item, extract)
        if not fixed:
            meta["fix_fail_drop"] += 1
            actions.append(
                {
                    "action": "drop",
                    "reason": "fix失败",
                    "reason_detail": (
                        f"triplet_fix 无有效输出。validate reason={v.reason}；"
                        f"suggestion={v.suggestion}"
                    ),
                    "evidence": "本段未讲授该关系",
                    "original": orig,
                }
            )
            continue

        recheck = validator.validate_single(fixed, extract)
        if not recheck.passed:
            meta["fix_fail_drop"] += 1
            detail = ""
            if recheck.revise:
                detail = recheck.revise[0].verdict.reason
            elif recheck.discarded:
                detail = recheck.discarded[0].verdict.reason
            actions.append(
                {
                    "action": "drop",
                    "reason": "fix后复验未通过",
                    "reason_detail": (
                        f"triplet_fix 后单条校验未 pass。{detail}；"
                        f"原 validate：{v.reason}"
                    ),
                    "evidence": "本段未讲授该关系",
                    "original": orig,
                }
            )
            continue

        meta["fix_ok"] += 1
        revised = _revised_dict_from_triplet(fixed, extract)
        actions.append(
            {
                "action": "revise",
                "reason": (v.reason or "校验需修改")[:30],
                "reason_detail": (
                    f"triplet_validate→fix。reason={v.reason}；"
                    f"suggestion={v.suggestion}"
                ),
                "evidence": _pick_evidence(extract, revised.get("context") or ""),
                "original": orig,
                "revised": revised,
            }
        )

    # property_of 方向纠偏
    briefs = [_trip_brief(t) for t in textbook]
    aligned: list[dict] = []
    for act in actions:
        aligned.append(_align_property_of_action(act, _brief_by_original(act, briefs)))
    return aligned, meta


def _apply_actions(textbook: list[dict], actions: list[dict]) -> tuple[list[dict], dict]:
    """由 actions 生成「修正后视图」三元组（不写回原边 SPO）。"""
    by_spo = {_trip_spo(t): t for t in textbook}
    used: set[tuple[str, str, str]] = set()
    out: list[dict] = []
    stats = {"keep": 0, "drop": 0, "revise": 0, "fallback_keep": 0}

    for act in actions:
        if not isinstance(act, dict):
            continue
        action = str(act.get("action") or "keep").strip().lower()
        orig = act.get("original") or {}
        key = _spo_key(
            str(orig.get("subject") or ""),
            str(orig.get("predicate") or orig.get("abstract_relation") or ""),
            str(orig.get("object") or ""),
        )
        src = by_spo.get(key)
        if src is None:
            continue
        used.add(key)
        rf = _reason_fields(act)
        reason_full = _format_reason_text(rf["reason"], rf["reason_detail"], rf["evidence"])

        if action == "drop":
            stats["drop"] += 1
            continue

        if action == "revise":
            rev = act.get("revised") or {}
            sub = str(rev.get("subject") or src.get("subject") or "").strip()
            obj = str(rev.get("object") or src.get("object") or "").strip()
            pred = str(
                rev.get("abstract_relation")
                or rev.get("predicate")
                or src.get("predicate")
                or src.get("abstract_relation")
                or ""
            ).strip()
            if not sub or not obj or pred not in PRED_OK:
                # 严格：非法 revise 改为丢弃，不再 fallback keep
                stats["drop"] += 1
                continue
            row = {
                "subject": sub,
                "object": obj,
                "predicate": pred,
                "abstract_relation": pred,
                "concrete_relation": str(
                    rev.get("concrete_relation") or src.get("concrete_relation") or ""
                ).strip(),
                "statement_direction": str(
                    rev.get("statement_direction")
                    or src.get("statement_direction")
                    or "subject_to_object"
                ).strip(),
                "attribute_category": str(
                    rev.get("attribute_category")
                    or ("内禀属性" if pred == "property_of" else "关系属性")
                ).strip(),
                "description": str(rev.get("description") or src.get("description") or "").strip(),
                "context": str(
                    rev.get("context") or rf["evidence"] or src.get("context") or ""
                ).strip(),
                "extract_source": "textbook",
                "correction_action": "revise",
                "correction_reason": reason_full,
                "correction_reason_short": rf["reason"],
                "correction_reason_detail": rf["reason_detail"],
                "correction_evidence": rf["evidence"],
                "correction_from": {
                    "subject": src.get("subject"),
                    "predicate": src.get("predicate") or src.get("abstract_relation"),
                    "object": src.get("object"),
                    "concrete_relation": src.get("concrete_relation") or "",
                    "statement_direction": src.get("statement_direction") or "",
                    "abstract_relation": src.get("abstract_relation")
                    or src.get("predicate")
                    or "",
                    "description": src.get("description") or "",
                    "context": src.get("context") or "",
                },
            }
            out.append(row)
            stats["revise"] += 1
            continue

        row = _strip_feedback_fields(src)
        row["extract_source"] = "textbook"
        row["correction_action"] = "keep"
        if rf["evidence"]:
            row["context"] = rf["evidence"]
        if reason_full:
            row["correction_reason"] = reason_full
            row["correction_reason_short"] = rf["reason"]
            row["correction_reason_detail"] = rf["reason_detail"]
            row["correction_evidence"] = rf["evidence"]
        out.append(row)
        stats["keep"] += 1

    for key, src in by_spo.items():
        if key in used:
            continue
        # 严格模式：漏掉的边不再默认保留
        stats["drop"] += 1

    return out, stats


def _annotate_original_edges(textbook: list[dict], actions: list[dict]) -> None:
    """在原教材边上附加 classroom_correction，不改 SPO。"""
    by_spo = {_trip_spo(t): t for t in textbook}
    used: set[tuple[str, str, str]] = set()

    for act in actions:
        if not isinstance(act, dict):
            continue
        action = str(act.get("action") or "keep").strip().lower()
        if action not in {"keep", "drop", "revise"}:
            action = "keep"
        orig = act.get("original") or {}
        key = _spo_key(
            str(orig.get("subject") or ""),
            str(orig.get("predicate") or orig.get("abstract_relation") or ""),
            str(orig.get("object") or ""),
        )
        src = by_spo.get(key)
        if src is None:
            continue
        used.add(key)
        rf = _reason_fields(act)
        note: dict = {
            "action": action,
            "reason": rf["reason"],
            "reason_detail": rf["reason_detail"],
            "evidence": rf["evidence"],
        }
        if action == "revise" and isinstance(act.get("revised"), dict):
            note["revised"] = act["revised"]
        src["classroom_correction"] = note

    for key, src in by_spo.items():
        if key in used:
            continue
        src["classroom_correction"] = {
            "action": "drop",
            "reason": "模型未返回且无依据",
            "reason_detail": "严格模式：模型未给出对应 action，不默认保留。",
            "evidence": "本段未讲授该关系",
        }


def restore_lecture_textbook_from_kg(
    all_cues: list[dict],
    *,
    course: str,
    lecture: str,
) -> int:
    """用 kg/triplets.jsonl 恢复 cue 内教材边（SPO 原样），再按已有反馈字段重标。"""
    kg_path = ROOT / "data/kg" / course / "triplets.jsonl"
    by_cue_tb: dict[str, list[dict]] = defaultdict(list)
    for t in load_jsonl(kg_path):
        if str(t.get("lecture_id")) != lecture:
            continue
        if (t.get("extract_source") or "") != "textbook":
            continue
        by_cue_tb[str(t.get("cue_id"))].append(_strip_feedback_fields(t))

    restored = 0
    for cue in all_cues:
        if str(cue.get("lecture_id")) != lecture:
            continue
        cid = str(cue.get("cue_id"))
        originals = [dict(t) for t in by_cue_tb.get(cid, [])]
        non_tb = [
            t
            for t in (cue.get("triplets") or [])
            if (t.get("extract_source") or "") != "textbook"
        ]
        corr = ((cue.get("stage1") or {}).get("textbook_correction") or {})
        actions = list(corr.get("actions") or [])
        if originals and actions and not corr.get("skipped"):
            _annotate_original_edges(originals, actions)
        before = sum(
            1
            for t in (cue.get("triplets") or [])
            if (t.get("extract_source") or "") == "textbook"
        )
        cue["triplets"] = originals + non_tb
        after = len(originals)
        if before != after or any(
            t.get("correction_action") or t.get("correction_from")
            for t in (cue.get("triplets") or [])
            if (t.get("extract_source") or "") == "textbook"
        ):
            restored += 1
            logger.info(
                "restore cue=%s textbook_edges %d -> %d (from kg)",
                cid,
                before,
                after,
            )
    return restored


def correct_cue(
    client: LLMClient,
    *,
    cue: dict,
    course_context: str,
    temperature: float,
    dry_run: bool,
    validator: TripletValidator | None = None,
    fixer: TripletExtractor | None = None,
    parse_retries: int = 2,
) -> dict | None:
    _ = course_context, parse_retries  # 保留 CLI 兼容；引擎已统一为 validate/fix
    trips = list(cue.get("triplets") or [])
    textbook = [
        t
        for t in trips
        if (t.get("extract_source") or "") == "textbook"
    ]
    s1 = dict(cue.get("stage1") or {})
    extract = (s1.get("extract_text") or cue.get("asr_text") or "").strip()
    if not textbook:
        s1["textbook_correction"] = {
            "skipped": True,
            "reason": "no_textbook_edges",
            "stats": {"keep": 0, "drop": 0, "revise": 0},
            "actions": [],
            "input_triples": [],
            "corrected_triples": [],
        }
        cue["stage1"] = s1
        return cue

    if not extract:
        s1["textbook_correction"] = {
            "skipped": True,
            "reason": "empty_extract_text",
            "stats": {"keep": len(textbook), "drop": 0, "revise": 0},
            "actions": [],
            "input_triples": [_trip_brief(t) for t in textbook],
            "corrected_triples": [
                _trip_brief(t)
                | {"extract_source": "textbook", "correction_action": "keep"}
                for t in textbook
            ],
        }
        cue["stage1"] = s1
        _annotate_original_edges(
            textbook,
            [
                {
                    "action": "keep",
                    "reason": "empty_extract_text",
                    "original": {
                        "subject": t.get("subject"),
                        "predicate": t.get("predicate") or t.get("abstract_relation"),
                        "object": t.get("object"),
                    },
                }
                for t in textbook
            ],
        )
        return cue

    briefs = [_trip_brief(t) for t in textbook]
    if dry_run:
        logger.info(
            "dry-run cue=%s textbook_edges=%d extract_chars=%d engine=validate_fix",
            cue.get("cue_id"),
            len(textbook),
            len(extract),
        )
        return None

    if validator is None:
        validator = TripletValidator(llm_client=client, temperature=0.0)
    if fixer is None:
        fixer = TripletExtractor(
            llm_client=client,
            temperature=temperature,
            validate_enabled=True,
            retry_fix_enabled=True,
            retry_reextract_enabled=False,
        )

    actions, engine_meta = _build_actions_via_validate_fix(
        textbook=textbook,
        extract=extract,
        validator=validator,
        fixer=fixer,
    )

    corrected, stats = _apply_actions(textbook, actions)
    _annotate_original_edges(textbook, actions)

    s1["textbook_correction"] = {
        "skipped": False,
        "strict": True,
        "stats": stats,
        "actions": actions,
        "input_triples": briefs,
        "corrected_triples": corrected,
        "input_count": len(textbook),
        "output_count": len(corrected),
        "overlay_only": True,
        **engine_meta,
    }
    cue["stage1"] = s1
    cue["triplets"] = trips
    logger.info(
        "cue=%s keep=%d drop=%d revise=%d out=%d "
        "(validate/fix placeholder=%d fix_ok=%d fix_fail=%d)",
        cue.get("cue_id"),
        stats["keep"],
        stats["drop"],
        stats["revise"],
        len(corrected),
        engine_meta.get("placeholder_dropped", 0),
        engine_meta.get("fix_ok", 0),
        engine_meta.get("fix_fail_drop", 0),
    )
    return cue


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--course", default="shuliluoji")
    parser.add_argument("--lecture", default="1")
    parser.add_argument("--limit", type=int, default=0, help="仅处理前 N 个有教材边的 cue（0=全部）")
    parser.add_argument("--temperature", type=float, default=0.1)
    parser.add_argument(
        "--parse-retries",
        type=int,
        default=2,
        help="（已弃用）旧一站式 JSON 重试参数；现引擎为 validate/fix，保留仅兼容 CLI",
    )
    parser.add_argument(
        "--cue-id",
        action="append",
        default=[],
        help="只处理指定 cue_id（可重复）；默认处理本讲全部",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--write", action="store_true", help="写回 filtered_cues.jsonl")
    parser.add_argument(
        "--restore-only",
        action="store_true",
        help="仅从 kg/triplets.jsonl 恢复本讲教材边并重标已有反馈，不调用 LLM",
    )
    args = parser.parse_args()

    cfg = TeachKGConfig.from_yaml(ROOT / "configs/teaching.yaml")
    cues_path = ROOT / "data/processed" / args.course / "filtered_cues.jsonl"
    all_cues = load_jsonl(cues_path)
    lecture = str(args.lecture)
    targets = [c for c in all_cues if str(c.get("lecture_id")) == lecture]
    targets.sort(key=lambda r: float(r.get("start_sec") or 0))
    if args.cue_id:
        want = {str(x) for x in args.cue_id}
        targets = [c for c in targets if str(c.get("cue_id")) in want]
        if not targets:
            raise SystemExit(f"no cues matched --cue-id {sorted(want)}")

    # 先恢复：避免上次错误替换导致原边丢失
    n_restored = restore_lecture_textbook_from_kg(
        all_cues, course=args.course, lecture=lecture
    )
    if n_restored:
        logger.info("restored textbook edges on %d cues from kg", n_restored)

    if args.restore_only:
        if not args.write:
            print("restore-only 预览完成；加 --write 落盘。")
            return
        save_jsonl(cues_path, all_cues)
        save_json(pretty_json_path(cues_path), all_cues)
        out_dir = ROOT / "data/processed" / args.course / "textbook_correction"
        out_dir.mkdir(parents=True, exist_ok=True)
        lec_rows = [c for c in all_cues if str(c.get("lecture_id")) == lecture]
        backup = out_dir / f"lecture_{lecture}.json"
        backup.write_text(json.dumps(lec_rows, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"restored+wrote {cues_path}")
        print(f"wrote {backup} cues={len(lec_rows)}")
        return

    course_context = str(
        cfg.get("project", "course_context", default="")
        or cfg.get("course", "name", default="")
        or args.course
    )

    client = LLMClient(**llm_settings_from_config(cfg.get("llm", default={})))
    validate_cfg = cfg.get("stage1", "triplet_extract", "validate", default={}) or {}
    retry_cfg = (validate_cfg.get("retry") if isinstance(validate_cfg, dict) else None) or {}
    validator = TripletValidator(
        llm_client=client,
        prompt_name=str(validate_cfg.get("prompt") or "stage1/triplet_validate.txt"),
        retry_prompt_name=validate_cfg.get("retry_prompt") or None,
        temperature=float(validate_cfg.get("temperature", 0.0) or 0.0),
    )
    fixer = TripletExtractor(
        llm_client=client,
        temperature=args.temperature,
        fix_prompt=str(retry_cfg.get("fix_prompt") or "stage1/triplet_fix.txt"),
        retry_fix_enabled=True,
        retry_reextract_enabled=False,
        conceptual_focus=True,
    )

    processed = 0
    by_id = {str(c.get("cue_id")): c for c in all_cues}
    for cue in targets:
        # targets 与 all_cues 是同一对象引用（restore 已改）
        tb_n = sum(
            1
            for t in (cue.get("triplets") or [])
            if (t.get("extract_source") or "") == "textbook"
        )
        if tb_n == 0 and args.limit:
            out = correct_cue(
                client,
                cue=cue,
                course_context=course_context,
                temperature=args.temperature,
                dry_run=args.dry_run,
                validator=validator,
                fixer=fixer,
                parse_retries=args.parse_retries,
            )
            if out and not args.dry_run:
                by_id[str(cue.get("cue_id"))] = out
            continue
        if tb_n > 0 and args.limit and processed >= args.limit:
            continue
        out = correct_cue(
            client,
            cue=cue,
            course_context=course_context,
            temperature=args.temperature,
            dry_run=args.dry_run,
            validator=validator,
            fixer=fixer,
            parse_retries=args.parse_retries,
        )
        if tb_n > 0:
            processed += 1
        if out and not args.dry_run:
            by_id[str(cue.get("cue_id"))] = out

    if args.dry_run:
        print(f"dry-run done lecture={lecture} cues={len(targets)}")
        return

    if not args.write:
        print("未加 --write，结果未落盘。预览已打日志。")
        return

    merged = [by_id[str(c.get("cue_id"))] for c in all_cues]
    save_jsonl(cues_path, merged)
    save_json(pretty_json_path(cues_path), merged)
    out_dir = ROOT / "data/processed" / args.course / "textbook_correction"
    out_dir.mkdir(parents=True, exist_ok=True)
    lec_rows = [c for c in merged if str(c.get("lecture_id")) == lecture]
    backup = out_dir / f"lecture_{lecture}.json"
    backup.write_text(json.dumps(lec_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {cues_path}")
    print(f"wrote {backup} cues={len(lec_rows)}")


if __name__ == "__main__":
    main()
