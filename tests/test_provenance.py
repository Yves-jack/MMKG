from teachkg.provenance import compact_payload, enrich_with_cue_index, from_triplet, text_snippets


def test_from_triplet_includes_source_and_clip():
    row = {
        "cue_id": "c1",
        "lecture_id": "1",
        "context": "合取词真值表",
        "source_text": "P 且 Q 当且仅当两者为真",
        "clip_path": "data/clips/c1.mp4",
        "start_sec": 1.0,
        "end_sec": 9.0,
        "extract_source": "textbook",
        "textbook_origin": True,
    }
    prov = from_triplet(row)
    assert prov["source_text"].startswith("P 且 Q")
    assert prov["clip_path"].endswith("c1.mp4")
    assert prov["extract_source"] == "textbook"


def test_enrich_with_cue_index_fills_missing_fields():
    cue_index = {
        "c1": {
            "cue_id": "c1",
            "clip_path": "data/clips/c1.mp4",
            "source_text": "字幕全文",
            "start_sec": 1.0,
            "end_sec": 9.0,
        }
    }
    enriched = enrich_with_cue_index([{"cue_id": "c1", "context": "ctx"}], cue_index)
    assert enriched[0]["clip_path"].endswith("c1.mp4")
    assert enriched[0]["source_text"] == "字幕全文"


def test_text_snippets_and_compact_payload():
    provenance = [
        {"cue_id": "c1", "context": "定义A", "source_text": "长字幕" * 20},
        {"cue_id": "c2", "context": "定义B", "source_text": "另一段"},
    ]
    snippets = text_snippets(provenance, max_items=2)
    assert "定义A" in snippets[0]
    compact = compact_payload(provenance, max_items=2)
    assert len(compact) == 2
    assert len(compact[0]["source_text"]) <= 400
