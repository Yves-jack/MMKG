"""图谱导出：GraphML / Neo4j Cypher。"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


def export_graphml(mmkg: dict[str, Any], out_path: Path) -> None:
    ns = "http://graphml.graphdrawing.org/xmlns"
    ET.register_namespace("", ns)
    root = ET.Element(f"{{{ns}}}graphml")
    key_id = ET.SubElement(root, f"{{{ns}}}key", id="d0", **{"for": "node", "attr.name": "label"})
    key_id.set("attr.type", "string")
    key_desc = ET.SubElement(root, f"{{{ns}}}key", id="d1", **{"for": "node", "attr.name": "description"})
    key_desc.set("attr.type", "string")
    key_rel = ET.SubElement(root, f"{{{ns}}}key", id="d2", **{"for": "edge", "attr.name": "relation"})
    key_rel.set("attr.type", "string")

    graph = ET.SubElement(root, f"{{{ns}}}graph", id="G", edgedefault="directed")

    for ent in mmkg.get("entities") or []:
        nid = ent.get("id") or ent.get("name", "")
        node = ET.SubElement(graph, f"{{{ns}}}node", id=str(nid))
        d0 = ET.SubElement(node, f"{{{ns}}}data", key="d0")
        d0.text = ent.get("name", nid)
        d1 = ET.SubElement(node, f"{{{ns}}}data", key="d1")
        d1.text = ent.get("description") or ""

    for i, edge in enumerate(mmkg.get("edges") or []):
        sub, obj = edge.get("subject", ""), edge.get("object", "")
        e = ET.SubElement(
            graph,
            f"{{{ns}}}edge",
            id=f"e{i}",
            source=str(sub),
            target=str(obj),
        )
        d2 = ET.SubElement(e, f"{{{ns}}}data", key="d2")
        d2.text = edge.get("abstract_relation") or ""

    tree = ET.ElementTree(root)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tree.write(out_path, encoding="utf-8", xml_declaration=True)


def export_neo4j_cypher(mmkg: dict[str, Any], out_path: Path) -> None:
    lines: list[str] = ["// Auto-generated from MMKG", "CREATE CONSTRAINT IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE;"]
    for ent in mmkg.get("entities") or []:
        eid = ent.get("id") or ent.get("name", "")
        name = json.dumps(ent.get("name", eid), ensure_ascii=False)
        desc = json.dumps(ent.get("description") or "", ensure_ascii=False)
        lines.append(
            f"MERGE (n:Entity {{id: {json.dumps(eid, ensure_ascii=False)}}}) "
            f"SET n.name = {name}, n.description = {desc};"
        )
    for edge in mmkg.get("edges") or []:
        sub, obj = edge.get("subject", ""), edge.get("object", "")
        rel = edge.get("abstract_relation") or "RELATED"
        rel_safe = "".join(c if c.isalnum() else "_" for c in rel).upper() or "RELATED"
        stmt = json.dumps(edge.get("natural_statement") or "", ensure_ascii=False)
        lines.append(
            f"MATCH (a:Entity {{id: {json.dumps(sub, ensure_ascii=False)}}}), "
            f"(b:Entity {{id: {json.dumps(obj, ensure_ascii=False)}}}) "
            f"MERGE (a)-[:{rel_safe} {{statement: {stmt}}}]->(b);"
        )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
