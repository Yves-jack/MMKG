"""Stage 2：实体分流 → 实体合并 → 课程/单讲知识图谱。"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from teachkg.config import TeachKGConfig
from teachkg.stage2_kg_build.entity_merge import merge_triplets_to_kg
from teachkg.stage2_kg_build.entity_triage import EntityTriageConfig, triage_triplets
from teachkg.utils.artifact_fingerprint import (
    can_reuse,
    file_identity,
    hash_jsonl_rows,
    save_meta,
)
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
        self.merge_synonym_of = bool(merge_cfg.get("merge_synonym_of", True))
        embed_cfg = merge_cfg.get("embedding_merge", {})
        self.embedding_merge_enabled = bool(embed_cfg.get("enabled", False))
        self.embedding_merge_threshold = float(embed_cfg.get("similarity_threshold", 0.93))
        self.embedding_merge_model = embed_cfg.get("embedder_model") or config.get(
            "stage3", "index", default={}
        ).get("embedder_model", "shibing624/text2vec-base-multilingual")
        self.embedding_merge_max_statements = int(embed_cfg.get("max_statements", 2))
        self.embedding_merge_block_structural = bool(embed_cfg.get("block_structural_pairs", True))

        self.triage_cfg = EntityTriageConfig.from_dict(s2.get("entity_triage") or {})

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

    def _load_entity_registry(self):
        """加载教材实体注册表（分流 merge 依赖）；无教材路径则返回 None。"""
        tb_cfg = self.config.get("stage1", "textbook_kg", default={}) or {}
        raw_path = tb_cfg.get("path") or ""
        if not raw_path:
            return None, set()
        path = Path(raw_path)
        if not path.is_absolute():
            path = self.project_root / path
        if not path.exists():
            logger.warning("entity_triage: textbook path missing: %s", path)
            return None, set()
        from teachkg.textbook_kg.entity_registry import EntityRegistry
        from teachkg.textbook_kg.loader import TextbookKG

        kg = TextbookKG.load(
            path,
            entity_file=tb_cfg.get("entity_file", "entity_final.json"),
            relations_file=tb_cfg.get("relations_file", "relations_final.json"),
        )
        return EntityRegistry.from_textbook_kg(kg), set(kg.entity_names)

    def run(
        self,
        course_id: str,
        *,
        lecture_id: str | None = None,
        force: bool = False,
        input_filename: str | None = None,
        output_filename: str | None = None,
    ) -> Path:
        input_name = input_filename or self.input_filename
        output_name = output_filename or self.output_filename
        input_path = self.kg_dir / course_id / input_name
        kg_path, merge_path, report_path = self._output_paths(course_id, lecture_id)
        if output_name != self.output_filename:
            base = kg_path.parent
            kg_path = base / output_name

        if not input_path.is_file():
            raise FileNotFoundError(f"Stage 1 triplets not found: {input_path}")

        meta_path = kg_path.with_name(kg_path.stem + "_input_meta.json")
        expected_meta = {
            "course_id": course_id,
            "lecture_id": str(lecture_id) if lecture_id else None,
            "triplets_file": file_identity(input_path),
            "triplets_fp": hash_jsonl_rows(input_path, lecture_id=lecture_id),
            "input_filename": input_name,
            "embedding_merge_enabled": bool(self.embedding_merge_enabled),
            "triage_enabled": bool(self.triage_cfg.enabled),
        }
        if self.use_existing and not force and can_reuse(kg_path, meta_path, expected_meta):
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

        triage_stats: dict[str, Any] = {"enabled": False}
        textbook_entity_names: set[str] | None = None
        working = filtered
        if self.triage_cfg.enabled:
            registry, textbook_entity_names = self._load_entity_registry()
            if registry is None:
                logger.warning("entity_triage enabled but no textbook registry; skip triage")
            else:
                triage = triage_triplets(
                    working,
                    registry,
                    cfg=self.triage_cfg,
                    lecture_id=lecture_id,
                )
                working = triage.triplets
                triage_stats = dict(triage.stats)
                triage_path = self.processed_dir / course_id
                if lecture_id:
                    triage_path = triage_path / f"entity_triage_lecture_{lecture_id}.json"
                else:
                    triage_path = triage_path / "entity_triage.json"
                triage_path.parent.mkdir(parents=True, exist_ok=True)
                triage_path.write_text(
                    json.dumps(
                        {
                            "course_id": course_id,
                            "lecture_id": lecture_id,
                            "stats": triage_stats,
                            "decisions": [d.to_dict() for d in triage.decisions],
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
                logger.info(
                    "entity_triage: %s → %s triplets; decisions=%s; wrote %s",
                    triage_stats.get("input_triplets"),
                    triage_stats.get("output_triplets"),
                    triage_stats.get("decision_counts"),
                    triage_path,
                )

        embedding_merge_map: dict[str, str] = {}
        if self.embedding_merge_enabled:
            from teachkg.quality.entity_embedding_merge import merge_map_by_embedding
            from teachkg.stage3_mmkg.text_embedder import TextEmbedder

            names = sorted(
                {
                    str(t.get("subject", "")).strip()
                    for t in working
                    if str(t.get("subject", "")).strip()
                }
                | {
                    str(t.get("object", "")).strip()
                    for t in working
                    if str(t.get("object", "")).strip()
                }
            )
            embedder = TextEmbedder(model_name=self.embedding_merge_model)
            embedding_merge_map = merge_map_by_embedding(
                names,
                embedder=embedder,
                similarity_threshold=self.embedding_merge_threshold,
                triplets=working,
                max_statements=self.embedding_merge_max_statements,
                block_structural_pairs=self.embedding_merge_block_structural,
            )
            if embedding_merge_map:
                logger.info("Embedding merge: %d alias pairs", len(embedding_merge_map))

        result = merge_triplets_to_kg(
            working,
            drop_related_with_when_specific=self.drop_related_with,
            min_subgraph_size=self.min_subgraph_size,
            embedding_merge_map=embedding_merge_map or None,
            textbook_entity_names=textbook_entity_names,
            merge_synonym_of=self.merge_synonym_of,
        )

        payload = {
            "course_id": course_id,
            "lecture_id": lecture_id,
            "triplet_count": len(working),
            "triplet_count_before_triage": len(filtered),
            "entity_triage": triage_stats,
            **result.to_dict(),
        }

        kg_path.parent.mkdir(parents=True, exist_ok=True)
        kg_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        save_meta(meta_path, expected_meta)

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
                    "triplets_after_triage": len(working),
                    "entity_triage": triage_stats,
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
