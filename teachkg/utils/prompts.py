from __future__ import annotations

from pathlib import Path

PROMPT_DIR = Path(__file__).resolve().parents[2] / "prompts"

# 旧路径 → 新路径（分 stage 后兼容）
_LEGACY_ALIASES: dict[str, str] = {
    "asr_correct.txt": "stage0/asr_correct.txt",
    "teaching/cue_text_preprocess.txt": "stage1/cue_text_preprocess.txt",
    "teaching/subgraph_extract.txt": "stage1/subgraph_extract.txt",
    "teaching/subgraph_hybrid_extract.txt": "stage1/subgraph_hybrid_extract.txt",
    "teaching/subgraph_hybrid_extract_complete.txt": "stage1/subgraph_hybrid_extract_complete.txt",
    "teaching/subgraph_extract_retry.txt": "stage1/subgraph_extract_retry.txt",
    "teaching/triplet_validate.txt": "stage1/triplet_validate.txt",
    "teaching/triplet_fix.txt": "stage1/triplet_fix.txt",
    "teaching/triplet_reextract.txt": "stage1/triplet_reextract.txt",
    "teaching/entity_define.txt": "stage3/entity_define.txt",
    "teaching/mmkg_rag.txt": "rag/mmkg_rag.txt",
    "teaching/rag_answer_check.txt": "rag/rag_answer_check.txt",
    "teaching/quiz_generate.txt": "rag/quiz_generate.txt",
    # 根目录遗留
    "triplet.txt": "_archive/triplet.txt",
    "recaption.txt": "_archive/recaption.txt",
    "rag_augment.txt": "_archive/rag_augment.txt",
    "description_crawl.txt": "_archive/description_crawl.txt",
}


def resolve_prompt_name(name: str) -> str:
    """解析 prompt 相对路径；支持旧别名。"""
    normalized = name.replace("\\", "/").lstrip("/")
    return _LEGACY_ALIASES.get(normalized, normalized)


def load_prompt(name: str) -> str:
    resolved = resolve_prompt_name(name)
    path = PROMPT_DIR / resolved
    if not path.exists():
        raise FileNotFoundError(f"Prompt not found: {path} (requested: {name})")
    return path.read_text(encoding="utf-8")


def format_prompt(name: str, **kwargs: str) -> str:
    """填充 prompt 占位符；kwargs 值可含任意 `{...}`（如 JSON、{T,F}）。"""
    text = load_prompt(name)
    # 保护模板中的字面量花括号
    text = text.replace("{{", "\x00LB\x00").replace("}}", "\x00RB\x00")
    for key, value in kwargs.items():
        text = text.replace("{" + key + "}", value)
    return text.replace("\x00LB\x00", "{").replace("\x00RB\x00", "}")
