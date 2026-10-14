# -*- coding: utf-8 -*-
"""批量修补 showcase pipeline JSON：

1) 种子/教材同中文名合并，并改写后续阶段端点
2) 各图阶段节点重要性改为片段轻量分（清洗文本提及 + 本 stage 图结构）
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from teachkg.stage2_kg_build.entity_merge import build_entity_merge_map
from teachkg.textbook_kg.importance_signals import (
    RELATED_WITH_STRUCTURE_WEIGHT,
    compute_fragment_light_importance,
    default_channel_weights_light,
    longest_match_mentions,
    _build_mention_vocab,
)

PIPELINE_DIRS = [
    ROOT / "web" / "teachkg-showcase" / "public" / "data" / "pipeline",
    ROOT / "web" / "teachkg-showcase" / "public" / "data" / "courses",
    ROOT / "data" / "viz",
]
GRAPH_STAGE_IDS = {
    "seeds",
    "textbook",
    "correct",
    "delta",
    "merge",
    "cross_cue",
    "session_merge",
    "course_merge",
}


def _zh(name: str) -> str:
    return (name or "").split("/", 1)[0].strip()


def _should_remap(sid: str) -> bool:
    return (
        sid in GRAPH_STAGE_IDS
        or sid.startswith("merge__")
        or sid.startswith("course_merge__")
    )


def _build_merge_map(stages: list[dict]) -> dict[str, str]:
    names: set[str] = set()
    textbook: set[str] = set()
    for st in stages:
        sid = str(st.get("id") or "")
        if sid not in {"seeds", "textbook"}:
            continue
        for n in st.get("nodes") or []:
            nid = str(n.get("id") or "").strip()
            if nid:
                names.add(nid)
        for e in st.get("edges") or []:
            frm = str(e.get("from") or "").strip()
            to = str(e.get("to") or "").strip()
            if frm:
                names.add(frm)
            if to:
                names.add(to)
            if sid == "textbook":
                src = str(e.get("source") or "")
                if src in {"textbook", "textbook_revised"}:
                    if frm:
                        textbook.add(frm)
                    if to:
                        textbook.add(to)
    if len(names) < 2:
        return {}
    return build_entity_merge_map(sorted(names), textbook_entity_names=textbook)


def _collapse_nodes(nodes: list[dict], mmap: dict[str, str]) -> list[dict]:
    if not nodes or not mmap:
        return nodes
    out: dict[str, dict] = {}
    for n in nodes:
        nid = str(n.get("id") or "").strip()
        if not nid:
            continue
        cid = mmap.get(nid, nid)
        prev = out.get(cid)
        row = dict(n)
        row["id"] = cid
        row["label"] = _zh(cid) or row.get("label")
        if not prev:
            out[cid] = row
            continue
        kind = str(row.get("kind") or "")
        pkind = str(prev.get("kind") or "")
        prefer = (("alias" in kind and "alias" not in pkind)
            or ("filtered" in pkind and "filtered" not in kind)
        )
        base, other = (row, prev) if prefer else (prev, row)
        merged = dict(base)
        merged["id"] = cid
        merged["label"] = _zh(cid) or base.get("label") or other.get("label")
        merged["title"] = base.get("title") or other.get("title")
        merged["description"] = base.get("description") or other.get("description")
        out[cid] = merged
    return list(out.values())


def _collapse_edges(edges: list[dict], mmap: dict[str, str]) -> list[dict]:
    if not edges or not mmap:
        return edges
    out: list[dict] = []
    seen: set[tuple[str, str, str, str]] = set()
    for e in edges:
        row = dict(e)
        frm = mmap.get(str(row.get("from") or ""), row.get("from") or "")
        to = mmap.get(str(row.get("to") or ""), row.get("to") or "")
        row["from"] = frm
        row["to"] = to
        if not frm or not to or frm == to:
            continue
        key = (
            frm,
            str(row.get("relation") or row.get("label") or ""),
            to,
            str(row.get("source") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def _edges_as_trips(edges: list[dict]) -> list[dict]:
    trips: list[dict] = []
    for e in edges:
        src = str(e.get("source") or "")
        if src in {"process_rule", "process_node", "process_isolated", "filtered"}:
            continue
        frm = str(e.get("from") or "").strip()
        to = str(e.get("to") or "").strip()
        if not frm or not to:
            continue
        rel = str(e.get("relation") or e.get("label") or "related_with")
        trips.append(
            {
                "subject": frm,
                "object": to,
                "relation": rel,
                "abstract_relation": rel,
                "context": str(e.get("context") or ""),
            }
        )
    return trips


def _score_nodes(
    nodes: list[dict],
    edges: list[dict],
    extract_text: str,
) -> list[dict]:
    if not nodes:
        return nodes
    trips = _edges_as_trips(edges)
    # 无边时（种子步）仍按文本提及计；结构为 0
    if not trips:
        vocab = _build_mention_vocab([str(n.get("id") or "") for n in nodes])
        counts: dict[str, dict[str, float]] = {}
        text = (extract_text or "").strip()
        if text and vocab:
            from collections import Counter

            c = Counter(longest_match_mentions(text, vocab))
            for eid, m in c.items():
                counts[eid] = {"mention_time": float(m), "structure_graph": 0.0}
        scores: dict[str, float] = {}
        contrib: dict[str, dict[str, float]] = {}
        from teachkg.textbook_kg.importance_signals import compose_fragment_light_score

        for eid, fc in counts.items():
            m = float(fc["mention_time"])
            if m <= 0:
                continue
            score, m_part, s_part = compose_fragment_light_score(m, 0.0)
            scores[eid] = score
            contrib[eid] = {"mention_time": m_part, "structure_graph": s_part}
        factor_counts = counts
    else:
        scores, contrib, factor_counts = compute_fragment_light_importance(
            trips, extract_text=extract_text or None
        )

    def lookup(d: dict, name: str):
        if name in d:
            return d[name]
        z = _zh(name)
        for k, v in d.items():
            if _zh(k) == z:
                return v
        return None

    out: list[dict] = []
    for n in nodes:
        row = dict(n)
        name = str(row.get("id") or "")
        sc = lookup(scores, name)
        fc = lookup(factor_counts, name) or {}
        cb = lookup(contrib, name)
        m = float(fc.get("mention_time") or 0)
        s = float(fc.get("structure_graph") or 0)
        has = m > 0 or s > 0
        row["importance"] = round(float(sc), 4) if has and sc is not None else None
        row["importance_base"] = None
        row["importance_delta"] = None
        row["importance_factor_counts"] = {
            "mention_time": int(round(m)),
            "structure_graph": (
                int(round(s))
                if abs(s - round(s)) < 1e-9
                else round(s, 1)
            ),
        }
        row["importance_contributions"] = (
            {
                "mention_time": round(float(cb.get("mention_time") or 0), 6),
                "structure_graph": round(float(cb.get("structure_graph") or 0), 6),
            }
            if has and isinstance(cb, dict)
            else None
        )
        if has and sc is not None:
            # 与前端 sizeFromImportance 一致：1-e^(-x)
            sat = max(0.0, 1.0 - math.exp(-max(0.0, float(sc))))
            row["size"] = round(10 + (36 - 10) * sat, 2)
        out.append(row)
    return out


def patch_item(item: dict) -> bool:
    stages = list(item.get("stages") or [])
    if not stages:
        return False
    mmap = _build_merge_map(stages)
    changed = bool(mmap)
    if mmap:
        new_stages = []
        for st in stages:
            sid = str(st.get("id") or "")
            if not _should_remap(sid):
                new_stages.append(st)
                continue
            st = dict(st)
            st["nodes"] = _collapse_nodes(list(st.get("nodes") or []), mmap)
            st["edges"] = _collapse_edges(list(st.get("edges") or []), mmap)
            new_stages.append(st)
        stages = new_stages

    extract = (
        str(item.get("extract_text") or "").strip()
        or str(item.get("asr_text") or "").strip()
    )
    out_stages = []
    for st in stages:
        sid = str(st.get("id") or "")
        st = dict(st)
        nodes = list(st.get("nodes") or [])
        edges = list(st.get("edges") or [])
        if nodes and (
            sid in GRAPH_STAGE_IDS
            or sid.startswith("merge__")
            or st.get("focus") in {"graph", "multimodal"}
        ):
            # 种子步也重写因素计数，避免侧栏/导出残留整讲分
            use_edges = edges
            if sid in {"delta", "merge"} or sid.startswith("merge__"):
                use_edges = [
                    e
                    for e in edges
                    if str(e.get("source") or "")
                    not in {
                        "cross_cue",
                        "process_rule",
                        "process_node",
                        "process_isolated",
                    }
                    and not (
                        "讲的第" in str(e.get("source") or "")
                        and "段到第" in str(e.get("source") or "")
                    )
                ]
            st["nodes"] = _score_nodes(nodes, use_edges, extract)
            changed = True
        out_stages.append(st)
    item["stages"] = out_stages
    return changed


def patch_file(path: Path) -> bool:
    raw = path.read_text(encoding="utf-8")
    payload = json.loads(raw)
    items = payload.get("items") or []
    touched = False
    for item in items:
        if patch_item(item):
            touched = True
    if not touched:
        return False
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return True


def iter_pipeline_files() -> list[Path]:
    seen: set[str] = set()
    out: list[Path] = []
    for root in PIPELINE_DIRS:
        if not root.exists():
            continue
        for f in root.rglob("pipeline_build_*.json"):
            key = str(f.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(f)
    return sorted(out)


def main() -> None:
    files = iter_pipeline_files()
    n = 0
    for f in files:
        rel = f.relative_to(ROOT) if f.is_relative_to(ROOT) else f
        if patch_file(f):
            n += 1
            print(f"patched {rel}")
        else:
            print(f"skip {rel}")
    print(f"done: {n}/{len(files)}")


if __name__ == "__main__":
    main()
