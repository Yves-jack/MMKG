from teachkg.textbook_kg.mindmap_pipeline import (
    apply_llm_tidy,
    canonicalize_id_redirects,
    resolve_concept_id,
)


def _draft():
    return {
        "lecture_id": "1",
        "roots": [
            {
                "id": "__lecture__/1",
                "zh": "第 1 讲",
                "importance": 1,
                "children": [
                    {
                        "id": "析取/disjunction",
                        "zh": "析取",
                        "importance": 0.8,
                        "children": [],
                    },
                    {
                        "id": "或门/OR gate",
                        "zh": "或门",
                        "importance": 0.4,
                        "children": [],
                    },
                ],
            }
        ],
        "n_nodes": 3,
        "max_depth": 1,
        "orphan_count": 0,
        "concept_links": [
            {
                "id": "lnk-1",
                "concept_id": "或门/OR gate",
                "target_kind": "review",
                "target_id": "note-or",
            }
        ],
        "meta": {},
    }


def test_hydrate_drops_invented_ids():
    out = apply_llm_tidy(
        _draft(),
        {
            "roots": [
                {
                    "id": "__lecture__/1",
                    "zh": "第 1 讲",
                    "children": [
                        {"id": "析取/disjunction", "zh": "析取", "children": []},
                        {"id": "invented/new", "zh": "新造", "children": []},
                    ],
                }
            ],
            "notes": "should drop invented",
        },
    )
    ids = []

    def walk(n):
        ids.append(n["id"])
        for c in n.get("children") or []:
            walk(c)

    walk(out["roots"][0])
    assert "invented/new" not in ids
    assert "析取/disjunction" in ids


def test_merges_record_redirects_and_rewrite_links():
    out = apply_llm_tidy(
        _draft(),
        {
            "roots": [
                {
                    "id": "__lecture__/1",
                    "zh": "第 1 讲",
                    "children": [
                        {"id": "析取/disjunction", "zh": "析取", "children": []},
                    ],
                }
            ],
            "merges": [{"from": "或门/OR gate", "to": "析取/disjunction"}],
            "notes": "merge",
        },
    )
    assert out["id_redirects"]["或门/OR gate"] == "析取/disjunction"
    assert out["concept_links"][0]["concept_id"] == "析取/disjunction"


def test_canonicalize_ignores_redirect_when_source_still_kept():
    kept = {"A", "B"}
    assert canonicalize_id_redirects({}, {"A": "B"}, kept) == {}


def test_resolve_concept_id_follows_chain():
    redirects = {"a": "b", "b": "c"}
    assert resolve_concept_id("a", redirects) == "c"
    assert resolve_concept_id("c", redirects) == "c"
