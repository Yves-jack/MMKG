"""Stage 3–5：多模态知识图谱构建流水线（混合路线）。"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Literal

from teachkg.config import TeachKGConfig
from teachkg.stage3_mmkg.alignment import apply_alignment_scores
from teachkg.stage3_mmkg.entity_describe import enrich_entity_descriptions
from teachkg.stage3_mmkg.evidence_attach import attach_multimodal_evidence
from teachkg.stage3_mmkg.index_builder import MMKGIndex, build_and_save_index
from teachkg.stage3_mmkg.text_embedder import TextEmbedder
from teachkg.utils.io import load_jsonl
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config

logger = logging.getLogger(__name__)

StepName = Literal["evidence", "alignment", "describe", "index", "all"]


class Stage3MMKGPipeline:
    def __init__(
        self,
        config: TeachKGConfig,
        project_root: Path | None = None,
        mock: bool = False,
    ) -> None:
        self.config = config
        self.project_root = project_root or Path(__file__).resolve().parents[2]
        self.mock = mock

        s3 = config.get("stage3", default={})
        self.use_existing = s3.get("use_existing_artifacts", True)
        self.input_kg = s3.get("input_kg", "kg.json")
        self.input_triplets = s3.get("input_triplets", "triplets.jsonl")
        self.output_filename = s3.get("output_filename", "mmkg.json")
        self.report_filename = s3.get("report_filename", "stage3_mmkg_report.json")

        ev_cfg = s3.get("evidence_attach", {})
        self.evidence_enabled = ev_cfg.get("enabled", True)

        align_cfg = s3.get("alignment", {})
        self.alignment_enabled = align_cfg.get("enabled", True)
        self.clap_min_score = float(align_cfg.get("clap_min_score", 0.0))
        self.clip_min_score = float(align_cfg.get("clip_min_score", 0.0))
        self.alignment_skip_if_unavailable = align_cfg.get("skip_if_encoders_unavailable", True)
        self.video_grounding_enabled = bool(align_cfg.get("video_grounding_enabled", False))
        self.video_max_frames = int(align_cfg.get("video_max_frames", 4))

        desc_cfg = s3.get("entity_describe", {})
        self.describe_enabled = desc_cfg.get("enabled", True)

        idx_cfg = s3.get("index", {})
        self.index_enabled = idx_cfg.get("enabled", True)
        self.index_subdir = idx_cfg.get("subdir", "mmkg_index")
        self.embedder_model = idx_cfg.get("embedder_model", "paraphrase-multilingual-MiniLM-L12-v2")

        self.llm_cfg = config.get("llm", default={})

    @property
    def kg_dir(self) -> Path:
        return Path(self.config.get("project", "kg_dir", default="data/kg"))

    @property
    def index_dir(self) -> Path:
        return Path(self.config.get("project", "index_dir", default="data/index"))

    @property
    def processed_dir(self) -> Path:
        return Path(self.config.get("project", "output_dir", default="data/processed"))

    def _base_dir(self, course_id: str, lecture_id: str | None) -> Path:
        if lecture_id:
            return self.kg_dir / course_id / f"lecture_{lecture_id}"
        return self.kg_dir / course_id

    def _load_course_context(self, course_id: str) -> str:
        syllabus_dir = Path(self.config.get("project", "workspace_dir", default="data/raw")) / course_id / "syllabus"
        if syllabus_dir.is_dir():
            parts = []
            for p in sorted(syllabus_dir.glob("*")):
                if p.suffix.lower() in {".txt", ".md"}:
                    parts.append(p.read_text(encoding="utf-8")[:2000])
            if parts:
                return "\n".join(parts)[:4000]
        return course_id

    def _filter_triplets(self, triplets: list[dict[str, Any]], lecture_id: str | None) -> list[dict[str, Any]]:
        if not lecture_id:
            return triplets
        return [t for t in triplets if str(t.get("lecture_id", "")) == str(lecture_id)]

    def _load_inputs(
        self,
        course_id: str,
        lecture_id: str | None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        base = self._base_dir(course_id, lecture_id)
        kg_path = base / self.input_kg
        triplets_path = self.kg_dir / course_id / self.input_triplets

        if not kg_path.is_file():
            raise FileNotFoundError(f"Stage 2 KG not found: {kg_path}. Run stage2 first.")
        if not triplets_path.is_file():
            raise FileNotFoundError(f"Stage 1 triplets not found: {triplets_path}")

        kg = json.loads(kg_path.read_text(encoding="utf-8"))
        triplets = self._filter_triplets(load_jsonl(triplets_path), lecture_id)
        return kg, triplets

    def _make_llm_client(self) -> LLMClient:
        settings = llm_settings_from_config(self.llm_cfg)
        return LLMClient(**settings)

    def _get_encoders(self) -> tuple[Any | None, Any | None]:
        clap_encoder = None
        clip_encoder = None
        if not self.alignment_enabled:
            return clap_encoder, clip_encoder
        try:
            from teachkg.models.multimodal_encoders import ChineseClipEncoder, ClapEncoder
            from teachkg.utils.torch_device import torch_is_usable

            if not torch_is_usable():
                logger.warning(
                    "PyTorch not usable in current interpreter; skip alignment scoring. "
                    "Use conda env auto-edukg: D:\\software\\anaconda\\envs\\auto-edukg\\python.exe"
                )
                return clap_encoder, clip_encoder

            clap = ClapEncoder()
            if not clap.warmup() and self.alignment_skip_if_unavailable:
                clap = None
            else:
                clap_encoder = clap
            clip = ChineseClipEncoder()
            clip.warmup()
            clip_encoder = clip
        except Exception as exc:  # noqa: BLE001
            logger.warning("Multimodal encoders unavailable: %s", exc)
        return clap_encoder, clip_encoder

    def _save_mmkg(self, mmkg: dict[str, Any], path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(mmkg, ensure_ascii=False, indent=2), encoding="utf-8")

    def run(
        self,
        course_id: str,
        *,
        lecture_id: str | None = None,
        force: bool = False,
        steps: StepName | list[StepName] | None = "all",
    ) -> Path:
        base = self._base_dir(course_id, lecture_id)
        mmkg_path = base / self.output_filename
        report_path = self.processed_dir / course_id / self.report_filename
        if lecture_id:
            report_path = self.processed_dir / course_id / f"stage3_mmkg_report_lecture_{lecture_id}.json"

        step_list: list[str]
        if steps == "all" or steps is None:
            step_list = ["evidence", "alignment", "describe", "index"]
        elif isinstance(steps, str):
            step_list = [steps] if steps != "all" else ["evidence", "alignment", "describe", "index"]
        else:
            step_list = list(steps)

        if self.use_existing and not force and mmkg_path.is_file() and step_list == ["evidence", "alignment", "describe", "index"]:
            logger.info("Reuse existing MMKG: %s", mmkg_path)
            return mmkg_path

        kg, triplets = self._load_inputs(course_id, lecture_id)

        if mmkg_path.is_file() and step_list != ["evidence", "alignment", "describe", "index"]:
            mmkg = json.loads(mmkg_path.read_text(encoding="utf-8"))
        else:
            mmkg = {
                "course_id": course_id,
                "lecture_id": lecture_id,
                "schema_version": "teachkg-mmkg-v1",
                "pipeline_stages": [],
                "entities": kg.get("entities") or [],
                "edges": kg.get("edges") or [],
                "stats": {},
            }

        report: dict[str, Any] = {
            "course_id": course_id,
            "lecture_id": lecture_id,
            "steps_run": [],
        }

        if "evidence" in step_list and self.evidence_enabled:
            logger.info("Stage 3a: attaching multimodal evidence")
            result = attach_multimodal_evidence(kg, triplets)
            mmkg["entities"] = result.entities
            mmkg["edges"] = result.edges
            mmkg["stats"] = {**(mmkg.get("stats") or {}), **result.stats}
            mmkg.setdefault("pipeline_stages", []).append("evidence_attach")
            report["steps_run"].append("evidence")
            report["evidence_stats"] = result.stats

        if "alignment" in step_list and self.alignment_enabled:
            logger.info("Stage 3b: cross-modal alignment scoring")
            clap_enc, clip_enc = self._get_encoders()
            mmkg = apply_alignment_scores(
                mmkg,
                project_root=self.project_root,
                clap_encoder=clap_enc,
                clip_encoder=clip_enc,
                clap_min_score=self.clap_min_score,
                clip_min_score=self.clip_min_score,
                video_grounding_enabled=self.video_grounding_enabled,
                video_max_frames=self.video_max_frames,
            )
            mmkg.setdefault("pipeline_stages", []).append("alignment_score")
            report["steps_run"].append("alignment")
            report["alignment_stats"] = mmkg.get("stats", {}).get("alignment")

        if "describe" in step_list and self.describe_enabled:
            logger.info("Stage 4: generating entity descriptions")
            course_context = self._load_course_context(course_id)
            llm = None if self.mock else self._make_llm_client()
            mmkg = enrich_entity_descriptions(
                mmkg,
                triplets,
                course_context=course_context,
                llm_client=llm,
                mock=self.mock,
            )
            mmkg.setdefault("pipeline_stages", []).append("entity_describe")
            report["steps_run"].append("describe")
            report["describe_stats"] = mmkg.get("stats", {}).get("entity_descriptions")

        self._save_mmkg(mmkg, mmkg_path)
        report["mmkg_path"] = str(mmkg_path)

        if "index" in step_list and self.index_enabled:
            logger.info("Stage 5: building FAISS text index")
            from teachkg.stage3_mmkg.index_builder import MMKGIndex

            idx_dir = self.index_dir / course_id
            if lecture_id:
                idx_dir = idx_dir / f"lecture_{lecture_id}"
            else:
                idx_dir = idx_dir / "course"
            idx_dir = idx_dir / self.index_subdir
            index = MMKGIndex(embedder=TextEmbedder(model_name=self.embedder_model))
            index.build(mmkg)
            index.save(idx_dir)
            idx_stats = {
                "index_dir": str(idx_dir),
                "record_count": len(index.records),
                "embedder_backend": index.embedder.backend,
                "embedder_model": self.embedder_model,
            }
            mmkg.setdefault("pipeline_stages", []).append("faiss_index")
            mmkg["index_manifest"] = idx_stats
            self._save_mmkg(mmkg, mmkg_path)
            report["steps_run"].append("index")
            report["index_stats"] = idx_stats

        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

        logger.info("MMKG pipeline done → %s", mmkg_path)
        return mmkg_path
