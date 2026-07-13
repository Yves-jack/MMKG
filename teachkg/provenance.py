"""溯源字段规范化：triplet → provenance → 索引 / RAG 上下文。"""

from __future__ import annotations

from typing import Any


def from_triplet(row: dict[str, Any]) -> dict[str, Any]:
    """从 flat triplet 构建标准 provenance 记录。"""
    ppt = str(row.get("ppt_frame_path") or row.get("evidence_ppt_frame_path") or "").strip()
    page = row.get("ppt_page_index")
    if page is None:
        page = row.get("evidence_ppt_page_index")
    rec: dict[str, Any] = {
        "cue_id": str(row.get("cue_id", "")).strip(),
        "lecture_id": row.get("lecture_id", ""),
        "context": str(row.get("context", "")).strip(),
        "source_text": str(row.get("source_text", "")).strip(),
        "start_sec": row.get("start_sec"),
        "end_sec": row.get("end_sec"),
        "ppt_page_index": page,
        "clip_path": str(row.get("clip_path", "")).strip(),
        "ppt_frame_path": ppt,
        "extract_source": str(row.get("extract_source", "")).strip(),
        "textbook_origin": row.get("textbook_origin"),
        "grounding": str(row.get("grounding", "")).strip(),
    }
    return {k: v for k, v in rec.items() if v not in (None, "", False)}


def _prov_key(prov: dict[str, Any]) -> tuple[Any, ...]:
    return (
        prov.get("cue_id"),
        prov.get("context"),
        prov.get("start_sec"),
        prov.get("end_sec"),
    )


def dedupe_provenance(provenance: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    out: list[dict[str, Any]] = []
    for prov in provenance:
        if not prov:
            continue
        key = _prov_key(prov)
        if key in seen:
            continue
        seen.add(key)
        out.append(dict(prov))
    return out


def enrich_with_cue_index(
    provenance: list[dict[str, Any]],
    cue_index: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """用 cue 索引补全 clip/PPT/字幕等字段。"""
    enriched: list[dict[str, Any]] = []
    for prov in provenance:
        cue_id = str(prov.get("cue_id", "")).strip()
        meta = cue_index.get(cue_id, {})
        item = dict(prov)
        for field in (
            "lecture_id",
            "start_sec",
            "end_sec",
            "clip_path",
            "ppt_frame_path",
            "ppt_page_index",
            "source_text",
        ):
            if not item.get(field) and meta.get(field) not in (None, ""):
                item[field] = meta[field]
        enriched.append(item)
    return dedupe_provenance(enriched)


def text_snippets(
    provenance: list[dict[str, Any]],
    *,
    max_items: int = 3,
    max_source_chars: int = 500,
    max_context_chars: int = 300,
) -> list[str]:
    """提取用于检索/生成的原文片段（去重）。"""
    snippets: list[str] = []
    seen: set[str] = set()
    for prov in provenance[:max_items]:
        ctx = str(prov.get("context") or "").strip()
        if ctx:
            chunk = ctx[:max_context_chars]
            if chunk not in seen:
                seen.add(chunk)
                snippets.append(chunk)
        src = str(prov.get("source_text") or "").strip()
        if src:
            chunk = src[:max_source_chars]
            if chunk not in seen:
                seen.add(chunk)
                snippets.append(chunk)
    return snippets


def compact_payload(
    provenance: list[dict[str, Any]],
    *,
    max_items: int = 3,
) -> list[dict[str, Any]]:
    """索引 manifest 用的紧凑 provenance。"""
    out: list[dict[str, Any]] = []
    for prov in provenance[:max_items]:
        item = {
            k: prov[k]
            for k in (
                "cue_id",
                "lecture_id",
                "context",
                "source_text",
                "start_sec",
                "end_sec",
                "ppt_page_index",
                "clip_path",
                "ppt_frame_path",
                "extract_source",
                "textbook_origin",
                "grounding",
            )
            if prov.get(k) not in (None, "", False)
        }
        if item.get("source_text"):
            item["source_text"] = str(item["source_text"])[:400]
        if item.get("context"):
            item["context"] = str(item["context"])[:300]
        if item:
            out.append(item)
    return out


def primary_provenance(provenance: list[dict[str, Any]]) -> dict[str, Any]:
    """优先选含 context/source_text 的条目作为主溯源。"""
    if not provenance:
        return {}
    for prov in provenance:
        if prov.get("context") or prov.get("source_text"):
            return prov
    return provenance[0]
