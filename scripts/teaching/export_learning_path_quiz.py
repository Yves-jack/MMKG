#!/usr/bin/env python
"""将 learning_path_quiz.json 导出为 Markdown。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def quiz_to_markdown(data: dict, *, course_id: str) -> str:
    lines = [f"# {course_id} · 学习路径习题", ""]
    for sec in data.get("sections") or []:
        idx = sec.get("section_index", "?")
        names = [p.get("name", p.get("entity_id", "")) for p in sec.get("path_slice") or []]
        lines.append(f"## 第 {idx} 段")
        if names:
            lines.append("")
            lines.append("**覆盖概念**：" + "、".join(names[:8]) + ("…" if len(names) > 8 else ""))
        lines.append("")
        for qi, q in enumerate(sec.get("quiz", {}).get("questions") or [], 1):
            qtype = q.get("type", "question")
            lines.append(f"### {idx}.{qi} [{qtype}]")
            lines.append("")
            lines.append(q.get("stem", ""))
            lines.append("")
            for opt in q.get("options") or []:
                lines.append(f"- {opt}")
            if q.get("options"):
                lines.append("")
            lines.append(f"**答案**：{q.get('answer', '')}")
            if q.get("explanation"):
                lines.append("")
                lines.append(f"**解析**：{q['explanation']}")
            kps = q.get("knowledge_points") or []
            if kps:
                lines.append("")
                lines.append("**知识点**：" + "；".join(kps))
            lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--course-id", required=True)
    p.add_argument("--input", default=None)
    p.add_argument("--output", default=None)
    args = p.parse_args()
    src = Path(args.input) if args.input else ROOT / "data" / "processed" / args.course_id / "learning_path_quiz.json"
    data = json.loads(src.read_text(encoding="utf-8"))
    out = Path(args.output) if args.output else ROOT / "data" / "processed" / args.course_id / "learning_path_quiz.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(quiz_to_markdown(data, course_id=args.course_id), encoding="utf-8")
    n_q = sum(len(s.get("quiz", {}).get("questions") or []) for s in data.get("sections") or [])
    print(f"Exported {n_q} questions → {out}")


if __name__ == "__main__":
    main()
