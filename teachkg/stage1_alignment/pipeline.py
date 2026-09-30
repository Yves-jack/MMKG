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
    load_ppt_ocr_texts,
    load_ppt_pages,
    page_index_for_cue,
    resolve_stage0_ppt_frame,
    stage0_ppt_ocr_cache_path,
)
from teachkg.stage1_alignment.text_preprocess import CueTextPreprocessor
from teachkg.utils.artifact_fingerprint import (
    can_reuse,
    file_identity,
    hash_jsonl_rows,
    save_meta,
)
from teachkg.utils.llm_client import LLMClient
from teachkg.stage1_alignment.triplet_extract import (
    Triplet,
    TripletExtractor,
    build_char_half_windows,
    build_flat_triplet_records,
    build_textbook_spo_keys,
    dedupe_triplets,
    filter_delta_triplets,
    filter_deltas_against_textbook,
    format_cross_cue_source_span,
    is_cross_cue_extract_source,
    load_course_context,
    overlaps_textbook_spo,
    rank_llm_fallback_candidates,
)
from teachkg.textbook_kg.entity_registry import (
    EntityRegistry,
    format_known_entities_for_prompt,
)
from teachkg.textbook_kg.convert import (
    format_subgraph_for_prompt,
    relations_to_triplets,
)
from teachkg.textbook_kg.loader import TextbookKG
from teachkg.textbook_kg.subgraph import TextbookSubgraphRetriever
from teachkg.stage1_alignment.corrected_textbook import (
    correction_basis_from_stage1,
)
from teachkg.textbook_kg.theorem_edges import augment_textbook_kg
from teachkg.utils.io import exclusive_dir_lock, load_jsonl, save_jsonl

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
    ppt_ocr_text: str = ""
    extract_text: str = ""
    # 双阶段 A 通畅结果；B 为 extract_text（可跑 focus 或复用存量）
    fluency_text: str = ""
    # 讲次级 B 产出的本讲大纲（同讲各 cue 共享）
    lecture_outline: list[str] = field(default_factory=list)
    # 流水线接入：挂载已有 extract_text，作 B 复用（不重跑 B）
    prior_extract_text: str = ""
    preprocess_ab_mode: str = ""
    # 实际用于子图/三元组抽取的文本来源：asr | preprocessed
    extract_source_used: str = ""
    triplets: list[Triplet] = field(default_factory=list)
    triplet_error: str = ""
    triplet_validation: dict[str, Any] = field(default_factory=dict)
    textbook_subgraph: dict[str, Any] = field(default_factory=dict)
    # 可选：已有课堂核实结果；use_corrected_textbook 时作增量基座
    textbook_correction: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = self.cue.to_dict()
        stage1: dict[str, Any] = {
            **self.check.to_dict(),
            "triplet_count": len(self.triplets),
        }
        raw = (self.cue.asr_text or "").strip()
        et_stripped = (self.extract_text or "").strip()
        src = self.extract_source_used or ""

        if self.triplet_error == "empty_text_after_preprocess":
            status = "empty_after_preprocess"
            note = "预处理后无保留可用知识内容；抽取侧无可用文本。"
            stage1["extract_text"] = et_stripped
        elif not raw and not et_stripped:
            status = "empty_source"
            note = "原始 asr_text 为空，无预处理文本。"
            stage1["extract_text"] = ""
        elif et_stripped and et_stripped == raw:
            status = "unchanged"
            note = "预处理未改动原文。"
            stage1["extract_text"] = et_stripped
        elif et_stripped and et_stripped != raw:
            status = "changed"
            note = "预处理已改动原文；extract_text 为预处理结果。"
            stage1["extract_text"] = et_stripped
        else:
            status = "unavailable"
            note = "尚未执行文本预处理（或结果未回填）。"

        if src == "asr":
            note = (
                f"{note} 抽取使用 asr_text"
                + ("，并拼接 PPT OCR。" if self.ppt_ocr_text.strip() else "。")
            )
        elif src == "preprocessed":
            note = (
                f"{note} 抽取使用预处理文本"
                + ("，并拼接 PPT OCR。" if self.ppt_ocr_text.strip() else "。")
            )

        stage1["text_preprocess_status"] = status
        stage1["text_preprocess_note"] = note
        if self.lecture_outline:
            stage1["lecture_outline"] = list(self.lecture_outline)
        if self.fluency_text.strip():
            stage1["fluency_text"] = self.fluency_text.strip()
        if self.preprocess_ab_mode:
            stage1["preprocess_ab_mode"] = self.preprocess_ab_mode
        if src:
            stage1["extract_from"] = src
        if self.ppt_ocr_text.strip():
            stage1["ppt_ocr_chars"] = len(self.ppt_ocr_text.strip())

        if self.triplet_error:
            stage1["triplet_error"] = self.triplet_error
        if self.triplet_validation:
            stage1["triplet_validation"] = self.triplet_validation
        if self.textbook_subgraph:
            stage1["textbook_subgraph"] = self.textbook_subgraph
        if self.textbook_correction:
            stage1["textbook_correction"] = self.textbook_correction
        data["stage1"] = stage1
        if self.triplets:
            data["triplets"] = [t.to_dict() for t in self.triplets]
        if self.ppt_frame_path:
            data.setdefault("extra", {})["ppt_frame_path"] = self.ppt_frame_path
        if self.ppt_page_index is not None:
            data.setdefault("extra", {})["ppt_page_index"] = self.ppt_page_index
        if self.ppt_ocr_text.strip():
            data.setdefault("extra", {})["ppt_ocr_text"] = self.ppt_ocr_text.strip()
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
        self.textbook_dedupe_match = str(
            textbook_cfg.get("extract", {}).get("dedupe_textbook_match", "exact_fullname")
            or "exact_fullname"
        )
        self.textbook_max_delta_per_cue = textbook_cfg.get("extract", {}).get(
            "max_delta_per_cue", None
        )
        if self.textbook_max_delta_per_cue is not None:
            try:
                self.textbook_max_delta_per_cue = int(self.textbook_max_delta_per_cue)
            except (TypeError, ValueError):
                self.textbook_max_delta_per_cue = None
            if self.textbook_max_delta_per_cue is not None and self.textbook_max_delta_per_cue <= 0:
                self.textbook_max_delta_per_cue = None
        self.textbook_delta_words_per_item = int(
            textbook_cfg.get("extract", {}).get("delta_words_per_item", 20) or 0
        )
        self.textbook_delta_min_per_cue = int(
            textbook_cfg.get("extract", {}).get("delta_min_per_cue", 1) or 1
        )
        self.textbook_conceptual_focus = textbook_cfg.get("extract", {}).get(
            "conceptual_focus", True
        )
        self.textbook_completeness_pass = bool(
            textbook_cfg.get("extract", {}).get("delta_completeness_pass", True)
        )
        self.textbook_completeness_prompt = textbook_cfg.get("extract", {}).get(
            "delta_completeness_prompt",
            "stage1/subgraph_hybrid_extract_complete.txt",
        )
        cross_raw = textbook_cfg.get("extract", {}).get("cross_cue_extract", {})
        if isinstance(cross_raw, bool):
            self.cross_cue_enabled = cross_raw
            cross_cfg: dict[str, Any] = {}
        elif isinstance(cross_raw, dict):
            cross_cfg = cross_raw
            self.cross_cue_enabled = bool(cross_cfg.get("enabled", False))
        else:
            cross_cfg = {}
            self.cross_cue_enabled = False
        self.cross_cue_prompt = str(
            cross_cfg.get("prompt", "stage1/subgraph_cross_cue_extract.txt")
        )
        self.cross_cue_max_triples = int(cross_cfg.get("max_triples", 6) or 6)
        # 兼容旧 window 配置：若仍写 window 且无 char_budget，忽略相邻对语义，默认字数窗
        self.cross_cue_char_budget = max(
            1,
            int(cross_cfg.get("char_budget", cross_cfg.get("char_threshold", 1500)) or 1500),
        )
        self.cross_cue_slide = str(cross_cfg.get("slide", "half") or "half").lower()
        kgc_raw = textbook_cfg.get("extract", {}).get("kg_completion", {})
        if isinstance(kgc_raw, bool):
            self.kg_completion_enabled = kgc_raw
            kgc_cfg: dict[str, Any] = {}
        elif isinstance(kgc_raw, dict):
            kgc_cfg = kgc_raw
            self.kg_completion_enabled = bool(kgc_cfg.get("enabled", False))
        else:
            kgc_cfg = {}
            self.kg_completion_enabled = False
        self.kg_completion_prompt = str(
            kgc_cfg.get("prompt", "stage1/subgraph_kg_completion.txt")
        )
        self.kg_completion_validate_prompt = str(
            kgc_cfg.get(
                "validate_prompt", "stage1/triplet_validate_kg_completion.txt"
            )
        )
        _kgc_max = kgc_cfg.get("max_triples", None)
        self.kg_completion_max_triples = (
            None if _kgc_max is None or int(_kgc_max) <= 0 else int(_kgc_max)
        )
        self.textbook_zero_fallback = textbook_cfg.get("extract", {}).get(
            "zero_coverage_fallback", False
        )
        self.textbook_thin_fallback = textbook_cfg.get("extract", {}).get(
            "thin_coverage_fallback", False
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
            "prompt", "stage1/subgraph_hybrid_extract.txt"
        )
        self.textbook_use_corrected = bool(
            textbook_cfg.get("extract", {}).get("use_corrected_textbook", False)
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
        self.textbook_cfg = textbook_cfg
        if self.textbook_kg_enabled:
            tb_path = self.project_root / textbook_cfg.get(
                "path", "data/textbook/CS2501-离散数学（数理逻辑与集合论）"
            )
            self.textbook_tb_path = tb_path
            textbook_kg = TextbookKG.load(
                tb_path,
                entity_file=textbook_cfg.get("entity_file", "entity_final.json"),
                relations_file=textbook_cfg.get("relations_file", "relations_final.json"),
                importance_file=textbook_cfg.get("importance_file", "entity_sorted_ppr.json"),
                importance_bundle_file=textbook_cfg.get(
                    "importance_bundle_file", "importance_bundle.json"
                ),
            )
            if self.textbook_include_theorems:
                textbook_kg = augment_textbook_kg(textbook_kg)
            self.textbook_entity_registry = EntityRegistry.from_textbook_kg(textbook_kg)
            registry_out = registry_cfg.get("output_path") or str(
                tb_path / "entity_registry.json"
            )
            if registry_out:
                self.textbook_entity_registry.save(self.project_root / registry_out)
            seed_filter_cfg = subgraph_cfg.get("seed_llm_filter", {}) or {}
            seed_llm_filter = None
            if seed_filter_cfg.get("enabled", False):
                from teachkg.textbook_kg.seed_filter import SeedLLMFilter

                seed_llm_filter = SeedLLMFilter(
                    enabled=True,
                    prompt=seed_filter_cfg.get("prompt", "stage1/seed_filter.txt"),
                    temperature=float(seed_filter_cfg.get("temperature", 0.1) or 0.1),
                    llm_model=seed_filter_cfg.get("llm_model"),
                    min_candidates=int(seed_filter_cfg.get("min_candidates", 1) or 1),
                    fallback_keep_all_on_empty=bool(
                        seed_filter_cfg.get("fallback_keep_all_on_empty", False)
                    ),
                    fallback_to_alias_on_empty=(
                        seed_filter_cfg["fallback_to_alias_on_empty"]
                        if "fallback_to_alias_on_empty" in seed_filter_cfg
                        else None
                    ),
                    course_context="",
                )
            edge_filter_cfg = subgraph_cfg.get("edge_llm_filter", {}) or {}
            edge_llm_filter = None
            if edge_filter_cfg.get("enabled", False):
                from teachkg.textbook_kg.edge_filter import EdgeLLMFilter

                edge_llm_filter = EdgeLLMFilter(
                    enabled=True,
                    prompt=edge_filter_cfg.get("prompt", "stage1/edge_filter.txt"),
                    temperature=float(edge_filter_cfg.get("temperature", 0.1) or 0.1),
                    llm_model=edge_filter_cfg.get("llm_model"),
                    min_candidates=int(edge_filter_cfg.get("min_candidates", 1) or 1),
                    fallback_keep_all_on_empty=bool(
                        edge_filter_cfg.get("fallback_keep_all_on_empty", False)
                    ),
                    description_max_chars=int(
                        edge_filter_cfg.get("description_max_chars", 60) or 0
                    ),
                    require_classroom_evidence=bool(
                        edge_filter_cfg.get("require_classroom_evidence", True)
                    ),
                    min_evidence_chars=int(
                        edge_filter_cfg.get("min_evidence_chars", 4) or 4
                    ),
                    course_context="",
                )
            kp_cfg = subgraph_cfg.get("knowledge_point_extract", {}) or {}
            knowledge_point_extractor = None
            if kp_cfg.get("enabled", False):
                from teachkg.stage1_alignment.knowledge_points import (
                    KnowledgePointExtractor,
                )

                knowledge_point_extractor = KnowledgePointExtractor(
                    enabled=True,
                    prompt=kp_cfg.get(
                        "prompt", "stage1/knowledge_point_extract.txt"
                    ),
                    temperature=float(kp_cfg.get("temperature", 0.1) or 0.1),
                    llm_model=kp_cfg.get("llm_model"),
                    course_context="",
                )
            self.textbook_retriever = TextbookSubgraphRetriever(
                textbook_kg,
                max_hops=subgraph_cfg.get("max_hops", 2),
                max_edges_per_cue=subgraph_cfg.get("max_edges_per_cue", 18),
                max_edges_per_lecture=subgraph_cfg.get("max_edges_per_lecture", 60),
                max_seed_entities=subgraph_cfg.get("max_seed_entities", 40),
                lecture_min_relation_score=float(
                    subgraph_cfg.get("lecture_min_relation_score", 3.0)
                ),
                cue_min_relation_score=float(
                    subgraph_cfg.get("cue_min_relation_score", 4.0)
                ),
                require_text_anchor=subgraph_cfg.get("require_text_anchor", False),
                require_both_ends_in_candidate_seeds=subgraph_cfg.get(
                    "require_both_ends_in_candidate_seeds", True
                ),
                score_prune_edges=subgraph_cfg.get("score_prune_edges", False),
                lecture_dynamic_cap=subgraph_cfg.get("lecture_dynamic_cap", True),
                lecture_edges_per_cue_cap=float(
                    subgraph_cfg.get("lecture_edges_per_cue_cap", 7.0)
                ),
                lecture_embedding_link_min_score=subgraph_cfg.get(
                    "lecture_embedding_link_min_score"
                ),
                embedding_link_enabled=subgraph_cfg.get("embedding_link_enabled", False),
                embedding_link_top_k=subgraph_cfg.get("embedding_link_top_k"),
                embedding_link_words_per_seed=int(
                    subgraph_cfg.get("embedding_link_words_per_seed", 25) or 0
                ),
                embedding_link_min_score=subgraph_cfg.get("embedding_link_min_score", 0.82),
                embedder_model=subgraph_cfg.get(
                    "embedder_model", "shibing624/text2vec-base-multilingual"
                ),
                embedding_cache_enabled=subgraph_cfg.get("embedding_cache_enabled", True),
                textbook_base_path=tb_path,
                seed_llm_filter=seed_llm_filter,
                edge_llm_filter=edge_llm_filter,
                knowledge_point_extractor=knowledge_point_extractor,
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
        ocr_text_cfg = ppt_cfg.get("ocr_text") or {}
        self.ppt_ocr_text_enabled = bool(ocr_text_cfg.get("enabled", True))
        self.ppt_ocr_max_chars = int(ocr_text_cfg.get("max_chars", 2000) or 2000)

        self.llm_cfg = config.get("llm", default={})
        triplet_cfg = s1.get("triplet_extract", {})
        self.triplet_enabled = triplet_cfg.get("enabled", True)
        validate_cfg = triplet_cfg.get("validate", {})
        retry_cfg = validate_cfg.get("retry", {})
        preprocess_cfg = s1.get("text_preprocess", {})
        # true：子图/增量用 asr_text；extract_text 仍写入供对照
        self.extract_from_asr = bool(preprocess_cfg.get("extract_from_asr", True))
        # true：已有 extract_text 时跳过 B，把存量当 B；仍跑 A
        self.reuse_existing_extract_as_b = bool(
            preprocess_cfg.get("reuse_existing_extract_as_b", True)
        )

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

        llm_cfg = preprocess_cfg.get("llm", {}) or {}
        self.text_preprocessor = CueTextPreprocessor(
            enabled=preprocess_cfg.get("enabled", True),
            rule_options=preprocess_cfg.get("rules", {}),
            llm_enabled=llm_cfg.get("enabled", False),
            llm_two_pass=bool(llm_cfg.get("two_pass", False)),
            # 默认开按 cue 的 B；配置可关。整讲拼接需同时 focus_pass + focus_lecture_level
            focus_pass=bool(llm_cfg.get("focus_pass", True)),
            focus_lecture_level=bool(llm_cfg.get("focus_lecture_level", False)),
            llm_prompt=llm_cfg.get("prompt", "stage1/cue_text_preprocess.txt"),
            llm_fluency_prompt=llm_cfg.get("fluency_prompt", "stage1/cue_text_fluency.txt"),
            llm_focus_prompt=llm_cfg.get("focus_prompt", "stage1/cue_text_focus.txt"),
            llm_focus_lecture_prompt=llm_cfg.get(
                "focus_lecture_prompt", "stage1/cue_text_focus_lecture.txt"
            ),
            llm_client=preprocess_client,
            temperature=llm_cfg.get("temperature", 0.1),
            mock=mock,
        )
        self.triplet_extractor: TripletExtractor | None = None
        if self.triplet_enabled:
            self.triplet_extractor = TripletExtractor(
                llm_client=extract_client,
                validate_client=validate_client,
                prompt_name=triplet_cfg.get("prompt", "stage1/subgraph_extract.txt"),
                temperature=triplet_cfg.get("temperature", 0.1),
                max_triplets_per_cue=triplet_cfg.get("max_triplets_per_cue", 30),
                mock=mock,
                validate_enabled=validate_cfg.get("enabled", True),
                validate_prompt=validate_cfg.get("prompt", "stage1/triplet_validate.txt"),
                retry_validate_prompt=validate_cfg.get("retry_prompt"),
                validate_temperature=validate_cfg.get("temperature", 0.0),
                retry_enabled=retry_cfg.get("enabled", True),
                retry_fix_enabled=retry_cfg.get("fix_enabled", True),
                retry_reextract_enabled=retry_cfg.get("reextract_enabled", True),
                retry_fix_fallback_reextract=retry_cfg.get("fix_fallback_reextract", True),
                max_fix_attempts=retry_cfg.get("max_fix_attempts", 3),
                max_reextract_attempts=retry_cfg.get("max_reextract_attempts", 3),
                retry_keep_original_on_fail=retry_cfg.get("keep_original_on_retry_fail", True),
                fix_prompt=retry_cfg.get("fix_prompt", "stage1/triplet_fix.txt"),
                reextract_prompt=retry_cfg.get("reextract_prompt", "stage1/triplet_reextract.txt"),
                hybrid_prompt_name=self.textbook_hybrid_prompt,
                conceptual_focus=self.textbook_conceptual_focus if self.textbook_kg_enabled else False,
                max_hybrid_delta_per_cue=self.textbook_max_delta_per_cue if self.textbook_kg_enabled else 12,
                hybrid_delta_words_per_item=(
                    self.textbook_delta_words_per_item if self.textbook_kg_enabled else 0
                ),
                hybrid_delta_min_per_cue=(
                    self.textbook_delta_min_per_cue if self.textbook_kg_enabled else 1
                ),
                dedupe_textbook_match=self.textbook_dedupe_match if self.textbook_kg_enabled else "exact_fullname",
                hybrid_completeness_pass=(
                    self.textbook_completeness_pass if self.textbook_kg_enabled else False
                ),
                hybrid_completeness_prompt_name=(
                    self.textbook_completeness_prompt
                    if self.textbook_kg_enabled
                    else "stage1/subgraph_hybrid_extract_complete.txt"
                ),
                kg_completion_enabled=(
                    self.kg_completion_enabled if self.textbook_kg_enabled else False
                ),
                kg_completion_prompt_name=self.kg_completion_prompt,
                kg_completion_validate_prompt=self.kg_completion_validate_prompt,
                kg_completion_max_triples=self.kg_completion_max_triples,
                cross_cue_extract_enabled=self.cross_cue_enabled,
                cross_cue_prompt_name=self.cross_cue_prompt,
                cross_cue_max_triples=self.cross_cue_max_triples,
                cross_cue_char_budget=self.cross_cue_char_budget,
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
        ocr_by_lecture: dict[str, dict[int, str]] | None = None,
    ) -> PreparedCue:
        check = self._check_rules(cue)
        ppt_frame_path = ""
        ppt_page_index: int | None = None
        ppt_ocr_text = ""

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
            if (
                self.ppt_ocr_text_enabled
                and ppt_page_index is not None
                and ocr_by_lecture is not None
            ):
                ppt_ocr_text = (ocr_by_lecture.get(cue.lecture_id) or {}).get(
                    ppt_page_index, ""
                )

        return PreparedCue(
            cue=cue,
            check=check,
            ppt_frame_path=ppt_frame_path,
            ppt_page_index=ppt_page_index,
            ppt_ocr_text=ppt_ocr_text,
        )

    def _link_delta_triplets(
        self,
        triplets: list[Triplet],
        cue_text: str,
        *,
        known_entities: set[str] | None = None,
    ) -> list[Triplet]:
        if not self.textbook_link_delta or not self.textbook_entity_registry:
            return triplets
        linked: list[Triplet] = []
        for triplet in triplets:
            src = (triplet.extract_source or "").strip()
            if (
                src != "lecture_delta"
                and src != "kg_completion"
                and not is_cross_cue_extract_source(src)
            ):
                linked.append(triplet)
                continue
            sub, obj, sub_ref, obj_ref = self.textbook_entity_registry.link_triplet(
                triplet.subject,
                triplet.object,
                cue_text=cue_text,
                known_entities=known_entities,
            )
            triplet.subject = sub
            triplet.object = obj
            triplet.subject_entity_ref = sub_ref
            triplet.object_entity_ref = obj_ref
            linked.append(triplet)
        return linked

    def _attach_prior_textbook_corrections(
        self,
        course_id: str,
        prepared: list[PreparedCue],
    ) -> None:
        """从已有 filtered_cues 挂载 textbook_correction（pilot 产物），供 use_corrected_textbook。"""
        path = self.config.processed_dir / course_id / self.output_filename
        if not path.is_file():
            return
        by_cue: dict[str, dict[str, Any]] = {}
        for row in load_jsonl(path):
            cue_id = str(row.get("cue_id", "")).strip()
            if not cue_id:
                continue
            corr = (row.get("stage1") or {}).get("textbook_correction")
            if isinstance(corr, dict) and "corrected_triples" in corr and not corr.get("skipped"):
                by_cue[cue_id] = corr
        if not by_cue:
            return
        attached = 0
        for item in prepared:
            corr = by_cue.get(item.cue.cue_id)
            if corr:
                item.textbook_correction = corr
                attached += 1
        if attached:
            logger.info(
                "Attached prior textbook_correction for %d/%d cues (use_corrected_textbook)",
                attached,
                len(prepared),
            )

    def _iter_prior_cue_rows(self, course_id: str):
        """优先 processed jsonl，其次 pretty_view filtered_cues.json。"""
        candidates = [
            self.config.processed_dir / course_id / self.output_filename,
            self.config.processed_dir / course_id / "filtered_cues.json",
            self.project_root
            / "data"
            / "pretty_view"
            / "processed"
            / course_id
            / "filtered_cues.json",
        ]
        for path in candidates:
            if not path.is_file():
                continue
            if path.suffix == ".jsonl":
                yield from load_jsonl(path)
                return
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
            if isinstance(raw, list):
                yield from raw
                return
            if isinstance(raw, dict):
                for key in ("cues", "items", "filtered_cues"):
                    if isinstance(raw.get(key), list):
                        yield from raw[key]
                        return

    def _attach_prior_extract_texts(
        self,
        course_id: str,
        prepared: list[PreparedCue],
    ) -> None:
        """挂载已有 extract_text，供 A 接入后复用为 B（不重跑 B）。"""
        if not self.reuse_existing_extract_as_b:
            return
        by_cue: dict[str, dict[str, str]] = {}
        for row in self._iter_prior_cue_rows(course_id):
            cue_id = str(row.get("cue_id", "")).strip()
            if not cue_id:
                continue
            stage1 = row.get("stage1") if isinstance(row.get("stage1"), dict) else {}
            extract = str(stage1.get("extract_text") or "").strip()
            fluency = str(stage1.get("fluency_text") or "").strip()
            if extract or fluency:
                by_cue[cue_id] = {"extract_text": extract, "fluency_text": fluency}
        if not by_cue:
            return
        attached = 0
        for item in prepared:
            prior = by_cue.get(item.cue.cue_id)
            if not prior:
                continue
            if prior.get("extract_text"):
                item.prior_extract_text = prior["extract_text"]
                attached += 1
            if prior.get("fluency_text") and not item.fluency_text:
                item.fluency_text = prior["fluency_text"]
        if attached:
            logger.info(
                "Attached prior extract_text for %d/%d cues (reuse as B)",
                attached,
                len(prepared),
            )

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
        textbook_spo_keys: set[tuple[str, str, str]],
        max_add: int,
    ) -> list[Triplet]:
        if max_add <= 0 or not rows:
            return []
        existing = {t.dedupe_key for t in merged}
        ranked_rows = rank_llm_fallback_candidates(
            rows,
            cue_text=cue_text,
            merged=merged,
            existing_keys=existing,
            textbook_spo_keys=textbook_spo_keys,
        )
        out: list[Triplet] = []
        for row in ranked_rows:
            if len(out) >= max_add:
                break
            triplet = Triplet.from_dict(row)
            if not triplet or triplet.dedupe_key in existing:
                continue
            if overlaps_textbook_spo(triplet, textbook_spo_keys):
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
        textbook_spo_keys: set[tuple[str, str, str]],
    ) -> tuple[list[Triplet], int, int]:
        """零覆盖或薄覆盖时从 LLM 基线补概念边。返回 (merged, zero_used, thin_used)。"""
        zero_used = 0
        thin_used = 0
        if not llm_rows:
            return merged, zero_used, thin_used
        if not self.textbook_zero_fallback and not self.textbook_thin_fallback:
            return merged, zero_used, thin_used

        if not merged:
            if not self.textbook_zero_fallback:
                return merged, zero_used, thin_used
            supplements = self._llm_supplement_triplets(
                merged,
                llm_rows,
                cue_text=cue_text,
                textbook_spo_keys=textbook_spo_keys,
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
                textbook_spo_keys=textbook_spo_keys,
                max_add=need,
            )
            thin_used = len(supplements)
            merged = dedupe_triplets(merged + supplements)
        return merged, zero_used, thin_used

    def _apply_lecture_importance_context(
        self,
        lecture_id: str,
        prepared_items: list[PreparedCue] | None = None,
    ) -> None:
        """为当前讲次设置子图重要性视图（多章加权，课程无关）。"""
        if not self.textbook_retriever:
            return
        from teachkg.textbook_kg.chapter_map import resolve_lecture_chapters

        kg = self.textbook_retriever.kg
        chapter_order = list(getattr(kg, "chapter_order", None) or [])
        if not chapter_order and getattr(kg, "importance_by_chapter", None):
            chapter_order = list(kg.importance_by_chapter.keys())
        tb = getattr(self, "textbook_cfg", {}) or {}
        fb = tb.get("importance_feedback", {}) or {}
        cues = []
        for p in prepared_items or []:
            cues.append(
                {
                    "lecture_id": p.cue.lecture_id,
                    "asr_text": p.cue.asr_text,
                }
            )
        chapters = resolve_lecture_chapters(
            lecture_id,
            chapter_order=chapter_order,
            lecture_chapter_map=tb.get("lecture_chapter_map") or {},
            cues=cues,
            top_k=int(fb.get("multi_chapter_top_k", 2)),
            min_ratio=float(fb.get("multi_chapter_min_ratio", 0.35)),
        )
        if chapters:
            self.textbook_retriever.set_importance_context(chapters=chapters)
            logger.info(
                "Textbook importance context lecture=%s chapters=%s",
                lecture_id,
                [(c, round(w, 3)) for c, w in chapters],
            )
        else:
            self.textbook_retriever.set_importance_context(chapter=None)

    def _fill_preprocess_text(self, prepared: PreparedCue, course_context: str) -> None:
        """中间步骤：A 通畅 →（可选）B 精炼 / 复用存量 extract_text。"""
        pp = self.text_preprocessor
        if not pp.llm_two_pass:
            prepared.extract_text = pp.process(prepared.cue.asr_text, course_context)
            prepared.preprocess_ab_mode = "single_pass"
            return

        fluent = pp.process_pass_a(prepared.cue.asr_text, course_context)
        prepared.fluency_text = fluent

        if pp.focus_lecture_level and pp.focus_pass:
            prepared.extract_text = fluent
            prepared.preprocess_ab_mode = "a_pending_lecture_b"
            return

        prior_b = (prepared.prior_extract_text or "").strip()
        if self.reuse_existing_extract_as_b and prior_b:
            prepared.extract_text = prior_b
            prepared.preprocess_ab_mode = "a_run_b_reused_extract_text"
            return

        if pp.focus_pass:
            prepared.extract_text = pp.process_pass_b_cue(fluent, course_context)
            prepared.preprocess_ab_mode = "a_then_cue_b"
            return

        prepared.extract_text = fluent
        prepared.preprocess_ab_mode = "a_only"

    def _fill_preprocess_lecture(
        self,
        items: list[PreparedCue],
        course_context: str,
    ) -> None:
        """讲次批量预处理：逐 cue 跑 A；可选讲次级 B 拼接。"""
        if not items:
            return
        pp = self.text_preprocessor
        use_lecture_b = bool(
            pp.enabled
            and pp.llm_enabled
            and pp.llm_two_pass
            and pp.focus_pass
            and pp.focus_lecture_level
        )
        if not use_lecture_b:
            for prepared in items:
                self._fill_preprocess_text(prepared, course_context)
            return

        lecture_id = str(items[0].cue.lecture_id)
        fluents: list[tuple[str, str]] = []
        for prepared in items:
            fluent = pp.process_pass_a(prepared.cue.asr_text, course_context)
            prepared.fluency_text = fluent
            fluents.append((prepared.cue.cue_id, fluent))

        focus = pp.process_lecture_focus(
            fluents,
            course_context=course_context,
            lecture_id=lecture_id,
        )
        outline = list(focus.outline)
        for prepared in items:
            prepared.lecture_outline = outline
            prior_b = (prepared.prior_extract_text or "").strip()
            if self.reuse_existing_extract_as_b and prior_b:
                prepared.extract_text = prior_b
                prepared.preprocess_ab_mode = "a_run_b_reused_extract_text"
            else:
                prepared.extract_text = focus.cue_texts.get(prepared.cue.cue_id, "") or ""
                prepared.preprocess_ab_mode = "a_then_lecture_b"

        logger.info(
            "Lecture text focus lecture=%s cues=%d outline=%d nonempty=%d",
            lecture_id,
            len(items),
            len(outline),
            sum(1 for _cid, t in focus.cue_texts.items() if (t or "").strip()),
        )

    def _text_for_extract(self, prepared: PreparedCue) -> str:
        """实际送入子图检索与三元组抽取的文本。"""
        if self.extract_from_asr:
            prepared.extract_source_used = "asr"
            base = (prepared.cue.asr_text or "").strip()
        else:
            prepared.extract_source_used = "preprocessed"
            base = (prepared.extract_text or "").strip()
        ocr = (prepared.ppt_ocr_text or "").strip()
        if not self.ppt_ocr_text_enabled or not ocr:
            return base
        if self.ppt_ocr_max_chars > 0 and len(ocr) > self.ppt_ocr_max_chars:
            ocr = ocr[: self.ppt_ocr_max_chars].rstrip() + "…"
        if not base:
            return f"【PPT OCR】\n{ocr}"
        return f"{base}\n\n【PPT OCR】\n{ocr}"

    def _extract_hybrid_lecture(
        self,
        items: list[PreparedCue],
        course_id: str,
        course_context: str,
    ) -> None:
        """逐 cue 边筛子图写入教材边 + 约束增量；讲次内同边可不重复写入。"""
        if not self.triplet_extractor or not self.textbook_retriever:
            return

        self._fill_preprocess_lecture(items, course_context)

        active: list[PreparedCue] = []
        for prepared in items:
            if self._text_for_extract(prepared):
                active.append(prepared)
            elif not self.extract_from_asr and not (prepared.extract_text or "").strip():
                prepared.triplet_error = "empty_text_after_preprocess"
            else:
                prepared.triplet_error = "empty_asr_text"

        if not active:
            return

        # 按讲次切换章条件重要性（通用：目录打分 / yaml 映射）
        self._apply_lecture_importance_context(active[0].cue.lecture_id, active)

        # 讲次内已写入的教材边键（仅影响输出去重，不影响 prompt 子图）
        global_used_tb_keys: set[tuple[str, str, str, str]] = set()
        llm_by_cue: dict[str, list[dict[str, Any]]] = {}
        if (self.textbook_zero_fallback or self.textbook_thin_fallback) and active:
            llm_by_cue = self._load_llm_baseline_by_cue(
                course_id, active[0].cue.lecture_id
            )

        for prepared in active:
            cue_id = prepared.cue.cue_id
            src_text = self._text_for_extract(prepared)
            cue_subgraph = self.textbook_retriever.retrieve(src_text)
            cue_tb_all = relations_to_triplets(cue_subgraph.relations)
            # 写入边 = 本 cue 边筛子图；可选讲次去重（同边不重复进入多个 cue）
            if self.textbook_lecture_dedupe:
                cue_tb = [
                    t for t in cue_tb_all if t.dedupe_key not in global_used_tb_keys
                ]
                global_used_tb_keys.update(t.dedupe_key for t in cue_tb)
            else:
                cue_tb = list(cue_tb_all)

            known_entities = set(cue_subgraph.entities) | set(cue_subgraph.seed_entities)
            subgraph_json = format_subgraph_for_prompt(
                self.textbook_retriever.kg,
                seed_entities=cue_subgraph.seed_entities,
                entities=cue_subgraph.entities,
                relations=cue_subgraph.relations,
            )
            # 增量基座：优先经课堂核实后的教材子图（drop 不计入；revise 用改正后 SPO）
            delta_tb = list(cue_tb_all)
            delta_subgraph_json = subgraph_json
            delta_basis = "cue_subgraph"
            if self.textbook_use_corrected and prepared.textbook_correction:
                basis = correction_basis_from_stage1(
                    {
                        "textbook_correction": prepared.textbook_correction,
                        "textbook_subgraph": prepared.textbook_subgraph
                        or cue_subgraph.to_dict(),
                    }
                )
                if basis is not None:
                    delta_tb, delta_subgraph_json, corr_ents = basis
                    known_entities |= corr_ents
                    delta_basis = "corrected_textbook"
            known_entities_text = format_known_entities_for_prompt(known_entities)
            cue_kps = list(
                (prepared.textbook_subgraph or {}).get("knowledge_points")
                or getattr(cue_subgraph, "knowledge_points", None)
                or []
            )
            # 增量去重对象与 prompt 一致
            delta_result = self.triplet_extractor.extract_hybrid(
                src_text,
                course_context,
                textbook_subgraph_json=delta_subgraph_json,
                textbook_triplets=delta_tb,
                dedupe_against_textbook=self.textbook_dedupe_delta,
                known_entities_text=known_entities_text,
                knowledge_points=cue_kps,
            )
            delta_triplets = filter_delta_triplets(
                self._link_delta_triplets(
                    delta_result.triplets,
                    src_text,
                    known_entities=known_entities,
                ),
                src_text,
                conceptual_focus=self.textbook_conceptual_focus,
            )
            if self.textbook_dedupe_delta:
                delta_triplets = filter_deltas_against_textbook(
                    delta_triplets,
                    delta_tb,
                    match=self.textbook_dedupe_match,
                )

            kg_triplets: list[Triplet] = []
            kg_result = None
            if self.kg_completion_enabled and self.triplet_extractor:
                kg_result = self.triplet_extractor.extract_kg_completion(
                    src_text,
                    course_context,
                    textbook_subgraph_json=delta_subgraph_json,
                    textbook_triplets=delta_tb,
                    already=delta_triplets,
                    dedupe_against_textbook=self.textbook_dedupe_delta,
                    known_entities_text=known_entities_text,
                    knowledge_points=cue_kps,
                )
                kg_triplets = filter_delta_triplets(
                    self._link_delta_triplets(
                        kg_result.triplets,
                        src_text,
                        known_entities=known_entities,
                    ),
                    src_text,
                    conceptual_focus=self.textbook_conceptual_focus,
                    allow_model_written_context=True,
                )
                if self.textbook_dedupe_delta:
                    kg_triplets = filter_deltas_against_textbook(
                        kg_triplets,
                        delta_tb,
                        match=self.textbook_dedupe_match,
                    )
                    # 再与原文增量 SPO 去重
                    delta_spo = {t.spo_dedupe_key for t in delta_triplets}
                    kg_triplets = [
                        t for t in kg_triplets if t.spo_dedupe_key not in delta_spo
                    ]

            merged: list[Triplet] = []
            if self.textbook_include_in_output:
                merged.extend(cue_tb)
            merged.extend(delta_triplets)
            merged.extend(kg_triplets)
            merged = dedupe_triplets(merged)
            textbook_spo_keys = build_textbook_spo_keys(delta_tb)
            llm_rows = list(llm_by_cue.get(cue_id, []))
            # 无 llm_only 基线时：零覆盖当场补一次纯 LLM 抽取（thin 仍依赖基线文件）
            if (
                not llm_rows
                and self.textbook_zero_fallback
                and not merged
                and self.triplet_extractor is not None
            ):
                try:
                    fb = self.triplet_extractor.extract(src_text, course_context)
                    llm_rows = [t.to_dict() for t in fb.triplets]
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "On-the-fly LLM fallback extract failed cue=%s: %s",
                        cue_id,
                        exc,
                    )
            merged, zero_fallback, thin_fallback = self._apply_coverage_fallback(
                merged,
                llm_rows,
                cue_text=src_text,
                textbook_spo_keys=textbook_spo_keys,
            )
            prepared.triplets = merged
            prepared.triplet_error = delta_result.error or (
                kg_result.error if kg_result else None or ""
            )
            validation_payload: dict[str, Any] = {
                "cue_subgraph_edges": len(cue_tb_all),
                "assigned_textbook_edges": len(cue_tb),
                "textbook_edges": len(cue_tb),
                "delta_textbook_basis": delta_basis,
                "delta_basis_edges": len(delta_tb),
                "lecture_delta_edges": len(delta_triplets),
                "kg_completion_edges": len(kg_triplets),
                "llm_fallback_edges": zero_fallback + thin_fallback,
                "llm_zero_fallback_edges": zero_fallback,
                "llm_thin_fallback_edges": thin_fallback,
                "write_source": "cue_subgraph",
                "extract_from": prepared.extract_source_used or "asr",
            }
            if delta_result.validation:
                validation_payload["lecture_delta_validation"] = (
                    delta_result.validation.to_dict()
                )
                validation_payload.update(delta_result.validation.to_dict())
            if kg_result and kg_result.validation:
                validation_payload["kg_completion_validation"] = (
                    kg_result.validation.to_dict()
                )
            prepared.triplet_validation = validation_payload
            prepared.textbook_subgraph = {
                **cue_subgraph.to_dict(),
                "written_edges": len(cue_tb),
                "subgraph_edges": len(cue_tb_all),
                "delta_basis": delta_basis,
                "delta_basis_edges": len(delta_tb),
            }
            logger.info(
                "Hybrid lecture extract for cue %s: src=%s subgraph_tb=%d written_tb=%d "
                "delta_basis=%s(%d) delta=%d kg_completion=%d total=%d",
                prepared.cue.cue_id,
                prepared.extract_source_used or "?",
                len(cue_tb_all),
                len(cue_tb),
                delta_basis,
                len(delta_tb),
                len(delta_triplets),
                len(kg_triplets),
                len(prepared.triplets),
            )

    def _extract_cross_cue_lecture(
        self,
        items: list[PreparedCue],
        course_context: str,
    ) -> None:
        """单段抽取完成后的字数窗跨段 pass；挂到窗末段 cue，不绑 multimodal/context。"""
        if not self.cross_cue_enabled or not self.triplet_extractor:
            return
        ordered = sorted(
            [
                p
                for p in items
                if p.check.passed and self._text_for_extract(p)
            ],
            key=lambda p: (p.cue.start_sec, p.cue.cue_id),
        )
        if len(ordered) < 2:
            return
        texts = [self._text_for_extract(p) for p in ordered]
        lengths = [len(t) for t in texts]
        budget = max(1, int(self.cross_cue_char_budget or 1500))
        windows = build_char_half_windows(lengths, char_budget=budget)
        if not windows:
            return
        lecture_id = str(ordered[0].cue.lecture_id or "")
        conceptual = bool(
            self.textbook_conceptual_focus if self.textbook_kg_enabled else False
        )
        # 重叠窗重复关系：讲次内全局 SPO 去重（后续课程级还可再压）
        seen_cross_spo: set[tuple[str, str, str]] = {
            t.spo_dedupe_key
            for p in ordered
            for t in p.triplets
            if is_cross_cue_extract_source(t.extract_source)
        }
        # 也避免与本讲已有单段边 SPO 重复
        lecture_spo: set[tuple[str, str, str]] = {
            t.spo_dedupe_key for p in ordered for t in p.triplets
        }

        logger.info(
            "Cross-cue char windows lecture=%s budget=%d windows=%d cues=%d",
            lecture_id,
            budget,
            len(windows),
            len(ordered),
        )
        for start_i, end_i in windows:
            window_items = ordered[start_i : end_i + 1]
            window_texts = texts[start_i : end_i + 1]
            source_span = format_cross_cue_source_span(
                lecture_id,
                start_i + 1,
                end_i + 1,
            )
            already = [t for p in window_items for t in p.triplets]
            known_entities: set[str] = set()
            for prepared in window_items:
                sg = prepared.textbook_subgraph or {}
                known_entities |= {
                    str(x) for x in (sg.get("entities") or []) if x
                }
                known_entities |= {
                    str(x) for x in (sg.get("seed_entities") or []) if x
                }
            known_text = (
                format_known_entities_for_prompt(known_entities)
                if known_entities
                else ""
            )
            segments = [
                (p.cue.cue_id, txt)
                for p, txt in zip(window_items, window_texts)
            ]
            cross = self.triplet_extractor.extract_cross_cue(
                window_segments=segments,
                source_span=source_span,
                course_context=course_context,
                already=already,
                known_entities_text=known_text,
                max_triples=self.cross_cue_max_triples,
            )
            if not cross:
                continue
            joined = "\n".join(window_texts)
            cross = filter_delta_triplets(
                cross,
                joined,
                conceptual_focus=conceptual,
            )
            if self.textbook_dedupe_delta:
                tb = [t for t in already if (t.extract_source or "") == "textbook"]
                if tb:
                    cross = filter_deltas_against_textbook(
                        cross,
                        tb,
                        match=self.textbook_dedupe_match,
                    )
            cross = self._link_delta_triplets(
                cross,
                joined,
                known_entities=known_entities or None,
            )
            kept: list[Triplet] = []
            dropped_rows: list[dict[str, Any]] = []
            for triplet in cross:
                triplet.extract_source = "cross_cue"
                triplet.cross_cue_span = source_span
                triplet.context = ""
                key = triplet.spo_dedupe_key
                if key in seen_cross_spo:
                    row = triplet.to_dict()
                    row["dedupe_reason"] = "window_overlap"
                    row["dedupe_reason_zh"] = "重叠窗已保留"
                    dropped_rows.append(row)
                    continue
                if key in lecture_spo:
                    row = triplet.to_dict()
                    row["dedupe_reason"] = "lecture_existing"
                    row["dedupe_reason_zh"] = "与本讲已有边重复"
                    dropped_rows.append(row)
                    continue
                seen_cross_spo.add(key)
                lecture_spo.add(key)
                kept.append(triplet)

            # 即使全部被去重，也把去重结果记在窗末段，供流水线展示
            anchor = window_items[-1]
            payload = anchor.triplet_validation or {}
            win_logs = list(payload.get("cross_cue_window_logs") or [])
            win_logs.append(
                {
                    "source_span": source_span,
                    "start_seg": start_i + 1,
                    "end_seg": end_i + 1,
                    "chars": sum(lengths[start_i : end_i + 1]),
                    "kept": len(kept),
                    "deduped": len(dropped_rows),
                    "deduped_triples": dropped_rows,
                }
            )
            payload["cross_cue_window_logs"] = win_logs
            prev_deduped = list(payload.get("cross_cue_deduped") or [])
            prev_deduped.extend(dropped_rows)
            payload["cross_cue_deduped"] = prev_deduped
            if kept:
                before = len(anchor.triplets)
                anchor.triplets = dedupe_triplets(list(anchor.triplets) + kept)
                added = len(anchor.triplets) - before
                if added > 0:
                    payload["cross_cue_edges"] = (
                        int(payload.get("cross_cue_edges", 0)) + added
                    )
                    from_list = list(payload.get("cross_cue_from") or [])
                    from_list.append(source_span)
                    payload["cross_cue_from"] = from_list
                    payload["cross_cue_window"] = {
                        "start_seg": start_i + 1,
                        "end_seg": end_i + 1,
                        "char_budget": budget,
                        "chars": sum(lengths[start_i : end_i + 1]),
                    }
                    logger.info(
                        "Cross-cue extract attached %d edge(s) to %s (%s)",
                        added,
                        anchor.cue.cue_id,
                        source_span,
                    )
            if dropped_rows:
                logger.info(
                    "Cross-cue deduped %d edge(s) for %s (%s)",
                    len(dropped_rows),
                    anchor.cue.cue_id,
                    source_span,
                )
            anchor.triplet_validation = payload
            if not kept and not dropped_rows:
                continue


    def _extract_triplets(
        self,
        prepared: PreparedCue,
        course_id: str,
        course_context: str,
        *,
        preprocess: bool = True,
    ) -> None:
        if not self.triplet_enabled or not self.triplet_extractor or not prepared.check.passed:
            return

        if preprocess:
            self._fill_preprocess_text(prepared, course_context)
        src_text = self._text_for_extract(prepared)
        if not src_text:
            prepared.triplet_error = (
                "empty_asr_text" if self.extract_from_asr else "empty_text_after_preprocess"
            )
            logger.warning(
                "Empty extract source (%s) for cue %s",
                prepared.extract_source_used or "?",
                prepared.cue.cue_id,
            )
            return

        if self.textbook_retriever:
            self._apply_lecture_importance_context(
                prepared.cue.lecture_id,
                [prepared],
            )
            subgraph = self.textbook_retriever.retrieve(src_text)
            prepared.textbook_subgraph = subgraph.to_dict()
            textbook_triplets = relations_to_triplets(subgraph.relations)
            known_entities = set(subgraph.entities) | set(subgraph.seed_entities)
            subgraph_json = format_subgraph_for_prompt(
                self.textbook_retriever.kg,
                seed_entities=subgraph.seed_entities,
                entities=subgraph.entities,
                relations=subgraph.relations,
            )
            delta_tb = list(textbook_triplets)
            delta_subgraph_json = subgraph_json
            delta_basis = "cue_subgraph"
            if self.textbook_use_corrected and prepared.textbook_correction:
                basis = correction_basis_from_stage1(
                    {
                        "textbook_correction": prepared.textbook_correction,
                        "textbook_subgraph": prepared.textbook_subgraph,
                    }
                )
                if basis is not None:
                    delta_tb, delta_subgraph_json, corr_ents = basis
                    known_entities |= corr_ents
                    delta_basis = "corrected_textbook"

            delta_result = self.triplet_extractor.extract_hybrid(
                src_text,
                course_context,
                textbook_subgraph_json=delta_subgraph_json,
                textbook_triplets=delta_tb,
                dedupe_against_textbook=self.textbook_dedupe_delta,
                known_entities_text=format_known_entities_for_prompt(known_entities),
                knowledge_points=list(
                    (prepared.textbook_subgraph or {}).get("knowledge_points")
                    or getattr(subgraph, "knowledge_points", None)
                    or []
                ),
            )
            delta_triplets = filter_delta_triplets(
                self._link_delta_triplets(
                    delta_result.triplets,
                    src_text,
                    known_entities=known_entities,
                ),
                src_text,
                conceptual_focus=self.textbook_conceptual_focus,
            )
            if self.textbook_dedupe_delta:
                delta_triplets = filter_deltas_against_textbook(
                    delta_triplets,
                    delta_tb,
                    match=self.textbook_dedupe_match,
                )
            known_entities_text = format_known_entities_for_prompt(known_entities)
            cue_kps = list(
                (prepared.textbook_subgraph or {}).get("knowledge_points")
                or getattr(subgraph, "knowledge_points", None)
                or []
            )
            kg_triplets: list[Triplet] = []
            kg_result = None
            if self.kg_completion_enabled:
                kg_result = self.triplet_extractor.extract_kg_completion(
                    src_text,
                    course_context,
                    textbook_subgraph_json=delta_subgraph_json,
                    textbook_triplets=delta_tb,
                    already=delta_triplets,
                    dedupe_against_textbook=self.textbook_dedupe_delta,
                    known_entities_text=known_entities_text,
                    knowledge_points=cue_kps,
                )
                kg_triplets = filter_delta_triplets(
                    self._link_delta_triplets(
                        kg_result.triplets,
                        src_text,
                        known_entities=known_entities,
                    ),
                    src_text,
                    conceptual_focus=self.textbook_conceptual_focus,
                    allow_model_written_context=True,
                )
                if self.textbook_dedupe_delta:
                    kg_triplets = filter_deltas_against_textbook(
                        kg_triplets,
                        delta_tb,
                        match=self.textbook_dedupe_match,
                    )
                    delta_spo = {t.spo_dedupe_key for t in delta_triplets}
                    kg_triplets = [
                        t for t in kg_triplets if t.spo_dedupe_key not in delta_spo
                    ]
            merged: list[Triplet] = []
            if self.textbook_include_in_output:
                merged.extend(textbook_triplets)
            merged.extend(delta_triplets)
            merged.extend(kg_triplets)
            merged = dedupe_triplets(merged)
            llm_rows: list[dict[str, Any]] = []
            if self.textbook_zero_fallback or self.textbook_thin_fallback:
                llm_rows = self._load_llm_baseline_by_cue(
                    course_id, prepared.cue.lecture_id
                ).get(prepared.cue.cue_id, [])
            merged, zero_fallback, thin_fallback = self._apply_coverage_fallback(
                merged,
                llm_rows,
                cue_text=src_text,
                textbook_spo_keys=build_textbook_spo_keys(delta_tb),
            )
            prepared.triplets = merged
            prepared.triplet_error = delta_result.error or (
                kg_result.error if kg_result else None or ""
            )
            validation_payload: dict[str, Any] = {
                "textbook_edges": len(textbook_triplets),
                "delta_textbook_basis": delta_basis,
                "delta_basis_edges": len(delta_tb),
                "lecture_delta_edges": len(delta_triplets),
                "kg_completion_edges": len(kg_triplets),
                "llm_fallback_edges": zero_fallback + thin_fallback,
                "write_source": "cue_subgraph",
                "extract_from": prepared.extract_source_used or "asr",
            }
            if delta_result.validation:
                validation_payload.update(delta_result.validation.to_dict())
            if kg_result and kg_result.validation:
                validation_payload["kg_completion_validation"] = (
                    kg_result.validation.to_dict()
                )
            prepared.triplet_validation = validation_payload
            logger.info(
                "Hybrid extract for cue %s: src=%s textbook=%d delta_basis=%s(%d) "
                "delta=%d kg_completion=%d total=%d",
                prepared.cue.cue_id,
                prepared.extract_source_used or "?",
                len(textbook_triplets),
                delta_basis,
                len(delta_tb),
                len(delta_triplets),
                len(kg_triplets),
                len(prepared.triplets),
            )
            if delta_result.error:
                logger.warning(
                    "Hybrid delta extraction failed for cue %s: %s",
                    prepared.cue.cue_id,
                    delta_result.error,
                )
            return

        result = self.triplet_extractor.extract(src_text, course_context)
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

    def _stage1_meta_dir(self, output_dir: Path) -> Path:
        return output_dir / "stage1_meta"

    def _lecture_input_meta(
        self,
        course_id: str,
        input_path: Path,
        lecture_id: str,
    ) -> dict[str, Any]:
        ocr_path = stage0_ppt_ocr_cache_path(
            self.config.segments_dir, course_id, lecture_id
        )
        seg_txt = (
            self.config.segments_dir / course_id / "ppt_change" / f"{lecture_id}_seg.txt"
        )
        return {
            "lecture_id": str(lecture_id),
            "cues_fp": hash_jsonl_rows(input_path, lecture_id=lecture_id),
            "cues_file": file_identity(input_path),
            "ppt_seg": file_identity(seg_txt),
            "ppt_ocr": file_identity(ocr_path),
            "extract_from_asr": bool(self.extract_from_asr),
            "ppt_ocr_text_enabled": bool(self.ppt_ocr_text_enabled),
            "textbook_kg_enabled": bool(self.textbook_kg_enabled),
            "require_clip": bool(self.require_clip),
        }

    def _course_input_meta(self, course_id: str, input_path: Path) -> dict[str, Any]:
        return {
            "course_id": course_id,
            "cues_fp": hash_jsonl_rows(input_path),
            "cues_file": file_identity(input_path),
            "extract_from_asr": bool(self.extract_from_asr),
            "ppt_ocr_text_enabled": bool(self.ppt_ocr_text_enabled),
            "textbook_kg_enabled": bool(self.textbook_kg_enabled),
            "require_clip": bool(self.require_clip),
        }

    def _should_skip_course(
        self,
        course_id: str,
        input_path: Path,
        output_path: Path,
        rejected_path: Path,
        triplets_path: Path,
        meta_path: Path,
    ) -> bool:
        if not self.use_existing:
            return False
        if not output_path.exists() or not rejected_path.exists():
            return False
        if self.triplet_enabled and not triplets_path.exists():
            return False
        expected = self._course_input_meta(course_id, input_path)
        # 全课复用可领养缺失 meta；讲次增量见 _filter_reusable_lectures
        return can_reuse(output_path, meta_path, expected, adopt_missing_meta=True)

    def _filter_reusable_lectures(
        self,
        course_id: str,
        input_path: Path,
        output_dir: Path,
        lecture_ids: set[str],
    ) -> set[str]:
        """返回输入未变、可跳过的讲次。

        必须同时满足：该讲已在 filtered_cues 中、存在讲次 meta、指纹匹配。
        不领养缺失 meta（避免「全课 filtered 存在」误跳过未处理讲次）。
        """
        if not self.use_existing:
            return set()
        filtered_path = output_dir / self.output_filename
        if not filtered_path.is_file():
            return set()
        present: set[str] = set()
        for row in load_jsonl(filtered_path):
            lid = str(row.get("lecture_id", "")).strip()
            if lid:
                present.add(lid)
        meta_dir = self._stage1_meta_dir(output_dir)
        reusable: set[str] = set()
        for lid in lecture_ids:
            if lid not in present:
                continue
            expected = self._lecture_input_meta(course_id, input_path, lid)
            meta_path = meta_dir / f"{lid}.json"
            if can_reuse(
                filtered_path,
                meta_path,
                expected,
                adopt_missing_meta=False,
            ):
                reusable.add(lid)
        return reusable

    def run(self, course_id: str, lecture_ids: list[str] | None = None) -> Path:
        input_path = self.config.segments_dir / course_id / self.input_filename
        output_dir = self.config.processed_dir / course_id
        output_path = output_dir / self.output_filename
        rejected_path = output_dir / self.rejected_filename
        report_path = output_dir / "stage1_report.json"
        course_meta_path = output_dir / "stage1_input_meta.json"
        triplets_path = self.kg_dir / course_id / self.triplets_filename
        llm_only_path = self.kg_dir / course_id / self.llm_only_triplets_filename
        rerun_lectures = {str(x) for x in lecture_ids} if lecture_ids else None

        if not input_path.exists():
            raise FileNotFoundError(f"Stage 0 cues not found: {input_path}")

        if (
            not rerun_lectures
            and self._should_skip_course(
                course_id,
                input_path,
                output_path,
                rejected_path,
                triplets_path,
                course_meta_path,
            )
        ):
            logger.info("Reuse existing Stage 1 output: %s", output_path)
            return output_path

        raw = load_jsonl(input_path)
        cues = [VideoSegment.from_dict(row) for row in raw]
        if rerun_lectures:
            reusable = self._filter_reusable_lectures(
                course_id, input_path, output_dir, rerun_lectures
            )
            if reusable:
                logger.info(
                    "Stage 1 skip lectures with matching input fingerprint: %s",
                    sorted(reusable, key=lambda x: int(x) if x.isdigit() else x),
                )
            active = rerun_lectures - reusable
            if not active:
                logger.info("Stage 1: all requested lectures reusable, nothing to do")
                return output_path
            cues = [c for c in cues if c.lecture_id in active]
            if not cues:
                raise ValueError(f"No cues matched lecture_ids={sorted(active)}")
            logger.info(
                "Stage 1 incremental: processing %d cues for lecture(s) %s",
                len(cues),
                sorted(active),
            )
            rerun_lectures = active

        logger.info("Stage 1: preparing %d cues from %s", len(cues), input_path)

        pages_by_lecture: dict[str, list] = {}
        ocr_by_lecture: dict[str, dict[int, str]] = {}
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
            if self.ppt_ocr_text_enabled:
                ocr_by_lecture[lecture_id] = load_ppt_ocr_texts(
                    self.config.segments_dir, course_id, lecture_id
                )
                if ocr_by_lecture[lecture_id]:
                    logger.info(
                        "Loaded PPT OCR cache lecture=%s pages=%d",
                        lecture_id,
                        len(ocr_by_lecture[lecture_id]),
                    )

        course_context = load_course_context(
            self.config.workspace_dir,
            course_id,
            cue=cues[0] if cues else None,
        )

        prepared = [
            self._prepare_cue(cue, course_id, pages_by_lecture, ocr_by_lecture)
            for cue in cues
        ]
        if self.textbook_use_corrected:
            self._attach_prior_textbook_corrections(course_id, prepared)
        self._attach_prior_extract_texts(course_id, prepared)

        if self.textbook_retriever and self.textbook_lecture_dedupe:
            by_lecture: dict[str, list[PreparedCue]] = {}
            for item in prepared:
                if not item.check.passed or not self.triplet_enabled:
                    continue
                by_lecture.setdefault(item.cue.lecture_id, []).append(item)
            for lecture_items in by_lecture.values():
                self._extract_hybrid_lecture(lecture_items, course_id, course_context)
                self._extract_cross_cue_lecture(lecture_items, course_context)
        else:
            by_lecture_llm: dict[str, list[PreparedCue]] = {}
            for item in prepared:
                if not item.check.passed or not self.triplet_enabled:
                    continue
                by_lecture_llm.setdefault(item.cue.lecture_id, []).append(item)
            for lecture_items in by_lecture_llm.values():
                self._fill_preprocess_lecture(lecture_items, course_context)
            for item in prepared:
                # 预处理已在讲次批量完成；此处跳过重复 A/B
                if not item.check.passed or not self.triplet_enabled:
                    continue
                self._extract_triplets(item, course_id, course_context, preprocess=False)
            if self.cross_cue_enabled and self.triplet_enabled:
                by_lecture_x: dict[str, list[PreparedCue]] = {}
                for item in prepared:
                    if not item.check.passed:
                        continue
                    by_lecture_x.setdefault(item.cue.lecture_id, []).append(item)
                for lecture_items in by_lecture_x.values():
                    self._extract_cross_cue_lecture(lecture_items, course_context)

        passed = [p for p in prepared if p.check.passed]
        rejected = [p for p in prepared if not p.check.passed]

        def _lecture_of_row(row: dict[str, Any]) -> str:
            return str(row.get("lecture_id", ""))

        # Build new rows outside the lock so parallel lecture workers can
        # overlap LLM extraction; only the shared JSONL merge is serialized.
        extract_mode = "hybrid" if self.textbook_kg_enabled else "llm_only"
        new_passed_rows = [p.to_dict() for p in passed]
        new_rejected_rows = [p.to_dict() for p in rejected]
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
                    source_text=self._text_for_extract(p),
                )
            )

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

        output_dir.mkdir(parents=True, exist_ok=True)
        with exclusive_dir_lock(output_dir / ".stage1_merge.lock"):
            existing_passed: list[dict[str, Any]] = []
            existing_rejected: list[dict[str, Any]] = []
            existing_triplets: list[dict[str, Any]] = []
            existing_llm_only: list[dict[str, Any]] = []
            if rerun_lectures:
                if output_path.is_file():
                    existing_passed = [
                        r
                        for r in load_jsonl(output_path)
                        if _lecture_of_row(r) not in rerun_lectures
                    ]
                if rejected_path.is_file():
                    existing_rejected = [
                        r
                        for r in load_jsonl(rejected_path)
                        if _lecture_of_row(r) not in rerun_lectures
                    ]
                if self.sync_active_triplets or self.textbook_kg_enabled:
                    existing_triplets = self._load_triplets_excluding_lectures(
                        triplets_path, rerun_lectures
                    )
                if self.llm_only_enabled:
                    existing_llm_only = self._load_triplets_excluding_lectures(
                        llm_only_path, rerun_lectures
                    )

            merged_passed = existing_passed + new_passed_rows
            merged_rejected = existing_rejected + new_rejected_rows
            save_jsonl(output_path, merged_passed)
            save_jsonl(rejected_path, merged_rejected)

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
                    active_triplets = list(existing_triplets) + self._tag_llm_only_triplets(
                        new_triplets
                    )
                triplets_path.parent.mkdir(parents=True, exist_ok=True)
                save_jsonl(triplets_path, active_triplets)
                flat_triplets = active_triplets

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
            report_path.write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
            )

            # 输入指纹：全课 + 本轮处理讲次（供 use_existing 校验）
            save_meta(course_meta_path, self._course_input_meta(course_id, input_path))
            meta_dir = self._stage1_meta_dir(output_dir)
            lecture_ids_done = {
                str(p.cue.lecture_id) for p in prepared if p.cue.lecture_id
            }
            for lid in lecture_ids_done:
                save_meta(
                    meta_dir / f"{lid}.json",
                    self._lecture_input_meta(course_id, input_path, lid),
                )

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
