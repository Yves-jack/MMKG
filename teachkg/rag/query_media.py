"""RAG 查询侧多模态附件：图片 / 文件 / 视频 → 检索文本 + LLM 附件。"""

from __future__ import annotations

import logging
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

logger = logging.getLogger(__name__)

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"}
TEXT_SUFFIXES = {
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".py",
    ".log",
}


@dataclass
class MediaAttachment:
    """单个用户上传附件。"""

    path: Path
    kind: str  # image | video | file
    mime: str = ""
    extracted_text: str = ""
    note: str = ""
    frame_paths: list[Path] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "kind": self.kind,
            "mime": self.mime,
            "extracted_text": self.extracted_text[:2000],
            "note": self.note,
            "frame_paths": [str(p) for p in self.frame_paths],
        }


@dataclass
class MediaBundle:
    attachments: list[MediaAttachment] = field(default_factory=list)
    retrieval_extra: str = ""
    question_extra: str = ""
    image_paths: list[Path] = field(default_factory=list)

    @property
    def has_media(self) -> bool:
        return bool(self.attachments)

    def to_dict(self) -> dict[str, Any]:
        return {
            "attachments": [a.to_dict() for a in self.attachments],
            "retrieval_extra": self.retrieval_extra,
            "question_extra": self.question_extra,
            "image_paths": [str(p) for p in self.image_paths],
        }


def _guess_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def _classify(path: Path) -> str:
    suf = path.suffix.lower()
    if suf in IMAGE_SUFFIXES:
        return "image"
    if suf in VIDEO_SUFFIXES:
        return "video"
    return "file"


def _read_text_file(path: Path, *, max_chars: int) -> str:
    raw = path.read_bytes()
    for enc in ("utf-8", "utf-8-sig", "gbk", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", errors="replace")
    text = text.strip()
    if len(text) > max_chars:
        return text[:max_chars] + "\n…(截断)"
    return text


def _read_pdf(path: Path, *, max_chars: int) -> str:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        try:
            from PyPDF2 import PdfReader  # type: ignore
        except ImportError:
            return f"[无法解析 PDF：未安装 pypdf] 文件={path.name}"
    try:
        reader = PdfReader(str(path))
        parts: list[str] = []
        for page in reader.pages:
            parts.append(page.extract_text() or "")
            if sum(len(p) for p in parts) >= max_chars:
                break
        text = "\n".join(parts).strip()
        if not text:
            return f"[PDF 无提取到文本] 文件={path.name}"
        if len(text) > max_chars:
            return text[:max_chars] + "\n…(截断)"
        return text
    except Exception as exc:  # noqa: BLE001
        logger.warning("PDF extract failed: %s", exc)
        return f"[PDF 解析失败: {exc}] 文件={path.name}"


def _read_docx(path: Path, *, max_chars: int) -> str:
    try:
        import docx  # type: ignore
    except ImportError:
        return f"[无法解析 DOCX：未安装 python-docx] 文件={path.name}"
    try:
        doc = docx.Document(str(path))
        text = "\n".join(p.text for p in doc.paragraphs if p.text).strip()
        if not text:
            return f"[DOCX 无提取到文本] 文件={path.name}"
        if len(text) > max_chars:
            return text[:max_chars] + "\n…(截断)"
        return text
    except Exception as exc:  # noqa: BLE001
        logger.warning("DOCX extract failed: %s", exc)
        return f"[DOCX 解析失败: {exc}] 文件={path.name}"


def _ocr_or_describe_image(
    path: Path,
    *,
    llm_client: Any | None,
    vision_model: str | None,
    max_chars: int,
) -> str:
    """优先用视觉模型抽取图中文字/简述；失败则仅返回文件名提示。"""
    prompt = (
        "请提取该图片中的可读文字（板书/PPT/习题等），并一句话概括画面主题。"
        "若几乎无字，只描述关键视觉内容。不要编造。"
    )
    if llm_client is not None and vision_model:
        try:
            text = llm_client.chat_multimodal(
                prompt,
                image_paths=[path],
                temperature=0.0,
                model=vision_model,
            )
            text = (text or "").strip()
            if text:
                return text[:max_chars]
        except Exception as exc:  # noqa: BLE001
            logger.warning("vision describe failed for %s: %s", path, exc)
    try:
        from teachkg.models.qwen_vl_ocr import QwenVLOCRModel

        ocr = QwenVLOCRModel(model=vision_model or "qwen-vl-ocr")
        result = ocr.extract_text(path, prompt=prompt)
        text = (result.text or "").strip()
        if text:
            return text[:max_chars]
    except Exception as exc:  # noqa: BLE001
        logger.warning("OCR fallback failed for %s: %s", path, exc)
    return f"[图片附件] {path.name}（未能自动提取文字，生成阶段将直接附带原图）"


def _sample_video_frames(
    path: Path,
    *,
    max_frames: int,
    interval_sec: float,
    work_dir: Path,
) -> list[Path]:
    try:
        import cv2  # type: ignore
    except ImportError:
        logger.warning("opencv not available; skip video frame sampling")
        return []
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return []
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = (total / fps) if total > 0 else 0.0
    if duration <= 0:
        targets = [i * max(interval_sec, 1.0) for i in range(max_frames)]
    else:
        step = max(interval_sec, duration / max(max_frames, 1))
        targets: list[float] = []
        t = min(step * 0.5, duration * 0.1)
        while len(targets) < max_frames and t < duration:
            targets.append(t)
            t += step
    work_dir.mkdir(parents=True, exist_ok=True)
    out: list[Path] = []
    for i, sec in enumerate(targets):
        cap.set(cv2.CAP_PROP_POS_MSEC, float(sec) * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        fp = work_dir / f"{path.stem}_frame_{i:02d}.jpg"
        from teachkg.utils.cv_io import imwrite_unicode

        if imwrite_unicode(fp, frame):
            out.append(fp)
    cap.release()
    return out


def normalize_upload_paths(
    image: str | Path | None = None,
    files: Sequence[str | Path] | None = None,
    video: str | Path | None = None,
) -> list[Path]:
    """把 Gradio/CLI 传入的路径规整为存在的 Path 列表。"""
    paths: list[Path] = []
    seen: set[str] = set()

    def add(raw: str | Path | None) -> None:
        if raw is None:
            return
        if isinstance(raw, (list, tuple)):
            for item in raw:
                add(item)
            return
        p = Path(str(raw))
        key = str(p.resolve()) if p.exists() else str(p)
        if key in seen:
            return
        if not p.is_file():
            logger.warning("media path missing: %s", p)
            return
        seen.add(key)
        paths.append(p)

    add(image)
    if files:
        for f in files:
            add(f)
    add(video)
    return paths


def build_media_bundle(
    paths: Sequence[str | Path],
    *,
    llm_client: Any | None = None,
    vision_model: str | None = None,
    max_file_chars: int = 8000,
    video_max_frames: int = 3,
    video_frame_interval_sec: float = 5.0,
    work_dir: Path | None = None,
) -> MediaBundle:
    """解析上传媒体，生成检索增强文本与视觉附件列表。"""
    bundle = MediaBundle()
    if not paths:
        return bundle
    work = work_dir or Path(".cache") / "rag_query_media"
    extras: list[str] = []

    for raw in paths:
        path = Path(raw)
        if not path.is_file():
            continue
        kind = _classify(path)
        att = MediaAttachment(path=path, kind=kind, mime=_guess_mime(path))

        if kind == "image":
            att.extracted_text = _ocr_or_describe_image(
                path,
                llm_client=llm_client,
                vision_model=vision_model,
                max_chars=max_file_chars,
            )
            att.note = "用户上传图片"
            bundle.image_paths.append(path)
            extras.append(f"【用户图片 {path.name}】\n{att.extracted_text}")

        elif kind == "video":
            frames = _sample_video_frames(
                path,
                max_frames=video_max_frames,
                interval_sec=video_frame_interval_sec,
                work_dir=work / path.stem,
            )
            att.frame_paths = frames
            frame_texts: list[str] = []
            for fp in frames:
                bundle.image_paths.append(fp)
                desc = _ocr_or_describe_image(
                    fp,
                    llm_client=llm_client,
                    vision_model=vision_model,
                    max_chars=max_file_chars // max(video_max_frames, 1),
                )
                frame_texts.append(f"- 帧 {fp.name}: {desc}")
            att.extracted_text = (
                "\n".join(frame_texts) if frame_texts else f"[视频] {path.name}"
            )
            att.note = f"用户上传视频（采样 {len(frames)} 帧）"
            extras.append(f"【用户视频 {path.name}】\n{att.extracted_text}")

        else:
            suf = path.suffix.lower()
            if suf in TEXT_SUFFIXES:
                att.extracted_text = _read_text_file(path, max_chars=max_file_chars)
            elif suf == ".pdf":
                att.extracted_text = _read_pdf(path, max_chars=max_file_chars)
            elif suf == ".docx":
                att.extracted_text = _read_docx(path, max_chars=max_file_chars)
            elif suf in IMAGE_SUFFIXES:
                att.kind = "image"
                att.extracted_text = _ocr_or_describe_image(
                    path,
                    llm_client=llm_client,
                    vision_model=vision_model,
                    max_chars=max_file_chars,
                )
                bundle.image_paths.append(path)
            else:
                att.extracted_text = (
                    f"[附件] {path.name}（类型 {suf or 'unknown'} 暂不支持正文抽取，"
                    "请改用 txt/md/pdf/docx/图片/视频）"
                )
            att.note = "用户上传文件"
            extras.append(f"【用户文件 {path.name}】\n{att.extracted_text}")

        bundle.attachments.append(att)

    bundle.retrieval_extra = "\n\n".join(extras).strip()
    bundle.question_extra = bundle.retrieval_extra
    return bundle
