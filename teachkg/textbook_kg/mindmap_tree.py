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

# 树边只允许层次关系；属于优先于组成
_REL_STRENGTH = {
    "belong_to": 1.0,
    "part_of": 0.85,
}
_RELATED_RELS = frozenset({"depend_on", "related_with"})
_PROPERTY_REL = "property_of"


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
    copy: bool = False

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "zh": self.zh,
            "importance": round(self.importance, 6),
            "relation": self.relation,
            "related": self.related,
            "children": [c.to_dict() for c in self.children],
        }
        if self.copy:
            d["copy"] = True
        return d


@dataclass
class MindmapResult:
    lecture_id: str
    root: TreeNode
    n_nodes: int
    max_depth: int
    orphan_count: int
    meta: dict[str, Any] = field(default_factory=dict)
    roots: list[TreeNode] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        trees = self.roots or [self.root]
        return {
            "lecture_id": self.lecture_id,
            "root": self.root.to_dict(),
            "roots": [t.to_dict() for t in trees],
            "n_nodes": self.n_nodes,
            "max_depth": self.max_depth,
            "orphan_count": self.orphan_count,
            "meta": self.meta,
        }


def _drop_hierarchy_shortcuts(edges: list[dict[str, Any]], can) -> list[dict[str, Any]]:
    """子-belong_to→父 且 父-part_of→祖 时，丢掉子→祖的 part_of（对齐课堂图后处理）。"""
    belong: dict[str, set[str]] = defaultdict(set)
    part_of: dict[str, set[str]] = defaultdict(set)
    rows: list[tuple[dict[str, Any], str, str, str]] = []
    for e in edges:
        rel = _rel_key(e)
        s = can(str(e.get("subject") or e.get("from") or ""))
        o = can(str(e.get("object") or e.get("to") or ""))
        rows.append((e, rel, s, o))
        if not s or not o or s == o:
            continue
        if rel == "belong_to":
            belong[s].add(o)
        elif rel == "part_of":
            part_of[s].add(o)
    kept: list[dict[str, Any]] = []
    for e, rel, s, o in rows:
        if rel == "part_of" and any(o in part_of.get(p, ()) for p in belong.get(s, ())):
            continue
        kept.append(e)
    return kept


def _is_special_attach_kind(name: str) -> bool:
    """定理/算法/公式等不得做概念的父；应挂在概念下。"""
    t = f"{_zh(name)} {name}"
    return bool(
        re.search(r"定理|算法|公式|公理|引理|推论|定律|法则|命题演算系统", t)
    )


def _orient_hierarchy_edge(subj: str, obj: str, rel: str) -> tuple[str, str, float] | None:
    """返回 (parent, child, strength)；不可作层级则 None。

    约定与课堂图一致：A belong_to/part_of B → 父=B、子=A。
    property_of 已折进实体特性，depend_on 只作 related，均不作树边。
    若父为定理/算法而子为概念 → 翻转。
    """
    strength = _REL_STRENGTH.get(rel, 0.0)
    if strength <= 0:
        return None
    if rel not in _REL_STRENGTH:
        return None
    parent, child = obj, subj
    if _is_special_attach_kind(parent) and not _is_special_attach_kind(child):
        parent, child = child, parent
    return parent, child, strength


def _bottom_up_parent_of(
    nodes: set[str],
    hier: list[tuple[float, float, str, str, str]],
    importance: dict[str, float],
) -> dict[str, tuple[str, str]]:
    """自底向上挂父：先处理叶子（不当任何人的父），属于优先。"""
    uf = {n: n for n in nodes}

    def find(x: str) -> str:
        while uf[x] != x:
            uf[x] = uf[uf[x]]
            x = uf[x]
        return x

    cands: dict[str, list[tuple[float, float, str, str, str]]] = defaultdict(list)
    for h in hier:
        cands[h[3]].append(h)

    unassigned = set(cands)
    parent_of: dict[str, tuple[str, str]] = {}

    def ready(child: str) -> bool:
        for other in unassigned:
            if other == child:
                continue
            if any(h[2] == child for h in cands[other]):
                return False
        return True

    while unassigned:
        batch = [c for c in unassigned if ready(c)] or list(unassigned)
        batch.sort(key=lambda c: (-importance.get(c, 0.0), c))
        progressed = False
        for child in batch:
            opts = sorted(
                cands[child],
                key=lambda x: (-x[0], -importance.get(x[2], 0.0), -x[1], x[2]),
            )
            for _strength, _cimp, parent, ch, rel in opts:
                if ch not in nodes or parent not in nodes:
                    continue
                if ch in parent_of or ch == parent:
                    continue
                if find(ch) == find(parent):
                    continue
                parent_of[ch] = (parent, rel)
                uf[find(ch)] = find(parent)
                progressed = True
                break
            unassigned.discard(child)
        if not progressed:
            break
    return parent_of


def _looks_like_property_phrase(name: str) -> bool:
    zh = _zh(name)
    if len(zh) >= 6 and re.search(r"(为空|相连|为真|为假|等于|大于|小于|具有)", zh):
        return True
    if re.match(r"^(任意|所有|每个)", zh) and len(zh) >= 6:
        return True
    return False


def _prepare_graph(
    entities: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, set[str]]]:
    """对齐课堂后处理：去掉 property_of 边与纯属性句节点；depend_on 记入 related。"""
    related: dict[str, set[str]] = defaultdict(set)
    attr_subjects: set[str] = set()
    kept: list[dict[str, Any]] = []
    for e in edges:
        rel = _rel_key(e)
        s, o = str(e.get("subject") or e.get("from") or ""), str(e.get("object") or e.get("to") or "")
        if not s or not o or s == o:
            continue
        if rel == _PROPERTY_REL:
            attr_subjects.add(s)
            continue
        if rel in _RELATED_RELS:
            related[s].add(_zh(o))
            related[o].add(_zh(s))
            if rel == "depend_on":
                kept.append(e)  # 课程总导图仍可能沿 depend_on 传分；讲次导图改走树边
            continue
        kept.append(e)

    still_linked: set[str] = set()
    for e in kept:
        still_linked.add(str(e.get("subject") or e.get("from") or ""))
        still_linked.add(str(e.get("object") or e.get("to") or ""))

    drop = {
        n
        for n in attr_subjects
        if n not in still_linked or _looks_like_property_phrase(n)
    }
    ents = [
        e
        for e in entities
        if str(e.get("id") or e.get("name") or "") not in drop
    ]
    edges_out = [
        e
        for e in kept
        if str(e.get("subject") or e.get("from") or "") not in drop
        and str(e.get("object") or e.get("to") or "") not in drop
    ]
    return ents, edges_out, related


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
    entities, edges, related_seed = _prepare_graph(entities, edges)
    importance = dict(importance or {})
    chapters = [c for c in (chapter_order or []) if c]

    for e in entities:
        nid = str(e.get("id") or e.get("name") or "")
        if nid and nid not in importance:
            importance[nid] = 0.05 * math.log1p(float(e.get("mention_count") or 1))

    alias_map, importance = _merge_synonyms(entities, edges, importance)

    def can(n: str) -> str:
        return alias_map.get(n, n)

    edges = _drop_hierarchy_shortcuts(edges, can)

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
    for k, vs in related_seed.items():
        related[can(k)].update(vs)
    out_deg: dict[str, int] = defaultdict(int)

    for e in edges:
        rel = _rel_key(e)
        s, o = str(e.get("subject") or ""), str(e.get("object") or "")
        if not s or not o:
            continue
        s, o = can(s), can(o)
        if s not in pool or o not in pool or s == o:
            continue
        oriented = _orient_hierarchy_edge(s, o, rel)
        if not oriented:
            continue
        parent, child, strength = oriented
        strength *= entity_weight_multiplier(child)
        hier.append((strength, importance.get(child, 0.0), parent, child, rel))
        out_deg[parent] += 1

    # 重要性由图谱侧传递后传入；导图只展示，不再二次传递
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
        roots=[root],
        n_nodes=len(in_tree),
        max_depth=depth_of(root),
        orphan_count=max(0, len(pool) - len(in_tree) + 1),
        meta={
            "scope": "course",
            "course_title": course_title,
            "root_zh": course_title,
            "virtual_root": True,
            "n_trees": 1,
            "n_chapters": len(chapters),
            "max_nodes": max_nodes,
            "max_depth_cap": max_depth,
            "max_nodes_per_chapter": max_nodes_per_chapter,
            "n_entities_raw": len(entities),
            "n_edges_raw": len(edges),
            "pool_size": len(pool),
            "alias_merged": len({a for a, c in alias_map.items() if a != c}),
            "source": "kg",
        },
    )


def build_mindmap_tree(
    kg: dict[str, Any],
    *,
    importance: dict[str, float] | None = None,
    chapter: str | None = None,
    max_nodes: int = 64,
    max_depth: int = 4,
    max_children: int = 8,
) -> MindmapResult:
    """从讲次 kg.json 构建思维导树。"""
    lecture_id = str(kg.get("lecture_id") or "")
    entities = list(kg.get("entities") or [])
    edges = list(kg.get("edges") or [])
    entities, edges, related_seed = _prepare_graph(entities, edges)
    importance = dict(importance or {})

    for e in entities:
        nid = str(e.get("id") or e.get("name") or "")
        if nid and nid not in importance:
            importance[nid] = 0.05 * math.log1p(float(e.get("mention_count") or 1))

    alias_map, importance = _merge_synonyms(entities, edges, importance)

    def can(n: str) -> str:
        return alias_map.get(n, n)

    edges = _drop_hierarchy_shortcuts(edges, can)

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
    for k, vs in related_seed.items():
        related[can(k)].update(vs)

    for e in edges:
        rel = _rel_key(e)
        s, o = str(e.get("subject") or ""), str(e.get("object") or "")
        if not s or not o:
            continue
        s, o = can(s), can(o)
        if s not in nodes or o not in nodes or s == o:
            continue
        oriented = _orient_hierarchy_edge(s, o, rel)
        if not oriented:
            continue
        parent, child, strength = oriented
        if parent not in nodes or child not in nodes:
            continue
        hier.append((strength, importance.get(child, 0.0), parent, child, rel))

    # 重要性由图谱侧传递后传入；导图只展示，不再二次传递

    # 导图结构：去掉依赖边，并丢掉因此产生的孤立点
    linked = {h[2] for h in hier} | {h[3] for h in hier}
    nodes = {n for n in nodes if n in linked}
    hier = [h for h in hier if h[2] in nodes and h[3] in nodes]
    parent_of = _bottom_up_parent_of(nodes, hier, importance)

    belong_kids = {h[3] for h in hier if h[4] == "belong_to"}
    part_kids = {h[3] for h in hier if h[4] == "part_of"}
    extra: list[tuple[str, str, str]] = []
    extra_seen: set[tuple[str, str, str]] = set()
    for _s, _ci, parent, child, rel in hier:
        if child not in belong_kids or child not in part_kids:
            continue
        used = parent_of.get(child)
        if used and used[0] == parent and used[1] == rel:
            continue
        key = (child, parent, rel)
        if key in extra_seen:
            continue
        extra_seen.add(key)
        extra.append(key)

    roots = [n for n in nodes if n not in parent_of]
    roots.sort(key=lambda n: -importance.get(n, 0.0))

    children_map: dict[str, list[tuple[str, str, bool]]] = defaultdict(list)
    for child, (parent, rel) in parent_of.items():
        children_map[parent].append((child, rel, False))
    for child, parent, rel in extra:
        children_map[parent].append((child, rel, True))

    attached_orphan = sum(1 for n in roots if not children_map.get(n))
    roots = [n for n in roots if children_map.get(n)]

    def build_node(nid: str, rel: str | None = None, is_copy: bool = False) -> TreeNode:
        kids = [] if is_copy else children_map.get(nid, [])
        kids = sorted(kids, key=lambda x: (x[2], -importance.get(x[0], 0.0)))
        # 叶层：定理/算法挂在概念下后不再深挖
        if _is_special_attach_kind(nid):
            kids = []
        else:
            pruned: list[tuple[str, str, bool]] = []
            for c, r, cp in kids:
                if _is_special_attach_kind(c):
                    pruned.append((c, r, True))  # 特殊子作叶（无再展开）
                else:
                    pruned.append((c, r, cp))
            kids = pruned
        return TreeNode(
            id=nid,
            zh=_zh(nid),
            importance=float(importance.get(nid, 0.0)),
            relation=rel or None,
            related=sorted(related.get(nid, set()))[:6],
            copy=is_copy,
            children=[
                build_node(c, r, cp or _is_special_attach_kind(c)) for c, r, cp in kids
            ],
        )

    def depth_of(node: TreeNode) -> int:
        if not node.children:
            return 1
        return 1 + max(depth_of(c) for c in node.children)

    if not roots:
        dummy = TreeNode(
            id=f"__lecture__/{lecture_id or 'graph'}",
            zh="本讲",
        )
        return MindmapResult(
            lecture_id=lecture_id,
            root=dummy,
            roots=[],
            n_nodes=0,
            max_depth=1,
            orphan_count=0,
            meta={
                "chapter": chapter,
                "root_id": dummy.id,
                "root_zh": dummy.zh,
                "virtual_root": False,
                "n_trees": 0,
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

    trees = [build_node(n) for n in roots]
    kept: set[str] = set()

    def collect(n: TreeNode) -> None:
        kept.add(n.id)
        for c in n.children:
            collect(c)

    for t in trees:
        collect(t)
    return MindmapResult(
        lecture_id=lecture_id,
        root=trees[0],
        roots=trees,
        n_nodes=len(kept),
        max_depth=max(depth_of(t) for t in trees),
        orphan_count=attached_orphan,
        meta={
            "chapter": chapter,
            "root_id": trees[0].id,
            "root_zh": trees[0].zh,
            "virtual_root": False,
            "n_trees": len(trees),
            "max_nodes": max_nodes,
            "max_depth_cap": max_depth,
            "max_children": max_children,
            "n_entities_raw": len(entities),
            "n_edges_raw": len(edges),
            "n_hierarchy_candidates": len(hier),
            "attached_orphans": attached_orphan,
            "alias_merged": len({a for a, c in alias_map.items() if a != c}),
            "scope": "lecture",
            "source": "kg",
        },
    )
