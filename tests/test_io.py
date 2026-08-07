from __future__ import annotations

import json
from pathlib import Path

from teachkg.utils.io import (
    configure_pretty_export,
    load_jsonl,
    pretty_json_path,
    save_jsonl,
)


def test_save_jsonl_writes_pretty_to_separate_dir(tmp_path: Path):
    data_root = tmp_path / "data"
    pretty_root = tmp_path / "pretty_view"
    configure_pretty_export(pretty_dir=pretty_root, data_dir=data_root)

    path = data_root / "processed" / "demo" / "filtered_cues.jsonl"
    records = [{"id": 1, "text": "命题逻辑"}, {"id": 2, "text": "谓词逻辑"}]
    save_jsonl(path, records)

    assert path.exists()
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2

    # 不在结果旁写 .pretty.json
    assert not path.with_name("filtered_cues.pretty.json").exists()

    pretty = pretty_json_path(path)
    assert pretty == pretty_root / "processed" / "demo" / "filtered_cues.json"
    assert pretty.exists()
    assert json.loads(pretty.read_text(encoding="utf-8")) == records
    assert "\n  " in pretty.read_text(encoding="utf-8")


def test_save_jsonl_pretty_false_skips_companion(tmp_path: Path):
    data_root = tmp_path / "data"
    pretty_root = tmp_path / "pretty_view"
    configure_pretty_export(pretty_dir=pretty_root, data_dir=data_root)

    path = data_root / "kg" / "triplets.jsonl"
    save_jsonl(path, [{"a": 1}], pretty=False)
    assert path.exists()
    assert not pretty_json_path(path).exists()


def test_load_jsonl_roundtrip(tmp_path: Path):
    configure_pretty_export(
        pretty_dir=tmp_path / "pretty_view",
        data_dir=tmp_path / "data",
    )
    path = tmp_path / "data" / "cues.jsonl"
    records = [{"cue_id": "a"}, {"cue_id": "b"}]
    save_jsonl(path, records)
    assert load_jsonl(path) == records
