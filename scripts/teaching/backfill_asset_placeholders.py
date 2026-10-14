#!/usr/bin/env python
"""补全「课堂提及的…」占位资产卡：用 LLM 写 summary/statement/steps。

只改 llm_assets_lecture_*.json 里的占位卡，再重建 library（保留 formula/example 缓存）并分章。

  python scripts/teaching/backfill_asset_placeholders.py \\
    --config configs/teaching_lisan.yaml \\
    --course-id 离散数学(图论+数理逻辑与集合论)
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.assets.build import build_asset_library, write_library
from teachkg.assets.chapter_assign import assign_card_chapters
from teachkg.assets.formula_quality import keep_generic_formulas
from teachkg.assets.llm_extract import _extract_json, load_lecture_cues
from teachkg.assets.overlap import primary_zh
from teachkg.assets.schema import AssetCard, AssetLibrary
from teachkg.config import TeachKGConfig
from teachkg.textbook_kg.loader import TextbookKG
from teachkg.utils.env import load_project_env
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config

logger = logging.getLogger("backfill_asset_placeholders")

FILL_PROMPT = """你是离散数学课程助教。下面有若干「已确认出现在课堂中的」定理/原理/方法卡片，但缺少正式摘要与陈述。
请根据【课堂全文】与每条已有 evidence，补全 summary / statement / steps。

【要求】
1. 不要改 kind、name；不要新造资产。
2. summary：一句中文摘要（不要写「课堂提及的…」）。
3. statement：正式陈述；theorem/principle 尽量写清条件与结论；若原文信息不足，用 evidence 改写为通顺陈述，勿编造原文没有的结论。
4. technique：steps 至少 2 步；theorem/principle：steps 必须为 []。
5. evidence：尽量沿用给定 evidence；仅当它不是全文连续子串时，改为全文中的连续原文子串（15–120 字）。
6. 只输出合法 JSON。

输出：
{{
  "assets": [
    {{
      "asset_id": "与输入相同",
      "kind": "theorem|principle|technique",
      "name": "与输入相同或微调中英对照",
      "summary": "一句摘要",
      "statement": "陈述",
      "steps": ["步骤1", "步骤2"],
      "evidence": "课堂原文连续子串"
    }}
  ]
}}

---
课程：{course}
讲次：{lecture_id}

待补全卡片（JSON）：
{cards_json}

课堂全文：
{text}
"""


def _is_placeholder(card: dict) -> bool:
    summary = str(card.get("summary") or "").strip()
    statement = str(card.get("statement") or "").strip()
    steps = [str(s).strip() for s in (card.get("steps") or []) if str(s).strip()]
    kind = str(card.get("kind") or "")
    if summary.startswith("课堂提及的"):
        return True
    if kind in {"theorem", "principle"} and not statement and not summary:
        return True
    if kind == "technique" and len(steps) < 2 and (
        summary.startswith("课堂提及的") or not statement
    ):
        return True
    return False


def clean_lecture_text(raw: str) -> str:
    lines = []
    for ln in (raw or "").splitlines():
        s = ln.strip()
        if not s or "无效口播" in s or s in {"空。", "空", "嗯。", "嗯"}:
            continue
        lines.append(s)
    return "\n".join(lines)


def _ground_evidence(evidence: str, text: str) -> str:
    ev = (evidence or "").strip()
    if not ev:
        return ""
    if ev in text:
        return ev
    compact = re.sub(r"\s+", "", ev)
    compact_text = re.sub(r"\s+", "", text)
    if compact and compact in compact_text:
        # 回退：在原文找最长前缀
        for n in range(min(len(ev), 120), 14, -1):
            frag = ev[:n].strip()
            if frag and frag in text:
                return frag
    return ev if ev in text else ""


def apply_fill(card: dict, filled: dict, text: str) -> dict:
    out = dict(card)
    summary = str(filled.get("summary") or "").strip()
    statement = str(filled.get("statement") or "").strip()
    steps = [str(s).strip() for s in (filled.get("steps") or []) if str(s).strip()]
    evidence = str(filled.get("evidence") or card.get("evidence") or "").strip()
    grounded = _ground_evidence(evidence, text) or str(card.get("evidence") or "").strip()
    kind = str(card.get("kind") or "")
    if kind != "technique":
        steps = []
    if summary.startswith("课堂提及的"):
        summary = ""
    if summary:
        out["summary"] = summary
    if statement:
        out["statement"] = statement
    elif grounded and not str(out.get("statement") or "").strip():
        # 至少用 evidence 当 statement，避免仍空
        out["statement"] = grounded
    if steps:
        out["steps"] = steps
    if grounded:
        out["evidence"] = grounded
    # 标记来源：KG hint 补全
    out["source"] = "llm"
    out["fill"] = "placeholder_backfill"
    return out


def rebuild_library(course: str, config_path: Path) -> Path:
    assets_dir = ROOT / "data" / "kg" / course / "assets"
    merged: list[AssetCard] = []
    for p in sorted(assets_dir.glob("llm_assets_lecture_*.json")):
        payload = json.loads(p.read_text(encoding="utf-8"))
        for row in payload.get("cards") or []:
            if isinstance(row, dict):
                merged.append(AssetCard.from_dict(row))
    for p in sorted(assets_dir.glob("llm_assets_formula_example_lecture_*.json")):
        payload = json.loads(p.read_text(encoding="utf-8"))
        rows = [
            AssetCard.from_dict(row)
            for row in (payload.get("assets") or [])
            if isinstance(row, dict)
        ]
        merged.extend(keep_generic_formulas(rows))

    cfg = TeachKGConfig.from_yaml(str(config_path))
    tb = cfg.get("stage1", "textbook_kg") or {}
    tb_path = Path(tb.get("path") or "")
    if not tb_path.is_absolute():
        tb_path = ROOT / tb_path
    curated = assets_dir / "curated_seed.json"
    library = build_asset_library(
        course_id=course,
        textbook_path=tb_path,
        curated_path=curated if curated.is_file() else None,
        kg_dir=ROOT / "data" / "kg",
        llm_cards=merged,
        include_textbook_theorems=False,
    )
    out = assets_dir / "library.json"
    write_library(library, out)
    return out


def assign_chapters(course: str, config_path: Path, lib_path: Path) -> None:
    yml = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    tb_cfg = ((yml.get("stage1") or {}).get("textbook_kg") or {})
    lecture_map = tb_cfg.get("lecture_chapter_map") or {}
    tb_path = Path(tb_cfg.get("path") or "")
    if not tb_path.is_absolute():
        tb_path = ROOT / tb_path
    chapter_order: list[str] = []
    chapter_entities: dict[str, list[str]] = {}
    if tb_path.is_dir():
        tb = TextbookKG.load(
            tb_path,
            entity_file=tb_cfg.get("entity_file", "entity_final.json"),
            relations_file=tb_cfg.get("relations_file", "relations_final.json"),
            importance_file=tb_cfg.get("importance_file", "entity_sorted_ppr.json"),
            importance_bundle_file=tb_cfg.get(
                "importance_bundle_file", "importance_bundle.json"
            ),
        )
        chapter_order = list(tb.chapter_order or [])
        by_ch = tb.importance_by_chapter or {}
        for ch, scores in by_ch.items():
            ranked = sorted(scores.items(), key=lambda x: float(x[1]), reverse=True)
            chapter_entities[str(ch)] = [
                str(n).split("/", 1)[0].strip() for n, _ in ranked[:50] if n
            ]
    raw = json.loads(lib_path.read_text(encoding="utf-8"))
    cards = [AssetCard.from_dict(r) for r in (raw.get("cards") or []) if isinstance(r, dict)]
    stats = assign_card_chapters(
        cards,
        chapter_order=chapter_order,
        lecture_chapter_map=lecture_map,
        chapter_entities=chapter_entities,
        model_name=(
            ((tb_cfg.get("subgraph") or {}).get("embedder_model"))
            or "shibing624/text2vec-base-multilingual"
        ),
    )
    logger.info("chapter assign: %s", stats)
    from datetime import datetime, timezone

    library = AssetLibrary(
        course_id=str(raw.get("course_id") or course),
        cards=cards,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        stats={**(raw.get("stats") or {}), "chapter_assign": stats},
    )
    lib_path.write_text(
        json.dumps(library.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching_lisan.yaml"))
    p.add_argument("--course-id", default="离散数学(图论+数理逻辑与集合论)")
    p.add_argument("--lectures", default="", help="逗号分隔；默认全部有占位卡的讲次")
    p.add_argument("--limit", type=int, default=0, help="最多补全多少张（调试用）")
    p.add_argument("--skip-assign", action="store_true")
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
    assets_dir = ROOT / "data" / "kg" / course / "assets"
    cues_path = ROOT / "data" / "pretty_view" / "processed" / course / "filtered_cues.json"
    if not cues_path.is_file():
        cues_path = ROOT / "data" / "processed" / course / "filtered_cues.json"

    yml = yaml.safe_load(Path(args.config).read_text(encoding="utf-8")) or {}
    client = LLMClient(**llm_settings_from_config(yml.get("llm") or {}))

    lecture_filter = {
        x.strip() for x in str(args.lectures).split(",") if x.strip()
    }
    filled_total = 0
    limit = int(args.limit or 0)

    for path in sorted(assets_dir.glob("llm_assets_lecture_*.json")):
        lec = path.stem.rsplit("_", 1)[-1]
        if lecture_filter and lec not in lecture_filter:
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        cards = [c for c in (payload.get("cards") or []) if isinstance(c, dict)]
        placeholders = [c for c in cards if _is_placeholder(c)]
        if not placeholders:
            continue
        if limit and filled_total >= limit:
            break
        if limit:
            placeholders = placeholders[: max(0, limit - filled_total)]

        cues = load_lecture_cues(cues_path, lec) if cues_path.is_file() else []
        text = clean_lecture_text(
            "\n".join(
                str(c.get("extract_text") or c.get("asr_text") or "") for c in cues
            )
        )
        if len(text) < 40:
            logger.warning("L%s text too short, skip", lec)
            continue

        # 每讲一次请求，最多 12 张，避免超长
        batch = placeholders[:12]
        slim = [
            {
                "asset_id": c.get("asset_id"),
                "kind": c.get("kind"),
                "name": c.get("name"),
                "evidence": (c.get("evidence") or "")[:200],
            }
            for c in batch
        ]
        prompt = FILL_PROMPT.format(
            course=course,
            lecture_id=lec,
            cards_json=json.dumps(slim, ensure_ascii=False, indent=2),
            text=text[:12000],
        )
        try:
            raw = client.chat(prompt, temperature=0.2)
            data = _extract_json(raw) or {}
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM failed L%s: %s", lec, exc)
            time.sleep(2)
            continue

        by_id = {
            str(r.get("asset_id") or "").strip(): r
            for r in (data.get("assets") or [])
            if isinstance(r, dict) and r.get("asset_id")
        }
        # 也按 name 兜底
        by_name = {
            primary_zh(str(r.get("name") or "")): r
            for r in (data.get("assets") or [])
            if isinstance(r, dict) and r.get("name")
        }

        n_ok = 0
        new_cards = []
        ph_ids = {str(c.get("asset_id")) for c in batch}
        for c in cards:
            aid = str(c.get("asset_id") or "")
            if aid not in ph_ids:
                new_cards.append(c)
                continue
            filled = by_id.get(aid) or by_name.get(primary_zh(str(c.get("name") or "")))
            if not filled:
                new_cards.append(c)
                continue
            updated = apply_fill(c, filled, text)
            if str(updated.get("summary") or "").startswith("课堂提及的"):
                new_cards.append(c)
                continue
            if not str(updated.get("statement") or "").strip() and str(
                updated.get("kind")
            ) in {"theorem", "principle"}:
                # statement 仍空则用 evidence
                updated["statement"] = str(updated.get("evidence") or "")
            new_cards.append(updated)
            n_ok += 1

        payload["cards"] = new_cards
        payload["backfill"] = {
            "placeholders": len(placeholders),
            "filled": n_ok,
        }
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        filled_total += n_ok
        logger.info("L%s filled %d / %d placeholders", lec, n_ok, len(placeholders))
        time.sleep(0.4)

    logger.info("total filled=%d", filled_total)
    lib_path = rebuild_library(course, Path(args.config))
    logger.info("rebuilt %s", lib_path)
    if not args.skip_assign:
        assign_chapters(course, Path(args.config), lib_path)
    # 剩余占位统计
    left = 0
    for p in assets_dir.glob("llm_assets_lecture_*.json"):
        raw = json.loads(p.read_text(encoding="utf-8"))
        left += sum(1 for c in (raw.get("cards") or []) if isinstance(c, dict) and _is_placeholder(c))
    print(f"done filled={filled_total} remaining_placeholders={left} library={lib_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
