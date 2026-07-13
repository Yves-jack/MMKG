from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from teachkg.utils.env import load_project_env


@dataclass
class TeachKGConfig:
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_yaml(cls, path: str | Path) -> "TeachKGConfig":
        load_project_env()
        with open(path, encoding="utf-8") as f:
            return cls(raw=yaml.safe_load(f))

    def get(self, *keys: str, default: Any = None) -> Any:
        node: Any = self.raw
        for key in keys:
            if not isinstance(node, dict) or key not in node:
                return default
            node = node[key]
        return node

    @property
    def workspace_dir(self) -> Path:
        return Path(self.get("project", "workspace_dir", default="data/raw"))

    @property
    def segments_dir(self) -> Path:
        return Path(self.get("project", "segments_dir", default="data/segments"))

    @property
    def processed_dir(self) -> Path:
        return Path(self.get("project", "output_dir", default="data/processed"))

    @property
    def kg_dir(self) -> Path:
        return Path(self.get("project", "kg_dir", default="data/kg"))
