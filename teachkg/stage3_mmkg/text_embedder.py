"""轻量文本嵌入：优先 sentence-transformers，回退哈希向量。"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


class TextEmbedder:
    def __init__(self, model_name: str = "paraphrase-multilingual-MiniLM-L12-v2") -> None:
        self.model_name = model_name
        self._model: Any = None
        self._backend = "hash"

    @property
    def backend(self) -> str:
        return self._backend

    @property
    def dim(self) -> int:
        if self._backend == "sentence_transformers":
            return int(self._model.get_sentence_embedding_dimension())
        return 384

    def _load_st(self) -> bool:
        try:
            from sentence_transformers import SentenceTransformer

            logger.info("Loading SentenceTransformer: %s", self.model_name)
            try:
                self._model = SentenceTransformer(self.model_name, local_files_only=True)
                logger.info("Loaded SentenceTransformer from local cache")
            except Exception:
                self._model = SentenceTransformer(self.model_name)
            self._backend = "sentence_transformers"
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("SentenceTransformer unavailable, using hash embedder: %s", exc)
            return False

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        if self._model is None:
            self._load_st()
        if self._backend == "sentence_transformers":
            vecs = self._model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
            return np.asarray(vecs, dtype=np.float32)
        return np.stack([self._hash_embed(t) for t in texts], axis=0)

    def embed_one(self, text: str) -> np.ndarray:
        return self.embed([text])[0]

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        tokens: list[str] = []
        word: list[str] = []
        for ch in text.lower():
            if "\u4e00" <= ch <= "\u9fff":
                if word:
                    tokens.append("".join(word))
                    word = []
                tokens.append(ch)
            elif ch.isalnum():
                word.append(ch)
            else:
                if word:
                    tokens.append("".join(word))
                    word = []
        if word:
            tokens.append("".join(word))
        return tokens

    @staticmethod
    def _hash_embed(text: str, dim: int = 384) -> np.ndarray:
        vec = np.zeros(dim, dtype=np.float32)
        for tok in TextEmbedder._tokenize(text):
            h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
            idx = h % dim
            sign = 1.0 if (h >> 1) & 1 else -1.0
            vec[idx] += sign
        norm = np.linalg.norm(vec)
        if norm > 1e-8:
            vec /= norm
        return vec
