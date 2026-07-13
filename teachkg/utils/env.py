"""从项目根目录加载 .env 到 os.environ。"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = PROJECT_ROOT / ".env"


def load_project_env(env_path: Path | None = None) -> bool:
    """加载 .env；若文件不存在则跳过。返回是否成功加载。"""
    path = env_path or ENV_FILE
    if not path.exists():
        return False

    try:
        from dotenv import load_dotenv
    except ImportError as exc:
        raise RuntimeError("python-dotenv is required. Run: pip install python-dotenv") from exc

    load_dotenv(path, override=False)
    return True
