"""教学多模态知识图谱 RAG 问答。

流水线：媒体解析 → 路由 → 检索 → 证据加权 → 生成 → 校验 → 引用
对外仍暴露 MMKGRAG.answer / retrieve，保持脚本与评测兼容。
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from teachkg.config import TeachKGConfig
from teachkg.rag.answer_checker import (
    check_answer,
    extract_evidence_citations,
    format_citations_text,
)
from teachkg.rag.evidence import (
    boost_grounded_hits,
    collect_evidence_image_paths,
    format_hit_for_context,
    merge_image_paths,
)
from teachkg.rag.hybrid_retriever import hybrid_search
from teachkg.rag.multi_turn import (
    ConversationTurn,
    analyze_multi_turn_retrieval,
    build_retrieval_query,
    format_conversation_history,
)
from teachkg.rag.query_media import MediaBundle, build_media_bundle, normalize_upload_paths
from teachkg.rag.router import plan_route
from teachkg.rag.types import PipelineTrace
from teachkg.stage3_mmkg.index_builder import MMKGIndex
from teachkg.utils.llm_client import LLMClient, llm_settings_from_config
from teachkg.utils.prompts import format_prompt

logger = logging.getLogger(__name__)

_LECTURE_HINT = re.compile(r"(?:第\s*([0-9一二三四五六七八九十]+)\s*讲|lecture\s*([0-9]+))", re.I)

# 兼容旧 import 路径
__all__ = ["MMKGRAG", "format_hit_for_context", "infer_lecture_hint"]


def infer_lecture_hint(question: str) -> str | None:
    m = _LECTURE_HINT.search(question)
    if not m:
        return None
    raw = m.group(1) or m.group(2)
    zh_map = {"一": "1", "二": "2", "三": "3", "四": "4", "五": "5"}
    if raw in zh_map:
        return zh_map[raw]
    return str(raw)


def _filter_hits_by_lecture(hits: list[dict[str, Any]], lecture_id: str | None) -> list[dict[str, Any]]:
    if not lecture_id:
        return hits
    lid = str(lecture_id)
    filtered: list[dict[str, Any]] = []
    for h in hits:
        h_lid = h.get("lecture_id")
        if h_lid is None or str(h_lid) == lid:
            filtered.append(h)
    return filtered


class MMKGRAG:
    def __init__(
        self,
        config: TeachKGConfig,
        *,
        project_root: Path | None = None,
        llm_client: LLMClient | None = None,
        mock: bool = False,
    ) -> None:
        self.config = config
        self.project_root = project_root or Path(__file__).resolve().parents[2]
        self.mock = mock

        rag_cfg = config.get("stage4", default={}).get("rag", {})
        self.top_k = int(rag_cfg.get("top_k", 5))
        self.min_score = float(rag_cfg.get("min_score", 0.15))
        self.index_subdir = rag_cfg.get("index_subdir") or config.get("stage3", "index", default={}).get(
            "subdir", "mmkg_index"
        )
        self.embedder_model = rag_cfg.get("embedder_model") or config.get("stage3", "index", default={}).get(
            "embedder_model", "paraphrase-multilingual-MiniLM-L12-v2"
        )
        self.check_enabled = bool(rag_cfg.get("check_enabled", True))
        self.check_strict = bool(rag_cfg.get("check_strict", False))
        self.check_min_confidence = float(rag_cfg.get("check_min_confidence", 0.75))
        self.hybrid_enabled = bool(rag_cfg.get("hybrid_enabled", True))
        self.vector_weight = float(rag_cfg.get("vector_weight", 0.65))
        self.bm25_weight = float(rag_cfg.get("bm25_weight", 0.35))
        self.graph_hops = int(rag_cfg.get("graph_hops", 1))
        self.graph_max = int(rag_cfg.get("graph_max", 5))
        self.reject_on_unsupported = bool(rag_cfg.get("reject_on_unsupported", False))
        self.conversation_turns = int(
            rag_cfg.get("conversation_turns", rag_cfg.get("history_max_turns", 4))
        )
        self.auto_lecture_hint = bool(
            rag_cfg.get("auto_lecture_hint", rag_cfg.get("infer_lecture", True))
        )
        self.retrieval_scope = str(rag_cfg.get("retrieval_scope", "course")).strip().lower()
        self.clap_downweight_threshold = float(rag_cfg.get("clap_downweight_threshold", 0.12))
        self.clap_downweight_factor = float(rag_cfg.get("clap_downweight_factor", 0.5))
        self.append_citations = bool(rag_cfg.get("append_citations", True))
        mt_cfg = rag_cfg.get("multi_turn", {}) or {}
        self.multi_turn_enabled = bool(mt_cfg.get("enabled", True))
        self.multi_turn_retrieval_rewrite = bool(mt_cfg.get("retrieval_rewrite", True))
        self.multi_turn_context_turns = int(mt_cfg.get("max_context_turns", 2))
        self.multi_turn_score_threshold = float(mt_cfg.get("score_threshold", 2.0))
        self.show_retrieval_analysis = bool(mt_cfg.get("show_analysis", True))
        mq_cfg = rag_cfg.get("multimodal_query", {}) or {}
        self.multimodal_query_enabled = bool(mq_cfg.get("enabled", True))
        self.vision_model = mq_cfg.get("vision_model") or "qwen-vl-plus"
        self.vision_for_answer = bool(mq_cfg.get("vision_for_answer", True))
        self.media_max_file_chars = int(mq_cfg.get("max_file_chars", 8000))
        self.media_video_max_frames = int(mq_cfg.get("video_max_frames", 3))
        self.media_video_interval = float(mq_cfg.get("video_frame_interval_sec", 5.0))
        self.media_work_dir = self.project_root / ".cache" / "rag_query_media"
        pipe_cfg = rag_cfg.get("pipeline", {}) or {}
        self.evidence_boost = bool(pipe_cfg.get("evidence_boost", True))
        self.evidence_boost_factor = float(pipe_cfg.get("evidence_boost_factor", 1.15))
        self.attach_hit_images = bool(pipe_cfg.get("attach_hit_images", True))
        self.max_evidence_images = int(pipe_cfg.get("max_evidence_images", 4))
        self.max_vision_images = int(pipe_cfg.get("max_vision_images", 6))
        llm_cfg = config.get("llm", default={})
        self.llm_client = llm_client or LLMClient(**llm_settings_from_config(llm_cfg))
        self._history: list[ConversationTurn] = []
        self._index_cache: dict[tuple[str, str | None], MMKGIndex] = {}
        self._mmkg_cache: dict[tuple[str, str | None], dict[str, Any]] = {}

    def clear_cache(self) -> None:
        self._index_cache.clear()
        self._mmkg_cache.clear()

    @property
    def kg_dir(self) -> Path:
        return Path(self.config.get("project", "kg_dir", default="data/kg"))

    @property
    def index_dir(self) -> Path:
        return Path(self.config.get("project", "index_dir", default="data/index"))

    def _index_path(self, course_id: str, lecture_id: str | None) -> Path:
        base = self.index_dir / course_id
        if lecture_id:
            return base / f"lecture_{lecture_id}" / self.index_subdir
        return base / "course" / self.index_subdir

    def _load_mmkg(self, course_id: str, lecture_id: str | None) -> dict[str, Any]:
        key = (course_id, lecture_id)
        if key in self._mmkg_cache:
            return self._mmkg_cache[key]
        base = self.kg_dir / course_id
        path = base / f"lecture_{lecture_id}" / "mmkg.json" if lecture_id else base / "mmkg.json"
        if not path.is_file():
            raise FileNotFoundError(f"MMKG not found: {path}")
        mmkg = json.loads(path.read_text(encoding="utf-8"))
        self._mmkg_cache[key] = mmkg
        return mmkg

    def _get_index(self, course_id: str, lecture_id: str | None) -> MMKGIndex:
        key = (course_id, lecture_id)
        if key not in self._index_cache:
            idx_path = self._index_path(course_id, lecture_id)
            if not idx_path.is_dir():
                raise FileNotFoundError(f"Index not found: {idx_path}")
            self._index_cache[key] = MMKGIndex.load(idx_path)
        return self._index_cache[key]

    def _load_course_context(self, course_id: str) -> str:
        syllabus_dir = (
            Path(self.config.get("project", "workspace_dir", default="data/raw"))
            / course_id
            / "syllabus"
        )
        if syllabus_dir.is_dir():
            parts = []
            for p in sorted(syllabus_dir.glob("*")):
                if p.suffix.lower() in {".txt", ".md"}:
                    parts.append(p.read_text(encoding="utf-8")[:1500])
            if parts:
                return "\n".join(parts)[:3000]
        return course_id

    def _resolve_lecture_id(self, question: str, lecture_id: str | None) -> str | None:
        if lecture_id:
            return lecture_id
        if self.auto_lecture_hint:
            return infer_lecture_hint(question)
        return None

    def _index_lecture_id(self, lecture_id: str | None) -> str | None:
        if self.retrieval_scope == "course":
            return None
        return lecture_id

    def _should_filter_by_lecture(
        self, lecture_id: str | None, effective_lecture: str | None
    ) -> bool:
        if self.retrieval_scope == "course":
            return False
        return lecture_id is None and bool(effective_lecture)

    def _downweight_low_alignment(self, hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.clap_downweight_threshold <= 0:
            return hits
        adjusted: list[dict[str, Any]] = []
        for h in hits:
            item = dict(h)
            align = ((item.get("payload") or {}).get("grounding") or {}).get("alignment") or {}
            clap = align.get("clap_audio_text")
            if isinstance(clap, (int, float)) and float(clap) < self.clap_downweight_threshold:
                item["score"] = float(item.get("score", 0)) * self.clap_downweight_factor
                item["alignment_penalty"] = True
            adjusted.append(item)
        adjusted.sort(key=lambda x: -float(x.get("score", 0)))
        return adjusted

    def retrieve(
        self,
        question: str,
        course_id: str,
        *,
        lecture_id: str | None = None,
        top_k: int | None = None,
        use_history: bool = False,
        retrieval_query: str | None = None,
    ) -> list[dict[str, Any]]:
        effective_lecture = self._resolve_lecture_id(question, lecture_id)
        k = top_k or self.top_k
        search_query = retrieval_query or question
        if retrieval_query is None and use_history:
            search_query, _ = self._resolve_retrieval_query(question, use_history=True)

        index_lecture = self._index_lecture_id(lecture_id)
        index = self._get_index(course_id, index_lecture)

        mmkg_for_graph = None
        if self.hybrid_enabled and self.graph_hops > 0:
            try:
                mmkg_for_graph = self._load_mmkg(course_id, index_lecture)
            except FileNotFoundError:
                pass

        if self.hybrid_enabled:
            hits = hybrid_search(
                index,
                search_query,
                top_k=k,
                vector_weight=self.vector_weight,
                bm25_weight=self.bm25_weight,
                mmkg=mmkg_for_graph,
                graph_hops=self.graph_hops if mmkg_for_graph else 0,
                graph_max=self.graph_max,
            )
        else:
            hits = index.search(search_query, top_k=k)

        if self._should_filter_by_lecture(lecture_id, effective_lecture):
            hits = _filter_hits_by_lecture(hits, effective_lecture)

        hits = self._downweight_low_alignment(hits)
        if self.min_score > 0:
            hits = [h for h in hits if h.get("score", 0) >= self.min_score]
        return hits

    def _resolve_retrieval_query(
        self,
        question: str,
        *,
        use_history: bool,
    ) -> tuple[str, dict[str, Any]]:
        if not use_history or not self.multi_turn_enabled or not self.multi_turn_retrieval_rewrite:
            analysis = analyze_multi_turn_retrieval(question, [])
            meta = analysis.to_dict()
            meta["rewritten"] = False
            meta["disabled"] = True
            meta["reason"] = "多轮检索未启用或无历史"
            return question, meta
        history_pairs = [(t.question, t.answer) for t in self._history]
        return build_retrieval_query(
            question,
            history_pairs,
            max_context_turns=self.multi_turn_context_turns,
            score_threshold=self.multi_turn_score_threshold,
        )

    def _format_history(self) -> str:
        if not self._history:
            return ""
        return format_conversation_history(self._history, max_turns=self.conversation_turns)

    def prepare_media(
        self,
        *,
        image: str | Path | None = None,
        files: list[str | Path] | None = None,
        video: str | Path | None = None,
        media_paths: list[str | Path] | None = None,
    ) -> MediaBundle:
        if not self.multimodal_query_enabled:
            return MediaBundle()
        paths = list(media_paths or [])
        paths.extend(normalize_upload_paths(image=image, files=files, video=video))
        uniq: list[Path] = []
        seen: set[str] = set()
        for p in paths:
            key = str(Path(p).resolve()) if Path(p).exists() else str(p)
            if key in seen:
                continue
            seen.add(key)
            uniq.append(Path(p))
        if not uniq:
            return MediaBundle()
        return build_media_bundle(
            uniq,
            llm_client=None if self.mock else self.llm_client,
            vision_model=None if self.mock else self.vision_model,
            max_file_chars=self.media_max_file_chars,
            video_max_frames=self.media_video_max_frames,
            video_frame_interval_sec=self.media_video_interval,
            work_dir=self.media_work_dir,
        )

    def answer(
        self,
        question: str,
        course_id: str,
        *,
        lecture_id: str | None = None,
        top_k: int | None = None,
        check: bool | None = None,
        use_history: bool = True,
        image: str | Path | None = None,
        files: list[str | Path] | None = None,
        video: str | Path | None = None,
        media_paths: list[str | Path] | None = None,
        media: MediaBundle | None = None,
    ) -> dict[str, Any]:
        trace = PipelineTrace()

        # 1) 媒体解析
        media_bundle = media or self.prepare_media(
            image=image, files=files, video=video, media_paths=media_paths
        )
        trace.mark("media", f"attachments={len(media_bundle.attachments)}")

        user_question = (question or "").strip()
        if not user_question and media_bundle.has_media:
            user_question = "请结合我上传的附件，结合课程知识说明其中的关键内容。"
        if not user_question:
            return {
                "question": "",
                "answer": "请输入问题，或上传图片/文件/视频后再提问。",
                "hits": [],
                "citations": [],
                "media": media_bundle.to_dict(),
                "pipeline": trace.to_dict(),
            }

        # 2) 路由
        route = plan_route(
            user_question,
            media_bundle,
            multimodal_enabled=self.multimodal_query_enabled,
            vision_for_answer=self.vision_for_answer,
            attach_hit_images=self.attach_hit_images,
            boost_grounded_hits=self.evidence_boost,
        )
        trace.route = route.to_dict()
        trace.mark("route", route.reason)

        # 3) 多轮改写 + 媒体增强 query
        effective_lecture = self._resolve_lecture_id(user_question, lecture_id)
        rewrite_meta: dict[str, Any] = {"original_question": user_question, "rewritten": False}
        if use_history and self.multi_turn_enabled and self.multi_turn_retrieval_rewrite:
            _, rewrite_meta = self._resolve_retrieval_query(user_question, use_history=True)
        retrieval_query = (
            rewrite_meta.get("retrieval_query", user_question)
            if rewrite_meta.get("rewritten")
            else user_question
        )
        if route.parse_user_media and media_bundle.retrieval_extra:
            retrieval_query = f"{retrieval_query}\n\n{media_bundle.retrieval_extra}".strip()
        trace.mark("query", f"rewritten={bool(rewrite_meta.get('rewritten'))}")

        # 4) 检索
        hits = self.retrieve(
            user_question,
            course_id,
            lecture_id=lecture_id,
            top_k=top_k,
            use_history=use_history,
            retrieval_query=retrieval_query,
        )
        trace.mark("retrieve", f"hits={len(hits)}")

        # 5) 证据加权（缓解纯文本偏见）
        if route.boost_grounded_hits and hits:
            hits = boost_grounded_hits(hits, factor=self.evidence_boost_factor)
            if self.top_k:
                hits = hits[: max(self.top_k + self.graph_max, self.top_k)]
            trace.mark("evidence_boost", f"factor={self.evidence_boost_factor}")

        if not hits:
            return {
                "question": user_question,
                "answer": "依据现有知识图谱索引，未检索到相关内容。",
                "hits": [],
                "citations": [],
                "retrieval_query": retrieval_query,
                "retrieval_analysis": rewrite_meta,
                "media": media_bundle.to_dict(),
                "pipeline": trace.to_dict(),
                "check": {
                    "verdict": "unsupported",
                    "confidence": 1.0,
                    "supported_claims": [],
                    "unsupported_claims": ["无检索命中"],
                    "reason": "检索结果为空",
                },
            }

        # 6) 组装上下文 + 证据图
        context_blocks = [format_hit_for_context(h) for h in hits]
        retrieved_context = "\n\n---\n\n".join(context_blocks)
        course_context = self._load_course_context(course_id)
        history = self._format_history() if use_history else ""
        media_context = media_bundle.question_extra or "（无）"
        display_question = user_question
        if media_bundle.question_extra:
            display_question = (
                f"{user_question}\n\n—— 用户附件解析 ——\n{media_bundle.question_extra}"
            )

        evidence_imgs: list[Path] = []
        if route.attach_hit_images:
            evidence_imgs = collect_evidence_image_paths(
                hits,
                project_root=self.project_root,
                max_images=self.max_evidence_images,
            )
        vision_images = merge_image_paths(
            list(media_bundle.image_paths),
            evidence_imgs,
            max_images=self.max_vision_images,
        )
        trace.mark(
            "evidence_images",
            f"user={len(media_bundle.image_paths)} hit={len(evidence_imgs)} merged={len(vision_images)}",
        )

        # 7) 生成
        if self.mock:
            answer = f"[mock] 基于 {len(hits)} 条检索结果：{hits[0].get('text', '')[:200]}"
            trace.mark("generate", "mock")
        else:
            prompt = format_prompt(
                "rag/mmkg_rag.txt",
                course_context=course_context,
                retrieved_context=retrieved_context,
                question=display_question,
                conversation_history=history or "（无）",
                media_context=media_context,
            )
            use_vision = route.use_vision_answer and bool(vision_images) and bool(self.vision_model)
            if use_vision:
                try:
                    answer = self.llm_client.chat_multimodal(
                        prompt,
                        image_paths=vision_images,
                        temperature=0.2,
                        model=self.vision_model,
                    )
                    trace.mark("generate", f"vision:{self.vision_model}")
                except Exception as exc:  # noqa: BLE001
                    logger.warning("vision answer failed, fallback text LLM: %s", exc)
                    answer = self.llm_client.chat(prompt, temperature=0.2)
                    trace.mark("generate", "text_fallback")
            else:
                answer = self.llm_client.chat(prompt, temperature=0.2)
                trace.mark("generate", "text")

        citations = extract_evidence_citations(hits)
        answer_text = answer.strip()
        cite_footer = format_citations_text(citations) if self.append_citations else ""
        if cite_footer and cite_footer not in answer_text:
            answer_text = f"{answer_text}\n\n{cite_footer}"

        result: dict[str, Any] = {
            "question": user_question,
            "answer": answer_text,
            "hits": hits,
            "citations": citations,
            "citation_footer": cite_footer,
            "course_id": course_id,
            "lecture_id": effective_lecture,
            "retrieval_query": retrieval_query,
            "retrieval_rewrite": rewrite_meta,
            "retrieval_analysis": rewrite_meta,
            "media": media_bundle.to_dict(),
            "route": route.to_dict(),
            "pipeline": trace.to_dict(),
            "evidence_images": [str(p) for p in vision_images],
        }

        # 8) 校验
        do_check = self.check_enabled if check is None else check
        if do_check:
            result["check"] = check_answer(
                question=user_question,
                answer=result["answer"],
                retrieved_context=retrieved_context,
                llm_client=self.llm_client,
                mock=self.mock,
                strict=self.check_strict,
                min_confidence=self.check_min_confidence,
            )
            trace.mark("check", str(result["check"].get("verdict")))
            result["pipeline"] = trace.to_dict()
            if self.reject_on_unsupported and result["check"].get("verdict") == "unsupported":
                result["answer"] = (
                    "抱歉，当前检索证据不足以可靠回答该问题。"
                    f"（校验：{result['check'].get('reason', '')}）"
                )

        if use_history:
            self._history.append(
                ConversationTurn(
                    question=user_question,
                    answer=result["answer"],
                    retrieval_query=retrieval_query,
                    hits=hits,
                    retrieval_analysis=rewrite_meta,
                )
            )
            if len(self._history) > self.conversation_turns * 2:
                self._history = self._history[-self.conversation_turns * 2 :]

        return result

    def reset_history(self) -> None:
        self._history.clear()

    def interactive_loop(
        self,
        course_id: str,
        *,
        lecture_id: str | None = None,
        check: bool | None = None,
    ) -> None:
        banner = f"MMKG RAG · course={course_id} · lecture={lecture_id or 'all'}"
        print(banner)
        print("输入问题，空行或 quit/exit 退出；输入 /reset 清空对话历史。\n")
        while True:
            try:
                question = input("问> ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n再见。")
                break
            if not question or question.lower() in {"quit", "exit", "q"}:
                print("再见。")
                break
            if question.lower() == "/reset":
                self.reset_history()
                print("已清空对话历史。\n")
                continue
            result = self.answer(
                question,
                course_id,
                lecture_id=lecture_id,
                check=check,
            )
            print(f"\n答> {result['answer']}")
            if result.get("pipeline"):
                stages = " → ".join(result["pipeline"].get("stages") or [])
                if stages:
                    print(f"[流水线] {stages}")
            if result.get("check"):
                chk = result["check"]
                print(
                    f"\n[校验] {chk.get('verdict')} (confidence={chk.get('confidence', 0):.2f})"
                    f" — {chk.get('reason', '')}"
                )
            if result.get("citations"):
                print("\n--- 引用证据 ---")
                for i, c in enumerate(result["citations"][:5], 1):
                    parts = [f"{i}."]
                    if c.get("lecture_id") is not None:
                        parts.append(f"L{c['lecture_id']}")
                    if c.get("cue_id"):
                        parts.append(f"cue={c['cue_id']}")
                    if c.get("ppt_page") is not None:
                        parts.append(f"PPT p.{c['ppt_page']}")
                    print(" ".join(parts))
            if self.show_retrieval_analysis and result.get("retrieval_analysis"):
                from teachkg.rag.multi_turn import format_retrieval_analysis

                print(f"\n{format_retrieval_analysis(result['retrieval_analysis'])}")
            print()
