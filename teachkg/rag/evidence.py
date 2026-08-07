"""检索证据格式化、多模态 grounding 加权、证据图收集。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from teachkg.provenance import text_snippets


def format_hit_for_context(hit: dict[str, Any]) -> str:
    payload = hit.get("payload") or {}
    lines = [f"[{hit.get('type', 'item')}] score={hit.get('score', 0):.3f}"]

    doc_text = str(hit.get("text") or "").strip()
    if doc_text:
        lines.append(f"检索文档：{doc_text}")

    if hit.get("type") == "entity":
        entity_id = payload.get("entity_id", hit.get("entity_id", ""))
        if entity_id and entity_id not in doc_text:
            lines.append(f"实体：{entity_id}")
        if payload.get("description") and payload["description"] not in doc_text:
            lines.append(f"定义：{payload['description']}")
    elif hit.get("type") == "edge":
        statement = payload.get("natural_statement", "")
        if statement and statement not in doc_text:
            lines.append(f"关系：{statement}")
        subj, obj, rel = (
            payload.get("subject", ""),
            payload.get("object", ""),
            payload.get("abstract_relation", ""),
        )
        if subj or obj:
            lines.append(f"({subj}) --[{rel}]--> ({obj})")
        grounding = payload.get("grounding") or {}
        provenance = payload.get("provenance") or []
        for i, snip in enumerate(text_snippets(provenance, max_items=2), 1):
            if snip and snip not in doc_text:
                lines.append(f"课程原文{i}：{snip[:500]}")
        if grounding.get("context") and grounding["context"] not in doc_text:
            lines.append(f"摘录：{grounding['context']}")
        if grounding.get("source_text") and str(grounding["source_text"]) not in doc_text:
            lines.append(f"字幕：{str(grounding['source_text'])[:500]}")
        if grounding.get("natural_statement") and grounding["natural_statement"] not in doc_text:
            lines.append(f"陈述：{grounding['natural_statement']}")
        if grounding.get("cue_id"):
            lines.append(f"cue：{grounding['cue_id']}")
        if grounding.get("clip_path"):
            lines.append(
                f"视频证据：{grounding['clip_path']} "
                f"({grounding.get('start_sec')}s–{grounding.get('end_sec')}s)"
            )
        if grounding.get("ppt_frame_path"):
            lines.append(
                f"PPT证据：{grounding['ppt_frame_path']} "
                f"(page {grounding.get('ppt_page_index')})"
            )
        align = grounding.get("alignment") or {}
        if align.get("clap_audio_text") is not None:
            lines.append(f"音频-文本对齐分：{align['clap_audio_text']:.3f}")
        if align.get("clip_image_text") is not None:
            lines.append(f"图像-文本对齐分：{align['clip_image_text']:.3f}")
        vscore = align.get("clip_video_text")
        if vscore is None:
            vscore = align.get("viclip_video_text")
        if vscore is not None:
            lines.append(f"视频-文本对齐分：{vscore:.3f}")
    elif not doc_text:
        lines.append(hit.get("text", ""))

    return "\n".join(lines)


def _grounding(hit: dict[str, Any]) -> dict[str, Any]:
    return ((hit.get("payload") or {}).get("grounding") or {})


def boost_grounded_hits(
    hits: list[dict[str, Any]],
    *,
    factor: float = 1.15,
    prefer_ppt: bool = True,
    prefer_clip: bool = True,
) -> list[dict[str, Any]]:
    """对带 PPT/视频 grounding 或较高跨模态对齐分的命中加权（缓解纯文本偏见）。"""
    if factor <= 1.0 or not hits:
        return hits
    out: list[dict[str, Any]] = []
    for h in hits:
        item = dict(h)
        g = _grounding(item)
        align = g.get("alignment") or {}
        mult = 1.0
        if prefer_ppt and g.get("ppt_frame_path"):
            mult *= factor
        if prefer_clip and g.get("clip_path"):
            mult *= 1.0 + (factor - 1.0) * 0.5
        clip_s = align.get("clip_image_text")
        if isinstance(clip_s, (int, float)) and float(clip_s) >= 0.25:
            mult *= 1.0 + min(0.2, float(clip_s) * 0.3)
        if mult != 1.0:
            item["score"] = float(item.get("score", 0)) * mult
            item["grounding_boost"] = round(mult, 3)
        out.append(item)
    out.sort(key=lambda x: -float(x.get("score", 0)))
    return out


def collect_evidence_image_paths(
    hits: list[dict[str, Any]],
    *,
    project_root: Path | None = None,
    max_images: int = 4,
) -> list[Path]:
    """从命中边的 PPT 帧收集可供 VLM 阅读的证据图。"""
    root = project_root or Path(".")
    paths: list[Path] = []
    seen: set[str] = set()
    for h in hits:
        g = _grounding(h)
        raw = g.get("ppt_frame_path")
        if not raw:
            continue
        p = Path(str(raw))
        if not p.is_file():
            cand = root / p
            if cand.is_file():
                p = cand
            else:
                continue
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        paths.append(p)
        if len(paths) >= max_images:
            break
    return paths


def merge_image_paths(
    *groups: list[Path],
    max_images: int = 6,
) -> list[Path]:
    """合并用户图与证据图，用户图优先。"""
    out: list[Path] = []
    seen: set[str] = set()
    for group in groups:
        for p in group:
            key = str(Path(p).resolve()) if Path(p).exists() else str(p)
            if key in seen:
                continue
            if not Path(p).is_file():
                continue
            seen.add(key)
            out.append(Path(p))
            if len(out) >= max_images:
                return out
    return out
