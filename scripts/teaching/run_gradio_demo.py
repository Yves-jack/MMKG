#!/usr/bin/env python
"""Gradio Web 演示（可选依赖 gradio）——支持文本 + 图片/文件/视频输入。"""

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
    p.add_argument("--course-id", default="数理逻辑")
    p.add_argument("--lecture-id", default="all")
    p.add_argument("--mock", action="store_true")
    p.add_argument("--port", type=int, default=7860)
    return p.parse_args()


def _user_content(
    question: str,
    *,
    image: str | None,
    files: list[str] | None,
    video: str | None,
) -> str:
    """构造 Chatbot 用户气泡文本（附件以标签展示）。"""
    parts: list[str] = []
    text = (question or "").strip()
    if text:
        parts.append(text)
    if image:
        parts.append(f"[图片] {Path(image).name}")
    if video:
        parts.append(f"[视频] {Path(video).name}")
    for f in files or []:
        if f:
            parts.append(f"[文件] {Path(f).name}")
    return "\n".join(parts) if parts else "（附件）"

def main() -> None:
    try:
        import gradio as gr
    except ImportError as exc:
        raise SystemExit("请安装 gradio: pip install gradio") from exc

    args = parse_args()
    config = TeachKGConfig.from_yaml(args.config)
    rag = MMKGRAG(config, project_root=ROOT, mock=args.mock)
    lecture_id = None if str(args.lecture_id).lower() in {"all", "course", ""} else args.lecture_id

    def ask(
        question: str,
        history: list,
        image: str | None,
        files: list[str] | None,
        video: str | None,
    ):
        q = (question or "").strip()
        has_media = bool(image or video or (files and any(files)))
        if not q and not has_media:
            return "", history, None, None, None

        result = rag.answer(
            q,
            args.course_id,
            lecture_id=lecture_id,
            use_history=True,
            image=image,
            files=list(files or []) or None,
            video=video,
        )
        reply = result["answer"]
        analysis = result.get("retrieval_analysis") or {}
        if analysis:
            from teachkg.rag.multi_turn import format_retrieval_analysis

            reply += f"\n\n{format_retrieval_analysis(analysis)}"
        media = result.get("media") or {}
        atts = media.get("attachments") or []
        if atts:
            names = ", ".join(
                f"{a.get('kind')}:{Path(a.get('path') or '').name}" for a in atts
            )
            reply += f"\n\n[附件] {names}"
        if result.get("check"):
            chk = result["check"]
            reply += f"\n\n[校验] {chk.get('verdict')} — {chk.get('reason', '')}"

        user_msg = _user_content(q, image=image, files=files, video=video)
        history = history + [
            {"role": "user", "content": user_msg},
            {"role": "assistant", "content": reply},
        ]
        return "", history, None, None, None

    with gr.Blocks(title=f"TeachKG RAG · {args.course_id}") as demo:
        gr.Markdown(
            f"# TeachKG 问答 · `{args.course_id}` · 讲次 `{args.lecture_id}`\n"
            "支持 **文本**，并可附带 **图片 / 文件 / 视频**（图片与视频帧会做视觉理解，"
            "txt/md/pdf/docx 抽取正文后参与检索）。"
        )
        chatbot = gr.Chatbot(height=480, type="messages")
        msg = gr.Textbox(
            label="问题",
            placeholder="例如：这张 PPT / 这段视频讲的是什么概念？也可以只上传附件。",
        )
        with gr.Row():
            image_in = gr.Image(label="图片", type="filepath", height=160)
            video_in = gr.Video(label="视频", height=160)
            file_in = gr.File(
                label="文件（可多选）",
                file_count="multiple",
                type="filepath",
                file_types=[
                    ".txt",
                    ".md",
                    ".pdf",
                    ".docx",
                    ".json",
                    ".csv",
                    ".png",
                    ".jpg",
                    ".jpeg",
                    ".webp",
                ],
            )
        with gr.Row():
            submit = gr.Button("发送", variant="primary")
            clear = gr.Button("清空")
            reset = gr.Button("重置记忆")

        def clear_chat():
            rag.reset_history()
            return [], "", None, None, None

        inputs = [msg, chatbot, image_in, file_in, video_in]
        outputs = [msg, chatbot, image_in, file_in, video_in]
        submit.click(ask, inputs, outputs)
        msg.submit(ask, inputs, outputs)
        clear.click(clear_chat, None, outputs)
        reset.click(clear_chat, None, outputs)

    demo.launch(server_port=args.port)


if __name__ == "__main__":
    main()
