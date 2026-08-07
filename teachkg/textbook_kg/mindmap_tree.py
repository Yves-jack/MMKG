"""讲次知识图谱 → 思维导树（图投影为单父树）。"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from teachkg.textbook_kg.importance_feedback import (
    entity_weight_multiplier,
    is_invalid_entity,
)

# 层级边强度：越大越优先作为树边
_REL_STRENGTH = {
    "part_of": 1.0,
    "belong_to": 0.85,
    "property_of": 0.65,
    "depend_on": 0.35,
    "related_with": 0.0,
    "synonym_of": 0.0,
}


def _zh(name: str) -> str:
    if (name or "").startswith("__chapter__/"):
        return name.split("/", 1)[1].strip() or name
    if (name or "").startswith("__course__/"):
        return name.split("/", 1)[1].strip() or name
    return (name or "").split("/")[0].strip()


def _rel_key(edge: dict[str, Any]) -> str:
    return str(edge.get("abstract_relation") or edge.get("relation") or "").split("|")[0].strip()


@dataclass
class TreeNode:
    id: str
    zh: str
    importance: float = 0.0
    relation: str | None = None
    children: list["TreeNode"] = field(default_factory=list)
    related: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "zh": self.zh,
            "importance": round(self.importance, 6),
            "relation": self.relation,
            "related": self.related,
            "children": [c.to_dict() for c in self.children],
        }


@dataclass
class MindmapResult:
    lecture_id: str
    root: TreeNode
    n_nodes: int
    max_depth: int
    orphan_count: int
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "lecture_id": self.lecture_id,
            "root": self.root.to_dict(),
            "n_nodes": self.n_nodes,
            "max_depth": self.max_depth,
            "orphan_count": self.orphan_count,
            "meta": self.meta,
        }


def _orient_hierarchy_edge(subj: str, obj: str, rel: str) -> tuple[str, str, float] | None:
    """返回 (parent, child, strength)；不可作层级则 None。"""
    strength = _REL_STRENGTH.get(rel, 0.0)
    if strength <= 0:
        return None
    # A part_of/belong_to/property_of/depend_on B → 父=B, 子=A
    if rel in {"part_of", "belong_to", "property_of", "depend_on"}:
        return obj, subj, strength
    return None


def _merge_synonyms(
    entities: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    importance: dict[str, float],
) -> tuple[dict[str, str], dict[str, float]]:
    """synonym_of 合并到重要性更高的 canonical；返回 alias→canonical 与合并后 importance。"""
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        # 选 importance 高、非泛化、名字较短者
        def score(n: str) -> tuple:
            return (
                entity_weight_multiplier(n),
                importance.get(n, 0.0),
                -len(_zh(n)),
            )

        if score(ra) >= score(rb):
            parent[rb] = ra
        else:
            parent[ra] = rb

    ids = {
        str(e.get("id") or e.get("name") or "")
        for e in entities
        if e.get("id") or e.get("name")
    }
    for e in edges:
        if _rel_key(e) != "synonym_of":
            continue
        s, o = str(e.get("subject") or ""), str(e.get("object") or "")
        if s in ids and o in ids and not is_invalid_entity(s) and not is_invalid_entity(o):
            parent.setdefault(s, s)
            parent.setdefault(o, o)
            union(s, o)

    alias_map: dict[str, str] = {}
    for n in ids:
        if not n or is_invalid_entity(n):
            continue
        parent.setdefault(n, n)
        alias_map[n] = find(n)

    merged_imp: dict[str, float] = defaultdict(float)
    for n, can in alias_map.items():
        merged_imp[can] = max(merged_imp[can], float(importance.get(n, 0.0)))
    return alias_map, dict(merged_imp)


def _pick_root(
    nodes: set[str],
    importance: dict[str, float],
    hierarchy_out: dict[str, int],
    chapter: str | None,
) -> tuple[str, bool]:
    """返回 (root_id, is_virtual)。章名实体不在图中时用虚拟根。"""
    chapter_keys: list[str] = []
    bare = ""
    if chapter:
        bare = re.sub(r"^第\s*\d+\s*章\s*", "", chapter).strip()
        if bare:
            chapter_keys.append(bare)
        chapter_keys.extend(p for p in re.split(r"[与和及、,，/\s]+", bare) if len(p) >= 2)

    # 章名命中实体
    chapter_hits = []
    for n in nodes:
        zh = _zh(n)
        for k in chapter_keys:
            if k and (k == zh or (len(k) >= 2 and (k in zh or zh in k))):
                chapter_hits.append(n)
                break
    if chapter_hits:
        best = max(
            chapter_hits,
            key=lambda n: (
                importance.get(n, 0.0),
                hierarchy_out.get(n, 0),
                -len(_zh(n)),
            ),
        )
        return best, False

    # 无章名实体：虚拟根（用章标题裸名）
    if bare:
        vid = f"__chapter__/{bare}"
        return vid, True

    best, best_s = "", -1e18
    for n in nodes:
        if entity_weight_multiplier(n) < 0.5:
            continue
        s = float(importance.get(n, 0.0))
        s += 0.15 * math.log1p(hierarchy_out.get(n, 0))
        if s > best_s:
            best_s, best = s, n
    if best:
        return best, False
    return max(nodes, key=lambda n: importance.get(n, 0.0)), False


def _chapter_keys(chapter: str) -> list[str]:
    bare = re.sub(r"^第\s*\d+\s*章\s*", "", chapter).strip()
    keys: list[str] = []
    if bare:
        keys.append(bare)
    keys.extend(p for p in re.split(r"[与和及、,，/\s]+", bare) if len(p) >= 2)
    return list(dict.fromkeys(keys))


def _entity_matches_keys(name: str, keys: list[str]) -> bool:
    zh = _zh(name)
    for k in keys:
        if k and (k == zh or (len(k) >= 2 and (k in zh or zh in k))):
            return True
    return False


def build_course_mindmap_tree(
    kg: dict[str, Any],
    *,
    importance: dict[str, float] | None = None,
    chapter_order: list[str] | None = None,
    course_title: str = "课程知识图谱",
    max_nodes: int = 120,
    max_depth: int = 4,
    max_children_per_chapter: int = 8,
    max_nodes_per_chapter: int = 12,
    top_entity_pool: int = 160,
) -> MindmapResult:
    """整课导图：课名根 → 各章（目录）→ 章内层级展开。"""
    entities = list(kg.get("entities") or [])
    edges = list(kg.get("edges") or [])
    importance = dict(importance or {})
    chapters = [c for c in (chapter_order or []) if c]

    for e in entities:
        nid = str(e.get("id") or e.get("name") or "")
        if nid and nid not in importance:
            importance[nid] = 0.05 * math.log1p(float(e.get("mention_count") or 1))

    alias_map, importance = _merge_synonyms(entities, edges, importance)

    def can(n: str) -> str:
        return alias_map.get(n, n)

    all_nodes: set[str] = set()
    for e in entities:
        nid = str(e.get("id") or e.get("name") or "")
        if not nid or is_invalid_entity(nid):
            continue
        c = can(nid)
        if not is_invalid_entity(c) and entity_weight_multiplier(c) >= 0.5:
            all_nodes.add(c)

    # 控制规模：先取重要性头部作为池
    pool = set(
        n
        for n, _ in sorted(importance.items(), key=lambda x: -x[1])[:top_entity_pool]
        if n in all_nodes
    )
    if not pool:
        pool = set(all_nodes)

    hier: list[tuple[float, float, str, str, str]] = []
    related: dict[str, set[str]] = defaultdict(set)
    out_deg: dict[str, int] = defaultdict(int)

    for e in edges:
        rel = _rel_key(e)
        s, o = str(e.get("subject") or ""), str(e.get("object") or "")
        if not s or not o:
            continue
        s, o = can(s), can(o)
        if s not in pool or o not in pool or s == o:
            continue
        if rel == "related_with":
            related[s].add(_zh(o))
            related[o].add(_zh(s))
            continue
        oriented = _orient_hierarchy_edge(s, o, rel)
        if not oriented:
            continue
        parent, child, strength = oriented
        strength *= entity_weight_multiplier(child)
        hier.append((strength, importance.get(child, 0.0), parent, child, rel))
        out_deg[parent] += 1

    root_id = f"__course__/{course_title}"
    importance[root_id] = (max(importance.values()) if importance else 1.0) * 1.1

    parent_of: dict[str, tuple[str, str]] = {}
    in_tree = {root_id}
    chapter_roots: list[str] = []

    # 每章：虚拟章节点挂到课根；再挂章主题实体 + 层级扩展
    for ch in chapters:
        if len(in_tree) >= max_nodes:
            break
        bare = re.sub(r"^第\s*\d+\s*章\s*", "", ch).strip() or ch
        ch_id = f"__chapter__/{bare}"
        importance[ch_id] = importance.get(ch_id, 0.35)
        parent_of[ch_id] = (root_id, "toc_chapter")
        in_tree.add(ch_id)
        chapter_roots.append(ch_id)

        keys = _chapter_keys(ch)
        # 章内候选：命中章名 或 与章命中实体有层级边
        matched = [
            n
            for n in pool
            if n not in in_tree and _entity_matches_keys(n, keys)
        ]
        matched.sort(key=lambda n: -importance.get(n, 0.0))

        # 无命中则跳过全局 Top 回填（避免「集合」等贯穿词污染每章）
        seeds = matched[:4]
        # 次选：与已命中实体有层级邻接、且尚未入树
        if len(seeds) < 2:
            neighbor: set[str] = set()
            seed_set = set(matched[:6]) or {
                n for n in pool if _entity_matches_keys(n, keys)
            }
            for _s, _ci, p, c, _r in hier:
                if p in seed_set and c not in in_tree:
                    neighbor.add(c)
                if c in seed_set and p not in in_tree:
                    neighbor.add(p)
            extra = sorted(neighbor, key=lambda n: -importance.get(n, 0.0))
            for n in extra:
                if n not in seeds:
                    seeds.append(n)
                if len(seeds) >= 4:
                    break

        ch_budget = max_nodes_per_chapter
        local_in = {ch_id}
        for n in seeds:
            if len(in_tree) >= max_nodes or len(local_in) >= ch_budget:
                break
            if n in in_tree:
                continue
            parent_of[n] = (ch_id, "chapter_topic")
            in_tree.add(n)
            local_in.add(n)

        # 章内扩展：parent 在 local_in
        local_hier = sorted(
            [
                x
                for x in hier
                if x[2] in local_in or x[3] in local_in
            ],
            key=lambda x: (-x[0], -x[1]),
        )
        changed = True
        while changed and len(local_in) < ch_budget and len(in_tree) < max_nodes:
            changed = False
            for strength, _cimp, parent, child, rel in local_hier:
                if parent not in local_in or child in in_tree:
                    continue
                # 深度：章节点算 1
                depth = 1
                walk = parent
                while walk in parent_of:
                    walk = parent_of[walk][0]
                    depth += 1
                    if depth >= max_depth:
                        break
                if depth >= max_depth:
                    continue
                sibs = sum(1 for c, (p, _) in parent_of.items() if p == parent)
                cap = max_children_per_chapter if parent == ch_id else max_children_per_chapter
                if sibs >= cap:
                    continue
                parent_of[child] = (parent, rel)
                in_tree.add(child)
                local_in.add(child)
                changed = True
                if len(local_in) >= ch_budget or len(in_tree) >= max_nodes:
                    break

    # 未覆盖的高重要性实体：挂到最相关章，否则挂课根「其他」
    other_id = f"__chapter__/其他要点"
    leftover = [
        n
        for n in sorted(pool, key=lambda x: -importance.get(x, 0.0))
        if n not in in_tree
    ][:12]
    if leftover and len(in_tree) < max_nodes:
        importance[other_id] = 0.2
        parent_of[other_id] = (root_id, "toc_chapter")
        in_tree.add(other_id)
        for n in leftover:
            if len(in_tree) >= max_nodes:
                break
            sibs = sum(1 for c, (p, _) in parent_of.items() if p == other_id)
            if sibs >= max_children_per_chapter:
                break
            parent_of[n] = (other_id, "attach")
            in_tree.add(n)

    children_map: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for child, (parent, rel) in parent_of.items():
        children_map[parent].append((child, rel))

    def build_node(nid: str, rel: str | None = None) -> TreeNode:
        kids = children_map.get(nid, [])
        # 章顺序保持目录序；其余按重要性
        if nid == root_id:
            order = {c: i for i, c in enumerate(chapter_roots)}
            kids.sort(
                key=lambda x: (
                    0 if x[0] in order else 1,
                    order.get(x[0], 999),
                    -importance.get(x[0], 0.0),
                )
            )
        else:
            kids.sort(key=lambda x: -importance.get(x[0], 0.0))
        return TreeNode(
            id=nid,
            zh=_zh(nid) if not nid.startswith("__course__/") else course_title,
            importance=float(importance.get(nid, 0.0)),
            relation=rel,
            related=sorted(related.get(nid, set()))[:6],
            children=[build_node(c, r) for c, r in kids],
        )

    # fix _zh for __course__
    root = build_node(root_id)
    root.zh = course_title

    def depth_of(node: TreeNode) -> int:
        if not node.children:
            return 1
        return 1 + max(depth_of(c) for c in node.children)

    return MindmapResult(
        lecture_id="course",
        root=root,
        n_nodes=len(in_tree),
        max_depth=depth_of(root),
        orphan_count=max(0, len(pool) - len(in_tree) + 1),
        meta={
            "scope": "course",
            "course_title": course_title,
            "root_zh": course_title,
            "virtual_root": True,
            "n_chapters": len(chapters),
            "max_nodes": max_nodes,
            "max_depth_cap": max_depth,
            "max_nodes_per_chapter": max_nodes_per_chapter,
            "n_entities_raw": len(entities),
            "n_edges_raw": len(edges),
            "pool_size": len(pool),
            "alias_merged": len({a for a, c in alias_map.items() if a != c}),
        },
    )


def build_mindmap_tree(
    kg: dict[str, Any],
    *,
    importance: dict[str, float] | None = None,
    chapter: str | None = None,
    max_nodes: int = 36,
    max_depth: int = 4,
    max_children: int = 8,
) -> MindmapResult:
    """从讲次 kg.json 构建思维导树。"""
    lecture_id = str(kg.get("lecture_id") or "")
    entities = list(kg.get("entities") or [])
    edges = list(kg.get("edges") or [])
    importance = dict(importance or {})

    for e in entities:
        nid = str(e.get("id") or e.get("name") or "")
        if nid and nid not in importance:
            importance[nid] = 0.05 * math.log1p(float(e.get("mention_count") or 1))

    alias_map, importance = _merge_synonyms(entities, edges, importance)

    def can(n: str) -> str:
        return alias_map.get(n, n)

    nodes: set[str] = set()
    for e in entities:
        nid = str(e.get("id") or e.get("name") or "")
        if not nid or is_invalid_entity(nid):
            continue
        c = can(nid)
        if not is_invalid_entity(c):
            nodes.add(c)

    hier: list[tuple[float, float, str, str, str]] = []
    related: dict[str, set[str]] = defaultdict(set)
    out_deg: dict[str, int] = defaultdict(int)

    for e in edges:
        rel = _rel_key(e)
        s, o = str(e.get("subject") or ""), str(e.get("object") or "")
        if not s or not o:
            continue
        s, o = can(s), can(o)
        if s not in nodes or o not in nodes or s == o:
            continue
        if rel == "related_with":
            related[s].add(_zh(o))
            related[o].add(_zh(s))
            continue
        oriented = _orient_hierarchy_edge(s, o, rel)
        if not oriented:
            continue
        parent, child, strength = oriented
        if parent not in nodes or child not in nodes:
            continue
        strength *= entity_weight_multiplier(child)
        hier.append((strength, importance.get(child, 0.0), parent, child, rel))
        out_deg[parent] += 1

    root_id, virtual_root = _pick_root(nodes, importance, out_deg, chapter)
    if virtual_root:
        importance[root_id] = max(importance.values() or [1.0]) * 1.05
        nodes.add(root_id)
        seeds = sorted(
            [n for n in nodes if n != root_id and entity_weight_multiplier(n) >= 0.5],
            key=lambda n: (-importance.get(n, 0.0), -out_deg.get(n, 0)),
        )[: max(3, min(6, max_children))]
        for n in seeds:
            hier.append((0.55, importance.get(n, 0.0), root_id, n, "chapter_topic"))
            out_deg[root_id] += 1
    elif out_deg.get(root_id, 0) < 3:
        # 真根但层级出边很少：用高重要性节点补一层主题枝
        seeds = sorted(
            [
                n
                for n in nodes
                if n != root_id and entity_weight_multiplier(n) >= 0.5
            ],
            key=lambda n: -importance.get(n, 0.0),
        )[: max(3, min(6, max_children))]
        for n in seeds:
            hier.append((0.5, importance.get(n, 0.0), root_id, n, "chapter_topic"))
            out_deg[root_id] += 1

    parent_of: dict[str, tuple[str, str]] = {}
    in_tree = {root_id}
    hier.sort(key=lambda x: (-x[0], -x[1], -importance.get(x[2], 0.0)))

    changed = True
    while changed and len(in_tree) < max_nodes:
        changed = False
        for strength, _cimp, parent, child, rel in hier:
            if parent not in in_tree or child in in_tree:
                continue
            depth = 1
            walk = parent
            while walk in parent_of:
                walk = parent_of[walk][0]
                depth += 1
                if depth >= max_depth:
                    break
            if depth >= max_depth:
                continue
            sibs = sum(1 for c, (p, _) in parent_of.items() if p == parent)
            if sibs >= max_children:
                continue
            parent_of[child] = (parent, rel)
            in_tree.add(child)
            changed = True
            if len(in_tree) >= max_nodes:
                break

    orphans = [
        n
        for n in sorted(nodes, key=lambda x: -importance.get(x, 0.0))
        if n not in in_tree and n != root_id and entity_weight_multiplier(n) >= 0.5
    ]
    attached_orphan = 0
    for n in orphans:
        if len(in_tree) >= max_nodes:
            break
        host = None
        for rzh in related.get(n, ()):
            for t in in_tree:
                if _zh(t) == rzh:
                    host = t
                    break
            if host:
                break
        if host is None:
            host = root_id
        sibs = sum(1 for c, (p, _) in parent_of.items() if p == host)
        if sibs >= max_children:
            if host != root_id:
                host = root_id
                sibs = sum(1 for c, (p, _) in parent_of.items() if p == host)
            if sibs >= max_children:
                continue
        parent_of[n] = (host, "related_with" if host != root_id else "attach")
        in_tree.add(n)
        attached_orphan += 1

    children_map: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for child, (parent, rel) in parent_of.items():
        children_map[parent].append((child, rel))

    def build_node(nid: str, rel: str | None = None, depth: int = 0) -> TreeNode:
        kids = children_map.get(nid, [])
        kids.sort(key=lambda x: -importance.get(x[0], 0.0))
        return TreeNode(
            id=nid,
            zh=_zh(nid),
            importance=float(importance.get(nid, 0.0)),
            relation=rel,
            related=sorted(related.get(nid, set()))[:6],
            children=[build_node(c, r, depth + 1) for c, r in kids],
        )

    root = build_node(root_id)

    def depth_of(node: TreeNode) -> int:
        if not node.children:
            return 1
        return 1 + max(depth_of(c) for c in node.children)

    return MindmapResult(
        lecture_id=lecture_id,
        root=root,
        n_nodes=len(in_tree),
        max_depth=depth_of(root),
        orphan_count=max(0, len(nodes) - len(in_tree)),
        meta={
            "chapter": chapter,
            "root_id": root_id,
            "root_zh": _zh(root_id),
            "virtual_root": virtual_root,
            "max_nodes": max_nodes,
            "max_depth_cap": max_depth,
            "max_children": max_children,
            "n_entities_raw": len(entities),
            "n_edges_raw": len(edges),
            "n_hierarchy_candidates": len(hier),
            "attached_orphans": attached_orphan,
            "alias_merged": len({a for a, c in alias_map.items() if a != c}),
        },
    )
