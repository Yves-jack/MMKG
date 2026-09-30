"""从教材定理 + curated 种子构建资产库。"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from teachkg.assets.relink import relink_library_cards
from teachkg.assets.schema import (
    AssetCard,
    AssetConceptLink,
    AssetGrounding,
    AssetLibrary,
    empty_links,
    fill_grounding_times,
    refine_grounding_times,
    sort_cards_by_appearance,
    validate_card,
)
from teachkg.textbook_kg.loader import TextbookKG
from teachkg.textbook_kg.theorem_edges import theorem_entity_name

logger = logging.getLogger(__name__)

_BAD_THEOREM_NAMES = {
    "未知",
    "unknown",
    "未命名",
    "n/a",
    "na",
}


def _slug(text: str, *, max_len: int = 48) -> str:
    raw = re.sub(r"[^\w\u4e00-\u9fff]+", "_", text.strip(), flags=re.UNICODE)
    raw = re.sub(r"_+", "_", raw).strip("_").lower()
    if not raw:
        raw = "item"
    if len(raw) > max_len:
        digest = hashlib.sha1(text.encode("utf-8")).hexdigest()[:8]
        raw = f"{raw[: max_len - 9]}_{digest}"
    return raw


def _zh(name: str) -> str:
    return (name or "").split("/", 1)[0].strip()


def _is_junk_theorem(name: str, content: str) -> bool:
    n = name.strip()
    if not n:
        return True
    if _zh(n).lower() in _BAD_THEOREM_NAMES or n.lower() in _BAD_THEOREM_NAMES:
        return True
    # 仅编号、无实质内容的短碎片
    if len(content.strip()) < 8 and re.fullmatch(r"(定理|公理|命题|推论|引理)\s*[\d\.\-]+", n):
        return True
    return False


def cards_from_textbook(kg: TextbookKG) -> list[AssetCard]:
    """将 entity.theorems[] 展开为 theorem 卡片。"""
    cards: list[AssetCard] = []
    seen_ids: set[str] = set()

    for entity in kg.entities.values():
        for item in entity.theorems:
            if not isinstance(item, dict):
                continue
            th_name = str(item.get("name") or "").strip()
            content = str(item.get("content") or "").strip()
            if _is_junk_theorem(th_name, content):
                continue
            th_entity = theorem_entity_name(th_name, entity)
            if not th_entity:
                continue
            asset_id = f"thm_{_slug(_zh(entity.name))}_{_slug(_zh(th_name))}"
            if asset_id in seen_ids:
                digest = hashlib.sha1(f"{entity.name}|{th_name}|{content}".encode()).hexdigest()[:6]
                asset_id = f"{asset_id}_{digest}"
            seen_ids.add(asset_id)

            display = th_entity if "/" in th_entity else th_name
            summary = content
            if len(summary) > 160:
                summary = summary[:157].rstrip() + "…"

            cards.append(
                AssetCard(
                    asset_id=asset_id,
                    kind="theorem",
                    name=display,
                    aliases=[th_name] if th_name != _zh(display) else [],
                    summary=summary or f"{_zh(display)}（教材定理）",
                    statement=content,
                    steps=[],
                    concepts=[
                        AssetConceptLink(entity=entity.name, role="about"),
                    ],
                    grounding=None,
                    source="textbook",
                    links=empty_links(),
                )
            )
    return cards


def cards_from_curated(path: Path) -> list[AssetCard]:
    """读取 curated_seed.json（数组或 {cards:[...]}）。"""
    if not path.is_file():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    rows = raw.get("cards") if isinstance(raw, dict) else raw
    if not isinstance(rows, list):
        raise ValueError(f"curated seed must be a list or {{cards: []}}: {path}")
    cards: list[AssetCard] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        card = AssetCard.from_dict(row)
        if not card.source:
            card.source = "curated"
        if card.links is None:
            card.links = empty_links()
        errs = validate_card(card)
        if errs:
            raise ValueError(f"invalid curated card {card.asset_id or row}: {errs}")
        cards.append(card)
    return cards


def _lecture_entity_index(kg_dir: Path, course_id: str) -> dict[str, list[str]]:
    """entity 全名 / 中文主名 → 出现过的 lecture_id 列表。"""
    base = kg_dir / course_id
    if not base.is_dir():
        return {}
    index: dict[str, list[str]] = {}
    for child in sorted(base.iterdir()):
        if not child.is_dir() or not child.name.startswith("lecture_"):
            continue
        lid = child.name.replace("lecture_", "", 1)
        kg_path = child / "kg.json"
        if not kg_path.is_file():
            continue
        try:
            payload = json.loads(kg_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        for ent in payload.get("entities") or []:
            if not isinstance(ent, dict):
                continue
            name = str(ent.get("name") or ent.get("id") or "").strip()
            if not name:
                continue
            index.setdefault(name, []).append(lid)
            zh = _zh(name)
            if zh and zh != name:
                index.setdefault(zh, []).append(lid)
            for alias in ent.get("aliases") or []:
                a = str(alias).strip()
                if a:
                    index.setdefault(a, []).append(lid)
                    az = _zh(a)
                    if az and az != a:
                        index.setdefault(az, []).append(lid)
    # unique preserve order
    return {k: list(dict.fromkeys(v)) for k, v in index.items()}


def attach_lecture_grounding(cards: list[AssetCard], lecture_index: dict[str, list[str]]) -> int:
    """若卡片名/别名/关联概念命中讲次实体，回填 grounding.lecture_id。"""
    filled = 0
    for card in cards:
        if card.grounding and card.grounding.lecture_id:
            continue
        candidates = [card.name, _zh(card.name), *card.aliases, *(_zh(a) for a in card.aliases)]
        candidates.extend(link.entity for link in card.concepts)
        candidates.extend(_zh(link.entity) for link in card.concepts)
        hit_lec: str | None = None
        for key in candidates:
            key = (key or "").strip()
            if not key:
                continue
            lecs = lecture_index.get(key)
            if lecs:
                hit_lec = lecs[0]
                break
        if hit_lec:
            card.grounding = AssetGrounding(lecture_id=hit_lec)
            filled += 1
    return filled


def merge_cards(
    textbook_cards: list[AssetCard],
    curated_cards: list[AssetCard],
    llm_cards: list[AssetCard] | None = None,
) -> list[AssetCard]:
    """合并优先级：llm > curated > textbook（同 asset_id）；llm 另按中文名覆盖同 kind 教材卡。"""
    by_id: dict[str, AssetCard] = {c.asset_id: c for c in textbook_cards}
    for card in curated_cards:
        by_id[card.asset_id] = card
    for card in llm_cards or []:
        by_id[card.asset_id] = card

    # llm 与 textbook 可能 id 不同但同名：保留 llm，丢掉同 kind+中文主名的 textbook
    from teachkg.assets.overlap import primary_zh

    llm_keys = {
        (c.kind, primary_zh(c.name)): c.asset_id
        for c in (llm_cards or [])
        if primary_zh(c.name)
    }
    if llm_keys:
        drop: list[str] = []
        for aid, card in by_id.items():
            if card.source == "llm":
                continue
            key = (card.kind, primary_zh(card.name))
            if key in llm_keys and llm_keys[key] != aid:
                drop.append(aid)
        for aid in drop:
            by_id.pop(aid, None)
    return list(by_id.values())


def _load_course_cues(kg_dir: Path, course_id: str) -> list[dict[str, Any]]:
    data_root = Path(kg_dir).resolve().parent.parent
    candidates = [
        data_root / "pretty_view" / "processed" / course_id / "filtered_cues.json",
        data_root / "pretty_view" / "segments" / course_id / "cues.json",
        data_root / "processed" / course_id / "filtered_cues.json",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(raw, list) and raw:
            return raw
    return []


def build_asset_library(
    *,
    course_id: str,
    textbook_path: Path,
    curated_path: Path | None,
    kg_dir: Path,
    llm_cards: list[AssetCard] | None = None,
    include_textbook_theorems: bool = True,
) -> AssetLibrary:
    kg = TextbookKG.load(Path(textbook_path))
    textbook_cards = cards_from_textbook(kg) if include_textbook_theorems else []
    curated_cards = cards_from_curated(Path(curated_path)) if curated_path else []
    cards = merge_cards(textbook_cards, curated_cards, llm_cards)
    n_relink = relink_library_cards(cards, Path(kg_dir), course_id)

    lecture_index = _lecture_entity_index(Path(kg_dir), course_id)
    grounded = attach_lecture_grounding(cards, lecture_index)
    timed = fill_grounding_times(cards)
    cue_rows = _load_course_cues(Path(kg_dir), course_id)
    refined = refine_grounding_times(cards, cue_rows) if cue_rows else 0
    cards = sort_cards_by_appearance(cards)

    errors: list[str] = []
    for card in cards:
        for err in validate_card(card):
            errors.append(f"{card.asset_id}: {err}")
    if errors:
        raise ValueError("asset library validation failed:\n" + "\n".join(errors[:30]))

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return AssetLibrary(
        course_id=course_id,
        cards=cards,
        generated_at=now,
        stats={
            "textbook_cards": len(textbook_cards),
            "curated_cards": len(curated_cards),
            "llm_cards": len(llm_cards or []),
            "grounded_cards": grounded,
            "timed_cards": timed,
            "refined_times": refined,
            "relinked_cards": n_relink,
            "lecture_entity_keys": len(lecture_index),
            "with_evidence": sum(1 for c in cards if (c.evidence or "").strip()),
        },
    )


def write_library(library: AssetLibrary, out_path: Path) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(library.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return out_path
