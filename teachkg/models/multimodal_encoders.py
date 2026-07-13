"""CLAP / Chinese-CLIP 编码器封装（Stage 1 多模态对齐）。"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from teachkg.utils.torch_device import resolve_torch_device

logger = logging.getLogger(__name__)


def _cosine(a, b) -> float:
    import torch

    a = a.flatten().float()
    b = b.flatten().float()
    denom = a.norm() * b.norm()
    if denom < 1e-8:
        return 0.0
    return float(torch.dot(a, b) / denom)


class ClapEncoder:
    def __init__(self, model_name: str = "laion/clap-htsat-fused", device: str | None = None) -> None:
        self.model_name = model_name
        self.device = device or resolve_torch_device()
        self._model = None
        self._available = True

    @property
    def available(self) -> bool:
        return self._available

    def warmup(self) -> bool:
        try:
            self._load()
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("CLAP unavailable, audio-text filter disabled: %s", exc)
            self._available = False
            self._model = None
            return False

    def _load(self) -> None:
        if self._model is not None:
            return
        if not self._available:
            raise RuntimeError("CLAP is not available")

        import laion_clap

        logger.info("Loading CLAP (HTSAT-tiny) on %s", self.device)
        model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-tiny")
        model.load_ckpt()
        model.to(self.device)
        model.eval()
        self._model = model

    def _prepare_audio(self, audio_path: Path) -> Path:
        """确保 CLAP 可读：非 wav 或损坏时尝试 ffmpeg 转码。"""
        if audio_path.suffix.lower() == ".wav" and audio_path.is_file():
            return audio_path

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            out = Path(tmp.name)
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(audio_path),
            "-ac",
            "1",
            "-ar",
            "48000",
            str(out),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
            return out
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as exc:
            logger.warning("ffmpeg audio prep failed for %s: %s", audio_path, exc)
            out.unlink(missing_ok=True)
            return audio_path

    def score_audio_text(self, audio_path: Path, text: str) -> float:
        import torch

        if not self._available:
            raise RuntimeError("CLAP is not available")
        self._load()
        prepared = self._prepare_audio(audio_path)
        try:
            with torch.no_grad():
                audio_emb = self._model.get_audio_embedding_from_filelist(
                    x=[str(prepared)],
                    use_tensor=True,
                )
                text_emb = self._model.get_text_embedding([text], use_tensor=True)
        finally:
            if prepared != audio_path and prepared.is_file():
                prepared.unlink(missing_ok=True)
        if not isinstance(audio_emb, torch.Tensor):
            audio_emb = torch.tensor(audio_emb)
        if not isinstance(text_emb, torch.Tensor):
            text_emb = torch.tensor(text_emb)
        audio_emb = audio_emb.to(self.device)
        text_emb = text_emb.to(self.device)
        return _cosine(audio_emb[0], text_emb[0])


class ChineseClipEncoder:
    def __init__(self, model_name: str = "OFA-Sys/chinese-clip-vit-base-patch16", device: str | None = None) -> None:
        self.model_name = model_name
        self.device = device or resolve_torch_device()
        self._model = None
        self._processor = None

    def warmup(self) -> None:
        self._load()

    def _load(self) -> None:
        if self._model is not None:
            return
        from transformers import ChineseCLIPModel, ChineseCLIPProcessor

        logger.info("Loading Chinese-CLIP on %s", self.device)
        self._processor = ChineseCLIPProcessor.from_pretrained(self.model_name)
        self._model = ChineseCLIPModel.from_pretrained(self.model_name).to(self.device)
        self._model.eval()

    def score_image_text(self, image: np.ndarray, text: str) -> float:
        """image: BGR uint8 (OpenCV)。"""
        import cv2
        import torch
        from PIL import Image

        self._load()
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        pil = Image.fromarray(rgb)
        inputs = self._processor(text=[text], images=pil, return_tensors="pt", padding=True)
        inputs = {k: v.to(self.device) for k, v in inputs.items()}
        with torch.no_grad():
            outputs = self._model(**inputs)
            image_emb = outputs.image_embeds[0]
            text_emb = outputs.text_embeds[0]
        return _cosine(image_emb, text_emb)

    def score_images_text(self, images: list[np.ndarray], text: str) -> float:
        if not images:
            return 0.0
        return max(self.score_image_text(img, text) for img in images)
