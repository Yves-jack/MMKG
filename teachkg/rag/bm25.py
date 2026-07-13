"""轻量 BM25 检索（倒排索引 + 中文二元组 + 可持久化）。"""

from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path
from typing import Any


def _base_tokenize(text: str) -> list[str]:
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


def tokenize_for_bm25(text: str, *, bigram: bool = True) -> list[str]:
    """分词：英文词 + 中文单字；连续中文片段附加二元组。"""
    tokens = _base_tokenize(text)
    if not bigram:
        return tokens

    chars: list[str] = []
    for ch in text.lower():
        if "\u4e00" <= ch <= "\u9fff":
            chars.append(ch)
        else:
            if len(chars) >= 2:
                for i in range(len(chars) - 1):
                    tokens.append(chars[i] + chars[i + 1])
            chars = []
    if len(chars) >= 2:
        for i in range(len(chars) - 1):
            tokens.append(chars[i] + chars[i + 1])
    return tokens


class BM25Index:
    def __init__(
        self,
        documents: list[str] | None = None,
        *,
        k1: float = 1.5,
        b: float = 0.75,
        bigram: bool = True,
    ) -> None:
        self.k1 = k1
        self.b = b
        self.bigram = bigram
        self.docs: list[str] = []
        self.doc_lens: list[int] = []
        self.avgdl = 0.0
        self.n = 0
        self.df: Counter[str] = Counter()
        self.inverted: dict[str, list[tuple[int, int]]] = {}
        if documents:
            self.build(documents)

    def build(self, documents: list[str]) -> None:
        self.docs = list(documents)
        self.n = len(documents)
        self.doc_lens = []
        self.df = Counter()
        self.inverted = {}

        tokenized: list[list[str]] = []
        for doc in documents:
            tokens = tokenize_for_bm25(doc, bigram=self.bigram)
            tokenized.append(tokens)
            self.doc_lens.append(len(tokens))

        self.avgdl = sum(self.doc_lens) / max(self.n, 1)

        for doc_idx, tokens in enumerate(tokenized):
            tf_map = Counter(tokens)
            for term, tf in tf_map.items():
                self.df[term] += 1
                self.inverted.setdefault(term, []).append((doc_idx, tf))

    def _idf(self, term: str) -> float:
        df = self.df.get(term, 0)
        return math.log(1 + (self.n - df + 0.5) / (df + 0.5))

    def score(self, query: str) -> list[float]:
        q_tokens = tokenize_for_bm25(query, bigram=self.bigram)
        scores = [0.0] * self.n
        for term in q_tokens:
            postings = self.inverted.get(term)
            if not postings:
                continue
            idf = self._idf(term)
            for doc_idx, tf in postings:
                dl = self.doc_lens[doc_idx]
                denom = tf + self.k1 * (1 - self.b + self.b * dl / self.avgdl)
                scores[doc_idx] += idf * (tf * (self.k1 + 1)) / denom
        return scores

    def search(self, query: str, top_k: int = 5) -> list[tuple[int, float]]:
        if self.n == 0:
            return []
        q_tokens = tokenize_for_bm25(query, bigram=self.bigram)
        if not q_tokens:
            return []

        candidate_scores: dict[int, float] = {}
        for term in q_tokens:
            postings = self.inverted.get(term)
            if not postings:
                continue
            idf = self._idf(term)
            for doc_idx, tf in postings:
                dl = self.doc_lens[doc_idx]
                denom = tf + self.k1 * (1 - self.b + self.b * dl / self.avgdl)
                delta = idf * (tf * (self.k1 + 1)) / denom
                candidate_scores[doc_idx] = candidate_scores.get(doc_idx, 0.0) + delta

        ranked = sorted(candidate_scores.items(), key=lambda x: -x[1])[:top_k]
        return [(i, s) for i, s in ranked if s > 0]

    def to_dict(self) -> dict[str, Any]:
        return {
            "k1": self.k1,
            "b": self.b,
            "bigram": self.bigram,
            "n": self.n,
            "avgdl": self.avgdl,
            "doc_lens": self.doc_lens,
            "df": dict(self.df),
            "inverted": {k: v for k, v in self.inverted.items()},
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BM25Index:
        obj = cls(k1=float(data.get("k1", 1.5)), b=float(data.get("b", 0.75)), bigram=bool(data.get("bigram", True)))
        obj.n = int(data.get("n", 0))
        obj.avgdl = float(data.get("avgdl", 0.0))
        obj.doc_lens = list(data.get("doc_lens") or [])
        obj.df = Counter(data.get("df") or {})
        inverted_raw = data.get("inverted") or {}
        obj.inverted = {str(k): [(int(i), int(tf)) for i, tf in v] for k, v in inverted_raw.items()}
        return obj

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> BM25Index:
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls.from_dict(data)


# 兼容旧调用
def _tokenize(text: str) -> list[str]:
    return tokenize_for_bm25(text)
