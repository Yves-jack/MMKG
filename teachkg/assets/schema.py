"""资产库卡片 schema。"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

ASSET_KINDS = ("theorem", "principle", "technique")
CONCEPT_ROLES = ("about", "applies_to", "uses")

AssetKind = Literal["theorem", "principle", "technique"]
ConceptRole = Literal["about", "applies_to", "uses"]


@dataclass
class AssetConceptLink:
    entity: str
    role: str = "about"

    def to_dict(self) -> dict[str, str]:
        return {"entity": self.entity, "role": self.role}


@dataclass
class AssetGrounding:
    lecture_id: str | None = None
    cue_id: str | None = None
    ppt_page: int | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.lecture_id:
            out["lecture_id"] = self.lecture_id
        if self.cue_id:
            out["cue_id"] = self.cue_id
        if self.ppt_page is not None:
            out["ppt_page"] = self.ppt_page
        return out


@dataclass
class AssetLinks:
    demos: list[str] = field(default_factory=list)
    anims: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, list[str]]:
        return {
            "demos": list(self.demos),
            "anims": list(self.anims),
            "problems": list(self.problems),
        }


def empty_links() -> AssetLinks:
    return AssetLinks()


@dataclass
class AssetCard:
    asset_id: str
    kind: str
    name: str
    aliases: list[str] = field(default_factory=list)
    summary: str = ""
    statement: str = ""
    steps: list[str] = field(default_factory=list)
    concepts: list[AssetConceptLink] = field(default_factory=list)
    grounding: AssetGrounding | None = None
    source: str = "curated"
    links: AssetLinks = field(default_factory=empty_links)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "asset_id": self.asset_id,
            "kind": self.kind,
            "name": self.name,
            "aliases": list(self.aliases),
            "summary": self.summary,
            "statement": self.statement,
            "steps": list(self.steps),
            "concepts": [c.to_dict() for c in self.concepts],
            "source": self.source,
            "links": self.links.to_dict(),
        }
        if self.grounding:
            g = self.grounding.to_dict()
            if g:
                data["grounding"] = g
        return data

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> AssetCard:
        concepts = [
            AssetConceptLink(
                entity=str(c.get("entity") or "").strip(),
                role=str(c.get("role") or "about").strip() or "about",
            )
            for c in (raw.get("concepts") or [])
            if isinstance(c, dict) and str(c.get("entity") or "").strip()
        ]
        g_raw = raw.get("grounding") if isinstance(raw.get("grounding"), dict) else None
        grounding = None
        if g_raw:
            ppt = g_raw.get("ppt_page")
            grounding = AssetGrounding(
                lecture_id=str(g_raw.get("lecture_id") or "").strip() or None,
                cue_id=str(g_raw.get("cue_id") or "").strip() or None,
                ppt_page=int(ppt) if ppt is not None and str(ppt).strip() != "" else None,
            )
        links_raw = raw.get("links") if isinstance(raw.get("links"), dict) else {}
        links = AssetLinks(
            demos=[str(x) for x in (links_raw.get("demos") or []) if x],
            anims=[str(x) for x in (links_raw.get("anims") or []) if x],
            problems=[str(x) for x in (links_raw.get("problems") or []) if x],
        )
        return cls(
            asset_id=str(raw.get("asset_id") or "").strip(),
            kind=str(raw.get("kind") or "").strip(),
            name=str(raw.get("name") or "").strip(),
            aliases=[str(a).strip() for a in (raw.get("aliases") or []) if str(a).strip()],
            summary=str(raw.get("summary") or "").strip(),
            statement=str(raw.get("statement") or "").strip(),
            steps=[str(s).strip() for s in (raw.get("steps") or []) if str(s).strip()],
            concepts=concepts,
            grounding=grounding,
            source=str(raw.get("source") or "curated").strip() or "curated",
            links=links,
        )


@dataclass
class AssetLibrary:
    course_id: str
    cards: list[AssetCard] = field(default_factory=list)
    generated_at: str = ""
    stats: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        by_kind: dict[str, int] = {}
        for c in self.cards:
            by_kind[c.kind] = by_kind.get(c.kind, 0) + 1
        return {
            "course_id": self.course_id,
            "generated_at": self.generated_at,
            "card_count": len(self.cards),
            "stats": {**by_kind, **self.stats},
            "cards": [c.to_dict() for c in self.cards],
            "index_by_entity": _index_by_entity(self.cards),
        }


def _index_by_entity(cards: list[AssetCard]) -> dict[str, list[str]]:
    idx: dict[str, list[str]] = {}
    for card in cards:
        for link in card.concepts:
            idx.setdefault(link.entity, []).append(card.asset_id)
    return {k: sorted(set(v)) for k, v in sorted(idx.items())}


def validate_card(card: AssetCard) -> list[str]:
    """返回错误列表；空列表表示合法。"""
    errors: list[str] = []
    if not card.asset_id:
        errors.append("missing asset_id")
    if card.kind not in ASSET_KINDS:
        errors.append(f"invalid kind: {card.kind}")
    if not card.name:
        errors.append("missing name")
    for link in card.concepts:
        if link.role not in CONCEPT_ROLES:
            errors.append(f"invalid role on {link.entity}: {link.role}")
    if card.source not in {"textbook", "lecture", "curated"}:
        errors.append(f"invalid source: {card.source}")
    if card.kind != "technique" and card.steps:
        # 允许但提示性：非 technique 不应依赖 steps；不报错
        pass
    return errors


def card_to_jsonable(card: AssetCard) -> dict[str, Any]:
    return asdict(card)
