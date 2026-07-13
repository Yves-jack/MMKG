"""流水线冒烟测试（不调用 LLM / 不加载大模型）。"""

from __future__ import annotations

import json
from pathlib import Path


def smoke_test_course(course_id: str, project_root: Path) -> dict[str, bool]:
    kg = project_root / "data" / "kg" / course_id
    idx = project_root / "data" / "index" / course_id / "course" / "mmkg_index"
    checks = {
        "triplets": (kg / "triplets.jsonl").is_file() or (kg / "triplets.json").is_file(),
        "course_kg": (kg / "kg.json").is_file(),
        "course_mmkg": (kg / "mmkg.json").is_file(),
        "course_index": (idx / "manifest.json").is_file(),
    }
    return checks


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    course_id = "shuliluoji"
    checks = smoke_test_course(course_id, root)
    print(json.dumps(checks, ensure_ascii=False, indent=2))
    if not all(checks.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
