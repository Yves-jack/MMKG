"""安全解析 PyTorch 设备（兼容 CPU-only / 损坏 torch 安装）。"""

from __future__ import annotations


def resolve_torch_device(explicit: str | None = None) -> str:
    if explicit:
        return explicit
    try:
        import torch
    except ImportError:
        return "cpu"

    if not hasattr(torch, "__version__"):
        return "cpu"

    cuda = getattr(torch, "cuda", None)
    if cuda is None:
        return "cpu"
    is_available = getattr(cuda, "is_available", None)
    if callable(is_available) and is_available():
        return "cuda"
    return "cpu"


def torch_is_usable() -> bool:
    try:
        import torch

        return hasattr(torch, "__version__") and hasattr(torch, "Tensor")
    except ImportError:
        return False
