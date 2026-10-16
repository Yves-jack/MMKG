#!/usr/bin/env python
"""从讲次课堂全文抽取定理/原理/方法，写入 assets library。

默认对「离散数学(图论+数理逻辑与集合论)」两讲整篇抽取（比逐 cue 更稳）。

示例：
  python scripts/teaching/extract_assets_lecture_batch.py \\
    --course-id 离散数学(图论+数理逻辑与集合论)
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.assets.build import build_asset_library, write_library
from teachkg.assets.llm_extract import (
    ALLOWED_KINDS,
    _extract_json,
    _quality_drop_reason,
    _slug,
    attach_concepts_by_overlap,
    load_lecture_cues,
    load_lecture_kg,
    parse_llm_assets,
)
from teachkg.assets.overlap import build_entity_text_index, primary_zh
from teachkg.assets.schema import AssetCard, AssetGrounding, empty_links, validate_card
from teachkg.config import TeachKGConfig
from teachkg.utils.env import load_project_env
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config

logger = logging.getLogger("extract_assets_lecture_batch")

PROMPT = """你是教学知识图谱的「定理 / 原理 / 方法」抽取专家（课程无关，适用于任意理工/经管等课程）。只抽原文讲清内容的资产；宁缺毋滥。

【三类】
- theorem：原文有可陈述的结论/判定条件（若…则…、当且仅当、充要、对任意…成立 等）。statement 必须写结论本身。仅点名「某某定理/某人解决了某问题」而无结论 → 不抽。
- principle：老师强调的原则/基本思想；不要硬造「××原理」空壳；纯定义/分类 → 不抽。
- technique：原文有可照做的多步过程；steps≥2 且须能从原文归纳，禁止补教材常识步骤。仅点名算法/方法 → 不抽。

【拒抽】
- 寒暄、进度、学科史一句带过、无实质内容的点名
- summary 禁止写成「课堂提及的××」
- 为凑数而抽

【硬约束】
1. evidence 必须是课堂全文连续原文子串（约 24–180 字），覆盖实质内容；对不上就不要抽
2. name 用「中文」或「中文/English」；勿杜撰原文未出现的正式编号名
3. theorem：statement 填结论；technique 必填真实 steps；principle/theorem 的 steps 为 []
4. 只输出合法 JSON

输出格式：
{{
  "assets": [
    {{
      "kind": "theorem|principle|technique",
      "name": "中文名或中文/English",
      "summary": "一句实质摘要（禁止「课堂提及的…」）",
      "statement": "定理结论或原理陈述",
      "steps": ["步骤1", "步骤2"],
      "evidence": "课堂原文连续子串（含实质内容）"
    }}
  ]
}}

若无可抽：{{"assets": []}}

---
课程：{course}
讲次：{lecture_id}

课堂全文：
{text}
"""


def clean_lecture_text(raw: str) -> str:
    lines = []
    for ln in (raw or "").splitlines():
        s = ln.strip()
        if not s:
            continue
        if "无效口播" in s:
            continue
        if s in {"空。", "空", "嗯。", "嗯"}:
            continue
        lines.append(s)
    return "\n".join(lines)


def soften_cards(
    data: dict,
    *,
    text: str,
    lecture_id: str,
) -> list[AssetCard]:
    """evidence 对不上时：用名称在原文中的窗口作 evidence。"""
    compact_src = re.sub(r"\s+", "", text or "")
    out: list[AssetCard] = []
    for row in data.get("assets") or []:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind") or "").strip()
        name = str(row.get("name") or "").strip()
        evidence = str(row.get("evidence") or "").strip()
        if kind not in ALLOWED_KINDS or not name:
            continue
        if evidence and re.sub(r"\s+", "", evidence) not in compact_src:
            zh = primary_zh(name)
            idx = text.find(zh) if zh else -1
            if idx < 0:
                for tok in re.findall(r"[\u4e00-\u9fffA-Za-z0-9·\-]+", name):
                    if len(tok) >= 2 and tok in text:
                        idx = text.find(tok)
                        zh = tok
                        break
            if idx < 0:
                logger.info("skip no evidence window: %s", name)
                continue
            left = max(0, idx - 24)
            right = min(len(text), idx + len(zh) + 72)
            evidence = text[left:right].strip()
        if not evidence:
            continue
        steps = [str(s).strip() for s in (row.get("steps") or []) if str(s).strip()]
        if kind != "technique":
            steps = []
        # 不再垫默认两步：方法必须 LLM 给出真实多步流程，否则质检丢弃
        reason = _quality_drop_reason(kind, name, evidence, steps, text)
        if reason:
            logger.info("drop (%s): %s", reason, name)
            continue
        card = AssetCard(
            asset_id=f"llm_{kind[:4]}_{_slug(primary_zh(name))}_L{lecture_id}",
            kind=kind,  # type: ignore[arg-type]
            name=name,
            aliases=[],
            summary=str(row.get("summary") or name).strip() or name,
            statement=str(row.get("statement") or "").strip(),
            steps=steps,
            concepts=[],
            grounding=AssetGrounding(
                lecture_id=str(lecture_id), cue_id=f"lecture_{lecture_id}_all"
            ),
            source="llm",
            links=empty_links(),
            evidence=evidence,
        )
        errs = validate_card(card)
        if errs:
            logger.warning("invalid %s: %s", card.asset_id, errs)
            continue
        out.append(card)
    return out


def cards_from_kg_hints(
    *,
    text: str,
    lecture_id: str,
    entities: list[dict],
) -> list[AssetCard]:
    """图谱实体名命中课堂原文时，兜底生成卡片。"""
    junk = {
        "定理",
        "公理",
        "算法",
        "方法",
        "原理",
        "technique",
        "theorem",
        "axiom",
        "algorithm",
        "method",
        "lemma",
        "corollary",
        "principle",
    }
    out: list[AssetCard] = []
    for e in entities:
        name = str(e.get("name") or "").strip()
        if not name:
            continue
        zh = primary_zh(name)
        if not zh or zh.lower() in junk or len(zh) <= 1:
            continue
        kind = None
        if re.search(
            r"定理|theorem|引理|lemma|推论|corollary|定律|law\b", name, re.I
        ):
            kind = "theorem"
        elif re.search(r"原理|principle|公理|axiom", name, re.I):
            kind = "principle"
        elif re.search(
            r"算法|方法|technique|method|algorithm|流程|步骤",
            name,
            re.I,
        ):
            kind = "technique"
        if not kind:
            continue
        if zh not in text and not any(
            tok in text
            for tok in re.findall(r"[A-Za-z][A-Za-z0-9\-]+", name)
            if len(tok) >= 3
        ):
            # 英文专名
            en = name.split("/")[-1].strip() if "/" in name else ""
            hit = None
            for tok in re.findall(r"[A-Za-z][A-Za-z0-9\-]+", en):
                if len(tok) >= 3 and tok in text:
                    hit = tok
                    break
            if not hit:
                continue
            idx = text.find(hit)
            evidence = text[max(0, idx - 20) : idx + len(hit) + 60].strip()
        else:
            idx = text.find(zh)
            if idx < 0:
                continue
            # 扩到邻近句，避免「课堂提及」短窗无结论
            left = max(0, idx - 40)
            right = min(len(text), idx + len(zh) + 200)
            evidence = text[left:right].strip()
        steps: list[str] = []
        # 方法兜底禁止垫默认步骤；无真实多步则不当 technique
        if kind == "technique":
            continue
        # 用 evidence 首句作实质摘要，禁止「课堂提及的××」
        summary = re.split(r"[。！？!?]", evidence, maxsplit=1)[0].strip()
        if len(re.sub(r"\s+", "", summary)) < 8:
            summary = zh
        reason = _quality_drop_reason(
            kind, name, evidence, steps, text, summary=summary, statement=""
        )
        if reason:
            logger.info("skip kg hint (%s): %s", reason, name)
            continue
        card = AssetCard(
            asset_id=f"kg_{kind[:4]}_{_slug(zh)}_L{lecture_id}",
            kind=kind,  # type: ignore[arg-type]
            name=name,
            aliases=[],
            summary=summary,
            statement="",
            steps=steps,
            concepts=[],
            grounding=AssetGrounding(
                lecture_id=str(lecture_id), cue_id=f"lecture_{lecture_id}_all"
            ),
            source="llm",
            links=empty_links(),
            evidence=evidence,
        )
        if validate_card(card):
            continue
        out.append(card)
    return out


def merge_unique(cards: list[AssetCard]) -> list[AssetCard]:
    by: dict[str, AssetCard] = {}

    def score(c: AssetCard) -> tuple:
        summary = (c.summary or "").strip()
        placeholder = 1 if summary.startswith("课堂提及的") else 0
        has_stmt = 1 if (c.statement or "").strip() else 0
        has_steps = 1 if c.steps else 0
        ev_len = len(c.evidence or "")
        # 优先非占位、有陈述/步骤，再比 evidence 长度
        return (1 - placeholder, has_stmt, has_steps, ev_len)

    for c in cards:
        key = f"{c.kind}\t{primary_zh(c.name)}"
        prev = by.get(key)
        if not prev or score(c) > score(prev):
            by[key] = c
    return list(by.values())


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", default="离散数学(图论+数理逻辑与集合论)")
    p.add_argument("--lectures", default="1,2")
    p.add_argument("--no-textbook-theorems", action="store_true", default=True)
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    load_project_env()
    course = args.course_id
    lectures = [x.strip() for x in str(args.lectures).split(",") if x.strip()]

    yml = Path(args.config)
    llm_cfg = {}
    if yml.is_file():
        llm_cfg = (yaml.safe_load(yml.read_text(encoding="utf-8")) or {}).get("llm") or {}
    client = LLMClient(**llm_settings_from_config(llm_cfg))

    cues_path = ROOT / "data" / "pretty_view" / "processed" / course / "filtered_cues.json"
    if not cues_path.is_file():
        logger.error("missing cues: %s", cues_path)
        return 1

    assets_dir = ROOT / "data" / "kg" / course / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    all_llm: list[AssetCard] = []

    for lec in lectures:
        cues = load_lecture_cues(cues_path, lec, text_source="fluency")
        text = clean_lecture_text(
            "\n".join(
                (
                    c.get("fluency_text")
                    or c.get("asr_text")
                    or c.get("extract_text")
                    or ""
                )
                for c in cues
            )
        )
        src_counts: dict[str, int] = {}
        for c in cues:
            k = str(c.get("text_source") or "?")
            src_counts[k] = src_counts.get(k, 0) + 1
        logger.info(
            "lecture %s cues=%d chars=%d (pref=fluency, used=%s)",
            lec,
            len(cues),
            len(text),
            src_counts,
        )
        if len(text) < 40:
            logger.warning("lecture %s text too short, skip LLM", lec)
            cards: list[AssetCard] = []
        else:
            prompt = PROMPT.format(course=course, lecture_id=lec, text=text)
            try:
                raw = client.chat(prompt, temperature=0.2)
                data = _extract_json(raw)
            except Exception as exc:  # noqa: BLE001
                logger.warning("LLM failed lecture=%s: %s", lec, exc)
                data = {"assets": []}
            cards = parse_llm_assets(
                data,
                source_text=text,
                lecture_id=str(lec),
                cue_id=f"lecture_{lec}_all",
            )
            if not cards:
                cards = soften_cards(data, text=text, lecture_id=str(lec))
            logger.info("LLM cards lecture %s: %d", lec, len(cards))

        kg_path = ROOT / "data" / "kg" / course / f"lecture_{lec}" / "kg.json"
        if kg_path.is_file():
            entities, edges = load_lecture_kg(kg_path)
        else:
            logger.warning("missing lecture kg %s; skip KG hints", kg_path)
            entities, edges = [], []
        hint_cards = cards_from_kg_hints(
            text=text, lecture_id=str(lec), entities=entities
        )
        logger.info("KG hint cards lecture %s: %d", lec, len(hint_cards))
        cards = merge_unique(cards + hint_cards)
        attach_concepts_by_overlap(
            cards,
            build_entity_text_index(entities, edges),
            min_score=0.18,
            top_k=2,
        )

        cache = assets_dir / f"llm_assets_lecture_{lec}.json"
        cache.write_text(
            json.dumps(
                {
                    "course_id": course,
                    "lecture_id": lec,
                    "count": len(cards),
                    "cards": [c.to_dict() for c in cards],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        logger.info("wrote %s (%d)", cache, len(cards))
        all_llm.extend(cards)

    # 占位卡（课堂提及的…）自动补全 statement/summary
    if lectures:
        import subprocess

        cmd = [
            sys.executable,
            str(ROOT / "scripts" / "teaching" / "backfill_asset_placeholders.py"),
            "--config",
            str(args.config),
            "--course-id",
            course,
            "--lectures",
            ",".join(lectures),
            "--skip-assign",
        ]
        logger.info("backfill placeholders for lectures=%s", ",".join(lectures))
        try:
            subprocess.run(cmd, check=False)
        except Exception as exc:  # noqa: BLE001
            logger.warning("backfill failed: %s", exc)

    # reload all lecture caches (+ formula caches if present)
    merged: list[AssetCard] = []
    for p in sorted(assets_dir.glob("llm_assets_lecture_*.json")):
        payload = json.loads(p.read_text(encoding="utf-8"))
        for row in payload.get("cards") or []:
            if isinstance(row, dict):
                merged.append(AssetCard.from_dict(row))
    try:
        from teachkg.assets.formula_quality import keep_generic_formulas

        for p in sorted(assets_dir.glob("llm_assets_formula_example_lecture_*.json")):
            payload = json.loads(p.read_text(encoding="utf-8"))
            rows = [
                AssetCard.from_dict(row)
                for row in (payload.get("assets") or [])
                if isinstance(row, dict)
            ]
            merged.extend(keep_generic_formulas(rows))
    except Exception as exc:  # noqa: BLE001
        logger.warning("skip formula caches merge: %s", exc)

    cfg = TeachKGConfig.from_yaml(args.config)
    tb_path = Path(
        (cfg.get("stage1", "textbook_kg") or {}).get(
            "path", "data/textbook/CS2501-离散数学（数理逻辑与集合论）"
        )
    )
    if not tb_path.is_absolute():
        tb_path = ROOT / tb_path
    curated = assets_dir / "curated_seed.json"
    kg_dir = Path(cfg.get("project", "kg_dir", default="data/kg"))
    if not kg_dir.is_absolute():
        kg_dir = ROOT / kg_dir

    library = build_asset_library(
        course_id=course,
        textbook_path=tb_path,
        curated_path=curated if curated.is_file() else None,
        kg_dir=kg_dir,
        llm_cards=merged,
        include_textbook_theorems=not args.no_textbook_theorems,
    )
    out = assets_dir / "library.json"
    write_library(library, out)
    print(f"Wrote {out} cards={len(library.cards)} stats={library.stats}")
    for c in library.cards:
        print(f"  [{c.kind}] {primary_zh(c.name)} · L{c.grounding.lecture_id if c.grounding else '-'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
