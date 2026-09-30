from teachkg.textbook_kg.mindmap_tree import _orient_hierarchy_edge, build_mindmap_tree
from teachkg.textbook_kg.propagate_importance import propagate_importance_to_parents


def _forest_nodes(tree):
    trees = tree.roots or [tree.root]
    ids = []

    def walk(n):
        if not str(n.id).startswith("__"):
            ids.append(n.id)
        for c in n.children:
            walk(c)

    for t in trees:
        walk(t)
    return ids


def _forest_parent_of(tree):
    parent_of = {}

    def walk(n, parent=None):
        if parent is not None and not str(parent.id).startswith("__"):
            parent_of[n.id] = parent.id
        for c in n.children:
            walk(c, n)

    for t in tree.roots or [tree.root]:
        walk(t)
    return parent_of


def _forest_edges(tree):
    edges = []

    def walk(n):
        for c in n.children:
            edges.append((n.id, c.id, c.relation, bool(getattr(c, "copy", False))))
            walk(c)

    for t in tree.roots or [tree.root]:
        walk(t)
    return edges


def test_tree_edge_only_hierarchy():
    assert _orient_hierarchy_edge("子", "父", "belong_to") == ("父", "子", 1.0)
    assert _orient_hierarchy_edge("部分", "整体", "part_of") == ("整体", "部分", 0.85)
    assert _orient_hierarchy_edge("属性句", "图", "property_of") is None
    assert _orient_hierarchy_edge("A", "B", "depend_on") is None
    assert _orient_hierarchy_edge("A", "B", "related_with") is None


def test_propagate_chain():
    scores = {"A": 0.5, "B": 0.2, "C": 0.1}
    edges = [
        {"subject": "A", "object": "B", "abstract_relation": "belong_to"},
        {"subject": "B", "object": "C", "abstract_relation": "belong_to"},
    ]
    out = propagate_importance_to_parents(scores, edges)
    # A 不变；B/C 经渐近饱和抬升，且不应顶满到 1
    assert abs(out["A"] - 0.5) < 1e-9
    assert out["B"] > 0.2
    assert out["C"] > 0.1
    assert out["B"] < 0.9
    assert out["C"] < out["B"] + 0.35
    assert out["C"] < 1.0 - 1e-6


def test_longest_match_mentions_prefers_longer_entity():
    from teachkg.textbook_kg.importance_signals import (
        _build_mention_vocab,
        longest_match_mentions,
        signal_mention_time,
    )

    vocab = _build_mention_vocab(
        ["谓词/predicate", "谓词逻辑/predicate logic", "逻辑/logic"]
    )
    hits = longest_match_mentions("一阶谓词逻辑中的谓词", vocab)
    # 「谓词逻辑」整段优先；其后单独的「谓词」可再命中
    assert "谓词逻辑/predicate logic" in hits
    assert hits.count("谓词/predicate") == 1
    assert "逻辑/logic" not in hits  # 已被「谓词逻辑」吃掉

    trips = [
        {
            "subject": "谓词/predicate",
            "object": "谓词逻辑/predicate logic",
            "context": "我们介绍谓词逻辑，以及谓词逻辑里面的主要概念。",
            "cue_id": "c1",
        }
    ]
    sig = signal_mention_time(trips)
    assert sig.get("谓词逻辑/predicate logic", 0) > sig.get("谓词/predicate", 0)


def test_mindmap_drops_property_phrase():
    kg = {
        "lecture_id": "2",
        "entities": [
            {"id": "图/Graph", "name": "图/Graph"},
            {"id": "简单图/simple graph", "name": "简单图/simple graph"},
            {"id": "边集为空", "name": "边集为空"},
        ],
        "edges": [
            {
                "subject": "简单图/simple graph",
                "object": "图/Graph",
                "abstract_relation": "belong_to",
            },
            {
                "subject": "边集为空",
                "object": "图/Graph",
                "abstract_relation": "property_of",
            },
        ],
    }
    tree = build_mindmap_tree(
        kg,
        importance={"图/Graph": 0.4, "简单图/simple graph": 0.2, "边集为空": 0.01},
        max_nodes=12,
        max_depth=4,
        max_children=8,
    )
    ids = []

    def walk(n):
        ids.append(n.id)
        for c in n.children:
            walk(c)

    walk(tree.root)
    assert "边集为空" not in ids
    rels = []

    def walk_rel(n):
        if n.relation:
            rels.append(n.relation)
        for c in n.children:
            walk_rel(c)

    walk_rel(tree.root)
    assert "property_of" not in rels


def test_mindmap_drops_part_of_shortcut_like_processed_graph():
    """全称量词 belong_to 量词、量词 part_of 谓词逻辑时，不应再把全称量词直接挂到谓词逻辑。"""
    kg = {
        "lecture_id": "1",
        "entities": [
            {"id": "谓词逻辑", "name": "谓词逻辑"},
            {"id": "量词", "name": "量词"},
            {"id": "全称量词", "name": "全称量词"},
        ],
        "edges": [
            {
                "subject": "全称量词",
                "object": "量词",
                "abstract_relation": "belong_to",
            },
            {
                "subject": "量词",
                "object": "谓词逻辑",
                "abstract_relation": "part_of",
            },
            {
                "subject": "全称量词",
                "object": "谓词逻辑",
                "abstract_relation": "part_of",
            },
        ],
    }
    tree = build_mindmap_tree(
        kg,
        importance={"谓词逻辑": 0.9, "量词": 0.5, "全称量词": 0.4},
        max_nodes=12,
        max_depth=4,
        max_children=8,
    )
    parent_of = {}

    def walk(n, parent=None):
        if parent is not None:
            parent_of[n.id] = parent.id
        for c in n.children:
            walk(c, n)

    walk(tree.root)
    assert parent_of.get("全称量词") == "量词"
    assert parent_of.get("量词") == "谓词逻辑"
    child_rel = {}

    def walk_rel(n):
        for c in n.children:
            child_rel[c.id] = c.relation
            walk_rel(c)

    walk_rel(tree.root)
    assert child_rel.get("全称量词") == "belong_to"
    assert child_rel.get("量词") == "part_of"


def test_mindmap_prefers_belong_to_over_part_of():
    kg = {
        "lecture_id": "1",
        "entities": [
            {"id": "A", "name": "A"},
            {"id": "B", "name": "B"},
            {"id": "X", "name": "X"},
        ],
        "edges": [
            {"subject": "X", "object": "A", "abstract_relation": "belong_to"},
            {"subject": "X", "object": "B", "abstract_relation": "part_of"},
        ],
    }
    tree = build_mindmap_tree(kg, importance={"A": 0.2, "B": 0.9, "X": 0.5})
    edges = _forest_edges(tree)
    assert ("A", "X", "belong_to", False) in edges
    assert ("B", "X", "part_of", True) in edges
    assert set(_forest_nodes(tree)) == {"A", "B", "X"}
    assert tree.n_nodes == 3
    assert tree.orphan_count == 0


def test_mindmap_drops_unlinked_and_depend_on_isolates():
    kg = {
        "lecture_id": "2",
        "entities": [
            {"id": "图", "name": "图"},
            {"id": "简单图", "name": "简单图"},
            {"id": "集合", "name": "集合"},
            {"id": "路径", "name": "路径"},
        ],
        "edges": [
            {"subject": "简单图", "object": "图", "abstract_relation": "belong_to"},
            {"subject": "路径", "object": "图", "abstract_relation": "depend_on"},
        ],
    }
    tree = build_mindmap_tree(
        kg, importance={"图": 0.8, "简单图": 0.4, "集合": 0.3, "路径": 0.5}
    )
    assert set(_forest_nodes(tree)) == {"图", "简单图"}
    assert "集合" not in _forest_nodes(tree)
    assert "路径" not in _forest_nodes(tree)
    assert tree.meta.get("n_trees") == 1


def test_mindmap_drops_singleton_lost_parent():
    """两个属于父节点时只挂一个；另一个空父节点不应再单独成树。"""
    kg = {
        "lecture_id": "1",
        "entities": [
            {"id": "A", "name": "A"},
            {"id": "B", "name": "B"},
            {"id": "X", "name": "X"},
        ],
        "edges": [
            {"subject": "X", "object": "A", "abstract_relation": "belong_to"},
            {"subject": "X", "object": "B", "abstract_relation": "belong_to"},
        ],
    }
    tree = build_mindmap_tree(kg, importance={"A": 0.9, "B": 0.2, "X": 0.5})
    ids = set(_forest_nodes(tree))
    assert "X" in ids and "A" in ids
    assert "B" not in ids
    assert tree.orphan_count >= 1
    assert tree.meta.get("n_trees") == 1


def test_importance_propagates_on_graph_depend_on():
    """depend_on 不作树边，但仍在图上把重要性传给被依赖节点（传递在导图外完成）。"""
    kg = {
        "lecture_id": "1",
        "entities": [
            {"id": "A", "name": "A"},
            {"id": "B", "name": "B"},
            {"id": "X", "name": "X"},
        ],
        "edges": [
            {"subject": "X", "object": "B", "abstract_relation": "belong_to"},
            {"subject": "X", "object": "A", "abstract_relation": "depend_on"},
        ],
    }
    imp = propagate_importance_to_parents(
        {"A": 0.2, "B": 0.2, "X": 1.0}, kg["edges"], node_ids=["A", "B", "X"]
    )
    tree = build_mindmap_tree(kg, importance=imp)
    assert _forest_parent_of(tree).get("X") == "B"
    assert "A" not in set(_forest_nodes(tree))
    imps = {}

    def walk(n):
        imps[n.id] = n.importance
        for c in n.children:
            walk(c)

    for t in tree.roots or [tree.root]:
        walk(t)

    assert imps["B"] > 0.2
    assert abs(imps["X"] - 1.0) < 1e-9
