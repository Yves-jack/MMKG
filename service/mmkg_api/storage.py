"""Atomic MMKG graph storage, CRUD, fusion, and video-chunk extraction."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

Graph = dict[str, Any]
GRAPH_VIEWS = frozenset({"base", "document", "fused", "video"})
_write_lock = Lock()


def _safe_part(value: str) -> str:
    value = str(value).strip()
    if not value or not re.fullmatch(r"[A-Za-z0-9_.:-]+", value):
        raise ValueError("course_id contains unsupported characters")
    return value


def _empty_graph(course_id: str, view: str) -> Graph:
    return {"courseid": str(course_id), "view": view, "nodes": [], "edges": [], "kg_protocol": "kg-json-v1"}


def _identity(node: Graph) -> str:
    raw = node.get("zh_name") or node.get("name") or node.get("en_name") or node.get("id")
    return re.sub(r"\s+", "", str(raw or "")).casefold()


def _knowledge_aliases(*values: Any) -> set[str]:
    aliases: set[str] = set()
    for value in values:
        raw = str(value or "").strip()
        if not raw:
            continue
        for part in (raw, *re.split(r"[/／|]", raw)):
            normalized = re.sub(r"[^\w]+", "", part.casefold())
            if normalized:
                aliases.add(normalized)
    return aliases


class GraphStore:
    def __init__(self, root: str | Path | None = None) -> None:
        self.root = Path(root or os.environ.get("MMKG_DATA_DIR") or "/data")

    def _course_root(self, course_id: str) -> Path:
        return self.root / "courses" / _safe_part(course_id)

    def _path(self, course_id: str, name: str) -> Path:
        return self._course_root(course_id) / name

    @staticmethod
    def _read(path: Path, default: Any) -> Any:
        if not path.is_file():
            return default
        with path.open(encoding="utf-8") as stream:
            return json.load(stream)

    @staticmethod
    def _write(path: Path, payload: Any) -> Any:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _write_lock:
            fd, temporary = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".json", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(payload, stream, ensure_ascii=False, indent=2)
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return payload

    @staticmethod
    def normalize_graph(course_id: str, view: str, graph: Graph) -> Graph:
        if view not in GRAPH_VIEWS:
            raise ValueError(f"unsupported graph view: {view}")
        if not isinstance(graph, dict):
            raise ValueError("graph must be an object")
        nodes, edges = graph.get("nodes", []), graph.get("edges", [])
        if not isinstance(nodes, list) or not all(isinstance(item, dict) for item in nodes):
            raise ValueError("graph.nodes must be a list of objects")
        if not isinstance(edges, list) or not all(isinstance(item, dict) for item in edges):
            raise ValueError("graph.edges must be a list of objects")
        return {**graph, "courseid": str(course_id), "view": view, "nodes": [dict(x) for x in nodes], "edges": [dict(x) for x in edges], "kg_protocol": "kg-json-v1"}

    def read_view(self, course_id: str, view: str) -> Graph:
        if view not in GRAPH_VIEWS:
            raise ValueError(f"unsupported graph view: {view}")
        return self.normalize_graph(course_id, view, self._read(self._path(course_id, f"{view}.json"), _empty_graph(course_id, view)))

    def write_view(self, course_id: str, view: str, graph: Graph) -> Graph:
        normalized = self.normalize_graph(course_id, view, graph)
        self._write(self._path(course_id, f"{view}.json"), normalized)
        if view in {"base", "document"}:
            if self.read_video_chunks(course_id):
                self.rebuild_video(course_id)
            else:
                self.rebuild_fused(course_id)
        return normalized

    def read_graph(self, course_id: str) -> Graph:
        fused = self.read_view(course_id, "fused")
        return fused if fused["nodes"] or fused["edges"] else self.read_view(course_id, "base")

    def list_nodes(self, course_id: str) -> list[Graph]:
        """Return every knowledge node without pagination or ranking truncation."""
        return [dict(node) for node in self.read_graph(course_id).get("nodes", [])]

    def get_node(self, course_id: str, node_id: str) -> Graph:
        for node in self.read_graph(course_id)["nodes"]:
            if str(node.get("id")) == str(node_id):
                return node
        raise ValueError(f"Node with id {node_id} not found")

    def add_node(self, course_id: str, node: Graph) -> Graph:
        graph = self.read_view(course_id, "base")
        node_id = str(node.get("id") or "").strip()
        if not node_id:
            raise ValueError("node id is required")
        if any(str(item.get("id")) == node_id for item in graph["nodes"]):
            raise ValueError(f"Node with id {node_id} already exists")
        graph["nodes"].append(dict(node))
        self.write_view(course_id, "base", graph)
        return dict(node)

    def update_node(self, course_id: str, node_id: str, patch: Graph) -> Graph:
        for view in ("base", "document"):
            graph = self.read_view(course_id, view)
            for index, node in enumerate(graph["nodes"]):
                if str(node.get("id")) != str(node_id):
                    continue
                updated = {**node, **patch}
                next_id = str(updated.get("id") or "").strip()
                if not next_id:
                    raise ValueError("node id is required")
                if next_id != str(node_id) and any(
                    str(item.get("id")) == next_id for item in self.read_graph(course_id)["nodes"]
                ):
                    raise ValueError(f"Node with id {next_id} already exists")
                updated["id"] = next_id
                graph["nodes"][index] = updated
                if next_id != str(node_id):
                    for edge in graph["edges"]:
                        if str(edge.get("source")) == str(node_id):
                            edge["source"] = next_id
                        if str(edge.get("target")) == str(node_id):
                            edge["target"] = next_id
                self.write_view(course_id, view, graph)
                return updated
        raise ValueError(f"Node with id {node_id} not found")

    def delete_node(self, course_id: str, node_id: str) -> None:
        found = False
        for view in ("base", "document"):
            graph = self.read_view(course_id, view)
            remaining = [node for node in graph["nodes"] if str(node.get("id")) != str(node_id)]
            if len(remaining) == len(graph["nodes"]):
                continue
            found = True
            graph["nodes"] = remaining
            graph["edges"] = [edge for edge in graph["edges"] if str(edge.get("source")) != str(node_id) and str(edge.get("target")) != str(node_id)]
            self.write_view(course_id, view, graph)
        if not found:
            raise ValueError(f"Node with id {node_id} not found")

    def get_edge(self, course_id: str, edge_id: str) -> Graph:
        for edge in self.read_graph(course_id)["edges"]:
            if str(edge.get("id")) == str(edge_id):
                return edge
        raise ValueError(f"Edge with id {edge_id} not found")

    def node_edges(self, course_id: str, node_id: str) -> list[Graph]:
        self.get_node(course_id, node_id)
        return [edge for edge in self.read_graph(course_id)["edges"] if str(edge.get("source")) == str(node_id) or str(edge.get("target")) == str(node_id)]

    def add_edge(self, course_id: str, edge: Graph) -> Graph:
        graph = self.read_view(course_id, "base")
        node_ids = {str(node.get("id")) for node in graph["nodes"]}
        source, target = str(edge.get("source") or ""), str(edge.get("target") or "")
        if source not in node_ids or target not in node_ids:
            raise ValueError("source and target nodes must exist")
        if any({str(item.get("source")), str(item.get("target"))} == {source, target} for item in graph["edges"]):
            raise ValueError("Edge already exists between these nodes")
        edge_id = str(edge.get("id") or f"edge:{hashlib.sha256(f'{source}|{target}'.encode()).hexdigest()[:16]}")
        if any(str(item.get("id")) == edge_id for item in graph["edges"]):
            raise ValueError(f"Edge with id {edge_id} already exists")
        created = {**edge, "id": edge_id, "source": source, "target": target}
        graph["edges"].append(created)
        self.write_view(course_id, "base", graph)
        return created

    def update_edge(self, course_id: str, edge_id: str, patch: Graph) -> Graph:
        for view in ("base", "document"):
            graph = self.read_view(course_id, view)
            for index, edge in enumerate(graph["edges"]):
                if str(edge.get("id")) != str(edge_id):
                    continue
                updated = {**edge, **patch, "id": edge_id}
                node_ids = {str(node.get("id")) for node in self.read_graph(course_id)["nodes"]}
                if str(updated.get("source")) not in node_ids or str(updated.get("target")) not in node_ids:
                    raise ValueError("source and target nodes must exist")
                graph["edges"][index] = updated
                self.write_view(course_id, view, graph)
                return updated
        raise ValueError(f"Edge with id {edge_id} not found")

    def delete_edge(self, course_id: str, edge_id: str) -> None:
        found = False
        for view in ("base", "document"):
            graph = self.read_view(course_id, view)
            remaining = [edge for edge in graph["edges"] if str(edge.get("id")) != str(edge_id)]
            if len(remaining) == len(graph["edges"]):
                continue
            found = True
            graph["edges"] = remaining
            self.write_view(course_id, view, graph)
        if not found:
            raise ValueError(f"Edge with id {edge_id} not found")

    def read_video_chunks(self, course_id: str) -> list[Graph]:
        payload = self._read(self._path(course_id, "video_chunks.json"), {"chunks": []})
        chunks = payload.get("chunks", []) if isinstance(payload, dict) else []
        if not isinstance(chunks, list) or not all(isinstance(item, dict) for item in chunks):
            raise ValueError("video_chunks.json must contain a chunks list")
        return [dict(item) for item in chunks]

    def ingest_video_chunks(self, course_id: str, chunks: list[Graph]) -> Graph:
        existing = {str(row["segment_id"]): row for row in self.read_video_chunks(course_id)}
        accepted: list[str] = []
        for raw in chunks:
            row = {
                "segment_id": raw["segment_id"],
                "lesson_id": raw["lesson_id"],
                "video_id": raw.get("video_id") or raw["lesson_id"],
                "asr_text": raw["asr_text"],
                "text": raw["text"],
                "start_sec": raw["start_sec"],
                "end_sec": raw["end_sec"],
                "link": raw["link"],
            }
            if not str(row["asr_text"]).strip() or not str(row["text"]).strip():
                raise ValueError("video chunk requires non-empty asr_text and text")
            existing[str(row["segment_id"])] = row
            accepted.append(str(row["segment_id"]))
        stored = list(existing.values())
        self._write(self._path(course_id, "video_chunks.json"), {"courseid": str(course_id), "version": 1, "chunks": stored})
        return {
            "courseid": str(course_id),
            "stored_chunks": len(stored),
            "accepted_segment_ids": accepted,
        }

    def _video_extraction_path(self, course_id: str, segment_id: str) -> Path:
        name = hashlib.sha256(str(segment_id).encode()).hexdigest() + ".json"
        return self._path(course_id, "video_extractions") / name

    def read_video_extractions(self, course_id: str) -> list[Graph]:
        root = self._path(course_id, "video_extractions")
        if not root.is_dir():
            return []
        rows: list[Graph] = []
        for path in sorted(root.glob("*.json")):
            payload = self._read(path, {})
            if isinstance(payload, dict) and payload.get("segment_id"):
                rows.append(payload)
        return rows

    def write_video_extraction(self, course_id: str, extraction: Graph) -> Graph:
        segment_id = str(extraction.get("segment_id") or "").strip()
        if not segment_id:
            raise ValueError("video extraction requires segment_id")
        return self._write(
            self._video_extraction_path(course_id, segment_id), extraction
        )

    def video_chunks_needing_extraction(
        self, course_id: str, segment_ids: list[str]
    ) -> list[Graph]:
        from .video_extraction import chunk_fingerprint

        wanted = set(segment_ids)
        done = {
            str(row.get("segment_id")): str(row.get("input_hash"))
            for row in self.read_video_extractions(course_id)
            if row.get("status") == "completed"
        }
        return [
            chunk
            for chunk in self.read_video_chunks(course_id)
            if str(chunk.get("segment_id")) in wanted
            and done.get(str(chunk.get("segment_id"))) != chunk_fingerprint(chunk)
        ]

    def rebuild_video(self, course_id: str) -> Graph:
        from .video_extraction import build_video_graph

        chunks = self.read_video_chunks(course_id)
        video, relations = build_video_graph(
            course_id, chunks, self.read_video_extractions(course_id)
        )
        video = self.normalize_graph(course_id, "video", video)
        self._write(self._path(course_id, "video.json"), video)
        self._write(self._path(course_id, "knowledge_point_videos.json"), {"courseid": str(course_id), "version": 1, "relations": relations})
        fused = self.rebuild_fused(course_id)
        return {"courseid": str(course_id), "stored_chunks": len(chunks), "relations": len(relations), "video_nodes": len(video["nodes"]), "video_edges": len(video["edges"]), "fused_nodes": len(fused["nodes"])}

    def read_video_relations(self, course_id: str) -> list[Graph]:
        generated = self._read(self._path(course_id, "knowledge_point_videos.json"), {"relations": []})
        imported = self._read(self._path(course_id, "imported_knowledge_point_videos.json"), {"relations": []})
        rows = list(generated.get("relations", [])) + list(imported.get("relations", []))
        if not all(isinstance(row, dict) for row in rows):
            raise ValueError("video relation documents must contain object lists")
        return rows

    def find_video_segments(self, course_id: str, point_id: str, name: str | None = None) -> list[str]:
        wanted = _knowledge_aliases(point_id, name)
        result: list[str] = []
        for relation in self.read_video_relations(course_id):
            relation_aliases = _knowledge_aliases(
                relation.get("knowledge_point_id"),
                relation.get("knowledge_point_name"),
            )
            if wanted.intersection(relation_aliases):
                result.extend(str(value) for value in relation.get("segment_ids", []) if str(value))
        return list(dict.fromkeys(result))

    def find_video_references(
        self, course_id: str, point_id: str, name: str | None = None
    ) -> list[Graph]:
        segment_ids = self.find_video_segments(course_id, point_id, name)
        chunks = {
            str(row.get("segment_id")): row
            for row in self.read_video_chunks(course_id)
        }
        refs: list[Graph] = []
        seen: set[tuple[str, float]] = set()
        for segment_id in segment_ids:
            chunk = chunks.get(segment_id)
            if not chunk:
                continue
            video_id = str(
                chunk.get("video_id") or chunk.get("lesson_id") or ""
            ).strip()
            if not video_id:
                continue
            start_sec = float(chunk.get("start_sec") or 0)
            key = (video_id, start_sec)
            if key in seen:
                continue
            seen.add(key)
            refs.append(
                {
                    "video_id": video_id,
                    "segment_id": segment_id,
                    "start_sec": start_sec,
                    "end_sec": float(chunk.get("end_sec") or start_sec),
                    "link": str(chunk.get("link") or ""),
                }
            )
        return refs

    def import_video_relations(self, course_id: str, relations: list[Graph]) -> Graph:
        normalized = []
        for raw in relations:
            point_id = str(raw.get("knowledge_point_id") or "").strip()
            if not point_id:
                raise ValueError("knowledge_point_id is required")
            normalized.append({"knowledge_point_id": point_id, "knowledge_point_name": str(raw.get("knowledge_point_name") or "").strip(), "segment_ids": sorted({str(value) for value in raw.get("segment_ids", []) if str(value)}), "source": "legacy-import"})
        self._write(self._path(course_id, "imported_knowledge_point_videos.json"), {"courseid": str(course_id), "version": 1, "relations": normalized})
        return self.video_relation_status(course_id)

    def video_relation_status(self, course_id: str) -> Graph:
        relations = self.read_video_relations(course_id)
        canonical = json.dumps(relations, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        return {"courseid": str(course_id), "relation_count": len(relations), "link_count": sum(len(row.get("segment_ids", [])) for row in relations), "checksum": hashlib.sha256(canonical).hexdigest(), "sample": relations[:5]}

    def rebuild_fused(self, course_id: str) -> Graph:
        nodes: dict[str, Graph] = {}
        graph_maps: list[tuple[Graph, dict[str, str]]] = []
        for graph in [self.read_view(course_id, view) for view in ("base", "document", "video")]:
            id_map: dict[str, str] = {}
            for raw in graph["nodes"]:
                key = _identity(raw)
                if not key:
                    continue
                canonical_id = str(nodes.get(key, {}).get("id") or raw.get("id") or f"entity:{len(nodes) + 1}")
                if raw.get("id") is not None:
                    id_map[str(raw["id"])] = canonical_id
                merged = {**nodes.get(key, {}), **raw, "id": canonical_id}
                anchors = []
                for item in (nodes.get(key, {}), raw):
                    anchors.extend(value for value in item.get("video_anchors", []) if isinstance(value, dict))
                if anchors:
                    merged["video_anchors"] = list({json.dumps(item, sort_keys=True): item for item in anchors}.values())
                nodes[key] = merged
            graph_maps.append((graph, id_map))
        edges: dict[tuple[str, str, str], Graph] = {}
        for graph, id_map in graph_maps:
            for raw in graph["edges"]:
                source, target = id_map.get(str(raw.get("source")), ""), id_map.get(str(raw.get("target")), "")
                relation = str(raw.get("relation") or raw.get("rel") or "关联")
                if source and target:
                    edges[(source, target, relation)] = {**raw, "source": source, "target": target, "relation": relation}
        fused = self.normalize_graph(course_id, "fused", {"nodes": list(nodes.values()), "edges": list(edges.values())})
        overlay = self.read_metadata(course_id, "overlay", {})
        overrides = overlay.get("fused_node_overrides", {}) if isinstance(overlay, dict) else {}
        for node in fused["nodes"]:
            patch = overrides.get(str(node.get("id"))) if isinstance(overrides, dict) else None
            if isinstance(patch, dict):
                node.update(patch)
        self._write(self._path(course_id, "fused.json"), fused)
        return fused

    def read_metadata(self, course_id: str, name: str, default: Graph) -> Graph:
        if name not in {"config", "overlay"}:
            raise ValueError("unsupported metadata document")
        payload = self._read(self._path(course_id, f"{name}.json"), default)
        if not isinstance(payload, dict):
            raise ValueError(f"{name} must be an object")
        return payload

    def write_metadata(self, course_id: str, name: str, payload: Graph) -> Graph:
        if name not in {"config", "overlay"} or not isinstance(payload, dict):
            raise ValueError("invalid metadata document")
        result = {**payload, "updated_at": datetime.now(timezone.utc).isoformat()}
        self._write(self._path(course_id, f"{name}.json"), result)
        if name == "overlay":
            self.rebuild_fused(course_id)
        return result

    def list_courses(self) -> list[Graph]:
        root = self.root / "courses"
        if not root.is_dir():
            return []
        return [{"id": path.name, "name": self.read_metadata(path.name, "config", {}).get("course_name") or path.name} for path in sorted(root.iterdir()) if path.is_dir()]
