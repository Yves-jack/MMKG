"""
Stage 1：cue 后处理 + 知识子图抽取。

输入：Stage 0 的 cues.jsonl
输出：
  - filtered_cues.jsonl（规则校验 + PPT 帧 + 三元组）
  - data/kg/{course_id}/triplets.jsonl（扁平三元组，带溯源）
"""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from teachkg.config import TeachKGConfig
from teachkg.schemas import VideoSegment
from teachkg.stage1_alignment.media_utils import resolve_path
from teachkg.stage1_alignment.stage0_frame import (
    load_ppt_pages,
    page_index_for_cue,
    resolve_stage0_ppt_frame,
)
from teachkg.stage1_alignment.text_preprocess import CueTextPreprocessor
from teachkg.utils.llm_client import LLMClient
from teachkg.stage1_alignment.triplet_extract import (
    Triplet,
    TripletExtractor,
    build_flat_triplet_records,
    dedupe_triplets,
    filter_delta_triplets,
    load_course_context,
    rank_llm_fallback_candidates,
)
from teachkg.textbook_kg import (
    TextbookKG,
    TextbookSubgraphRetriever,
    format_subgraph_for_prompt,
    relations_to_triplets,
)
from teachkg.textbook_kg.lecture_assign import (
    CueAssignMeta,
    assign_textbook_triplets_to_cues,
    retrieve_lecture_subgraph,
    supplement_textbook_for_cue,
)
from teachkg.textbook_kg.entity_registry import EntityRegistry
from teachkg.textbook_kg.theorem_edges import augment_textbook_kg
from teachkg.utils.io import load_jsonl, save_jsonl

logger = logging.getLogger(__name__)


@dataclass
class CueCheckResult:
    passed: bool = True
    reject_reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"passed": self.passed, "reject_reason": self.reject_reason}


@dataclass
class PreparedCue:
    cue: VideoSegment
    check: CueCheckResult = field(default_factory=CueCheckResult)
    ppt_frame_path: str = ""
    ppt_page_index: int | None = None
    extract_text: str = ""
    triplets: list[Triplet] = field(default_factory=list)
    triplet_error: str = ""
    triplet_validation: dict[str, Any] = field(default_factory=dict)
    textbook_subgraph: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = self.cue.to_dict()
        stage1: dict[str, Any] = {
            **self.check.to_dict(),
            "triplet_count": len(self.triplets),
        }
        if self.extract_text and self.extract_text != self.cue.asr_text.strip():
            stage1["extract_text"] = self.extract_text
        if self.triplet_error:
            stage1["triplet_error"] = self.triplet_error
        if self.triplet_validation:
            stage1["triplet_validation"] = self.triplet_validation
        if self.textbook_subgraph:
            stage1["textbook_subgraph"] = self.textbook_subgraph
        data["stage1"] = stage1
        if self.triplets:
            data["triplets"] = [t.to_dict() for t in self.triplets]
        if self.ppt_frame_path:
            data.setdefault("extra", {})["ppt_frame_path"] = self.ppt_frame_path
        if self.ppt_page_index is not None:
            data.setdefault("extra", {})["ppt_page_index"] = self.ppt_page_index
        return data


class Stage1PreparePipeline:
    """规则校验 + Stage 0 OCR 帧 + LLM 三元组抽取。"""

    def __init__(
        self,
        config: TeachKGConfig,
        project_root: Path | None = None,
        mock: bool = False,
    ) -> None:
        self.config = config
        self.project_root = project_root or Path(__file__).resolve().parents[2]
        self.mock = mock
        s1 = config.get("stage1", default={})

        self.use_existing = s1.get("use_existing_artifacts", True)
        self.input_filename = s1.get("input_filename", "cues.jsonl")
        self.output_filename = s1.get("output_filename", "filtered_cues.jsonl")
        self.rejected_filename = s1.get("rejected_filename", "rejected_cues.jsonl")
        self.triplets_filename = s1.get("triplets_filename", "triplets.jsonl")
        llm_only_cfg = s1.get("llm_only", {})
        self.llm_only_enabled = llm_only_cfg.get("enabled", True)
        self.llm_only_triplets_filename = llm_only_cfg.get(
            "triplets_filename", "llm_only/triplets.jsonl"
        )
        self.sync_active_triplets = llm_only_cfg.get("sync_active_triplets", True)

        textbook_cfg = s1.get("textbook_kg", {})
        self.textbook_kg_enabled = textbook_cfg.get("enabled", False)
        self.textbook_include_in_output = textbook_cfg.get("extract", {}).get(
            "include_textbook_in_output", True
        )
        self.textbook_dedupe_delta = textbook_cfg.get("extract", {}).get(
            "dedupe_against_textbook", True
        )
        self.textbook_conceptual_focus = textbook_cfg.get("extract", {}).get(
            "conceptual_focus", True
        )
        self.textbook_max_delta_per_cue = int(
            textbook_cfg.get("extract", {}).get("max_delta_per_cue", 6)
        )
        self.textbook_zero_fallback = textbook_cfg.get("extract", {}).get(
            "zero_coverage_fallback", True
        )
        self.textbook_thin_fallback = textbook_cfg.get("extract", {}).get(
            "thin_coverage_fallback", True
        )
        self.textbook_thin_ratio = float(
            textbook_cfg.get("extract", {}).get("thin_coverage_ratio", 0.55)
        )
        self.textbook_thin_min_llm = int(
            textbook_cfg.get("extract", {}).get("thin_coverage_min_llm", 3)
        )
        self.textbook_llm_fallback_max = int(
            textbook_cfg.get("extract", {}).get("llm_fallback_max", 5)
        )
        self.textbook_hybrid_prompt = textbook_cfg.get("extract", {}).get(
            "prompt", "teaching/subgraph_hybrid_extract.txt"
        )
        registry_cfg = textbook_cfg.get("entity_registry", {})
        self.textbook_link_delta = registry_cfg.get("link_delta_entities", True)
        self.textbook_registry_path = registry_cfg.get("output_path", "")
        subgraph_cfg = textbook_cfg.get("subgraph", {})
        self.textbook_min_edges_per_cue = int(
            subgraph_cfg.get("min_edges_per_cue", 1)
        )
        self.textbook_include_theorems = subgraph_cfg.get("include_theorem_edges", True)
        self.textbook_lecture_dedupe = subgraph_cfg.get("lecture_dedupe_textbook", True)
        self.textbook_retriever: TextbookSubgraphRetriever | None = None
        self.textbook_entity_registry: EntityRegistry | None = None
        self.textbook_tb_path: Path | None = None
        if self.textbook_kg_enabled:
            tb_path = self.project_root / textbook_cfg.get(
                "path", "data/textbook/CS2501-离散数学（数理逻辑与集合论）"
            )
            self.textbook_tb_path = tb_path
            textbook_kg = TextbookKG.load(
                tb_path,
                entity_file=textbook_cfg.get("entity_file", "entity_final.json"),
                relations_file=textbook_cfg.get("relations_file", "relations_final.json"),
                importance_file=textbook_cfg.get("importance_file", "entity_sorted.json"),
            )
            if self.textbook_include_theorems:
                textbook_kg = augment_textbook_kg(textbook_kg)
            self.textbook_entity_registry = EntityRegistry.from_textbook_kg(textbook_kg)
            registry_out = registry_cfg.get("output_path") or str(
                tb_path / "entity_registry.json"
            )
            if registry_out:
                self.textbook_entity_registry.save(self.project_root / registry_out)
            self.textbook_retriever = TextbookSubgraphRetriever(
                textbook_kg,
                max_hops=subgraph_cfg.get("max_hops", 2),
                max_edges_per_cue=subgraph_cfg.get("max_edges_per_cue", 18),
                max_edges_per_lecture=subgraph_cfg.get("max_edges_per_lecture", 60),
                max_seed_entities=subgraph_cfg.get("max_seed_entities", 20),
                lecture_min_relation_score=float(
                    subgraph_cfg.get("lecture_min_relation_score", 3.0)
                ),
                lecture_dynamic_cap=subgraph_cfg.get("lecture_dynamic_cap", True),
                lecture_edges_per_cue_cap=float(
                    subgraph_cfg.get("lecture_edges_per_cue_cap", 7.0)
                ),
                lecture_embedding_link_min_score=subgraph_cfg.get(
                    "lecture_embedding_link_min_score"
                ),
                embedding_link_enabled=subgraph_cfg.get("embedding_link_enabled", False),
                embedding_link_top_k=subgraph_cfg.get("embedding_link_top_k", 5),
                embedding_link_min_score=subgraph_cfg.get("embedding_link_min_score", 0.82),
                embedder_model=subgraph_cfg.get(
                    "embedder_model", "shibing624/text2vec-base-multilingual"
                ),
                embedding_cache_enabled=subgraph_cfg.get("embedding_cache_enabled", True),
                textbook_base_path=tb_path,
            )
            if self.textbook_kg_enabled:
                self.sync_active_triplets = llm_only_cfg.get("sync_active_triplets", False)

        rules = s1.get("rules", {})
        self.require_clip = rules.get("require_clip", True)
        self.min_text_chars = rules.get("min_text_chars", 5)

        ppt_cfg = s1.get("ppt_frame", {})
        self.ppt_frame_enabled = ppt_cfg.get("enabled", True)
        self.ppt_frame_source = ppt_cfg.get("source", "stage0_ocr")
        self.legacy_ppt_frame_subdir = ppt_cfg.get("output_subdir", "ppt_frames")
        self.min_page_duration_sec = ppt_cfg.get("min_page_duration_sec", 1.0)

        self.llm_cfg = config.get("llm", default={})
        triplet_cfg = s1.get("triplet_extract", {})
        self.triplet_enabled = triplet_cfg.get("enabled", True)
        validate_cfg = triplet_cfg.get("validate", {})
        retry_cfg = validate_cfg.get("retry", {})
        preprocess_cfg = s1.get("text_preprocess", {})

        extract_client = self._make_llm_client(
            api_key=triplet_cfg.get("api_key"),
            base_url=triplet_cfg.get("base_url"),
            model=triplet_cfg.get("llm_model"),
        )
        validate_client = (
            self._make_llm_client(model=validate_cfg.get("llm_model"))
            if validate_cfg.get("llm_model")
            else extract_client
        )
        preprocess_client = self._make_llm_client(
            api_key=preprocess_cfg.get("llm", {}).get("api_key"),
            base_url=preprocess_cfg.get("llm", {}).get("base_url"),
            model=preprocess_cfg.get("llm", {}).get("llm_model"),
        )

        self.text_preprocessor = CueTextPreprocessor(
            enabled=preprocess_cfg.get("enabled", True),
            rule_options=preprocess_cfg.get("rules", {}),
            llm_enabled=preprocess_cfg.get("llm", {}).get("enabled", False),
            llm_prompt=preprocess_cfg.get("llm", {}).get("prompt", "teaching/cue_text_preprocess.txt"),
            llm_client=preprocess_client,
            temperature=preprocess_cfg.get("llm", {}).get("temperature", 0.1),
            mock=mock,
        )
        self.triplet_extractor: TripletExtractor | None = None
        if self.triplet_enabled:
            self.triplet_extractor = TripletExtractor(
                llm_client=extract_client,
                validate_client=validate_client,
                prompt_name=triplet_cfg.get("prompt", "teaching/subgraph_extract.txt"),
                temperature=triplet_cfg.get("temperature", 0.1),
                max_triplets_per_cue=triplet_cfg.get("max_triplets_per_cue", 30),
                mock=mock,
                validate_enabled=validate_cfg.get("enabled", True),
                validate_prompt=validate_cfg.get("prompt", "teaching/triplet_validate.txt"),
                retry_validate_prompt=validate_cfg.get("retry_prompt"),
                validate_temperature=validate_cfg.get("temperature", 0.0),
                retry_enabled=retry_cfg.get("enabled", True),
                retry_fix_enabled=retry_cfg.get("fix_enabled", True),
                retry_reextract_enabled=retry_cfg.get("reextract_enabled", True),
                retry_fix_fallback_reextract=retry_cfg.get("fix_fallback_reextract", True),
                max_fix_attempts=retry_cfg.get("max_fix_attempts", 3),
                max_reextract_attempts=retry_cfg.get("max_reextract_attempts", 3),
                fix_prompt=retry_cfg.get("fix_prompt", "teaching/triplet_fix.txt"),
                reextract_prompt=retry_cfg.get("reextract_prompt", "teaching/triplet_reextract.txt"),
                hybrid_prompt_name=self.textbook_hybrid_prompt,
                conceptual_focus=self.textbook_conceptual_focus if self.textbook_kg_enabled else False,
                max_hybrid_delta_per_cue=self.textbook_max_delta_per_cue if self.textbook_kg_enabled else 12,
            )

    def _make_llm_client(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ) -> LLMClient:
        from teachkg.utils.llm_client import llm_settings_from_config

        settings = llm_settings_from_config(
            self.llm_cfg,
            api_key=api_key,
            base_url=base_url,
            model=model,
        )
        return LLMClient(**settings)

    @property
    def kg_dir(self) -> Path:
        return Path(self.config.get("project", "kg_dir", default="data/kg"))

    @staticmethod
    def _load_triplets_excluding_lectures(
        path: Path,
        exclude_lectures: set[str] | None,
    ) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        if not exclude_lectures:
            return load_jsonl(path)
        return [
            r
            for r in load_jsonl(path)
            if str(r.get("lecture_id", "")) not in exclude_lectures
        ]

    @staticmethod
    def _tag_llm_only_triplets(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        tagged: list[dict[str, Any]] = []
        for row in records:
            item = dict(row)
            item["extract_source"] = "llm_only"
            tagged.append(item)
        return tagged

    def _check_rules(self, cue: VideoSegment) -> CueCheckResult:
        text = cue.asr_text.strip()
        if len(text) < self.min_text_chars:
            return CueCheckResult(passed=False, reject_reason="text_too_short")

        if self.require_clip:
            clip = resolve_path(cue.clip_path, self.project_root) if cue.clip_path else None
            if not clip or not clip.is_file():
                return CueCheckResult(passed=False, reject_reason="clip_missing")
        return CueCheckResult(passed=True)

    def _prepare_cue(
        self,
        cue: VideoSegment,
        course_id: str,
        pages_by_lecture: dict[str, list],
    ) -> PreparedCue:
        check = self._check_rules(cue)
        ppt_frame_path = ""
        ppt_page_index: int | None = None

        if self.ppt_frame_enabled and check.passed and self.ppt_frame_source == "stage0_ocr":
            pages = pages_by_lecture.get(cue.lecture_id, [])
            ppt_page_index = page_index_for_cue(cue, pages)
            ppt_frame_path = resolve_stage0_ppt_frame(
                self.config.segments_dir,
                course_id,
                cue,
                pages,
                self.project_root,
            )
            if ppt_page_index is not None and not ppt_frame_path:
                logger.warning(
                    "Stage 0 OCR frame missing for cue %s (page %d)",
                    cue.cue_id,
                    ppt_page_index,
                )

        return PreparedCue(
            cue=cue,
            check=check,
            ppt_frame_path=ppt_frame_path,
            ppt_page_index=ppt_page_index,
        )

    def _link_delta_triplets(self, triplets: list[Triplet], cue_text: str) -> list[Triplet]:
        if not self.textbook_link_delta or not self.textbook_entity_registry:
            return triplets
        linked: list[Triplet] = []
        for triplet in triplets:
            if triplet.extract_source != "lecture_delta":
                linked.append(triplet)
                continue
            sub, obj = self.textbook_entity_registry.link_triplet(
                triplet.subject,
                triplet.object,
                cue_text=cue_text,
            )
            triplet.subject = sub
            triplet.object = obj
            linked.append(triplet)
        return linked

    def _load_llm_baseline_by_cue(
        self,
        course_id: str,
        lecture_id: str,
    ) -> dict[str, list[dict[str, Any]]]:
        path = self.kg_dir / course_id / self.llm_only_triplets_filename
        if not path.is_file():
            return {}
        by_cue: dict[str, list[dict[str, Any]]] = {}
        for row in load_jsonl(path):
            if str(row.get("lecture_id")) != str(lecture_id):
                continue
            cid = str(row.get("cue_id", ""))
            if cid:
                by_cue.setdefault(cid, []).append(row)
        return by_cue

    def _llm_supplement_triplets(
        self,
        merged: list[Triplet],
        rows: list[dict[str, Any]],
        *,
        cue_text: str,
        textbook_keys: set[tuple[str, str, str, str]],
        max_add: int,
    ) -> list[Triplet]:
        if max_add <= 0 or not rows:
            return []
        existing = {t.dedupe_key for t in merged} | textbook_keys
        ranked_rows = rank_llm_fallback_candidates(
            rows,
            cue_text=cue_text,
            merged=merged,
            existing_keys=existing,
        )
        out: list[Triplet] = []
        for row in ranked_rows:
            if len(out) >= max_add:
                break
            triplet = Triplet.from_dict(row)
            if not triplet or triplet.dedupe_key in existing:
                continue
            triplet.extract_source = "llm_fallback"
            out.append(triplet)
            existing.add(triplet.dedupe_key)
        return out

    def _apply_coverage_fallback(
        self,
        merged: list[Triplet],
        llm_rows: list[dict[str, Any]],
        *,
        cue_text: str,
        textbook_keys: set[tuple[str, str, str, str]],
    ) -> tuple[list[Triplet], int, int]:
        """零覆盖或薄覆盖时从 LLM 基线补概念边。返回 (merged, zero_used, thin_used)。"""
        zero_used = 0
        thin_used = 0
        if not self.textbook_zero_fallback or not llm_rows:
            return merged, zero_used, thin_used

        if not merged:
            supplements = self._llm_supplement_triplets(
                merged,
                llm_rows,
                cue_text=cue_text,
                textbook_keys=textbook_keys,
                max_add=self.textbook_llm_fallback_max,
            )
            zero_used = len(supplements)
            return dedupe_triplets(merged + supplements), zero_used, thin_used

        if not self.textbook_thin_fallback:
            return merged, zero_used, thin_used

        llm_n = len(llm_rows)
        hybrid_n = len(merged)
        threshold = llm_n * self.textbook_thin_ratio
        if llm_n >= self.textbook_thin_min_llm and hybrid_n < threshold:
            need = min(
                self.textbook_llm_fallback_max,
                max(1, llm_n - hybrid_n),
            )
            supplements = self._llm_supplement_triplets(
                merged,
                llm_rows,
                cue_text=cue_text,
                textbook_keys=textbook_keys,
                max_add=need,
            )
            thin_used = len(supplements)
            merged = dedupe_triplets(merged + supplements)
        return merged, zero_used, thin_used

    def _extract_hybrid_lecture(
        self,
        items: list[PreparedCue],
        course_id: str,
        course_context: str,
    ) -> None:
        """讲次级教材边去重 + 逐 cue 增量抽取。"""
        if not self.triplet_extractor or not self.textbook_retriever:
            return

        for prepared in items:
            if not prepared.extract_text:
                prepared.extract_text = self.text_preprocessor.process(
                    prepared.cue.asr_text,
                    course_context,
                )

        active = [p for p in items if p.extract_text]
        if not active:
            return

        cue_texts = {p.cue.cue_id: p.extract_text for p in active}
        cue_meta = {
            p.cue.cue_id: CueAssignMeta(
                text=p.extract_text,
                duration_sec=max(0.0, p.cue.end_sec - p.cue.start_sec),
                ppt_page_index=p.ppt_page_index,
            )
            for p in active
        }
        _, lecture_relations = retrieve_lecture_subgraph(
            self.textbook_retriever,
            list(cue_texts.values()),
        )
        lecture_triplets = relations_to_triplets(lecture_relations)
        assigned = assign_textbook_triplets_to_cues(
            lecture_triplets,
            cue_meta,
            retriever=self.textbook_retriever,
            min_edges_per_cue=self.textbook_min_edges_per_cue,
        )
        global_used_tb_keys = {
            t.dedupe_key for edges in assigned.values() for t in edges
        }
        llm_by_cue: dict[str, list[dict[str, Any]]] = {}
        if (self.textbook_zero_fallback or self.textbook_thin_fallback) and active:
            llm_by_cue = self._load_llm_baseline_by_cue(
                course_id, active[0].cue.lecture_id
            )
        textbook_keys = {t.dedupe_key for t in lecture_triplets}

        for prepared in active:
            cue_id = prepared.cue.cue_id
            cue_tb = list(assigned.get(cue_id, []))
            if not cue_tb:
                extra = supplement_textbook_for_cue(
                    cue_meta[cue_id],
                    pool=lecture_triplets,
                    exclude_keys=global_used_tb_keys,
                    retriever=self.textbook_retriever,
                )
                if extra:
                    cue_tb.extend(extra)
                    global_used_tb_keys.update(t.dedupe_key for t in extra)
                    assigned[cue_id] = cue_tb
            cue_subgraph = self.textbook_retriever.retrieve(prepared.extract_text)
            subgraph_json = format_subgraph_for_prompt(
                self.textbook_retriever.kg,
                seed_entities=cue_subgraph.seed_entities,
                entities=cue_subgraph.entities,
                relations=cue_subgraph.relations,
            )

            delta_result = self.triplet_extractor.extract_hybrid(
                prepared.extract_text,
                course_context,
                textbook_subgraph_json=subgraph_json,
                textbook_triplets=lecture_triplets,
                dedupe_against_textbook=self.textbook_dedupe_delta,
            )
            delta_triplets = filter_delta_triplets(
                self._link_delta_triplets(delta_result.triplets, prepared.extract_text),
                prepared.extract_text,
                conceptual_focus=self.textbook_conceptual_focus,
            )

            merged: list[Triplet] = []
            if self.textbook_include_in_output:
                merged.extend(cue_tb)
            merged.extend(delta_triplets)
            merged = dedupe_triplets(merged)
            merged, zero_fallback, thin_fallback = self._apply_coverage_fallback(
                merged,
                llm_by_cue.get(cue_id, []),
                cue_text=prepared.extract_text,
                textbook_keys=textbook_keys,
            )
            prepared.triplets = merged
            prepared.triplet_error = delta_result.error
            validation_payload: dict[str, Any] = {
                "lecture_textbook_pool": len(lecture_triplets),
                "assigned_textbook_edges": len(cue_tb),
                "textbook_edges": len(cue_tb),
                "lecture_delta_edges": len(delta_triplets),
                "llm_fallback_edges": zero_fallback + thin_fallback,
                "llm_zero_fallback_edges": zero_fallback,
                "llm_thin_fallback_edges": thin_fallback,
            }
            if delta_result.validation:
                validation_payload.update(delta_result.validation.to_dict())
            prepared.triplet_validation = validation_payload
            prepared.textbook_subgraph = {
                **cue_subgraph.to_dict(),
                "lecture_pool_edges": len(lecture_triplets),
                "assigned_edges": len(cue_tb),
            }
            logger.info(
                "Hybrid lecture extract for cue %s: assigned_tb=%d delta=%d total=%d (pool=%d)",
                prepared.cue.cue_id,
                len(cue_tb),
                len(delta_triplets),
                len(prepared.triplets),
                len(lecture_triplets),
            )

        for prepared in items:
            if prepared not in active:
                prepared.triplet_error = "empty_text_after_preprocess"

    def _extract_triplets(
        self,
        prepared: PreparedCue,
        course_id: str,
        course_context: str,
    ) -> None:
        if not self.triplet_enabled or not self.triplet_extractor or not prepared.check.passed:
            return

        prepared.extract_text = self.text_preprocessor.process(
            prepared.cue.asr_text,
            course_context,
        )
        if not prepared.extract_text:
            prepared.triplet_error = "empty_text_after_preprocess"
            logger.warning("Empty text after preprocess for cue %s", prepared.cue.cue_id)
            return

        if self.textbook_retriever:
            subgraph = self.textbook_retriever.retrieve(prepared.extract_text)
            prepared.textbook_subgraph = subgraph.to_dict()
            textbook_triplets = relations_to_triplets(subgraph.relations)
            subgraph_json = format_subgraph_for_prompt(
                self.textbook_retriever.kg,
                seed_entities=subgraph.seed_entities,
                entities=subgraph.entities,
                relations=subgraph.relations,
            )

            delta_result = self.triplet_extractor.extract_hybrid(
                prepared.extract_text,
                course_context,
                textbook_subgraph_json=subgraph_json,
                textbook_triplets=textbook_triplets,
                dedupe_against_textbook=self.textbook_dedupe_delta,
            )
            delta_triplets = self._link_delta_triplets(
                delta_result.triplets, prepared.extract_text
            )
            merged: list[Triplet] = []
            if self.textbook_include_in_output:
                merged.extend(textbook_triplets)
            merged.extend(delta_triplets)
            prepared.triplets = dedupe_triplets(merged)
            prepared.triplet_error = delta_result.error
            validation_payload: dict[str, Any] = {}
            if delta_result.validation:
                validation_payload = delta_result.validation.to_dict()
            validation_payload["textbook_edges"] = len(textbook_triplets)
            validation_payload["lecture_delta_edges"] = len(delta_triplets)
            prepared.triplet_validation = validation_payload
            logger.info(
                "Hybrid extract for cue %s: textbook=%d delta=%d total=%d",
                prepared.cue.cue_id,
                len(textbook_triplets),
                len(delta_result.triplets),
                len(prepared.triplets),
            )
            if delta_result.error:
                logger.warning(
                    "Hybrid delta extraction failed for cue %s: %s",
                    prepared.cue.cue_id,
                    delta_result.error,
                )
            return

        result = self.triplet_extractor.extract(prepared.extract_text, course_context)
        prepared.triplets = result.triplets
        prepared.triplet_error = result.error
        if result.validation:
            prepared.triplet_validation = result.validation.to_dict()
        if result.ok:
            logger.info(
                "Extracted %d triplets for cue %s",
                len(prepared.triplets),
                prepared.cue.cue_id,
            )
        else:
            logger.warning(
                "Triplet extraction failed for cue %s: %s",
                prepared.cue.cue_id,
                result.error,
            )

    @staticmethod
    def _cleanup_legacy_ppt_frames(frame_dir: Path) -> None:
        if frame_dir.is_dir():
            shutil.rmtree(frame_dir)
            logger.info("Removed legacy ppt_frames dir: %s", frame_dir)

    def _should_skip(self, output_path: Path, rejected_path: Path, triplets_path: Path) -> bool:
        if not self.use_existing:
            return False
        if not output_path.exists() or not rejected_path.exists():
            return False
        if self.triplet_enabled and not triplets_path.exists():
            return False
        return True

    def run(self, course_id: str, lecture_ids: list[str] | None = None) -> Path:
        input_path = self.config.segments_dir / course_id / self.input_filename
        output_dir = self.config.processed_dir / course_id
        output_path = output_dir / self.output_filename
        rejected_path = output_dir / self.rejected_filename
        report_path = output_dir / "stage1_report.json"
        triplets_path = self.kg_dir / course_id / self.triplets_filename
        llm_only_path = self.kg_dir / course_id / self.llm_only_triplets_filename
        rerun_lectures = {str(x) for x in lecture_ids} if lecture_ids else None

        if not input_path.exists():
            raise FileNotFoundError(f"Stage 0 cues not found: {input_path}")

        if self._should_skip(output_path, rejected_path, triplets_path) and not rerun_lectures:
            logger.info("Reuse existing Stage 1 output: %s", output_path)
            return output_path

        raw = load_jsonl(input_path)
        cues = [VideoSegment.from_dict(row) for row in raw]
        if rerun_lectures:
            cues = [c for c in cues if c.lecture_id in rerun_lectures]
            if not cues:
                raise ValueError(f"No cues matched lecture_ids={lecture_ids}")
            logger.info(
                "Stage 1 incremental: processing %d cues for lecture(s) %s",
                len(cues),
                sorted(rerun_lectures),
            )

        logger.info("Stage 1: preparing %d cues from %s", len(cues), input_path)

        pages_by_lecture: dict[str, list] = {}
        for lecture_id in {c.lecture_id for c in cues}:
            lecture_cues = [c for c in cues if c.lecture_id == lecture_id]
            duration = max((c.end_sec for c in lecture_cues), default=0.0)
            pages_by_lecture[lecture_id] = load_ppt_pages(
                self.config.segments_dir,
                course_id,
                lecture_id,
                duration,
                min_page_duration_sec=self.min_page_duration_sec,
            )

        course_context = load_course_context(
            self.config.workspace_dir,
            course_id,
            cue=cues[0] if cues else None,
        )

        prepared = [self._prepare_cue(cue, course_id, pages_by_lecture) for cue in cues]

        if self.textbook_retriever and self.textbook_lecture_dedupe:
            by_lecture: dict[str, list[PreparedCue]] = {}
            for item in prepared:
                if not item.check.passed or not self.triplet_enabled:
                    continue
                by_lecture.setdefault(item.cue.lecture_id, []).append(item)
            for lecture_items in by_lecture.values():
                self._extract_hybrid_lecture(lecture_items, course_id, course_context)
        else:
            for item in prepared:
                self._extract_triplets(item, course_id, course_context)

        passed = [p for p in prepared if p.check.passed]
        rejected = [p for p in prepared if not p.check.passed]

        def _lecture_of_row(row: dict[str, Any]) -> str:
            return str(row.get("lecture_id", ""))

        existing_passed: list[dict[str, Any]] = []
        existing_rejected: list[dict[str, Any]] = []
        existing_triplets: list[dict[str, Any]] = []
        existing_llm_only: list[dict[str, Any]] = []
        if rerun_lectures:
            if output_path.is_file():
                existing_passed = [
                    r for r in load_jsonl(output_path) if _lecture_of_row(r) not in rerun_lectures
                ]
            if rejected_path.is_file():
                existing_rejected = [
                    r for r in load_jsonl(rejected_path) if _lecture_of_row(r) not in rerun_lectures
                ]
            if self.sync_active_triplets or self.textbook_kg_enabled:
                existing_triplets = self._load_triplets_excluding_lectures(
                    triplets_path, rerun_lectures
                )
            if self.llm_only_enabled:
                existing_llm_only = self._load_triplets_excluding_lectures(
                    llm_only_path, rerun_lectures
                )

        output_dir.mkdir(parents=True, exist_ok=True)
        merged_passed = existing_passed + [p.to_dict() for p in passed]
        merged_rejected = existing_rejected + [p.to_dict() for p in rejected]
        save_jsonl(output_path, merged_passed)
        save_jsonl(rejected_path, merged_rejected)

        extract_mode = "hybrid" if self.textbook_kg_enabled else "llm_only"
        new_triplets: list[dict[str, Any]] = []
        for p in passed:
            new_triplets.extend(
                build_flat_triplet_records(
                    p.cue,
                    p.triplets,
                    course_id=course_id,
                    ppt_frame_path=p.ppt_frame_path,
                    ppt_page_index=p.ppt_page_index,
                    extract_mode=extract_mode,
                    ground_textbook=not self.textbook_kg_enabled,
                )
            )

        if self.llm_only_enabled and not self.textbook_kg_enabled:
            llm_only_triplets = self._tag_llm_only_triplets(
                list(existing_llm_only if rerun_lectures else []) + new_triplets
            )
            llm_only_path.parent.mkdir(parents=True, exist_ok=True)
            save_jsonl(llm_only_path, llm_only_triplets)
            flat_triplets = llm_only_triplets
        elif self.textbook_kg_enabled:
            flat_triplets = list(existing_triplets) + new_triplets
        else:
            flat_triplets = list(existing_triplets) + new_triplets

        if self.textbook_kg_enabled or (self.sync_active_triplets and not rerun_lectures):
            triplets_path.parent.mkdir(parents=True, exist_ok=True)
            save_jsonl(triplets_path, flat_triplets)
        elif self.sync_active_triplets and rerun_lectures:
            if self.textbook_kg_enabled:
                active_triplets = list(existing_triplets) + new_triplets
            else:
                active_triplets = list(existing_triplets) + self._tag_llm_only_triplets(new_triplets)
            triplets_path.parent.mkdir(parents=True, exist_ok=True)
            save_jsonl(triplets_path, active_triplets)
            flat_triplets = active_triplets

        total_triplets = sum(len(p.triplets) for p in passed)
        triplet_validation_totals = {"pass": 0, "revise": 0, "discard": 0}
        for p in passed:
            counts = (p.triplet_validation or {}).get("counts", {})
            for key in triplet_validation_totals:
                triplet_validation_totals[key] += int(counts.get(key, 0))
        triplet_errors = [
            {"cue_id": p.cue.cue_id, "error": p.triplet_error}
            for p in passed
            if p.triplet_error
        ]

        prev_report: dict[str, Any] = {}
        if report_path.is_file():
            try:
                prev_report = json.loads(report_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                prev_report = {}

        report = {
            "course_id": course_id,
            "input_count": len(merged_passed) + len(merged_rejected),
            "passed_count": len(merged_passed),
            "rejected_count": len(merged_rejected),
            "ppt_frame_source": self.ppt_frame_source if self.ppt_frame_enabled else "disabled",
            "triplet_extract_enabled": self.triplet_enabled,
            "triplet_count": len(flat_triplets),
            "triplet_validation": triplet_validation_totals,
            "triplet_errors": triplet_errors,
            "filtered_cues_path": str(output_path),
            "rejected_cues_path": str(rejected_path),
            "triplets_path": str(triplets_path),
            "llm_only_triplets_path": str(llm_only_path) if self.llm_only_enabled else None,
            "extract_source_active": (
                "textbook_hybrid"
                if self.textbook_kg_enabled
                else ("llm_only" if self.sync_active_triplets else None)
            ),
            "textbook_kg_enabled": self.textbook_kg_enabled,
            "incremental_lectures": sorted(rerun_lectures) if rerun_lectures else None,
            "rejected": [
                {"cue_id": p.cue.cue_id, "reason": p.check.reject_reason}
                for p in rejected
            ],
        }
        if rerun_lectures and prev_report:
            report["last_incremental"] = {
                "lectures": sorted(rerun_lectures),
                "new_triplets": total_triplets,
            }
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

        if self.ppt_frame_enabled and self.ppt_frame_source == "stage0_ocr":
            self._cleanup_legacy_ppt_frames(output_dir / self.legacy_ppt_frame_subdir)

        logger.info(
            "Stage 1 done: %d passed → %s, %d triplets (total %d) → %s, %d rejected → %s",
            len(merged_passed),
            output_path,
            total_triplets,
            len(flat_triplets),
            triplets_path,
            len(merged_rejected),
            rejected_path,
        )
        return output_path


Stage1AlignmentPipeline = Stage1PreparePipeline
