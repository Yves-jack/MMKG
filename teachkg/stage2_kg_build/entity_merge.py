"""Stage 2：实体名归一化与合并（参考 AutoEduKG Processor.match_process）。"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any


def parse_entity(entity: str) -> tuple[str, str, str]:
    """解析实体为 (完整名, 中文, 英文)。"""
    char_remove_pos: list[int] = []
    entity = entity.strip()
    for idx, char in enumerate(entity):
        if char != " ":
            continue
        if idx <= 0 or idx >= len(entity) - 1:
            char_remove_pos.append(idx)
            continue
        lchar, rchar = entity[idx - 1], entity[idx + 1]
        if lchar.isalpha() and rchar.isalpha():
            continue
        char_remove_pos.append(idx)
    for pos in char_remove_pos[::-1]:
        entity = entity[:pos] + entity[pos + 1 :]

    entity_parts = entity.split("/")
    if len(entity_parts) == 1:
        if re.search(r"[\u4e00-\u9fff]", entity_parts[0]):
            return entity, entity, ""
        return entity, "", entity
    if len(entity_parts) == 2:
        zh, en = entity_parts[0], entity_parts[1]
        return entity, zh, en

    count = entity.count("/")
    middle_count = (count - 1) // 2 + 1
    pos = 0
    for idx, char in enumerate(entity):
        if char == "/":
            middle_count -= 1
            if middle_count == 0:
                pos = idx
                break
    zh, en = entity[:pos], entity[pos + 1 :]
    return entity, zh, en


def _normalize_lookup(text: str) -> str:
    return text.strip().lower()


@dataclass
class EntityRecord:
    canonical: str
    zh: str
    en: str
    aliases: set[str] = field(default_factory=set)
    cue_ids: set[str] = field(default_factory=set)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.canonical,
            "name": self.canonical,
            "zh": self.zh,
            "en": self.en,
            "aliases": sorted(self.aliases),
            "cue_ids": sorted(self.cue_ids),
            "mention_count": len(self.cue_ids),
        }


@dataclass
class MergedEdge:
    subject: str
    object: str
    abstract_relation: str
    concrete_relation: str
    statement_direction: str = ""
    attribute_category: str = ""
    natural_statement: str = ""
    description: str = ""
    provenance: list[dict[str, Any]] = field(default_factory=list)

    @property
    def edge_key(self) -> tuple[str, str, str, str]:
        return (self.subject, self.abstract_relation, self.concrete_relation, self.object)

    def to_dict(self) -> dict[str, Any]:
        return {
            "subject": self.subject,
            "object": self.object,
            "abstract_relation": self.abstract_relation,
            "concrete_relation": self.concrete_relation,
            "statement_direction": self.statement_direction,
            "attribute_category": self.attribute_category,
            "natural_statement": self.natural_statement,
            "description": self.description,
            "provenance": self.provenance,
            "cue_ids": sorted({p.get("cue_id", "") for p in self.provenance if p.get("cue_id")}),
        }


@dataclass
class EntityMergeResult:
    entities: dict[str, EntityRecord]
    edges: list[MergedEdge]
    merge_map: dict[str, str]
    stats: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "entity_count": len(self.entities),
            "edge_count": len(self.edges),
            "entities": [e.to_dict() for e in sorted(self.entities.values(), key=lambda x: x.canonical)],
            "edges": [e.to_dict() for e in self.edges],
            "merge_map": dict(sorted(self.merge_map.items())),
            "stats": self.stats,
        }


def build_entity_merge_map(entity_names: list[str]) -> dict[str, str]:
    """按中/英文主名合并实体，返回 alias → canonical。"""
    zh_to_canonical: dict[str, str] = {}
    en_to_canonical: dict[str, str] = {}
    merge_map: dict[str, str] = {}

    for name in entity_names:
        canonical, zh, en = parse_entity(name)
        match = canonical
        zh_key = _normalize_lookup(zh) if zh else ""
        en_key = _normalize_lookup(en) if en else ""

        if zh_key and zh_key in zh_to_canonical:
            match = zh_to_canonical[zh_key]
        elif en_key and en_key in en_to_canonical:
            match = en_to_canonical[en_key]
        else:
            if zh_key:
                zh_to_canonical[zh_key] = match
            if en_key:
                en_to_canonical[en_key] = match

        if name != match:
            merge_map[name] = match

    return merge_map


def _connected_components(nodes: set[str], edges: list[MergedEdge]) -> list[set[str]]:
    adj: dict[str, set[str]] = {n: set() for n in nodes}
    for edge in edges:
        adj.setdefault(edge.subject, set()).add(edge.object)
        adj.setdefault(edge.object, set()).add(edge.subject)

    seen: set[str] = set()
    components: list[set[str]] = []
    for node in nodes:
        if node in seen:
            continue
        stack = [node]
        comp: set[str] = set()
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            comp.add(cur)
            stack.extend(adj.get(cur, set()) - seen)
        components.append(comp)
    return components


def _compose_merge_map(
    base: dict[str, str],
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    """合并字符串规则与 embedding 规则，并解析 alias 链。"""
    merged = dict(base)
    if extra:
        for alias, target in extra.items():
            if alias and target and alias != target:
                merged[alias] = target

    def resolve(name: str) -> str:
        seen: set[str] = set()
        cur = name
        while cur in merged and merged[cur] != cur:
            if cur in seen:
                break
            seen.add(cur)
            cur = merged[cur]
        return cur

    return {alias: resolve(alias) for alias in merged if resolve(alias) != alias}


def merge_triplets_to_kg(
    triplets: list[dict[str, Any]],
    *,
    drop_related_with_when_specific: bool = True,
    min_subgraph_size: int = 0,
    embedding_merge_map: dict[str, str] | None = None,
) -> EntityMergeResult:
    """将 Stage 1 三元组列表合并为课程级知识图谱。"""
    raw_entity_names: list[str] = []
    for row in triplets:
        sub = str(row.get("subject", "")).strip()
        obj = str(row.get("object", "")).strip()
        if sub:
            raw_entity_names.append(sub)
        if obj:
            raw_entity_names.append(obj)

    merge_map = _compose_merge_map(build_entity_merge_map(raw_entity_names), embedding_merge_map)

    def canonical(name: str) -> str:
        return merge_map.get(name, name)

    edge_map: dict[tuple[str, str, str, str], MergedEdge] = {}
    for row in triplets:
        sub = canonical(str(row.get("subject", "")).strip())
        obj = canonical(str(row.get("object", "")).strip())
        if not sub or not obj or sub == obj:
            continue

        abstract_rel = str(row.get("abstract_relation", "")).strip()
        concrete_rel = str(row.get("concrete_relation", "")).strip()
        if not abstract_rel or not concrete_rel:
            continue

        edge = MergedEdge(
            subject=sub,
            object=obj,
            abstract_relation=abstract_rel,
            concrete_relation=concrete_rel,
            statement_direction=str(row.get("statement_direction", "")).strip(),
            attribute_category=str(row.get("attribute_category", "")).strip(),
            natural_statement=str(row.get("natural_statement", "")).strip(),
            description=str(row.get("description", "")).strip(),
        )
        prov = {
            "cue_id": row.get("cue_id", ""),
            "lecture_id": row.get("lecture_id", ""),
            "context": row.get("context", ""),
            "start_sec": row.get("start_sec"),
            "end_sec": row.get("end_sec"),
            "ppt_page_index": row.get("ppt_page_index"),
        }
        key = edge.edge_key
        if key in edge_map:
            edge_map[key].provenance.append(prov)
            if not edge_map[key].natural_statement and edge.natural_statement:
                edge_map[key].natural_statement = edge.natural_statement
            if not edge_map[key].description and edge.description:
                edge_map[key].description = edge.description
        else:
            edge.provenance.append(prov)
            edge_map[key] = edge

    edges = list(edge_map.values())

    if drop_related_with_when_specific:
        pair_relations: dict[frozenset[str], list[MergedEdge]] = defaultdict(list)
        for edge in edges:
            pair_relations[frozenset({edge.subject, edge.object})].append(edge)
        drop_keys: set[tuple[str, str, str, str]] = set()
        for group in pair_relations.values():
            rel_types = {e.abstract_relation for e in group}
            if "related_with" in rel_types and len(rel_types) > 1:
                for edge in group:
                    if edge.abstract_relation == "related_with":
                        drop_keys.add(edge.edge_key)
        if drop_keys:
            edges = [e for e in edges if e.edge_key not in drop_keys]

        cue_relations: dict[tuple[str, str, str], set[str]] = defaultdict(set)
        for edge in edges:
            for prov in edge.provenance:
                cid = str(prov.get("cue_id") or "")
                if not cid:
                    continue
                cue_relations[(edge.subject, edge.object, cid)].add(edge.abstract_relation)
        drop_keys_cue: set[tuple[str, str, str, str]] = set()
        for edge in edges:
            for prov in edge.provenance:
                cid = str(prov.get("cue_id") or "")
                if not cid:
                    continue
                rels = cue_relations.get((edge.subject, edge.object, cid), set())
                if edge.abstract_relation == "related_with" and len(rels) > 1:
                    drop_keys_cue.add(edge.edge_key)
        if drop_keys_cue:
            edges = [e for e in edges if e.edge_key not in drop_keys_cue]

    entity_names = {e.subject for e in edges} | {e.object for e in edges}
    if min_subgraph_size > 1 and entity_names:
        components = _connected_components(entity_names, edges)
        small_nodes = set()
        for comp in components:
            if len(comp) < min_subgraph_size:
                small_nodes.update(comp)
        if small_nodes:
            edges = [e for e in edges if e.subject not in small_nodes and e.object not in small_nodes]
            entity_names -= small_nodes

    entities: dict[str, EntityRecord] = {}
    for name in sorted(entity_names):
        _, zh, en = parse_entity(name)
        rec = EntityRecord(canonical=name, zh=zh, en=en)
        for alias, target in merge_map.items():
            if target == name and alias != name:
                rec.aliases.add(alias)
        entities[name] = rec

    for edge in edges:
        for prov in edge.provenance:
            cue_id = prov.get("cue_id")
            if cue_id:
                entities[edge.subject].cue_ids.add(cue_id)
                entities[edge.object].cue_ids.add(cue_id)

    stats = {
        "input_triplet_count": len(triplets),
        "raw_entity_mentions": len(raw_entity_names),
        "merged_entity_count": len(entities),
        "merged_alias_count": len(merge_map),
        "output_edge_count": len(edges),
        "relation_counts": dict(Counter(e.abstract_relation for e in edges)),
    }

    return EntityMergeResult(
        entities=entities,
        edges=edges,
        merge_map=merge_map,
        stats=stats,
    )
