"""Stage 5：FAISS 文本索引（实体 + 边 + 可检索 manifest）。"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import numpy as np

from teachkg.provenance import compact_payload, text_snippets
from teachkg.rag.bm25 import BM25Index
from teachkg.stage3_mmkg.text_embedder import TextEmbedder

logger = logging.getLogger(__name__)


def _entity_doc(ent: dict[str, Any]) -> str:
    parts = [ent.get("name") or ent.get("id", "")]
    if ent.get("description"):
        parts.append(str(ent["description"]))
    zh, en = ent.get("zh", ""), ent.get("en", "")
    if zh:
        parts.append(str(zh))
    if en:
        parts.append(str(en))
    modal = ent.get("modal_evidence") or {}
    for t in modal.get("texts") or []:
        if t.get("context"):
            parts.append(str(t["context"]))
        if t.get("source_text"):
            parts.append(str(t["source_text"])[:400])
    return " ".join(p for p in parts if p)


def _edge_doc(edge: dict[str, Any]) -> str:
    parts = [
        edge.get("natural_statement", ""),
        edge.get("description", ""),
        edge.get("subject", ""),
        edge.get("object", ""),
        edge.get("abstract_relation", ""),
        edge.get("concrete_relation", ""),
    ]
    parts.extend(text_snippets(edge.get("provenance") or [], max_items=3))
    grounding = edge.get("grounding") or {}
    if grounding.get("context"):
        parts.append(str(grounding["context"]))
    if grounding.get("source_text"):
        parts.append(str(grounding["source_text"]))
    return " ".join(p for p in parts if p)


def build_index_records(mmkg: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    course_id = mmkg.get("course_id", "")
    lecture_id = mmkg.get("lecture_id")

    for ent in mmkg.get("entities") or []:
        eid = ent.get("id") or ent.get("name", "")
        records.append(
            {
                "id": f"entity:{eid}",
                "type": "entity",
                "course_id": course_id,
                "lecture_id": lecture_id,
                "entity_id": eid,
                "text": _entity_doc(ent),
                "payload": {
                    "entity_id": eid,
                    "description": ent.get("description", ""),
                    "modal_links": ent.get("modal_links", []),
                },
            }
        )

    for i, edge in enumerate(mmkg.get("edges") or []):
        records.append(
            {
                "id": f"edge:{i}:{edge.get('subject')}->{edge.get('object')}",
                "type": "edge",
                "course_id": course_id,
                "lecture_id": lecture_id,
                "text": _edge_doc(edge),
                "payload": {
                    "subject": edge.get("subject"),
                    "object": edge.get("object"),
                    "abstract_relation": edge.get("abstract_relation"),
                    "natural_statement": edge.get("natural_statement"),
                    "description": edge.get("description", ""),
                    "grounding": edge.get("grounding"),
                    "provenance": compact_payload(edge.get("provenance") or []),
                },
            }
        )
    return records


class MMKGIndex:
    def __init__(self, embedder: TextEmbedder | None = None) -> None:
        self.embedder = embedder or TextEmbedder()
        self.records: list[dict[str, Any]] = []
        self.vectors: np.ndarray | None = None
        self._faiss_index: Any = None
        self.bm25: BM25Index | None = None

    def build(self, mmkg: dict[str, Any]) -> None:
        self.records = build_index_records(mmkg)
        texts = [r["text"] for r in self.records]
        self.vectors = self.embedder.embed(texts)
        self.bm25 = BM25Index(texts)
        self._build_faiss()

    def _build_faiss(self) -> None:
        if self.vectors is None or len(self.vectors) == 0:
            self._faiss_index = None
            return
        try:
            import faiss

            dim = self.vectors.shape[1]
            index = faiss.IndexFlatIP(dim)
            index.add(self.vectors.astype(np.float32))
            self._faiss_index = index
        except ImportError:
            logger.warning("faiss not installed; search will use numpy brute force")
            self._faiss_index = None

    def search(self, query: str, top_k: int = 5) -> list[dict[str, Any]]:
        if not self.records or self.vectors is None:
            return []
        q = self.embedder.embed_one(query).astype(np.float32).reshape(1, -1)

        if self._faiss_index is not None:
            import faiss

            scores, indices = self._faiss_index.search(q, min(top_k, len(self.records)))
            hits: list[dict[str, Any]] = []
            for score, idx in zip(scores[0], indices[0], strict=True):
                if idx < 0:
                    continue
                rec = dict(self.records[idx])
                rec["score"] = float(score)
                hits.append(rec)
            return hits

        sims = (self.vectors @ q.T).flatten()
        order = np.argsort(-sims)[:top_k]
        return [
            {**self.records[i], "score": float(sims[i])}
            for i in order
        ]

    def save(self, index_dir: Path) -> None:
        index_dir.mkdir(parents=True, exist_ok=True)
        manifest = {
            "record_count": len(self.records),
            "embedder_backend": self.embedder.backend,
            "embedder_model": self.embedder.model_name,
            "dim": self.embedder.dim,
            "records": self.records,
        }
        (index_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        if self.vectors is not None:
            np.save(index_dir / "vectors.npy", self.vectors)
        if self.bm25 is not None:
            self.bm25.save(index_dir / "bm25.json")
        if self._faiss_index is not None:
            import faiss
            import shutil
            import tempfile

            # Windows 下 faiss C API 对含中文路径的 fopen 常失败；先写到 ASCII 临时文件再复制
            target = (index_dir / "faiss.index").resolve()
            fd, tmp_name = tempfile.mkstemp(prefix="faiss_", suffix=".index")
            try:
                import os

                os.close(fd)
                faiss.write_index(self._faiss_index, tmp_name)
                shutil.copyfile(tmp_name, target)
            finally:
                Path(tmp_name).unlink(missing_ok=True)
        elif (index_dir / "faiss.index").is_file():
            (index_dir / "faiss.index").unlink(missing_ok=True)
        logger.info("Saved MMKG index to %s (%d records)", index_dir, len(self.records))

    @classmethod
    def load(cls, index_dir: Path) -> MMKGIndex:
        manifest_path = index_dir / "manifest.json"
        if not manifest_path.is_file():
            raise FileNotFoundError(f"Index manifest not found: {manifest_path}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        model_name = manifest.get("embedder_model", "paraphrase-multilingual-MiniLM-L12-v2")
        obj = cls(embedder=TextEmbedder(model_name=model_name))
        obj.records = manifest.get("records") or []
        vec_path = index_dir / "vectors.npy"
        if vec_path.is_file():
            obj.vectors = np.load(vec_path)
        bm25_path = index_dir / "bm25.json"
        if bm25_path.is_file():
            obj.bm25 = BM25Index.load(bm25_path)
        elif obj.records:
            texts = [r.get("text") or "" for r in obj.records]
            obj.bm25 = BM25Index(texts)
            logger.info("Rebuilt BM25 index from manifest records (%d docs)", len(texts))
        faiss_path = index_dir / "faiss.index"
        if faiss_path.is_file():
            try:
                import faiss

                obj._faiss_index = faiss.read_index(str(faiss_path))
            except ImportError:
                logger.warning("faiss not installed; search will use numpy brute force")
        elif obj.vectors is not None and len(obj.vectors) > 0:
            obj._build_faiss()
            if obj._faiss_index is not None:
                try:
                    import faiss

                    faiss.write_index(obj._faiss_index, str(faiss_path))
                    logger.info("Rebuilt missing faiss.index from vectors.npy")
                except ImportError:
                    pass
        if obj.embedder.backend == "hash" and manifest.get("embedder_backend") == "sentence_transformers":
            obj.embedder._load_st()
        return obj


def build_and_save_index(mmkg: dict[str, Any], index_dir: Path) -> dict[str, Any]:
    index = MMKGIndex()
    index.build(mmkg)
    index.save(index_dir)
    return {
        "index_dir": str(index_dir),
        "record_count": len(index.records),
        "embedder_backend": index.embedder.backend,
    }
