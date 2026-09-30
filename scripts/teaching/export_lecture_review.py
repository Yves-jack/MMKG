#!/usr/bin/env python3
"""按讲次导出「单课复习整理」知识点浓缩 JSON（规则聚合，不调 LLM）。"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig

_SENT_SPLIT = re.compile(r"(?<=[。！？!?；;])")


def _zh(name: str) -> str:
    return (name or "").split("/")[0].strip() or (name or "").strip()


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _first_sentence(text: str, max_chars: int = 48) -> str:
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return ""
    parts = _SENT_SPLIT.split(t)
    s = (parts[0] if parts else t).strip()
    if len(s) > max_chars:
        return s[: max_chars - 1].rstrip() + "…"
    return s


def _load_textbook_defs(tb_dir: Path, entity_file: str) -> dict[str, str]:
    path = tb_dir / entity_file
    if not path.is_file():
        return {}
    rows = _load_json(path)
    out: dict[str, str] = {}
    for row in rows or []:
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        defn = str(row.get("definition") or "").strip()
        out[name] = defn
        out[_zh(name)] = defn
    return out


def _load_importance(course: str, lecture_id: str) -> dict[str, float]:
    paths = [
        ROOT
        / "data/experiments/comparisons"
        / course
        / "importance_p3"
        / f"feedback_lec{lecture_id}_a0.45.json",
        ROOT / "data/kg" / course / "entity_importance_feedback.json",
    ]
    for path in paths:
        if not path.is_file():
            continue
        raw = _load_json(path)
        # by_context lecture scores
        by_ctx = raw.get("by_context") or {}
        lec_key = str(lecture_id)
        if lec_key in by_ctx and isinstance(by_ctx[lec_key], dict):
            scores = by_ctx[lec_key].get("scores") or by_ctx[lec_key]
            if isinstance(scores, dict) and scores:
                return {str(k): float(v) for k, v in scores.items() if _is_number(v)}
        scores = raw.get("scores") or {}
        if isinstance(scores, dict) and scores:
            return {str(k): float(v) for k, v in scores.items() if _is_number(v)}
    return {}


def _is_number(v: Any) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


def _lookup_imp(scores: dict[str, float], eid: str) -> float:
    if eid in scores:
        return float(scores[eid])
    z = _zh(eid)
    if z in scores:
        return float(scores[z])
    for k, v in scores.items():
        if _zh(k) == z:
            return float(v)
    return 0.0


def _load_assets_index(course: str) -> dict[str, list[str]]:
    path = ROOT / "data/kg" / course / "assets" / "library.json"
    if not path.is_file():
        return {}
    lib = _load_json(path)
    idx = lib.get("index_by_entity") or {}
    if isinstance(idx, dict) and idx:
        out: dict[str, list[str]] = {}
        for k, v in idx.items():
            ids = [str(x) for x in (v or [])]
            out[str(k)] = ids
            out[_zh(k)] = ids
        return out
    # fallback: scan cards
    out2: dict[str, list[str]] = defaultdict(list)
    for card in lib.get("cards") or []:
        aid = str(card.get("asset_id") or "")
        if not aid:
            continue
        names = [card.get("name"), *(card.get("aliases") or [])]
        for link in card.get("concepts") or []:
            names.append(link.get("entity") if isinstance(link, dict) else None)
        for n in names:
            if not n:
                continue
            out2[str(n)].append(aid)
            out2[_zh(str(n))].append(aid)
    return {k: list(dict.fromkeys(v)) for k, v in out2.items()}


def _cue_map(cues: list[dict], lecture_id: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for c in cues:
        if str(c.get("lecture_id") or "") not in {str(lecture_id), f"lecture_{lecture_id}"}:
            continue
        cid = str(c.get("cue_id") or c.get("id") or "")
        if cid:
            out[cid] = c
    return out


def _to_repo_data_rel(path: Path | str | None) -> str | None:
    if not path:
        return None
    p = Path(str(path).replace("\\", "/"))
    try:
        if p.is_absolute():
            rel = p.resolve().relative_to(ROOT.resolve())
        else:
            rel = Path(str(path).replace("\\", "/"))
            if str(rel).startswith("data/"):
                return str(rel).replace("\\", "/")
            rel = Path("data") / rel
        s = str(rel).replace("\\", "/")
        return s if s.startswith("data/") else f"data/{s}"
    except Exception:
        s = str(path).replace("\\", "/")
        idx = s.find("/data/")
        if idx >= 0:
            return s[idx + 1 :]
        if s.startswith("data/"):
            return s
        return None


def _segment_title(asr_text: str, index: int) -> str:
    raw = re.sub(r"\s+", " ", str(asr_text or "")).strip()
    if not raw or "本段无有效" in raw or "本段无实质" in raw:
        return f"片段 {index}"
    # 跳过过短开场，拼到可读标题
    parts = re.split(r"[。！？；.!?;，,]", raw)
    buf = ""
    for part in parts:
        piece = part.strip(" （）()[]【】\"'“”")
        if not piece:
            continue
        buf = f"{buf}{piece}" if not buf else f"{buf}，{piece}"
        if len(buf) >= 10:
            break
    if len(buf) < 4:
        return f"片段 {index}"
    if len(buf) > 22:
        return buf[:22].rstrip() + "…"
    return buf


def _segment_summary(asr_text: str, index: int) -> str:
    """比 title 更完整的一段浓缩，供进度条悬浮展示。"""
    raw = re.sub(r"\s+", " ", str(asr_text or "")).strip()
    if not raw or "本段无有效" in raw or "本段无实质" in raw:
        return f"片段 {index}"
    parts = re.split(r"[。！？；.!?;]", raw)
    buf = ""
    for part in parts:
        piece = part.strip(" （）()[]【】\"'“”，,")
        if len(piece) < 4:
            continue
        buf = piece if not buf else f"{buf}；{piece}"
        if len(buf) >= 36:
            break
    if len(buf) < 6:
        buf = raw
    if len(buf) > 72:
        return buf[:72].rstrip(" ，,；;") + "…"
    return buf


def build_lecture_segments(cues: list[dict], lecture_id: str) -> list[dict[str, Any]]:
    """课堂视频分段（Stage0 cues），供前端 B 站风格章节轨。"""
    rows = [
        c
        for c in cues
        if str(c.get("lecture_id") or "") in {str(lecture_id), f"lecture_{lecture_id}"}
    ]
    rows.sort(key=lambda c: float(c.get("start_sec") or 0))
    out: list[dict[str, Any]] = []
    for i, c in enumerate(rows, 1):
        start = float(c.get("start_sec") or 0)
        end = float(c.get("end_sec") or start)
        if end <= start:
            continue
        asr = str(c.get("asr_text") or "")
        out.append(
            {
                "id": str(c.get("cue_id") or f"seg_{lecture_id}_{i}"),
                "index": i,
                "start_sec": round(start, 3),
                "end_sec": round(end, 3),
                "title": _segment_title(asr, i),
                "summary": _segment_summary(asr, i),
            }
        )
    return out


def resolve_lecture_videos(course: str, lecture_id: str, cues: list[dict]) -> dict[str, str | None]:
    """课堂 / PPT 整讲视频路径（相对仓库，供 /repo-data 访问）。"""
    class_video = None
    ppt_video = None
    duration = 0.0
    for c in cues:
        if str(c.get("lecture_id") or "") not in {str(lecture_id), f"lecture_{lecture_id}"}:
            continue
        if not class_video and c.get("source_video"):
            class_video = _to_repo_data_rel(c.get("source_video"))
        if not ppt_video and c.get("ppt_video"):
            ppt_video = _to_repo_data_rel(c.get("ppt_video"))
        duration = max(duration, float(c.get("end_sec") or 0))

    if not class_video:
        for cand in (
            ROOT / "data/raw" / course / "video" / "class" / f"{lecture_id}_0.mp4",
            ROOT / "data/raw" / course / "video" / "class" / f"{lecture_id}_0.mkv",
        ):
            if cand.is_file():
                class_video = _to_repo_data_rel(cand)
                break
    if not ppt_video:
        for cand in (
            ROOT / "data/raw" / course / "video" / "ppt" / f"{lecture_id}_1.mp4",
            ROOT / "data/raw" / course / "video" / "ppt" / f"{lecture_id}_1.mkv",
        ):
            if cand.is_file():
                ppt_video = _to_repo_data_rel(cand)
                break
    return {
        "class_video": class_video,
        "ppt_video": ppt_video,
        "duration_sec": duration if duration > 0 else None,
    }


def build_lecture_review(
    course: str,
    lecture_id: str,
    *,
    tb_defs: dict[str, str],
    textbook_names: set[str],
    max_points: int = 24,
    max_neighbors: int = 8,
    max_evidence: int = 3,
) -> dict[str, Any] | None:
    kg_path = ROOT / "data/kg" / course / f"lecture_{lecture_id}" / "kg.json"
    if not kg_path.is_file():
        return None
    kg = _load_json(kg_path)
    entities = list(kg.get("entities") or [])
    edges = list(kg.get("edges") or [])
    if not entities:
        return None

    cues = _load_jsonl(ROOT / "data/processed" / course / "filtered_cues.jsonl")
    cue_by_id = _cue_map(cues, lecture_id)
    imp = _load_importance(course, lecture_id)
    assets_idx = _load_assets_index(course)

    # adjacency
    neighbors: dict[str, list[dict]] = defaultdict(list)
    degree: dict[str, int] = defaultdict(int)
    for e in edges:
        s = str(e.get("subject") or "")
        o = str(e.get("object") or "")
        if not s or not o:
            continue
        rel = str(e.get("abstract_relation") or e.get("predicate") or "related_with")
        concrete = str(e.get("concrete_relation") or "")
        item_s = {
            "subject": s,
            "predicate": rel,
            "object": o,
            "label": concrete or rel,
            "natural_statement": str(e.get("natural_statement") or ""),
        }
        item_o = dict(item_s)
        neighbors[s].append(item_s)
        neighbors[o].append(item_o)
        degree[s] += 1
        degree[o] += 1

    points: list[dict[str, Any]] = []
    for ent in entities:
        eid = str(ent.get("id") or ent.get("name") or "").strip()
        if not eid:
            continue
        zh = str(ent.get("zh") or _zh(eid)).strip() or _zh(eid)
        mention = int(ent.get("mention_count") or 1)
        score = _lookup_imp(imp, eid)
        if score <= 0:
            score = 0.05 * math.log1p(mention) + 0.01 * degree.get(eid, 0)

        in_tb = eid in textbook_names or zh in textbook_names or _zh(eid) in textbook_names
        origin = "shared" if in_tb else "lecture_only"

        defn = tb_defs.get(eid) or tb_defs.get(zh) or tb_defs.get(_zh(eid)) or ""
        # evidence from entity cue_ids + edge provenance
        evidence: list[dict] = []
        seen_cues: set[str] = set()
        for cid in ent.get("cue_ids") or []:
            cid = str(cid)
            if cid in seen_cues:
                continue
            seen_cues.add(cid)
            cue = cue_by_id.get(cid) or {}
            text = str(
                cue.get("asr_text")
                or cue.get("extract_text")
                or cue.get("text")
                or ""
            ).strip()
            evidence.append(
                {
                    "cue_id": cid,
                    "text": text[:400],
                    "start_sec": cue.get("start_sec"),
                    "end_sec": cue.get("end_sec"),
                    "clip_path": cue.get("clip_path"),
                }
            )
            if len(evidence) >= max_evidence:
                break
        if len(evidence) < max_evidence:
            for e in edges:
                if str(e.get("subject")) != eid and str(e.get("object")) != eid:
                    continue
                for prov in e.get("provenance") or []:
                    cid = str(prov.get("cue_id") or "")
                    if not cid or cid in seen_cues:
                        continue
                    seen_cues.add(cid)
                    text = str(
                        prov.get("context")
                        or prov.get("source_text")
                        or ""
                    ).strip()
                    evidence.append(
                        {
                            "cue_id": cid,
                            "text": text[:400],
                            "start_sec": prov.get("start_sec"),
                            "end_sec": prov.get("end_sec"),
                            "clip_path": prov.get("clip_path"),
                        }
                    )
                    if len(evidence) >= max_evidence:
                        break
                if len(evidence) >= max_evidence:
                    break

        summary = _first_sentence(defn, 48)
        if not summary and evidence:
            summary = _first_sentence(evidence[0].get("text") or "", 48)
        if not summary:
            summary = f"本讲涉及「{zh}」"

        asset_ids: list[str] = []
        for key in (eid, zh, _zh(eid)):
            asset_ids.extend(assets_idx.get(key) or [])
        asset_ids = list(dict.fromkeys(asset_ids))[:6]

        nbrs = neighbors.get(eid, [])[:max_neighbors]
        points.append(
            {
                "id": eid,
                "zh": zh,
                "importance": round(float(score), 6),
                "mention_count": mention,
                "origin": origin,
                "summary": summary,
                "definition": defn,
                "neighbors": nbrs,
                "evidence": evidence,
                "asset_ids": asset_ids,
            }
        )

    points.sort(key=lambda p: (-float(p["importance"]), -int(p["mention_count"]), p["zh"]))
    points = points[:max_points]
    for i, p in enumerate(points, 1):
        p["rank"] = i

    media = resolve_lecture_videos(course, lecture_id, cues)
    segments = build_lecture_segments(cues, lecture_id)

    return {
        "course_id": course,
        "lecture_id": str(lecture_id),
        "title": f"第{lecture_id}讲 · 知识点浓缩",
        "n_points": len(points),
        "class_video": media.get("class_video"),
        "ppt_video": media.get("ppt_video"),
        "duration_sec": media.get("duration_sec"),
        "segments": segments,
        "points": points,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    ap.add_argument("--course", required=True)
    ap.add_argument("--lectures", default="", help="逗号分隔；空=扫描 lecture_*")
    ap.add_argument("--max-points", type=int, default=24)
    args = ap.parse_args()

    cfg = TeachKGConfig.from_yaml(args.config)
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    tb_dir = ROOT / tb.get("path", "data/textbook/CS2501-离散数学（数理逻辑与集合论）")
    entity_file = tb.get("entity_file", "entity_final.json")
    tb_defs = _load_textbook_defs(tb_dir, entity_file)
    textbook_names = set(tb_defs.keys())

    course = args.course
    lids = [x.strip() for x in args.lectures.split(",") if x.strip()]
    if not lids:
        kg_root = ROOT / "data/kg" / course
        lids = sorted(
            {
                p.name.replace("lecture_", "")
                for p in kg_root.glob("lecture_*")
                if p.is_dir() and (p / "kg.json").is_file()
            },
            key=lambda x: int(x) if x.isdigit() else 999,
        )

    out_dir = ROOT / "data/viz" / course / "review"
    out_dir.mkdir(parents=True, exist_ok=True)
    items: list[dict] = []

    for lid in lids:
        doc = build_lecture_review(
            course,
            lid,
            tb_defs=tb_defs,
            textbook_names=textbook_names,
            max_points=args.max_points,
        )
        if not doc:
            print(f"skip L{lid}: missing kg")
            continue
        path = out_dir / f"lecture_{lid}.json"
        path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        items.append(
            {
                "lecture_id": str(lid),
                "title": doc["title"],
                "n_points": doc["n_points"],
                "path": f"review/lecture_{lid}.json",
                "class_video": doc.get("class_video"),
                "ppt_video": doc.get("ppt_video"),
                "duration_sec": doc.get("duration_sec"),
            }
        )
        print(f"wrote {path} ({doc['n_points']} points)")

    showcase = {
        "courseId": course,
        "title": "单课复习整理",
        "items": items,
    }
    (ROOT / "data/viz" / course / "review_showcase.json").write_text(
        json.dumps(showcase, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (out_dir / "index.json").write_text(
        json.dumps(showcase, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"index → {len(items)} lectures")


if __name__ == "__main__":
    main()
