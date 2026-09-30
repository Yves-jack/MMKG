#!/usr/bin/env python

"""用当前 extract_text + 已筛选种子，重跑指定讲次的教材子图与课堂增量。



不重新做 ASR/预处理/种子 LLM 筛选；保留 seed_entities 与 seed_candidates_*。

"""



from __future__ import annotations



import argparse

import logging

import sys

from pathlib import Path



ROOT = Path(__file__).resolve().parents[2]

if str(ROOT) not in sys.path:

    sys.path.insert(0, str(ROOT))



from teachkg.config import TeachKGConfig

from teachkg.schemas import VideoSegment

from teachkg.stage1_alignment.pipeline import (

    CueCheckResult,

    PreparedCue,

    Stage1PreparePipeline,

)

from teachkg.stage1_alignment.triplet_extract import (

    build_flat_triplet_records,

    load_course_context,

)

from teachkg.utils.io import load_jsonl, pretty_json_path, save_json, save_jsonl





def _parse_cue_indices(spec: str, n: int) -> list[int] | None:

    """解析 1-based 片段序号，返回 0-based 下标列表；空串表示全部。"""

    text = (spec or "").strip()

    if not text:

        return None

    picked: set[int] = set()

    for part in text.replace("，", ",").split(","):

        part = part.strip()

        if not part:

            continue

        if "-" in part:

            a, b = part.split("-", 1)

            start, end = int(a.strip()), int(b.strip())

            if start > end:

                start, end = end, start

            for i in range(start, end + 1):

                picked.add(i)

        else:

            picked.add(int(part))

    out: list[int] = []

    for i in sorted(picked):

        if i < 1 or i > n:

            raise SystemExit(f"cue index {i} out of range 1..{n}")

        out.append(i - 1)

    return out





def _resolve_extract(cue: dict) -> str:

    s1 = cue.get("stage1") or {}

    return (

        (s1.get("extract_text") or "").strip()

        or (cue.get("extract_text") or "").strip()

        or (cue.get("asr_text") or "").strip()

    )





def main() -> None:

    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument("--config", default=str(ROOT / "configs/teaching.yaml"))

    parser.add_argument("--course-id", default="数理逻辑")

    parser.add_argument("--lecture-id", required=True)

    parser.add_argument(

        "--cue-indices",

        default="",

        help="按讲次内排序后的片段序号（1-based），如 1-3 或 1,2,3；空=全部",

    )

    parser.add_argument("--dry-run", action="store_true")

    args = parser.parse_args()



    logging.basicConfig(

        level=logging.INFO,

        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",

        handlers=[logging.StreamHandler(sys.stdout)],

    )

    log = logging.getLogger("run_textbook_from_seeds")



    course = args.course_id

    lec = str(args.lecture_id)

    cfg = TeachKGConfig.from_yaml(args.config)

    cfg.raw.setdefault("stage1", {}).setdefault("textbook_kg", {})["enabled"] = True

    cfg.raw["stage1"].setdefault("llm_only", {})["sync_active_triplets"] = False



    pipeline = Stage1PreparePipeline(cfg, project_root=ROOT, mock=False)

    if not pipeline.textbook_retriever or not pipeline.triplet_extractor:

        raise SystemExit("textbook retriever / triplet extractor 未启用")



    cues_path = ROOT / "data/processed" / course / "filtered_cues.jsonl"

    trips_path = ROOT / "data/kg" / course / "triplets.jsonl"

    all_cues = load_jsonl(cues_path)

    cues = [c for c in all_cues if str(c.get("lecture_id")) == lec]

    cues.sort(key=lambda r: float(r.get("start_sec") or 0))

    if not cues:

        raise SystemExit(f"no cues for lecture {lec}")



    selected_idx = _parse_cue_indices(args.cue_indices, len(cues))

    if selected_idx is not None:

        cues = [cues[i] for i in selected_idx]

        log.info(

            "cue filter indices=%s -> %d cues: %s",

            args.cue_indices,

            len(cues),

            [c.get("cue_id") for c in cues],

        )



    course_context = load_course_context(

        cfg.workspace_dir, course, cue=VideoSegment.from_dict(cues[0])

    )



    items: list[PreparedCue] = []

    seed_meta: dict[str, dict] = {}

    for row in cues:

        seg = VideoSegment.from_dict(row)

        extract = _resolve_extract(row)

        s1 = row.get("stage1") or {}

        sg = dict(s1.get("textbook_subgraph") or {})

        seeds = set(sg.get("seed_entities") or [])

        alias = set(sg.get("alias_seeds") or [])

        emb = set(sg.get("embedding_seeds") or [])

        cand_a = set(sg.get("seed_candidates_alias") or [])

        cand_e = set(sg.get("seed_candidates_embedding") or [])

        if not seeds:

            seeds = alias | emb

        seed_meta[seg.cue_id] = {

            "seeds": seeds,

            "alias": alias,

            "emb": emb,

            "cand_a": cand_a,

            "cand_e": cand_e,

            "keep_sg": {

                k: sg[k]

                for k in (

                    "seed_filter_note",

                    "embedding_top_k_dynamic",

                    "extract_word_count",

                    "seed_candidates_alias",

                    "seed_candidates_embedding",

                )

                if k in sg

            },

        }

        extra = row.get("extra") or {}

        items.append(

            PreparedCue(

                cue=seg,

                check=CueCheckResult(passed=True),

                extract_text=extract,

                ppt_frame_path=str(extra.get("ppt_frame_path") or ""),

                ppt_page_index=extra.get("ppt_page_index"),

            )

        )



    orig_retrieve = pipeline.textbook_retriever.retrieve

    _orig_hybrid = pipeline._extract_hybrid_lecture



    def hybrid_once(lecture_items, course_id, course_context):

        # hybrid 只对有 extract_text 的 cue 调用 retrieve，游标必须与之对齐

        order = [p for p in lecture_items if (p.extract_text or "").strip()]

        idx = {"i": 0}



        def retrieve_seq(text: str):

            if idx["i"] >= len(order):

                return orig_retrieve(text)

            prepared = order[idx["i"]]

            idx["i"] += 1

            meta = seed_meta[prepared.cue.cue_id]

            seeds = set(meta["seeds"])

            if not seeds:

                return orig_retrieve(text)

            pool = meta["cand_a"] | meta["cand_e"] | seeds

            if not meta["cand_a"] and not meta["cand_e"]:

                pool = seeds

            result = pipeline.textbook_retriever.retrieve_from_seeds(

                seeds,

                text,

                candidate_seed_pool=pool,

                alias_seeds=meta["alias"] or seeds,

                embedding_seeds=meta["emb"],

            )

            result.seed_entities = set(seeds)

            if meta["alias"] or meta["emb"]:

                result.alias_seeds = set(meta["alias"]) & seeds

                result.embedding_seeds = seeds - result.alias_seeds

            if meta["cand_a"] or meta["cand_e"]:

                result.seed_candidates_alias = set(meta["cand_a"])

                result.seed_candidates_embedding = set(meta["cand_e"])

            return result



        pipeline.textbook_retriever.retrieve = retrieve_seq  # type: ignore[method-assign]

        _orig_hybrid(lecture_items, course_id, course_context)

        for prepared in lecture_items:

            meta = seed_meta[prepared.cue.cue_id]

            if not prepared.textbook_subgraph:

                continue

            sg = dict(prepared.textbook_subgraph)

            sg.update(meta["keep_sg"])

            sg["seed_entities"] = sorted(meta["seeds"])

            if meta["alias"] or meta["emb"]:

                sg["alias_seeds"] = sorted(meta["alias"] & meta["seeds"])

                sg["embedding_seeds"] = sorted(

                    (meta["emb"] & meta["seeds"]) - set(sg["alias_seeds"])

                )

            if meta["cand_a"] or meta["cand_e"]:

                sg["seed_candidates_alias"] = sorted(meta["cand_a"])

                sg["seed_candidates_embedding"] = sorted(meta["cand_e"])

            prepared.textbook_subgraph = sg



    log.info(

        "Rebuilding textbook + 三路增量 for lecture %s (%d cues)…", lec, len(items)

    )

    hybrid_once(items, course, course_context)

    # 第3阶段：跨段（整讲所有段完成教材/原文增量/KG补全后再跑）

    if pipeline.cross_cue_enabled:

        log.info("Stage 3/3: cross-cue extract…")

        pipeline._extract_cross_cue_lecture(items, course_context)



    from teachkg.stage1_alignment.triplet_extract import is_cross_cue_extract_source



    def _src_counts(triplets):

        tb = d = kg = x = 0

        for t in triplets:

            src = (t.extract_source or "").strip()

            if src == "textbook":

                tb += 1

            elif src == "lecture_delta":

                d += 1

            elif src == "kg_completion":

                kg += 1

            elif is_cross_cue_extract_source(src):

                x += 1

        return tb, d, kg, x



    tb_n = delta_n = kg_n = cross_n = 0

    for p in items:

        a, b, c, d = _src_counts(p.triplets)

        tb_n += a

        delta_n += b

        kg_n += c

        cross_n += d

    log.info(

        "done: textbook=%d lecture_delta=%d kg_completion=%d cross_cue=%d",

        tb_n,

        delta_n,

        kg_n,

        cross_n,

    )

    for p in items:

        a, b, c, d = _src_counts(p.triplets)

        print(

            f"{p.cue.cue_id}: tb={a} delta={b} kgc={c} cross={d} "

            f"seeds={len(seed_meta[p.cue.cue_id]['seeds'])}"

        )



    if args.dry_run:

        print("dry-run: not writing")

        return



    by_id = {p.cue.cue_id: p for p in items}

    merged = []

    for row in all_cues:

        cid = str(row.get("cue_id"))

        if cid in by_id:

            merged.append(by_id[cid].to_dict())

        else:

            merged.append(row)

    save_jsonl(cues_path, merged)

    save_json(pretty_json_path(cues_path), merged)

    print(f"updated {len(items)} cues → {cues_path}")



    existing = (

        [

            r

            for r in load_jsonl(trips_path)

            if not (

                str(r.get("lecture_id")) == lec

                and str(r.get("cue_id")) in by_id

            )

        ]

        if trips_path.is_file()

        else []

    )

    new_trips = []

    for p in items:

        new_trips.extend(

            build_flat_triplet_records(

                p.cue,

                p.triplets,

                course_id=course,

                ppt_frame_path=p.ppt_frame_path,

                ppt_page_index=p.ppt_page_index,

                extract_mode="hybrid",

                ground_textbook=False,

            )

        )

    save_jsonl(trips_path, existing + new_trips)

    print(

        f"triplets lecture {lec}: {len(new_trips)} "

        f"(course total {len(existing) + len(new_trips)}) → {trips_path}"

    )





if __name__ == "__main__":

    main()

