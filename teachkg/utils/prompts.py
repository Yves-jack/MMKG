from __future__ import annotations

from pathlib import Path

PROMPT_DIR = Path(__file__).resolve().parents[2] / "prompts"


def load_prompt(name: str) -> str:
    path = PROMPT_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"Prompt not found: {path}")
    return path.read_text(encoding="utf-8")


def format_prompt(name: str, **kwargs: str) -> str:
    """填充 prompt 占位符；kwargs 值可含任意 `{...}`（如 JSON、{T,F}）。"""
    text = load_prompt(name)
    # 保护模板中的字面量花括号
    text = text.replace("{{", "\x00LB\x00").replace("}}", "\x00RB\x00")
    for key, value in kwargs.items():
        text = text.replace("{" + key + "}", value)
    return text.replace("\x00LB\x00", "{").replace("\x00RB\x00", "}")
