"""教材实体向量预计算与缓存。"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

CACHE_MATRIX = "entity_embeddings.npy"
CACHE_MANIFEST = "entity_embeddings_manifest.json"


def _entity_text(name: str, definition: str = "") -> str:
    if definition:
        return f"{name}。{definition[:300]}"
    return name


def cache_paths(base_path: Path) -> tuple[Path, Path]:
    base = Path(base_path)
    return base / CACHE_MATRIX, base / CACHE_MANIFEST


def load_entity_embeddings(
    base_path: Path,
    *,
    entity_names: list[str],
    entity_texts: list[str],
    embedder_model: str,
    force_rebuild: bool = False,
) -> tuple[list[str], np.ndarray]:
    """加载或构建教材实体 embedding 矩阵。"""
    matrix_path, manifest_path = cache_paths(base_path)
    if (
        not force_rebuild
        and matrix_path.is_file()
        and manifest_path.is_file()
    ):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("embedder_model") == embedder_model and manifest.get("entity_names") == entity_names:
            matrix = np.load(matrix_path)
            logger.info("Loaded cached entity embeddings: %s (%d entities)", matrix_path, len(entity_names))
            return entity_names, matrix

    from teachkg.stage3_mmkg.text_embedder import TextEmbedder

    embedder = TextEmbedder(model_name=embedder_model)
    matrix = embedder.embed(entity_texts)
    matrix_path.parent.mkdir(parents=True, exist_ok=True)
    np.save(matrix_path, matrix)
    manifest_path.write_text(
        json.dumps(
            {
                "embedder_model": embedder_model,
                "entity_count": len(entity_names),
                "entity_names": entity_names,
                "dim": int(matrix.shape[1]) if matrix.ndim == 2 else 0,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    logger.info("Built entity embedding cache: %s (%d entities)", matrix_path, len(entity_names))
    return entity_names, matrix


def build_entity_texts(kg) -> tuple[list[str], list[str]]:
    names: list[str] = []
    texts: list[str] = []
    for name in kg.entity_names:
        ent = kg.entities.get(name)
        definition = ent.definition if ent else ""
        names.append(name)
        texts.append(_entity_text(name, definition))
    return names, texts
