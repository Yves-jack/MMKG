"""query_media 单元测试（不依赖外部视觉 API）。"""

from __future__ import annotations

from pathlib import Path

from teachkg.rag.query_media import build_media_bundle, normalize_upload_paths


def test_normalize_and_text_file(tmp_path: Path) -> None:
    f = tmp_path / "note.txt"
    f.write_text("谓词逻辑依赖量词。", encoding="utf-8")
    paths = normalize_upload_paths(files=[f])
    assert paths == [f]

    bundle = build_media_bundle(paths, vision_model=None, llm_client=None)
    assert bundle.has_media
    assert "谓词逻辑" in bundle.retrieval_extra
    assert bundle.attachments[0].kind == "file"


def test_image_without_vision_still_attaches(tmp_path: Path) -> None:
    img = tmp_path / "slide.png"
    # 最小合法 PNG
    img.write_bytes(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
            "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
        )
    )
    bundle = build_media_bundle([img], vision_model=None, llm_client=None)
    assert bundle.has_media
    assert bundle.attachments[0].kind == "image"
    assert img in bundle.image_paths
    assert "图片" in bundle.retrieval_extra or "slide.png" in bundle.retrieval_extra
