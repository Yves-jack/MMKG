#!/usr/bin/env python
"""教学 MMKG RAG 问答（支持交互式与答案校验）。"""

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
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from teachkg.config import TeachKGConfig
from teachkg.rag.mmkg_rag import MMKGRAG


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MMKG RAG Q&A")
    parser.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    parser.add_argument("--course-id", required=True)
    parser.add_argument("--lecture-id", default="all", help="讲次 ID；默认 all 使用课程级全课索引")
    parser.add_argument("--question", default=None, help="单次提问；省略时使用 --interactive")
    parser.add_argument("--interactive", "-i", action="store_true", help="交互式连续问答")
    parser.add_argument("--top-k", type=int, default=None)
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--no-check", action="store_true", help="跳过 Retrieval Checker")
    parser.add_argument("--json", action="store_true", help="输出完整 JSON")
    parser.add_argument("--image", default=None, help="附带图片路径")
    parser.add_argument("--video", default=None, help="附带视频路径（采样帧理解）")
    parser.add_argument(
        "--file",
        dest="files",
        action="append",
        default=None,
        help="附带文件路径，可重复传入（txt/md/pdf/docx 等）",
    )
    return parser.parse_args()


def _print_result(result: dict, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    print(result["answer"])
    if result.get("check"):
        chk = result["check"]
        print(
            f"\n--- 答案校验 ---\n"
            f"verdict={chk.get('verdict')} confidence={chk.get('confidence', 0):.2f}\n"
            f"{chk.get('reason', '')}"
        )
        if chk.get("unsupported_claims"):
            print("可能缺乏依据:", "; ".join(chk["unsupported_claims"][:3]))
    if result.get("hits"):
        print("\n--- 检索命中 ---")
        for i, hit in enumerate(result["hits"], 1):
            print(f"{i}. [{hit.get('type')}] score={hit.get('score', 0):.3f} id={hit.get('id', '')}")


def main() -> None:
    args = parse_args()
    has_media = bool(args.image or args.video or args.files)
    if not args.interactive and not args.question and not has_media:
        raise SystemExit(
            "请提供 --question，或至少提供 --image/--video/--file，或使用 --interactive"
        )

    config = TeachKGConfig.from_yaml(args.config)
    rag = MMKGRAG(config, project_root=ROOT, mock=args.mock)
    check = False if args.no_check else None
    lecture_id = None if str(args.lecture_id).lower() in {"", "all", "course"} else args.lecture_id

    if args.interactive:
        rag.interactive_loop(args.course_id, lecture_id=lecture_id, check=check)
        return

    result = rag.answer(
        args.question or "",
        args.course_id,
        lecture_id=lecture_id,
        top_k=args.top_k,
        check=check,
        image=args.image,
        files=args.files,
        video=args.video,
    )
    _print_result(result, as_json=args.json)


if __name__ == "__main__":
    main()
