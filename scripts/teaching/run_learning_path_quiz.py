#!/usr/bin/env python
"""按学习路径分段生成习题。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from teachkg.config import TeachKGConfig
from teachkg.kg.learning_path import build_learning_path
from teachkg.rag.quiz_generator import generate_quiz
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config


def _subgraph_mmkg(mmkg: dict, entity_ids: set[str]) -> dict:
    edges = [
        e
        for e in (mmkg.get("edges") or [])
        if e.get("subject") in entity_ids and e.get("object") in entity_ids
    ]
    entities = [e for e in (mmkg.get("entities") or []) if (e.get("id") or e.get("name")) in entity_ids]
    return {**mmkg, "entities": entities, "edges": edges}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", required=True)
    p.add_argument("--chunk-size", type=int, default=8, help="每段路径节点数")
    p.add_argument("--questions-per-chunk", type=int, default=2)
    p.add_argument("--mock", action="store_true")
    p.add_argument("--output", default=None)
    args = p.parse_args()

    base = ROOT / "data" / "kg" / args.course_id
    mmkg = json.loads((base / "mmkg.json").read_text(encoding="utf-8"))
    cues = ROOT / "data" / "processed" / args.course_id / "cues.jsonl"
    path = build_learning_path(mmkg, cues if cues.is_file() else None)

    config = TeachKGConfig.from_yaml(args.config)
    llm = LLMClient(**llm_settings_from_config(config.get("llm", default={})))

    sections: list[dict] = []
    for i in range(0, len(path), args.chunk_size):
        chunk = path[i : i + args.chunk_size]
        eids = {c["entity_id"] for c in chunk}
        sub = _subgraph_mmkg(mmkg, eids)
        quiz = generate_quiz(
            sub,
            n_questions=args.questions_per_chunk,
            llm_client=llm,
            mock=args.mock,
        )
        sections.append(
            {
                "section_index": i // args.chunk_size + 1,
                "entity_ids": list(eids),
                "path_slice": [{"entity_id": c["entity_id"], "name": c["name"]} for c in chunk],
                "quiz": quiz,
            }
        )

    out = Path(args.output) if args.output else ROOT / "data" / "processed" / args.course_id / "learning_path_quiz.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"sections": sections}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Generated {len(sections)} quiz sections → {out}")


if __name__ == "__main__":
    main()
