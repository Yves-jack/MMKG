#!/usr/bin/env python3
"""按讲次多章先验 + 多通道课堂信号融合；写出 v2 by_context 产物。"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.textbook_kg.chapter_map import (
    resolve_lecture_chapters,
    suggest_lecture_chapter_map,
)
from teachkg.textbook_kg.importance_feedback import (
    build_lecture_df,
    cap_secondary_chapter_weights,
    compute_importance_feedback,
    configure_entity_weights,
    load_importance_prior,
    load_textbook_importance,
    merge_lecture_feedbacks,
    merge_session_feedback,
    pack_feedback_document,
    save_feedback,
    save_feedback_document,
)
from teachkg.textbook_kg.importance_signals import load_asset_concept_boost


def _load_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _lecture_duration(cues: list[dict], trips: list[dict]) -> float:
    dur = 0.0
    for c in cues:
        dur += float(c.get("duration_sec") or 0)
    if dur > 0:
        return dur
    for t in trips:
        s, e = float(t.get("start_sec") or 0), float(t.get("end_sec") or 0)
        dur += max(0.0, e - s)
    return max(dur, 1.0)


def main() -> None:
    parser = argparse.ArgumentParser(description="章节感知重要性反馈 v2（多通道）")
    parser.add_argument("--course", default="数理逻辑")
    parser.add_argument("--config", default=None, help="默认 teaching.yaml；离散数学课用 teaching_lisan.yaml")
    parser.add_argument("--lecture", default=None)
    parser.add_argument("--alpha", type=float, default=None)
    parser.add_argument("--alphas", default="0.35,0.45,0.55")
    parser.add_argument("--chapter-mix", type=float, default=0.7)
    parser.add_argument("--suggest-map", action="store_true")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    cfg_path = Path(args.config) if args.config else ROOT / "configs/teaching.yaml"
    if args.config is None and ("图论" in str(args.course) or "离散数学(" in str(args.course)):
        alt = ROOT / "configs" / "teaching_lisan.yaml"
        if alt.is_file():
            cfg_path = alt
    cfg = TeachKGConfig.from_yaml(cfg_path)
    tb = cfg.get("stage1", "textbook_kg", default={}) or {}
    fb = tb.get("importance_feedback", {}) or {}
    configure_entity_weights(fb)
    tb_dir = ROOT / tb.get("path", "data/textbook/CS2501-离散数学（数理逻辑与集合论）")
    bundle = tb_dir / tb.get("importance_bundle_file", "importance_bundle.json")
    chapter_order: list[str] = []
    if bundle.is_file():
        chapter_order = list(
            json.loads(bundle.read_text(encoding="utf-8")).get("chapter_order") or []
        )

    lecture_map = tb.get("lecture_chapter_map") or {}
    cues = _load_jsonl(ROOT / "data/processed" / args.course / "filtered_cues.jsonl")
    trips = _load_jsonl(ROOT / "data/kg" / args.course / "triplets.jsonl")
    if not trips:
        trips = _load_jsonl(ROOT / "data/kg" / args.course / "llm_only" / "triplets.jsonl")

    kg_dir = ROOT / "data/kg" / args.course
    assets_rel = fb.get("assets_library", "assets/library.json")
    asset_boost = load_asset_concept_boost(kg_dir / assets_rel)
    app_path = kg_dir / fb.get("app_feedback_events", "app_feedback_events.jsonl")
    channel_weights = fb.get("channel_weights") or {}

    cues_by: dict[str, list] = defaultdict(list)
    for c in cues:
        cues_by[str(c.get("lecture_id"))].append(c)
    trips_by: dict[str, list] = defaultdict(list)
    for t in trips:
        trips_by[str(t.get("lecture_id"))].append(t)

    if args.suggest_map:
        suggested = suggest_lecture_chapter_map(
            sorted(cues_by.keys(), key=lambda x: int(x) if x.isdigit() else 999),
            chapter_order=chapter_order,
            cues_by_lecture=dict(cues_by),
            triplets_by_lecture=dict(trips_by),
        )
        out = (
            ROOT
            / "data/experiments/comparisons"
            / args.course
            / "lecture_chapter_map_suggest.json"
        )
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(suggested, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(suggested, ensure_ascii=False, indent=2))
        print(f"wrote {out}")
        return

    lecture_ids = (
        [args.lecture]
        if args.lecture
        else sorted(set(cues_by) | set(trips_by), key=lambda x: int(x) if x.isdigit() else 999)
    )
    alpha_default = float(args.alpha if args.alpha is not None else fb.get("alpha", 0.45))
    alphas = [float(x) for x in args.alphas.split(",") if x.strip()]
    if args.alpha is not None:
        alphas = [alpha_default]

    chapter_boost = float(fb.get("chapter_boost", 1.35))
    top_k = int(fb.get("multi_chapter_top_k", 2))
    min_ratio = float(fb.get("multi_chapter_min_ratio", 0.45))
    secondary_cap = float(fb.get("secondary_chapter_cap", 0.25))
    idf_power = float(fb.get("lecture_idf_power", 1.0))
    lecture_df, n_lectures = build_lecture_df(trips)
    exp_dir = ROOT / "data/experiments/comparisons" / args.course / "importance_p3"
    exp_dir.mkdir(parents=True, exist_ok=True)

    def primary_top(chapter: str | None, k: int = 80) -> set[str]:
        if not chapter or not bundle.is_file():
            return set()
        table = load_textbook_importance(bundle, chapter=chapter)
        return {n for n, _ in sorted(table.items(), key=lambda x: -x[1])[:k]}

    def one_lecture(lid: str, alpha: float):
        lec_trips = trips_by.get(lid, [])
        if not lec_trips:
            return None, [], 0.0
        chapter_weights = resolve_lecture_chapters(
            lid,
            chapter_order=chapter_order,
            lecture_chapter_map=lecture_map,
            cues=cues_by.get(lid, []),
            triplets=lec_trips,
            top_k=top_k,
            min_ratio=min_ratio,
        )
        chapter_weights = cap_secondary_chapter_weights(
            chapter_weights, secondary_cap=secondary_cap
        )
        prior, meta = load_importance_prior(
            tb_dir,
            importance_file=tb.get("importance_file", "entity_sorted_ppr.json"),
            bundle_file=tb.get("importance_bundle_file", "importance_bundle.json"),
            chapters=chapter_weights,
            chapter_mix=float(fb.get("chapter_mix", args.chapter_mix)),
            chapter_boost=chapter_boost,
        )
        primary = chapter_weights[0][0] if chapter_weights else None
        meta["lecture_id"] = lid
        meta["resolved_chapters"] = [
            {"name": c, "weight": round(w, 4)} for c, w in chapter_weights
        ]
        result = compute_importance_feedback(
            textbook_importance=prior,
            triplets=lec_trips,
            alpha=alpha,
            use_log_duration=bool(fb.get("use_log_duration", True)),
            classroom_hub_penalty=float(fb.get("classroom_hub_penalty", 0.15)),
            chapters=[c for c, _ in chapter_weights],
            primary_chapter_top=primary_top(primary),
            chapter_order=chapter_order,
            off_chapter_penalty=float(fb.get("off_chapter_penalty", 0.45)),
            adaptive_alpha_enabled=bool(fb.get("adaptive_alpha", True)),
            adaptive_alpha_min=float(fb.get("adaptive_alpha_min", 0.28)),
            adaptive_alpha_scope_classroom=bool(
                fb.get("adaptive_alpha_scope_classroom", True)
            ),
            lecture_df=lecture_df,
            n_lectures=n_lectures,
            idf_power=idf_power,
            meta=meta,
            channel_weights=channel_weights,
            asset_boost=asset_boost,
            app_feedback_path=app_path if app_path.is_file() else None,
            new_entity_scale=float(fb.get("new_entity_scale", 0.88)),
            new_entity_max=float(fb.get("new_entity_max", 0.75)),
        )
        dur = _lecture_duration(cues_by.get(lid, []), lec_trips)
        return result, chapter_weights, dur

    summary = []
    run_ablation = not (args.write and args.lecture is None)
    if run_ablation:
        for lid in lecture_ids:
            for a in alphas:
                result, ch_w, _ = one_lecture(lid, a)
                if result is None:
                    continue
                tag = f"lec{lid}_a{a:.2f}"
                path = exp_dir / f"feedback_{tag}.json"
                save_feedback(path, result)
                top5 = [x["zh"] for x in result.to_dict()["top"][:5]]
                ch_label = "|".join(f"{c}:{w:.2f}" for c, w in ch_w) if ch_w else "-"
                summary.append(
                    {
                        "lecture_id": lid,
                        "chapters": [{"name": c, "weight": w} for c, w in ch_w],
                        "alpha_base": a,
                        "alpha_used": result.alpha,
                        "jaccard": (result.meta or {}).get("prior_classroom_jaccard"),
                        "n": len(result.scores),
                        "top5": top5,
                        "path": str(path),
                    }
                )
                print(
                    f"L{lid} ch=[{ch_label}] a_base={a:.2f} a_used={result.alpha:.2f} "
                    f"J={summary[-1]['jaccard']} top5={top5}"
                )

    if args.write:
        out = kg_dir / fb.get("output_filename", "entity_importance_feedback.json")
        if args.lecture:
            result, ch_w, _ = one_lecture(args.lecture, alpha_default)
            if result is None:
                raise SystemExit(f"no triplets for lecture {args.lecture}")
            doc = pack_feedback_document(
                course_scores=result,
                by_context={f"lecture:{args.lecture}": result, "course": result},
            )
            save_feedback_document(out, doc)
            print(f"wrote formal feedback v2 -> {out} lecture={args.lecture}")
        else:
            parts: list[tuple] = []
            by_ctx: dict = {}
            lec_results: dict[str, tuple] = {}
            for lid in lecture_ids:
                result, ch_w, dur = one_lecture(lid, alpha_default)
                if result is None:
                    continue
                parts.append((result, dur))
                by_ctx[f"lecture:{lid}"] = result
                lec_results[lid] = (result, dur)
                print(
                    f"  merge L{lid} ch={[c for c, _ in ch_w]} "
                    f"a_used={result.alpha:.2f} top3={[x['zh'] for x in result.to_dict()['top'][:3]]}"
                )
            # session: 奇数讲起相邻两讲
            numeric = sorted(
                [k for k in lec_results if k.isdigit()],
                key=lambda x: int(x),
            )
            for i in range(0, len(numeric) - 1):
                a, b = numeric[i], numeric[i + 1]
                if int(b) != int(a) + 1:
                    continue
                if int(a) % 2 != 1:
                    continue
                ra, wa = lec_results[a]
                rb, wb = lec_results[b]
                by_ctx[f"session:{a}_{b}"] = merge_session_feedback(
                    ra, rb, weight_a=wa, weight_b=wb
                )

            merged = merge_lecture_feedbacks(parts, alpha=alpha_default)
            by_ctx["course"] = merged
            doc = pack_feedback_document(course_scores=merged, by_context=by_ctx)
            save_feedback_document(out, doc)
            print(
                f"wrote formal feedback v2 -> {out} "
                f"(merged {len(parts)} lectures, contexts={len(by_ctx)})"
            )

    if summary:
        (exp_dir / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"summary -> {exp_dir / 'summary.json'}")


if __name__ == "__main__":
    main()
