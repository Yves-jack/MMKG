#!/usr/bin/env python
"""教材母图试点重抽：只抽选定章节切片，写入独立目录，不覆盖现有 KG，并输出对比分析。

示例：
  python scripts/teaching/pilot_textbook_reextract.py
  python scripts/teaching/pilot_textbook_reextract.py --preset ch1-ch4
  python scripts/teaching/pilot_textbook_reextract.py --preset gaps
  python scripts/teaching/pilot_textbook_reextract.py --preset logic-expand
  python scripts/teaching/pilot_textbook_reextract.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger("pilot_textbook_reextract")

DEFAULT_MD = (
    ROOT.parent
    / "AutoEduKG/new_output/output-former/CS2501-离散数学（数理逻辑与集合论）"
    / "cleaned-md-file/数理逻辑与集合论.md"
)
DEFAULT_MD_FALLBACK = (
    ROOT.parent
    / "AutoEduKG/data/md-former/CS2501-离散数学（数理逻辑与集合论）/数理逻辑与集合论.md"
)
if not DEFAULT_MD.is_file():
    DEFAULT_MD = DEFAULT_MD_FALLBACK
DEFAULT_BASELINE = ROOT / "data/textbook/CS2501-离散数学（数理逻辑与集合论）"
DEFAULT_OUT = ROOT / "data/textbook/_pilot_reextract/CS2501-ch1-ch4-basic"

# 小范围试点：第1章基础 + 第4章基础
SECTIONS_BASIC = [
    "1.1 命题",
    "1.2 命题联结词及真值表",
    "1.3 合式公式",
    "1.4 重言式",
    "4.1 谓词和个体词",
    "4.2 函数和量词",
    "4.3 合式公式",
]

# 扩大试点：第1章 + 第4章全书（仍不覆盖原母图）
SECTIONS_CH1_CH4 = [
    "1.1 命题",
    "1.2 命题联结词及真值表",
    "1.3 合式公式",
    "1.4 重言式",
    "1.5 命题形式化",
    "1.6 波兰表达式",
    "4.1 谓词和个体词",
    "4.2 函数和量词",
    "4.3 合式公式",
    "4.4 自然语句的形式化",
    "4.5 有限域下公式",
    "4.6 公式的普遍有效性和判定问题",
]

# 覆盖缺口补抽：同义、次要联结词、形式化
SECTIONS_GAPS = [
    "1.1 命题",
    "1.2 命题联结词及真值表",
    "1.4 重言式",
    "1.5 命题形式化",
    "1.6 波兰表达式",
    "4.4 自然语句的形式化",
]

PRESETS = {
    "basic": {
        "sections": SECTIONS_BASIC,
        "out": ROOT / "data/textbook/_pilot_reextract/CS2501-ch1-ch4-basic",
        "merge_from": None,
    },
    "ch1-ch4": {
        "sections": SECTIONS_CH1_CH4,
        "out": ROOT / "data/textbook/_pilot_reextract/CS2501-ch1-ch4-full",
        "merge_from": None,
    },
    "gaps": {
        "sections": SECTIONS_GAPS,
        "out": ROOT / "data/textbook/_pilot_reextract/CS2501-ch1-ch4-full-v2",
        "merge_from": ROOT / "data/textbook/_pilot_reextract/CS2501-ch1-ch4-full",
    },
    # 扩到命题/谓词逻辑剩余章，合并已有第1+4章 v2
    "logic-expand": {
        "chapters": [2, 3, 5, 6],
        "min_chars": 300,
        "sections": None,
        "out": ROOT / "data/textbook/_pilot_reextract/CS2501-logic-ch1-6",
        "merge_from": ROOT / "data/textbook/_pilot_reextract/CS2501-ch1-ch4-full-v2",
    },
    # 第1–6章全量重抽（含 concrete_relation），不覆盖旧试点
    "logic-all": {
        "chapters": [1, 2, 3, 4, 5, 6],
        "min_chars": 300,
        "sections": None,
        "out": ROOT / "data/textbook/_pilot_reextract/CS2501-logic-ch1-6-concrete",
        "merge_from": None,
    },
}

GENERIC_HUBS = {
    "公式",
    "集合",
    "证明",
    "定理",
    "公理",
    "定义",
    "关系",
    "函数",
    "性质",
}


def zh_name(entity: str) -> str:
    return (entity or "").split("/")[0].strip()


def split_markdown_sections(text: str) -> list[dict]:
    """按 ## / ### 标题切段，返回 {title, level, text}。"""
    pattern = re.compile(r"^(#{2,3})\s+(.+?)\s*$", re.M)
    matches = list(pattern.finditer(text))
    sections: list[dict] = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        title = re.sub(r"\s+", " ", m.group(2)).strip()
        # 去掉页码尾巴「 69」
        title = re.sub(r"\s+\d+\s*$", "", title).strip()
        body = text[start:end].strip()
        sections.append(
            {
                "title": title,
                "level": len(m.group(1)),
                "text": body,
                "char_len": len(body),
            }
        )
    return sections


def select_pilot_sections(sections: list[dict], wanted: list[str]) -> list[dict]:
    out = []
    for w in wanted:
        key = w.strip()
        # 优先精确包含「1.1」「4.2」等节号
        num = key.split()[0]
        hit = None
        for s in sections:
            title = s["title"]
            if title.startswith(num) or f" {num} " in f" {title} ":
                hit = s
                break
        if hit is None:
            for s in sections:
                if key in s["title"]:
                    hit = s
                    break
        if hit is None:
            logger.warning("section not found: %s", key)
            continue
        out.append({**hit, "pilot_key": key})
    return out


def select_by_chapters(
    sections: list[dict],
    chapters: list[int],
    min_chars: int = 300,
) -> list[dict]:
    """按章号自动选取编号小节（如 2.1、5.6），跳过过短标题段。"""
    ch_set = set(chapters)
    out: list[dict] = []
    seen_keys: set[str] = set()
    for s in sections:
        m = re.match(r"^(\d+(?:\.\d+)*)\s+", s["title"])
        if not m:
            continue
        num = m.group(1)
        ch = int(num.split(".")[0])
        if ch not in ch_set:
            continue
        if s["char_len"] < min_chars:
            continue
        # 跳过纯「举例」且较短的演算展示（概念少）；长举例仍保留
        title = s["title"]
        if "举例" in title and s["char_len"] < 1500:
            continue
        key = title
        if key in seen_keys:
            continue
        seen_keys.add(key)
        out.append({**s, "pilot_key": key})
    return out


def parse_triples(raw: str) -> list[dict]:
    from teachkg.utils.llm_client import LLMClient as _C

    data = _C.parse_json_response(raw)
    if data is None:
        return []
    if isinstance(data, dict):
        triples = data.get("triples") or data.get("triplets") or []
    elif isinstance(data, list):
        triples = data
    else:
        triples = []
    out = []
    for t in triples:
        if not isinstance(t, dict):
            continue
        sub = (t.get("subject") or "").strip()
        obj = (t.get("object") or "").strip()
        pred = (
            t.get("abstract_relation")
            or t.get("predicate")
            or t.get("relation")
            or ""
        ).strip()
        if not sub or not obj or not pred:
            continue
        concrete = (t.get("concrete_relation") or t.get("concrete") or "").strip()
        direction = (t.get("statement_direction") or "subject_to_object").strip()
        if direction not in {"subject_to_object", "object_to_subject"}:
            direction = "subject_to_object"
        attr = (t.get("attribute_category") or "").strip()
        if not attr:
            attr = "内禀属性" if pred == "property_of" else "关系属性"
        out.append(
            {
                "subject": sub,
                "predicate": pred,
                "abstract_relation": pred,
                "object": obj,
                "concrete_relation": concrete,
                "statement_direction": direction,
                "attribute_category": attr,
                "description": (t.get("description") or "").strip(),
                "context": (t.get("context") or "").strip(),
            }
        )
    return out


def is_numbered_entity(name: str) -> bool:
    return bool(
        re.search(
            r"(定理|公理|定义|例|习题)\s*\d|(定理|公理|定义)\d",
            zh_name(name),
        )
    )


def is_bad_short(name: str) -> bool:
    z = zh_name(name)
    if len(z) <= 1:
        return True
    if re.fullmatch(r"[A-Za-z]", z):
        return True
    return False


def build_entities(relations: list[dict]) -> list[dict]:
    names: dict[str, int] = Counter()
    for r in relations:
        names[r["subject"]] += 1
        names[r["object"]] += 1
    return [
        {"name": n, "definition": "", "theorems": [], "importance": 0.0}
        for n in sorted(names)
    ]


def quality_report(relations: list[dict], entities: list[dict], label: str) -> dict:
    preds = Counter(r["predicate"] for r in relations)
    ent_names = [e["name"] for e in entities]
    numbered = [n for n in ent_names if is_numbered_entity(n)]
    short = [n for n in ent_names if is_bad_short(n)]
    related_ratio = preds.get("related_with", 0) / max(len(relations), 1)
    deg = Counter()
    for r in relations:
        deg[r["subject"]] += 1
        deg[r["object"]] += 1
    hubs = deg.most_common(8)
    generic_hits = [
        (h, deg[h])
        for h in deg
        if zh_name(h) in GENERIC_HUBS
    ]
    generic_hits.sort(key=lambda x: -x[1])
    return {
        "label": label,
        "entities": len(entities),
        "relations": len(relations),
        "predicates": dict(preds),
        "related_with_ratio": round(related_ratio, 4),
        "numbered_entities": len(numbered),
        "numbered_examples": numbered[:8],
        "short_entities": len(short),
        "short_examples": short[:8],
        "top_hubs": hubs,
        "generic_hub_degrees": generic_hits[:8],
    }


def baseline_subset_for_slices(
    baseline_dir: Path, slice_texts: list[str]
) -> tuple[list[dict], list[dict]]:
    """用切片正文粗召回旧图中相关边（实体中文名出现在切片中）。"""
    ents = json.loads((baseline_dir / "entity_final.json").read_text(encoding="utf-8"))
    rels = json.loads((baseline_dir / "relations_final.json").read_text(encoding="utf-8"))
    blob = "\n".join(slice_texts)
    # 长名优先，避免过短误伤
    zh_to_full: dict[str, str] = {}
    for e in ents:
        name = e.get("name") or ""
        z = zh_name(name)
        if len(z) >= 2:
            zh_to_full[z] = name
    present = {full for z, full in zh_to_full.items() if z in blob}
    sub_rels = [
        r
        for r in rels
        if (r.get("subject") in present) or (r.get("object") in present)
    ]
    sub_ents = [e for e in ents if e.get("name") in present]
    return sub_ents, sub_rels


def compare_reports(old: dict, new: dict) -> dict:
    def ratio(n, d):
        return round(n / max(d, 1), 4)

    return {
        "entity_count": {"old": old["entities"], "new": new["entities"]},
        "relation_count": {"old": old["relations"], "new": new["relations"]},
        "related_with_ratio": {
            "old": old["related_with_ratio"],
            "new": new["related_with_ratio"],
            "delta": round(new["related_with_ratio"] - old["related_with_ratio"], 4),
        },
        "numbered_entities": {
            "old": old["numbered_entities"],
            "new": new["numbered_entities"],
        },
        "short_entities": {"old": old["short_entities"], "new": new["short_entities"]},
        "predicate_shift": {
            "old": old["predicates"],
            "new": new["predicates"],
        },
        "hub_compare": {
            "old_top": old["top_hubs"][:5],
            "new_top": new["top_hubs"][:5],
            "old_generic": old["generic_hub_degrees"][:5],
            "new_generic": new["generic_hub_degrees"][:5],
        },
    }


def recommend(cmp: dict, new_rep: dict) -> dict:
    reasons = []
    score = 0
    if cmp["related_with_ratio"]["delta"] < -0.05:
        score += 2
        reasons.append("related_with 占比明显下降")
    elif cmp["related_with_ratio"]["delta"] > 0.05:
        score -= 1
        reasons.append("related_with 占比上升")
    if cmp["numbered_entities"]["new"] < cmp["numbered_entities"]["old"]:
        score += 2
        reasons.append("编号定理/公理实体减少")
    if cmp["numbered_entities"]["new"] == 0:
        score += 1
        reasons.append("新图无编号实体")
    if cmp["short_entities"]["new"] < cmp["short_entities"]["old"]:
        score += 1
        reasons.append("过短/单字母实体减少")
    old_gen = sum(d for _, d in cmp["hub_compare"]["old_generic"])
    new_gen = sum(d for _, d in cmp["hub_compare"]["new_generic"])
    if new_gen < old_gen * 0.7:
        score += 2
        reasons.append("泛化 hub 度数下降")
    elif new_gen > old_gen * 1.1:
        score -= 1
        reasons.append("泛化 hub 仍偏高")

    if score >= 4:
        verdict = "建议扩大重抽（先扩到命题/谓词逻辑全书章节，再评估全量）"
    elif score >= 2:
        verdict = "效果正向但不稳，建议再抽 1–2 章验证后再决定全量"
    else:
        verdict = "试点提升有限，先改提示词/切片策略，暂不全量重抽"

    return {"score": score, "reasons": reasons, "verdict": verdict}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--md", type=Path, default=DEFAULT_MD)
    parser.add_argument(
        "--preset",
        choices=sorted(PRESETS.keys()),
        default="basic",
        help="basic / ch1-ch4 / gaps / logic-expand / logic-all(第1-6章含具体关系)",
    )
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--out", type=Path, default=None, help="默认随 --preset 写入独立目录")
    parser.add_argument(
        "--merge-from",
        type=Path,
        default=None,
        help="合并已有试点 relations（同 source_section 用新结果覆盖）",
    )
    parser.add_argument("--dry-run", action="store_true", help="只切分与对比准备，不调 LLM")
    parser.add_argument("--max-chars", type=int, default=8000, help="单片过长则截断")
    args = parser.parse_args()

    preset = PRESETS[args.preset]
    if args.out is None:
        args.out = preset["out"]
    if args.merge_from is None:
        args.merge_from = preset.get("merge_from")

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )

    if not args.md.is_file():
        raise SystemExit(f"markdown not found: {args.md}")
    if not args.baseline.is_dir():
        raise SystemExit(f"baseline KG not found: {args.baseline}")

    text = args.md.read_text(encoding="utf-8")
    sections = split_markdown_sections(text)
    if preset.get("chapters"):
        pilot = select_by_chapters(
            sections,
            chapters=list(preset["chapters"]),
            min_chars=int(preset.get("min_chars") or 300),
        )
    else:
        pilot = select_pilot_sections(sections, preset["sections"])
    if not pilot:
        raise SystemExit("no pilot sections selected")

    args.out.mkdir(parents=True, exist_ok=True)
    slices_meta = []
    for s in pilot:
        body = s["text"]
        if len(body) > args.max_chars:
            body = body[: args.max_chars] + "\n…(截断)"
        slices_meta.append(
            {
                "pilot_key": s["pilot_key"],
                "title": s["title"],
                "char_len": len(body),
                "text": body,
            }
        )
        logger.info("slice %s (%d chars)", s["pilot_key"], len(body))

    (args.out / "slices.json").write_text(
        json.dumps(
            [{k: v for k, v in s.items() if k != "text"} | {"text_preview": s["text"][:200]}
             for s in slices_meta],
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    (args.out / "slices_full.json").write_text(
        json.dumps(slices_meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    if args.dry_run:
        print("dry-run: wrote slices only →", args.out)
        return

    cfg = TeachKGConfig.from_yaml(ROOT / "configs/teaching.yaml")
    settings = llm_settings_from_config(cfg.get("llm", default={}) or {})
    client = LLMClient(
        api_key=settings.get("api_key"),
        base_url=settings.get("base_url"),
        model=settings.get("model"),
        max_retry=int(settings.get("max_retry") or 3),
    )

    all_triples: list[dict] = []
    per_slice: list[dict] = []
    for s in slices_meta:
        prompt = format_prompt(
            "textbook/concept_extract_pilot.txt",
            course_context="CS2501 离散数学（数理逻辑与集合论）",
            section_title=s["title"],
            chunk_text=s["text"],
        )
        logger.info("extracting %s …", s["pilot_key"])
        try:
            raw = client.chat(prompt, temperature=0.1)
        except Exception as exc:  # noqa: BLE001
            logger.exception("LLM failed on %s: %s", s["pilot_key"], exc)
            per_slice.append({"pilot_key": s["pilot_key"], "error": str(exc), "triples": []})
            continue
        triples = parse_triples(raw)
        for t in triples:
            t["source_section"] = s["pilot_key"]
        logger.info("  → %d triples", len(triples))
        per_slice.append({"pilot_key": s["pilot_key"], "triple_count": len(triples), "triples": triples})
        all_triples.extend(triples)

    # 可选：与已有试点合并（同 section 覆盖）
    if args.merge_from:
        base_rels_path = Path(args.merge_from) / "relations_final.json"
        base_by_path = Path(args.merge_from) / "extract_by_slice.json"
        if not base_rels_path.is_file():
            raise SystemExit(f"merge-from missing relations: {base_rels_path}")
        base_rels = json.loads(base_rels_path.read_text(encoding="utf-8"))
        replaced = {s["pilot_key"] for s in slices_meta}
        kept = [t for t in base_rels if t.get("source_section") not in replaced]
        logger.info(
            "merge-from %s: keep %d triples, replace sections %s",
            args.merge_from,
            len(kept),
            sorted(replaced),
        )
        all_triples = kept + all_triples
        if base_by_path.is_file():
            base_by = json.loads(base_by_path.read_text(encoding="utf-8"))
            by_map = {x["pilot_key"]: x for x in base_by if x.get("pilot_key") not in replaced}
            for item in per_slice:
                by_map[item["pilot_key"]] = item
            per_slice = list(by_map.values())

    # 简单去重（全名 SPO）
    seen = set()
    deduped = []
    for t in all_triples:
        key = (t["subject"], t["predicate"], t["object"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(t)

    entities = build_entities(deduped)
    (args.out / "extract_by_slice.json").write_text(
        json.dumps(per_slice, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (args.out / "relations_final.json").write_text(
        json.dumps(deduped, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (args.out / "entity_final.json").write_text(
        json.dumps(entities, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 对比：优先用 merge 源的全书切片文本，保证与 ch1-ch4 全量可比
    compare_texts = [s["text"] for s in slices_meta]
    if args.merge_from:
        full_slices = Path(args.merge_from) / "slices_full.json"
        if full_slices.is_file():
            compare_texts = [
                s["text"] for s in json.loads(full_slices.read_text(encoding="utf-8"))
            ]
            # 保留完整切片副本便于后续扩展
            (args.out / "slices_full_merged_note.txt").write_text(
                f"merged from {args.merge_from}; gap slices overwritten\n",
                encoding="utf-8",
            )

    old_ents, old_rels = baseline_subset_for_slices(args.baseline, compare_texts)
    old_rep = quality_report(old_rels, old_ents, "baseline_subset")
    new_rep = quality_report(deduped, entities, "pilot_new")
    cmp = compare_reports(old_rep, new_rep)
    rec = recommend(cmp, new_rep)

    report = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "md": str(args.md),
        "baseline": str(args.baseline),
        "out": str(args.out),
        "pilot_sections": [s["pilot_key"] for s in slices_meta],
        "note": "未覆盖原有 data/textbook/... 母图；本目录为试点产物",
        "old_subset": old_rep,
        "new_pilot": new_rep,
        "compare": cmp,
        "recommendation": rec,
        "sample_new_triples": deduped[:12],
        "sample_old_triples": [
            {
                "subject": r.get("subject"),
                "predicate": r.get("predicate"),
                "object": r.get("object"),
            }
            for r in old_rels[:12]
        ],
    }
    (args.out / "compare_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("\n=== Pilot re-extract done ===")
    print("out:", args.out)
    print("new:", new_rep["entities"], "ents /", new_rep["relations"], "rels")
    print("old subset:", old_rep["entities"], "ents /", old_rep["relations"], "rels")
    print("related_with:", old_rep["related_with_ratio"], "→", new_rep["related_with_ratio"])
    print("numbered ents:", old_rep["numbered_entities"], "→", new_rep["numbered_entities"])
    print("verdict:", rec["verdict"])
    print("reasons:", "; ".join(rec["reasons"]) or "—")


if __name__ == "__main__":
    main()
