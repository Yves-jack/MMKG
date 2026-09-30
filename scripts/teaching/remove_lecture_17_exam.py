"""Remove 数理逻辑 lecture 17 (exam-only) artifacts from pipeline data."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
COURSE = "数理逻辑"
LEC = "17"
PREFIX = f"{COURSE}_{LEC}_"


def is_lec17_row(row: dict) -> bool:
    if str(row.get("lecture_id", "")) == LEC:
        return True
    cid = str(row.get("cue_id", ""))
    return cid.startswith(PREFIX)


def filter_jsonl(path: Path) -> tuple[int, int]:
    if not path.is_file():
        return 0, 0
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    kept = [r for r in rows if not is_lec17_row(r)]
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in kept)
        + ("\n" if kept else ""),
        encoding="utf-8",
    )
    return len(rows), len(kept)


def filter_json_list(path: Path) -> tuple[int, int]:
    if not path.is_file():
        return 0, 0
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        return 0, 0
    kept = [r for r in data if not is_lec17_row(r)]
    path.write_text(json.dumps(kept, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(data), len(kept)


def scrub_cue_list(cues: list | None) -> list:
    return [c for c in (cues or []) if not str(c).startswith(PREFIX)]


def scrub_kg(path: Path) -> dict:
    if not path.is_file():
        return {"skipped": True}
    data = json.loads(path.read_text(encoding="utf-8"))
    edges_in = data.get("edges") or []
    ents_in = data.get("entities") or []
    edges_out = []
    for e in edges_in:
        cues = scrub_cue_list(e.get("cue_ids"))
        if not cues:
            # drop edges that only came from lecture 17
            old = e.get("cue_ids") or []
            if old and all(str(c).startswith(PREFIX) for c in old):
                continue
            if not old:
                edges_out.append(e)
                continue
            continue
        e = dict(e)
        e["cue_ids"] = cues
        prov = e.get("provenance")
        if isinstance(prov, list):
            e["provenance"] = [
                p
                for p in prov
                if str(p.get("lecture_id", "")) != LEC
                and not str(p.get("cue_id", "")).startswith(PREFIX)
            ]
        edges_out.append(e)

    ents_out = []
    for ent in ents_in:
        cues = scrub_cue_list(ent.get("cue_ids"))
        old = ent.get("cue_ids") or []
        if old and not cues:
            continue  # entity only from lec17
        ent = dict(ent)
        if "cue_ids" in ent:
            ent["cue_ids"] = cues
            if "mention_count" in ent:
                ent["mention_count"] = len(cues)
        ents_out.append(ent)

    data["edges"] = edges_out
    data["entities"] = ents_out
    data["triplet_count"] = len(edges_out)
    data["edge_count"] = len(edges_out)
    data["entity_count"] = len(ents_out)
    if "stats" in data and isinstance(data["stats"], dict):
        data["stats"]["entity_count"] = len(ents_out)
        data["stats"]["edge_count"] = len(edges_out)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "path": str(path),
        "edges": f"{len(edges_in)}->{len(edges_out)}",
        "entities": f"{len(ents_in)}->{len(ents_out)}",
    }


def rm_path(path: Path, report: list) -> None:
    if not path.exists():
        return
    if path.is_dir():
        shutil.rmtree(path)
        report.append(f"rmdir {path}")
    else:
        path.unlink()
        report.append(f"rm {path}")


def _lec1_name(name: str) -> str:
    return name.replace("lec1_17", "lec1").replace("lec1_lec17", "lec1")


def filter_experiment_md_json() -> list[str]:
    """Drop lecture-17 sections from lec1_17 review artifacts; rewrite as lec1."""
    notes: list[str] = []
    exp = DATA / "experiments" / "comparisons" / COURSE
    for name in [
        "extract_text_with_subgraph_lec1_17.json",
        "extract_text_with_subgraph_lec1_lec17.json",
        "hybrid_delta_review_lec1_17.json",
        "subgraph_quality_lec1_17.json",
        "preprocess_rule_vs_llm_lec1_17.json",
    ]:
        p = exp / name
        if not p.is_file():
            continue
        data = json.loads(p.read_text(encoding="utf-8"))
        out = exp / _lec1_name(name)
        if isinstance(data, dict) and "items" in data:
            before = len(data["items"])
            data["items"] = [
                it
                for it in data["items"]
                if str(it.get("lecture_id")) != LEC
                and not str(it.get("cue_id", "")).startswith(PREFIX)
            ]
            data["lecture_ids"] = ["1"]
            data["note"] = (data.get("note") or "") + " | lecture 17 (exam) removed"
            out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            notes.append(f"rewrite {p.name} -> {out.name} items {before}->{len(data['items'])}")
        else:
            # comparison blob still tied to 1+17 naming; drop
            p.unlink()
            notes.append(f"rm {p.name}")
            continue
        if out != p and p.is_file():
            p.unlink()

    for name in [
        "extract_text_with_subgraph_lec1_17.md",
        "extract_text_with_subgraph_lec1_lec17.md",
        "hybrid_delta_review_lec1_17.md",
    ]:
        p = exp / name
        if not p.is_file():
            continue
        lines = p.read_text(encoding="utf-8").splitlines()
        out_lines: list[str] = []
        skip = False
        for line in lines:
            if line.startswith("## [17]"):
                skip = True
                continue
            if skip and line.startswith("## "):
                skip = False
            if skip:
                continue
            out_lines.append(
                line.replace("（1, 17）", "（1）")
                .replace("（1/17）", "（1）")
                .replace("1, 17", "1")
            )
        out = exp / _lec1_name(name)
        out.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
        notes.append(f"rewrite {p.name} -> {out.name}")
        if out != p:
            p.unlink()
    return notes


def main() -> None:
    report: list[str] = []

    # --- delete lecture-scoped trees / files ---
    delete_paths = [
        DATA / "index" / COURSE / "lecture_17",
        DATA / "kg" / COURSE / "lecture_17",
        DATA / "segments" / COURSE / "asr_work" / "17",
        DATA / "segments" / COURSE / "asr" / "17_0.srt",
        DATA / "segments" / COURSE / "ppt_change" / "17_seg.txt",
        DATA / "viz" / COURSE / "lecture_17_kg.html",
        DATA / "viz" / COURSE / "lecture_17_mmkg.html",
        DATA / "processed" / COURSE / "hybrid_vs_llm_lecture_17.json",
        DATA / "processed" / COURSE / "stage2_report_lecture_17.json",
        DATA / "processed" / COURSE / "stage3_mmkg_report_lecture_17.json",
    ]
    for p in delete_paths:
        rm_path(p, report)

    cues_dir = DATA / "segments" / COURSE / "cues"
    if cues_dir.is_dir():
        for p in cues_dir.glob(f"{COURSE}_17_*.mp4"):
            rm_path(p, report)

    logs = DATA / "logs"
    if logs.is_dir():
        for p in logs.glob(f"*_{COURSE}_17_*.log"):
            rm_path(p, report)
        for p in logs.glob(f"*{COURSE}*17*.log"):
            if "_17_" in p.name or p.name.endswith("_17.log"):
                rm_path(p, report)

    # --- filter line-oriented artifacts ---
    jsonl_files = [
        DATA / "segments" / COURSE / "cues.jsonl",
        DATA / "processed" / COURSE / "filtered_cues.jsonl",
        DATA / "processed" / COURSE / "rejected_cues.jsonl",
        DATA / "kg" / COURSE / "triplets.jsonl",
        DATA / "kg" / COURSE / "llm_only" / "triplets.jsonl",
        DATA / "kg" / COURSE / "triplets_review.jsonl",
    ]
    for p in jsonl_files:
        before, after = filter_jsonl(p)
        if before:
            report.append(f"jsonl {p.relative_to(DATA)}: {before}->{after}")

    json_lists = [
        DATA / "pretty_view" / "processed" / COURSE / "filtered_cues.json",
        DATA / "pretty_view" / "processed" / COURSE / "rejected_cues.json",
        DATA / "pretty_view" / "segments" / COURSE / "cues.json",
        DATA / "pretty_view" / "kg" / COURSE / "triplets_review.json",
        DATA / "pretty_view" / "kg" / COURSE / "llm_only" / "triplets.json",
    ]
    for p in json_lists:
        before, after = filter_json_list(p)
        if before:
            report.append(f"json-list {p.relative_to(DATA)}: {before}->{after}")

    # --- scrub course KG / MMKG ---
    for rel in [
        f"kg/{COURSE}/kg.json",
        f"kg/{COURSE}/mmkg.json",
        f"kg/{COURSE}/llm_only/kg.json",
        f"kg/{COURSE}/llm_only/mmkg.json",
    ]:
        info = scrub_kg(DATA / rel)
        if not info.get("skipped"):
            report.append(f"scrub_kg {info}")

    # --- stage1 report counts ---
    rep = DATA / "processed" / COURSE / "stage1_report.json"
    if rep.is_file():
        cues = [
            json.loads(l)
            for l in (DATA / "processed" / COURSE / "filtered_cues.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if l.strip()
        ]
        rejected = []
        rj = DATA / "processed" / COURSE / "rejected_cues.jsonl"
        if rj.is_file():
            rejected = [
                json.loads(l)
                for l in rj.read_text(encoding="utf-8").splitlines()
                if l.strip()
            ]
        trips = [
            json.loads(l)
            for l in (DATA / "kg" / COURSE / "triplets.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if l.strip()
        ]
        data = json.loads(rep.read_text(encoding="utf-8"))
        data["passed_count"] = len(cues)
        data["rejected_count"] = len(rejected)
        data["input_count"] = len(cues) + len(rejected)
        data["triplet_count"] = len(trips)
        data["note"] = (data.get("note") or "") + " | lecture 17 (exam) removed"
        rep.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        report.append("updated stage1_report.json")

    report.extend(filter_experiment_md_json())

    out = DATA / "experiments" / "comparisons" / COURSE / "remove_lecture_17_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out}")
    for line in report:
        print(line)


if __name__ == "__main__":
    main()
