"""Stage 2：实体合并 → 课程/单讲知识图谱。"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from teachkg.config import TeachKGConfig
from teachkg.stage2_kg_build.entity_merge import merge_triplets_to_kg
from teachkg.utils.io import load_jsonl

logger = logging.getLogger(__name__)


class Stage2KGPipeline:
    def __init__(self, config: TeachKGConfig, project_root: Path | None = None) -> None:
        self.config = config
        self.project_root = project_root or Path(__file__).resolve().parents[2]
        s2 = config.get("stage2", default={})

        self.use_existing = s2.get("use_existing_artifacts", True)
        self.input_filename = s2.get("input_filename", "triplets.jsonl")
        self.output_filename = s2.get("output_filename", "kg.json")
        self.merge_map_filename = s2.get("merge_map_filename", "entity_merge_map.json")
        self.report_filename = s2.get("report_filename", "stage2_report.json")

        merge_cfg = s2.get("entity_merge", {})
        self.drop_related_with = merge_cfg.get("drop_related_with_when_specific", True)
        self.min_subgraph_size = merge_cfg.get("min_subgraph_size", 0)
        embed_cfg = merge_cfg.get("embedding_merge", {})
        self.embedding_merge_enabled = bool(embed_cfg.get("enabled", False))
        self.embedding_merge_threshold = float(embed_cfg.get("similarity_threshold", 0.93))
        self.embedding_merge_model = embed_cfg.get("embedder_model") or config.get(
            "stage3", "index", default={}
        ).get("embedder_model", "shibing624/text2vec-base-multilingual")
        self.embedding_merge_max_statements = int(embed_cfg.get("max_statements", 2))
        self.embedding_merge_block_structural = bool(embed_cfg.get("block_structural_pairs", True))

    @property
    def kg_dir(self) -> Path:
        return Path(self.config.get("project", "kg_dir", default="data/kg"))

    @property
    def processed_dir(self) -> Path:
        return Path(self.config.get("project", "output_dir", default="data/processed"))

    def _output_paths(self, course_id: str, lecture_id: str | None) -> tuple[Path, Path, Path]:
        if lecture_id:
            base = self.kg_dir / course_id / f"lecture_{lecture_id}"
        else:
            base = self.kg_dir / course_id
        kg_path = base / self.output_filename
        merge_path = base / self.merge_map_filename
        report_path = self.processed_dir / course_id / self.report_filename
        if lecture_id:
            report_path = self.processed_dir / course_id / f"stage2_report_lecture_{lecture_id}.json"
        return kg_path, merge_path, report_path

    def _filter_triplets(
        self,
        triplets: list[dict[str, Any]],
        lecture_id: str | None,
    ) -> list[dict[str, Any]]:
        if not lecture_id:
            return triplets
        return [t for t in triplets if str(t.get("lecture_id", "")) == str(lecture_id)]

    def run(self, course_id: str, *, lecture_id: str | None = None, force: bool = False) -> Path:
        input_path = self.kg_dir / course_id / self.input_filename
        kg_path, merge_path, report_path = self._output_paths(course_id, lecture_id)

        if not input_path.is_file():
            raise FileNotFoundError(f"Stage 1 triplets not found: {input_path}")

        if self.use_existing and not force and kg_path.is_file():
            logger.info("Reuse existing Stage 2 KG: %s", kg_path)
            return kg_path

        triplets = load_jsonl(input_path)
        filtered = self._filter_triplets(triplets, lecture_id)
        if not filtered:
            raise ValueError(
                f"No triplets for course={course_id}"
                + (f" lecture={lecture_id}" if lecture_id else "")
            )

        logger.info(
            "Stage 2: merging %d triplets → KG (course=%s, lecture=%s)",
            len(filtered),
            course_id,
            lecture_id or "all",
        )

        embedding_merge_map: dict[str, str] = {}
        if self.embedding_merge_enabled:
            from teachkg.quality.entity_embedding_merge import merge_map_by_embedding
            from teachkg.stage3_mmkg.text_embedder import TextEmbedder

            names = sorted(
                {
                    str(t.get("subject", "")).strip()
                    for t in filtered
                    if str(t.get("subject", "")).strip()
                }
                | {
                    str(t.get("object", "")).strip()
                    for t in filtered
                    if str(t.get("object", "")).strip()
                }
            )
            embedder = TextEmbedder(model_name=self.embedding_merge_model)
            embedding_merge_map = merge_map_by_embedding(
                names,
                embedder=embedder,
                similarity_threshold=self.embedding_merge_threshold,
                triplets=filtered,
                max_statements=self.embedding_merge_max_statements,
                block_structural_pairs=self.embedding_merge_block_structural,
            )
            if embedding_merge_map:
                logger.info("Embedding merge: %d alias pairs", len(embedding_merge_map))

        result = merge_triplets_to_kg(
            filtered,
            drop_related_with_when_specific=self.drop_related_with,
            min_subgraph_size=self.min_subgraph_size,
            embedding_merge_map=embedding_merge_map or None,
        )

        payload = {
            "course_id": course_id,
            "lecture_id": lecture_id,
            "triplet_count": len(filtered),
            **result.to_dict(),
        }

        kg_path.parent.mkdir(parents=True, exist_ok=True)
        kg_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

        merge_path.write_text(
            json.dumps(
                {
                    "course_id": course_id,
                    "lecture_id": lecture_id,
                    "merge_map": result.merge_map,
                    "stats": result.stats,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(
                {
                    "course_id": course_id,
                    "lecture_id": lecture_id,
                    "input_triplets": len(filtered),
                    "entity_count": len(result.entities),
                    "edge_count": len(result.edges),
                    "merged_alias_count": len(result.merge_map),
                    "relation_counts": result.stats.get("relation_counts", {}),
                    "kg_path": str(kg_path),
                    "merge_map_path": str(merge_path),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        logger.info(
            "Stage 2 done: %d entities, %d edges → %s",
            len(result.entities),
            len(result.edges),
            kg_path,
        )
        return kg_path
