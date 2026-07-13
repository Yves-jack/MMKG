"""教材实体注册表：synonym + alias + 向量近邻，用于增量边 canonical 链接。"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from teachkg.textbook_kg.alias import clean_text
from teachkg.textbook_kg.loader import TextbookKG

logger = logging.getLogger(__name__)

_ORAL_NUMBERED_RE = re.compile(
    r"^(?:第[一二三四五六七八九十\d]+个)?(?:公理|定理|命题|推论|引理)\s*\d+",
    re.IGNORECASE,
)


def entity_primary(name: str) -> str:
    return name.split("/", 1)[0].strip()


def entity_en(name: str) -> str:
    parts = name.split("/", 1)
    return parts[1].strip() if len(parts) > 1 else ""


@dataclass
class EntityRegistry:
    textbook_entity_names: set[str] = field(default_factory=set)
    alias_to_canonical: dict[str, str] = field(default_factory=dict)
    zh_to_canonical: dict[str, str] = field(default_factory=dict)
    en_to_canonical: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_textbook_kg(cls, kg: TextbookKG) -> EntityRegistry:
        registry = cls(textbook_entity_names=set(kg.entity_names))
        for name in kg.entity_names:
            zh = entity_primary(name)
            en = entity_en(name)
            registry._register(name, name)
            if zh:
                registry._register_alias(zh, name)
            if en:
                registry._register_alias(en.lower(), name)

        for rel in kg.relations:
            if rel.predicate != "synonym_of":
                continue
            registry._register_alias(entity_primary(rel.subject), rel.object)
            registry._register_alias(entity_primary(rel.object), rel.subject)
            registry._register_alias(rel.subject, rel.object)
            registry._register_alias(rel.object, rel.subject)

        for alias, targets in kg.alias_map.items():
            for target in targets:
                registry._register_alias(alias, target)

        return registry

    def _register(self, alias: str, canonical: str) -> None:
        key = clean_text(alias)
        if key:
            self.alias_to_canonical[key] = canonical

    def _register_alias(self, alias: str, canonical: str) -> None:
        if not alias or not canonical:
            return
        zh = entity_primary(alias)
        en = entity_en(alias)
        if zh:
            self.zh_to_canonical.setdefault(zh.lower(), canonical)
            self._register(zh, canonical)
        if en:
            self.en_to_canonical.setdefault(en.lower(), canonical)
            self._register(en, canonical)
        self._register(alias, canonical)

    def lookup(self, name: str) -> str | None:
        if not name.strip():
            return None
        if name in self.textbook_entity_names:
            return name
        key = clean_text(name)
        if key in self.alias_to_canonical:
            return self.alias_to_canonical[key]
        zh = entity_primary(name).lower()
        if zh in self.zh_to_canonical:
            return self.zh_to_canonical[zh]
        en = entity_en(name).lower()
        if en in self.en_to_canonical:
            return self.en_to_canonical[en]
        return None

    def should_skip_link(self, name: str) -> bool:
        """口语编号实体不做链接（概念导向下应被过滤）。"""
        zh = entity_primary(name)
        return bool(_ORAL_NUMBERED_RE.match(zh))

    def canonicalize(self, name: str, *, cue_text: str = "") -> str:
        if not name.strip() or self.should_skip_link(name):
            return name
        hit = self.lookup(name)
        if hit:
            return hit
        if cue_text:
            linked = self._link_by_cue_alias(name, cue_text)
            if linked:
                return linked
        return name

    def _link_by_cue_alias(self, name: str, cue_text: str) -> str | None:
        zh = entity_primary(name)
        if not zh or len(zh) < 2:
            return None
        cue_clean = clean_text(cue_text)
        zh_clean = clean_text(zh)
        if zh_clean not in cue_clean:
            return None
        for canonical in self.textbook_entity_names:
            if clean_text(entity_primary(canonical)) == zh_clean:
                return canonical
        return None

    def link_triplet(
        self,
        subject: str,
        object_: str,
        *,
        cue_text: str = "",
        embedder=None,
        query_text: str = "",
        min_score: float = 0.88,
    ) -> tuple[str, str]:
        sub = self.canonicalize(subject, cue_text=cue_text)
        obj = self.canonicalize(object_, cue_text=cue_text)

        if embedder is not None and query_text.strip():
            if sub == subject and not self.should_skip_link(subject):
                sub = self._link_by_embedding(subject, embedder, query_text, min_score) or sub
            if obj == object_ and not self.should_skip_link(object_):
                obj = self._link_by_embedding(object_, embedder, query_text, min_score) or obj
        return sub, obj

    def _link_by_embedding(self, name: str, embedder, query_text: str, min_score: float) -> str | None:
        try:
            import numpy as np
        except ImportError:
            return None
        if self.should_skip_link(name):
            return None
        query = embedder.embed_one(f"{entity_primary(name)}。{query_text[:200]}")
        best_name: str | None = None
        best_score = min_score
        for canonical in self.textbook_entity_names:
            cand = embedder.embed_one(canonical)
            denom = np.linalg.norm(query) * np.linalg.norm(cand)
            if denom < 1e-8:
                continue
            score = float(np.dot(query, cand) / denom)
            if score > best_score:
                best_score = score
                best_name = canonical
        return best_name

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "entity_count": len(self.textbook_entity_names),
            "alias_count": len(self.alias_to_canonical),
            "alias_to_canonical": dict(sorted(self.alias_to_canonical.items())),
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
