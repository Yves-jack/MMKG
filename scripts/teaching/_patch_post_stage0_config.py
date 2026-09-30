"""一次性：写入 lecture_chapter_map，并收紧 Stage1–3 相关配置。"""
from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
C = "离散数学(图论+数理逻辑与集合论)"
MAP_PATH = ROOT / "data" / "processed" / C / "lecture_chapter_map.json"


def _dump_map(chapter_map: dict) -> str:
    ordered = {
        k: chapter_map[k]
        for k in sorted(chapter_map.keys(), key=lambda x: int(x) if str(x).isdigit() else 0)
    }
    # 用 yaml 块风格，键加引号保持与原配置一致
    lines = ["    lecture_chapter_map:"]
    for k, v in ordered.items():
        if isinstance(v, list):
            lines.append(f"      '{k}':")
            for item in v:
                lines.append(f"      - {item}")
        else:
            lines.append(f"      '{k}': {v}")
    return "\n".join(lines) + "\n"


def _replace_block(text: str, start_key: str, next_keys: list[str], new_block: str) -> str:
    start = text.find(start_key)
    if start < 0:
        raise SystemExit(f"missing key: {start_key}")
    # 找到 start_key 所在行开头
    line_start = text.rfind("\n", 0, start) + 1
    end = len(text)
    for nk in next_keys:
        pos = text.find(nk, start + len(start_key))
        if pos >= 0:
            end = min(end, pos)
    return text[:line_start] + new_block + text[end:]


def patch_lisan(chapter_map: dict) -> None:
    path = ROOT / "configs" / "teaching_lisan.yaml"
    text = path.read_text(encoding="utf-8")

    text = _replace_block(
        text,
        "lecture_chapter_map:",
        ["    importance_feedback:", "    subgraph:"],
        _dump_map(chapter_map),
    )

    replacements = [
        (
            "llm_only:\n    enabled: true\n    triplets_filename: llm_only/triplets.jsonl\n    sync_active_triplets: false",
            "llm_only:\n    enabled: false  # hybrid 主路径；对比轨关闭避免死数据\n    triplets_filename: llm_only/triplets.jsonl\n    sync_active_triplets: false",
        ),
        (
            "embedding_merge:\n      enabled: false",
            "embedding_merge:\n      enabled: true",
        ),
        (
            "clap_min_score: 0.0\n    clip_min_score: 0.0",
            "clap_min_score: 0.2\n    clip_min_score: 0.2",
        ),
        (
            "rules:\n    require_clip: true\n    min_text_chars: 5",
            "rules:\n    require_clip: false  # clip 缺失不丢 ASR 可用 cue\n    min_text_chars: 5",
        ),
        (
            "ppt_frame:\n    enabled: true\n    source: stage0_ocr\n    min_page_duration_sec: 1.0",
            "ppt_frame:\n    enabled: true\n    source: stage0_ocr\n    min_page_duration_sec: 1.0\n    ocr_text:\n      enabled: true          # 抽取拼接 Stage0 页级 OCR\n      max_chars: 2000",
        ),
        (
            "text_preprocess:\n    enabled: true\n    extract_from_asr: false\n    rules:",
            "text_preprocess:\n    enabled: true\n    extract_from_asr: false\n    rules:",
        ),
        (
            "    llm:\n      enabled: true\n      prompt: stage1/cue_text_preprocess.txt",
            "    llm:\n      enabled: false           # 收敛 LLM：规则预处理即可\n      prompt: stage1/cue_text_preprocess.txt",
        ),
        (
            "      delta_completeness_pass: true",
            "      delta_completeness_pass: false  # 收敛：去掉 completeness 补锅层",
        ),
        (
            "      zero_coverage_fallback: false\n      thin_coverage_fallback: false",
            "      zero_coverage_fallback: true\n      thin_coverage_fallback: true",
        ),
        (
            "        max_fix_attempts: 3\n        max_reextract_attempts: 3",
            "        max_fix_attempts: 1\n        max_reextract_attempts: 1",
        ),
    ]
    for old, new in replacements:
        if old not in text:
            print("WARN skip missing snippet:", old[:60].replace("\n", "\\n"))
            continue
        text = text.replace(old, new, 1)

    path.write_text(text, encoding="utf-8")
    print("patched", path)


def patch_teaching() -> None:
    path = ROOT / "configs" / "teaching.yaml"
    text = path.read_text(encoding="utf-8")
    replacements = [
        (
            "embedding_merge:\n      enabled: false                      # 向量相似度合并不稳定，仅保留字符串规则合并",
            "embedding_merge:\n      enabled: true                       # 近义实体向量合并（阈值见下）",
        ),
        (
            "clap_min_score: 0.0          # 0=只打分不过滤；VAT-KG 参考 0.2\n    clip_min_score: 0.0",
            "clap_min_score: 0.2          # 低于此标记 alignment_ok=false\n    clip_min_score: 0.2",
        ),
        (
            "require_clip: true",
            "require_clip: false",
        ),
        (
            "zero_coverage_fallback: false",
            "zero_coverage_fallback: true",
        ),
        (
            "thin_coverage_fallback: false",
            "thin_coverage_fallback: true",
        ),
        (
            "delta_completeness_pass: true",
            "delta_completeness_pass: false",
        ),
        (
            "max_fix_attempts: 3\n        max_reextract_attempts: 3",
            "max_fix_attempts: 1\n        max_reextract_attempts: 1",
        ),
    ]
    # ppt_frame ocr_text
    if "ocr_text:" not in text:
        text = text.replace(
            "  ppt_frame:\n    enabled: true\n    source: stage0_ocr",
            "  ppt_frame:\n    enabled: true\n    source: stage0_ocr\n    ocr_text:\n      enabled: true\n      max_chars: 2000",
            1,
        )
    # llm preprocess off
    text = re.sub(
        r"(text_preprocess:[\s\S]*?llm:\s*\n\s*enabled:\s*)true",
        r"\1false",
        text,
        count=1,
    )
    # llm_only off when present
    text = re.sub(
        r"(llm_only:\s*\n\s*enabled:\s*)true",
        r"\1false",
        text,
        count=1,
    )
    for old, new in replacements:
        if old not in text:
            print("WARN teaching skip:", old[:60].replace("\n", "\\n"))
            continue
        text = text.replace(old, new, 1)
    path.write_text(text, encoding="utf-8")
    print("patched", path)


def main() -> None:
    chapter_map = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    patch_lisan(chapter_map)
    patch_teaching()
    # sanity
    for name in ("teaching_lisan.yaml", "teaching.yaml"):
        yaml.safe_load((ROOT / "configs" / name).read_text(encoding="utf-8"))
        print("yaml ok", name)


if __name__ == "__main__":
    main()
