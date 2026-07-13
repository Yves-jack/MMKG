"""将 kg.json / mmkg.json 导出为可交互 HTML 图谱。"""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

_RELATION_COLORS = {
    "belong_to": "#4e79a7",
    "part_of": "#59a14f",
    "depend_on": "#f28e2b",
    "synonym_of": "#b07aa1",
    "property_of": "#e15759",
    "related_with": "#76b7b2",
}


def _load_graph(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if "entities" not in data:
        raise ValueError(f"Not a KG file: {path}")
    return data


def _node_label(ent: dict[str, Any]) -> str:
    name = ent.get("name") or ent.get("id", "")
    zh = ent.get("zh", "")
    if zh and zh not in name:
        return f"{zh}"
    return str(name).split("/")[0][:20]


def _edge_label(edge: dict[str, Any]) -> str:
    rel = edge.get("abstract_relation") or edge.get("concrete_relation") or ""
    stmt = edge.get("natural_statement") or edge.get("description") or ""
    if stmt:
        return stmt[:40]
    return rel


def build_graph_payload(kg: dict[str, Any]) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    for ent in kg.get("entities") or []:
        eid = ent.get("id") or ent.get("name", "")
        desc = ent.get("description", "")
        nodes.append(
            {
                "id": eid,
                "label": _node_label(ent),
                "title": html.escape(f"{eid}\n{desc[:200]}" if desc else eid),
                "group": "entity",
            }
        )

    for i, edge in enumerate(kg.get("edges") or []):
        subj = edge.get("subject", "")
        obj = edge.get("object", "")
        rel = edge.get("abstract_relation", "related_with")
        if not subj or not obj:
            continue
        node_ids = {n["id"] for n in nodes}
        if subj not in node_ids:
            nodes.append({"id": subj, "label": subj.split("/")[0][:20], "title": subj, "group": "entity"})
        if obj not in node_ids:
            nodes.append({"id": obj, "label": obj.split("/")[0][:20], "title": obj, "group": "entity"})
        grounding = edge.get("grounding") or {}
        align = grounding.get("alignment") or {}
        lecture_id = grounding.get("lecture_id")
        if lecture_id is None:
            for prov in edge.get("provenance") or []:
                if prov.get("lecture_id") is not None:
                    lecture_id = prov.get("lecture_id")
                    break
        title_parts = [_edge_label(edge)]
        if grounding.get("ppt_page_index") is not None:
            title_parts.append(f"PPT p.{grounding['ppt_page_index']}")
        if align.get("clip_image_text") is not None:
            title_parts.append(f"CLIP={align['clip_image_text']:.2f}")
        if align.get("clap_audio_text") is not None:
            title_parts.append(f"CLAP={align['clap_audio_text']:.2f}")
        edges.append(
            {
                "id": f"e{i}",
                "from": subj,
                "to": obj,
                "label": rel,
                "title": html.escape("\n".join(title_parts)),
                "color": _RELATION_COLORS.get(rel, "#999999"),
                "relation": rel,
                "lecture_id": str(lecture_id) if lecture_id is not None else "",
            }
        )

    return {
        "course_id": kg.get("course_id", ""),
        "lecture_id": kg.get("lecture_id", ""),
        "entity_count": len({n["id"] for n in nodes}),
        "edge_count": len(edges),
        "nodes": nodes,
        "edges": edges,
    }


def render_html(kg: dict[str, Any], *, title: str | None = None) -> str:
    payload = build_graph_payload(kg)
    page_title = title or f"{payload['course_id']} L{payload['lecture_id']} KG ({payload['entity_count']} nodes)"
    data_json = json.dumps(payload, ensure_ascii=False)
    relations = sorted({e.get("relation", "") for e in payload["edges"] if e.get("relation")})
    lectures = sorted({e.get("lecture_id", "") for e in payload["edges"] if e.get("lecture_id")})
    rel_options = "".join(f'<option value="{html.escape(r)}">{html.escape(r)}</option>' for r in relations)
    lec_options = "".join(f'<option value="{html.escape(l)}">第{html.escape(l)}讲</option>' for l in lectures if l)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>{html.escape(page_title)}</title>
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <style>
    body {{ margin: 0; font-family: system-ui, sans-serif; }}
    #header {{ padding: 12px 16px; background: #1e293b; color: #f8fafc; }}
    #header h1 {{ margin: 0; font-size: 18px; }}
    #meta {{ font-size: 13px; opacity: 0.85; margin-top: 4px; }}
    #toolbar {{ display: flex; gap: 12px; flex-wrap: wrap; padding: 10px 16px; background: #e2e8f0; align-items: center; }}
    #toolbar label {{ font-size: 13px; display: flex; gap: 6px; align-items: center; }}
    #toolbar input, #toolbar select {{ padding: 4px 8px; font-size: 13px; }}
    #graph {{ width: 100vw; height: calc(100vh - 110px); background: #f8fafc; }}
  </style>
</head>
<body>
  <div id="header">
    <h1>{html.escape(page_title)}</h1>
    <div id="meta">节点 {payload['entity_count']} · 边 {payload['edge_count']} · 拖拽/滚轮缩放 · 点击节点查看详情</div>
  </div>
  <div id="toolbar">
    <label>搜索 <input id="search" type="search" placeholder="实体名…"/></label>
    <label>关系 <select id="relFilter"><option value="">全部</option>{rel_options}</select></label>
    <label>讲次 <select id="lecFilter"><option value="">全部</option>{lec_options}</select></label>
    <button id="resetBtn" type="button">重置</button>
    <span id="filterMeta" style="font-size:13px;color:#475569"></span>
  </div>
  <div id="graph"></div>
  <script>
    const payload = {data_json};
    const allNodes = payload.nodes.map(n => ({{
      ...n, shape: 'dot', size: 18,
      font: {{ size: 12, color: '#1e293b' }},
      color: {{ background: '#dbeafe', border: '#3b82f6', highlight: {{ background: '#bfdbfe', border: '#2563eb' }} }}
    }}));
    const allEdges = payload.edges.map(e => ({{
      ...e, arrows: 'to', font: {{ align: 'middle', size: 10 }},
      smooth: {{ type: 'continuous' }}
    }}));
    const nodes = new vis.DataSet(allNodes);
    const edges = new vis.DataSet(allEdges);
    const network = new vis.Network(document.getElementById('graph'), {{ nodes, edges }}, {{
      physics: {{ stabilization: {{ iterations: 120 }}, barnesHut: {{ gravitationalConstant: -8000 }} }},
      interaction: {{ hover: true, tooltipDelay: 100 }},
      layout: {{ improvedLayout: true }}
    }});

    function applyFilters() {{
      const q = document.getElementById('search').value.trim().toLowerCase();
      const rel = document.getElementById('relFilter').value;
      const lec = document.getElementById('lecFilter').value;
      const visEdgeIds = new Set();
      allEdges.forEach(e => {{
        const relOk = !rel || e.relation === rel;
        const lecOk = !lec || String(e.lecture_id) === lec;
        if (relOk && lecOk) visEdgeIds.add(e.id);
      }});
      const visNodeIds = new Set();
      allEdges.forEach(e => {{
        if (!visEdgeIds.has(e.id)) return;
        visNodeIds.add(e.from); visNodeIds.add(e.to);
      }});
      allNodes.forEach(n => {{
        const labelOk = !q || (n.label && n.label.toLowerCase().includes(q)) || (n.id && n.id.toLowerCase().includes(q));
        if (labelOk && (visNodeIds.size === 0 || visNodeIds.has(n.id))) visNodeIds.add(n.id);
      }});
      const fn = allNodes.filter(n => visNodeIds.has(n.id));
      const fe = allEdges.filter(e => visEdgeIds.has(e.id) && visNodeIds.has(e.from) && visNodeIds.has(e.to));
      nodes.clear(); edges.clear();
      nodes.add(fn); edges.add(fe);
      document.getElementById('filterMeta').textContent = `显示 ${{fn.length}} 节点 · ${{fe.length}} 边`;
    }}
    ['search','relFilter','lecFilter'].forEach(id => document.getElementById(id).addEventListener('input', applyFilters));
    document.getElementById('resetBtn').addEventListener('click', () => {{
      document.getElementById('search').value = '';
      document.getElementById('relFilter').value = '';
      document.getElementById('lecFilter').value = '';
      nodes.clear(); edges.clear(); nodes.add(allNodes); edges.add(allEdges);
      document.getElementById('filterMeta').textContent = '';
    }});
  </script>
</body>
</html>"""


def export_kg_html(kg_path: Path, output_path: Path, *, title: str | None = None) -> Path:
    kg = _load_graph(kg_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(render_html(kg, title=title), encoding="utf-8")
    return output_path
