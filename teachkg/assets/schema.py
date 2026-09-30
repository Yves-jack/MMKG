"""资产库卡片 schema。

与流水线双层对齐
----------------
- **抽象层（可构图）**：六类 abstract_relation；property_of 在讲次后处理中
  折进实体 ``properties[]``（内禀属性），不再占图边。
- **资源层（不进主图）**：本模块的卡片。定理/原理/方法之外，公式与例子
  也落在这里。记号占位（``a,b,c...``）与编号「公式 3.1 / 例 2」禁止当图节点。
- **具体关系**：仍挂在边上的 ``concrete_relation``，不另开第七种抽象关系。
- **关联**：卡片 ``concepts[]`` 挂实体，可选 ``edges[]`` 挂 SPO；
  ``grounding`` 用完整课 ``start_sec/end_sec``（可由 cue_id 反查）。
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

ASSET_KINDS = ("theorem", "principle", "technique", "formula", "example")
GRAPH_ASSET_KINDS = ("theorem", "principle", "technique")  # 旧三类，构图外展示
RESOURCE_ASSET_KINDS = ("formula", "example")

CONCEPT_ROLES = (
    "about",
    "applies_to",
    "uses",
    "illustrates",
    "instance_of",
    "notation_of",
    "proves",
)

AssetKind = Literal["theorem", "principle", "technique", "formula", "example"]
ConceptRole = Literal[
    "about",
    "applies_to",
    "uses",
    "illustrates",
    "instance_of",
    "notation_of",
    "proves",
]

_CUE_MS_SPAN = re.compile(r"_(\d+)_(\d+)$")


@dataclass
class AssetConceptLink:
    entity: str
    role: str = "about"

    def to_dict(self) -> dict[str, str]:
        return {"entity": self.entity, "role": self.role}


@dataclass
class AssetEdgeLink:
    """资源卡挂到抽象层的一条 SPO（不把资源本身画进图）。"""

    subject: str
    predicate: str
    object: str
    role: str = "illustrates"

    def to_dict(self) -> dict[str, str]:
        return {
            "subject": self.subject,
            "predicate": self.predicate,
            "object": self.object,
            "role": self.role,
        }


@dataclass
class AssetGrounding:
    lecture_id: str | None = None
    cue_id: str | None = None
    ppt_page: int | None = None
    start_sec: float | None = None
    end_sec: float | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.lecture_id:
            out["lecture_id"] = self.lecture_id
        if self.cue_id:
            out["cue_id"] = self.cue_id
        if self.ppt_page is not None:
            out["ppt_page"] = self.ppt_page
        if self.start_sec is not None:
            out["start_sec"] = round(float(self.start_sec), 3)
        if self.end_sec is not None:
            out["end_sec"] = round(float(self.end_sec), 3)
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


def cue_time_span(cue: dict[str, Any] | None) -> tuple[float | None, float | None]:
    """从 cue 记录或 cue_id 毫秒后缀还原完整课时间。"""
    if not cue:
        return None, None
    start = cue.get("start_sec")
    end = cue.get("end_sec")
    if start is not None and str(start).strip() != "":
        s = float(start)
        e = float(end) if end is not None and str(end).strip() != "" else None
        return s, e
    cid = str(cue.get("cue_id") or cue.get("id") or "")
    return parse_cue_id_times(cid)


def parse_cue_id_times(cue_id: str | None) -> tuple[float | None, float | None]:
    """``课程_讲次_889100_980600`` → (889.1, 980.6) 秒。"""
    m = _CUE_MS_SPAN.search(str(cue_id or ""))
    if not m:
        return None, None
    return int(m.group(1)) / 1000.0, int(m.group(2)) / 1000.0


_CN_RUN = re.compile(r"[\u4e00-\u9fff0-9A-Za-z]{5,}")


def evidence_ratio_in_text(evidence: str, source: str) -> tuple[float, float] | None:
    """evidence 在原文中的起止比例（0–1）。对不上返回 None。"""
    ev = (evidence or "").strip()
    src = source or ""
    if not ev or not src:
        return None
    i = src.find(ev)
    if i >= 0:
        n = max(len(src), 1)
        return i / n, min(1.0, (i + len(ev)) / n)
    compact_ev = re.sub(r"\s+", "", ev)
    compact_src = re.sub(r"\s+", "", src)
    if not compact_ev or not compact_src:
        return None
    j = compact_src.find(compact_ev)
    if j >= 0:
        n = max(len(compact_src), 1)
        return j / n, min(1.0, (j + len(compact_ev)) / n)
    hits: list[tuple[int, int]] = []
    for run in _CN_RUN.findall(ev):
        k = src.find(run)
        if k >= 0:
            hits.append((k, k + len(run)))
            continue
        cr = re.sub(r"\s+", "", run)
        k = compact_src.find(cr)
        if k >= 0:
            n = max(len(compact_src), 1)
            hits.append(
                (
                    int(k / n * len(src)),
                    int((k + len(cr)) / n * len(src)),
                )
            )
    if not hits:
        min_keep = 12 if len(compact_ev) >= 12 else max(8, len(compact_ev))
        nlen = min(len(compact_ev), max(min_keep, int(len(compact_ev) * 0.6)))
        while nlen >= min_keep:
            gram = compact_ev[:nlen]
            j = compact_src.find(gram)
            if j >= 0:
                n = max(len(compact_src), 1)
                return j / n, min(1.0, (j + nlen) / n)
            nlen -= 2
        return None
    start = min(h[0] for h in hits)
    end = max(h[1] for h in hits)
    n = max(len(src), 1)
    return start / n, min(1.0, end / n)


def interpolate_evidence_time(
    evidence: str,
    source_text: str,
    start_sec: float | None,
    end_sec: float | None,
    *,
    lead_sec: float = 0.8,
    tail_sec: float = 0.4,
) -> tuple[float | None, float | None]:
    """按 evidence 在 cue 文本中的位置，把段首时间插值成更精确的起止秒。"""
    if start_sec is None:
        return None, end_sec
    if end_sec is None or float(end_sec) <= float(start_sec):
        return float(start_sec), end_sec
    ratios = evidence_ratio_in_text(evidence, source_text)
    if ratios is None:
        return float(start_sec), float(end_sec)
    dur = float(end_sec) - float(start_sec)
    lead = min(max(0.0, lead_sec), max(0.0, dur * 0.12))
    tail = min(max(0.0, tail_sec), max(0.0, dur * 0.08))
    t0 = float(start_sec) + ratios[0] * dur - lead
    t1 = float(start_sec) + ratios[1] * dur + tail
    t0 = min(max(t0, float(start_sec)), float(end_sec) - 0.05)
    t1 = min(max(t1, t0 + 0.25), float(end_sec))
    return t0, t1


def _cue_source_texts(row: dict[str, Any] | None, kind: str | None = None) -> list[str]:
    """计时只用口播 asr；extract 是压缩摘要，不能按字数映射到时间轴。"""
    if not row:
        return []
    asr = str(row.get("asr_text") or row.get("text") or "").strip()
    return [asr] if asr else []


def fill_grounding_times(
    cards: list[AssetCard],
    cues: list[dict[str, Any]] | None = None,
) -> int:
    """用 cue 表或 cue_id 后缀补全 start_sec/end_sec。已有秒数不覆盖。"""
    by_id: dict[str, dict[str, Any]] = {}
    for c in cues or []:
        cid = str(c.get("cue_id") or c.get("id") or "").strip()
        if cid:
            by_id[cid] = c
    filled = 0
    for card in cards:
        g = card.grounding
        if not g:
            continue
        if g.start_sec is not None:
            continue
        row = by_id.get(str(g.cue_id or ""))
        start, end = cue_time_span(row) if row else parse_cue_id_times(g.cue_id)
        if start is None:
            continue
        g.start_sec = start
        g.end_sec = end
        filled += 1
    return filled


def refine_grounding_times(
    cards: list[AssetCard],
    cues: list[dict[str, Any]] | None = None,
) -> int:
    """有 evidence 时，把 start_sec 从整段起点改到原文出现的位置。"""
    by_id: dict[str, dict[str, Any]] = {}
    for c in cues or []:
        cid = str(c.get("cue_id") or c.get("id") or "").strip()
        if cid:
            by_id[cid] = c
    refined = 0
    for card in cards:
        g = card.grounding
        ev = (getattr(card, "evidence", None) or "").strip()
        if not g or not ev:
            continue
        row = by_id.get(str(g.cue_id or ""))
        cue_start, cue_end = cue_time_span(row) if row else parse_cue_id_times(g.cue_id)
        if cue_start is None:
            continue
        if cue_end is None:
            cue_end = g.end_sec
        texts = _cue_source_texts(row, getattr(card, "kind", None))
        if not texts:
            continue
        hit: tuple[float | None, float | None] | None = None
        for text in texts:
            if evidence_ratio_in_text(ev, text) is None:
                continue
            hit = interpolate_evidence_time(ev, text, cue_start, cue_end)
            break
        if not hit or hit[0] is None:
            continue
        new_s, new_e = hit
        if g.start_sec != new_s or g.end_sec != new_e:
            g.start_sec = new_s
            g.end_sec = new_e
            refined += 1
    return refined


def card_appearance_key(card: AssetCard) -> tuple:
    """课堂原文出现顺序：讲次 → 时间轴秒数 → 种类 → id。无时间的排在该讲末尾。"""
    g = card.grounding
    lec_s = str(g.lecture_id) if g and g.lecture_id is not None else ""
    try:
        lec_n = int(lec_s) if lec_s else 10**9
    except ValueError:
        lec_n = 10**9
    start: float | None = None
    if g and g.start_sec is not None:
        start = float(g.start_sec)
    if start is None and g:
        parsed, _ = parse_cue_id_times(g.cue_id)
        start = parsed
    start_key = start if start is not None else float("inf")
    return (lec_n, start_key, str(card.kind or ""), str(card.asset_id or ""))


def sort_cards_by_appearance(cards: list[AssetCard]) -> list[AssetCard]:
    return sorted(cards, key=card_appearance_key)


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
    edges: list[AssetEdgeLink] = field(default_factory=list)
    grounding: AssetGrounding | None = None
    source: str = "curated"
    links: AssetLinks = field(default_factory=empty_links)
    # 原文依据（课堂连续子串），用于重叠关联
    evidence: str = ""
    # 公式卡：LaTeX 或记号原文
    latex: str = ""

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
        if self.edges:
            data["edges"] = [e.to_dict() for e in self.edges]
        if self.evidence:
            data["evidence"] = self.evidence
        if self.latex:
            data["latex"] = self.latex
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
        edges = [
            AssetEdgeLink(
                subject=str(e.get("subject") or "").strip(),
                predicate=str(e.get("predicate") or e.get("abstract_relation") or "").strip(),
                object=str(e.get("object") or "").strip(),
                role=str(e.get("role") or "illustrates").strip() or "illustrates",
            )
            for e in (raw.get("edges") or [])
            if isinstance(e, dict)
            and str(e.get("subject") or "").strip()
            and str(e.get("object") or "").strip()
        ]
        g_raw = raw.get("grounding") if isinstance(raw.get("grounding"), dict) else None
        grounding = None
        if g_raw:
            ppt = g_raw.get("ppt_page")
            start = g_raw.get("start_sec")
            end = g_raw.get("end_sec")
            grounding = AssetGrounding(
                lecture_id=str(g_raw.get("lecture_id") or "").strip() or None,
                cue_id=str(g_raw.get("cue_id") or "").strip() or None,
                ppt_page=int(ppt) if ppt is not None and str(ppt).strip() != "" else None,
                start_sec=float(start) if start is not None and str(start).strip() != "" else None,
                end_sec=float(end) if end is not None and str(end).strip() != "" else None,
            )
            if grounding.start_sec is None and grounding.cue_id:
                s, e = parse_cue_id_times(grounding.cue_id)
                grounding.start_sec, grounding.end_sec = s, e
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
            edges=edges,
            grounding=grounding,
            source=str(raw.get("source") or "curated").strip() or "curated",
            links=links,
            evidence=str(raw.get("evidence") or raw.get("context") or "").strip(),
            latex=str(raw.get("latex") or "").strip(),
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


def _zh(name: str) -> str:
    return (name or "").split("/", 1)[0].strip()


def _index_by_entity(cards: list[AssetCard]) -> dict[str, list[str]]:
    idx: dict[str, list[str]] = {}

    def add(key: str, aid: str) -> None:
        k = (key or "").strip()
        if not k:
            return
        idx.setdefault(k, []).append(aid)
        z = _zh(k)
        if z and z != k:
            idx.setdefault(z, []).append(aid)

    for card in cards:
        for link in card.concepts:
            add(link.entity, card.asset_id)
        for edge in card.edges:
            add(edge.subject, card.asset_id)
            add(edge.object, card.asset_id)
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
    for edge in card.edges:
        if edge.role not in CONCEPT_ROLES:
            errors.append(f"invalid edge role: {edge.role}")
        if not edge.predicate:
            errors.append("edge missing predicate")
    if card.source not in {"textbook", "lecture", "curated", "llm"}:
        errors.append(f"invalid source: {card.source}")
    if card.kind != "technique" and card.steps:
        # 允许但提示性：非 technique 不应依赖 steps；不报错
        pass
    return errors


def card_to_jsonable(card: AssetCard) -> dict[str, Any]:
    return asdict(card)
