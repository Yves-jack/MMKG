"""Regression coverage for MMKG-owned textbook course imports."""
import json

import pytest

from mmkg_api.storage import GraphStore
from scripts.import_textbook import load_textbook


def textbook(tmp_path):
    source = tmp_path / "textbook"
    source.mkdir()
    data = {
        "entity_final.json": [
            {"name": "集合/set", "definition": "确定成员的整体", "theorems": [{"name": "定理"}], "importance": 0.1},
            {"name": "子集/subset", "definition": "元素包含关系", "importance": 0.2},
        ],
        "relations_final.json": [
            {"subject": "子集/subset", "predicate": "related_to", "object": "集合/set", "description": "依赖集合概念", "context": "教材"}
        ],
        "entity_sorted.json": [["集合/set", 0.9]],
    }
    for filename, payload in data.items():
        (source / filename).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return source


def test_textbook_import_preserves_knowledge_and_stable_ids(tmp_path):
    source = textbook(tmp_path)
    target = tmp_path / "runtime"
    store = GraphStore(target)
    store.write_metadata("92311", "config", {"custom_setting": True})
    report = load_textbook(source, target, "92311")
    graph = store.read_view("92311", "base")
    by_name = {node["zh_name"]: node for node in graph["nodes"]}
    assert report["nodes"] == 2 and report["edges"] == 1
    assert by_name["集合"]["info"] == "确定成员的整体"
    assert by_name["集合"]["theorems"] == [{"name": "定理"}]
    assert by_name["集合"]["importance"] == 0.9
    assert by_name["子集"]["importance"] == 0.2
    assert graph["edges"][0]["source"] == by_name["子集"]["id"]
    assert graph["edges"][0]["target"] == by_name["集合"]["id"]
    assert all(node["source"] == "mmkg_textbook" for node in graph["nodes"])
    load_textbook(source, target, "92311")
    assert store.read_view("92311", "base") == graph
    assert store.read_metadata("92311", "config", {})["custom_setting"] is True
    assert store.list_courses() == [{"id": "92311", "name": "离散数学（数理逻辑与集合论）"}]
    assert len(store.read_view("92311", "fused")["nodes"]) == 2


@pytest.mark.parametrize("view", ["base", "document", "video"])
def test_import_rejects_other_sources_without_changing_them(tmp_path, view):
    source = textbook(tmp_path)
    target = tmp_path / "runtime"
    store = GraphStore(target)
    store.write_view("92311", view, {"nodes": [{"id": "legacy", "name": "临时节点"}], "edges": []})
    before = {name: store.read_view("92311", name) for name in ("base", "document", "video", "fused")}
    with pytest.raises(ValueError, match="another data source"):
        load_textbook(source, target, "92311")
    assert before == {name: store.read_view("92311", name) for name in before}


def test_courses_without_display_name_fall_back_to_id(tmp_path):
    store = GraphStore(tmp_path)
    store.write_view("92311", "base", {"nodes": [], "edges": []})
    assert store.list_courses() == [{"id": "92311", "name": "92311"}]


def test_bad_relation_does_not_create_a_partial_course(tmp_path):
    source = textbook(tmp_path)
    (source / "relations_final.json").write_text(json.dumps([{"subject": "缺失实体", "predicate": "related_to", "object": "集合/set"}]))
    target = tmp_path / "runtime"
    with pytest.raises(KeyError):
        load_textbook(source, target, "92311")
    assert GraphStore(target).list_courses() == []
