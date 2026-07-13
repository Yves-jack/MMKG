#!/usr/bin/env python
"""Gradio Web 演示（可选依赖 gradio）。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from teachkg.config import TeachKGConfig
from teachkg.rag.mmkg_rag import MMKGRAG


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--config", default=str(ROOT / "configs" / "teaching.yaml"))
    p.add_argument("--course-id", default="shuliluoji")
    p.add_argument("--lecture-id", default="all")
    p.add_argument("--mock", action="store_true")
    p.add_argument("--port", type=int, default=7860)
    return p.parse_args()


def main() -> None:
    try:
        import gradio as gr
    except ImportError as exc:
        raise SystemExit("请安装 gradio: pip install gradio") from exc

    args = parse_args()
    config = TeachKGConfig.from_yaml(args.config)
    rag = MMKGRAG(config, project_root=ROOT, mock=args.mock)
    lecture_id = None if str(args.lecture_id).lower() in {"all", "course", ""} else args.lecture_id

    def ask(question: str, history: list[dict]) -> tuple[str, list[dict]]:
        if not question.strip():
            return "", history
        result = rag.answer(question, args.course_id, lecture_id=lecture_id, use_history=True)
        reply = result["answer"]
        analysis = result.get("retrieval_analysis") or {}
        if analysis:
            from teachkg.rag.multi_turn import format_retrieval_analysis

            reply += f"\n\n{format_retrieval_analysis(analysis)}"
        if result.get("check"):
            chk = result["check"]
            reply += f"\n\n[校验] {chk.get('verdict')} — {chk.get('reason', '')}"
        history = history + [
            {"role": "user", "content": question},
            {"role": "assistant", "content": reply},
        ]
        return "", history

    with gr.Blocks(title=f"TeachKG RAG · {args.course_id}") as demo:
        gr.Markdown(f"# TeachKG 问答 · `{args.course_id}` · 讲次 `{args.lecture_id}`")
        chatbot = gr.Chatbot(height=480)
        msg = gr.Textbox(label="问题", placeholder="例如：什么是命题逻辑？")
        with gr.Row():
            submit = gr.Button("发送")
            clear = gr.Button("清空")
            reset = gr.Button("重置记忆")

        def clear_chat():
            rag.reset_history()
            return [], ""

        submit.click(ask, [msg, chatbot], [msg, chatbot])
        msg.submit(ask, [msg, chatbot], [msg, chatbot])
        clear.click(clear_chat, None, [chatbot, msg])
        reset.click(clear_chat, None, [chatbot, msg])

    demo.launch(server_port=args.port)


if __name__ == "__main__":
    main()
