"""Import legacy Knowledge-Graph JSON data into MMKG-owned course storage."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from mmkg_api.storage import GRAPH_VIEWS, GraphStore


def migrate(source: Path, target: Path, mapping: dict[str, str]) -> dict[str, dict[str, int]]:
    store = GraphStore(target)
    report: dict[str, dict[str, int]] = {}
    for legacy_id, course_id in mapping.items():
        counts: dict[str, int] = {}
        views_root = source / "graph_views" / legacy_id
        for view in sorted(GRAPH_VIEWS):
            path = views_root / f"{view}.json"
            if not path.is_file() and view == "base":
                path = source / f"course_{legacy_id}.json"
            if not path.is_file():
                continue
            with path.open(encoding="utf-8") as stream:
                graph = json.load(stream)
            normalized = store.write_view(course_id, view, graph)
            counts[f"{view}_nodes"] = len(normalized["nodes"])
            counts[f"{view}_edges"] = len(normalized["edges"])
        for filename in (
            "video_chunks.json",
            "knowledge_point_videos.json",
            "imported_knowledge_point_videos.json",
            "config.json",
            "overlay.json",
        ):
            path = views_root / filename
            if path.is_file():
                with path.open(encoding="utf-8") as stream:
                    store._write(store._path(course_id, filename), json.load(stream))
        store.rebuild_fused(course_id)
        if store.read_video_chunks(course_id):
            store.rebuild_video(course_id)
        report[course_id] = counts
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument(
        "--map",
        action="append",
        required=True,
        metavar="LEGACY_ID:COURSE_ID",
        help="Repeat for each legacy-to-Canvas course mapping.",
    )
    args = parser.parse_args()
    mapping = dict(value.split(":", 1) for value in args.map)
    print(json.dumps(migrate(args.source, args.target, mapping), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
