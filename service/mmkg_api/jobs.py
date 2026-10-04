"""Persistent asynchronous PDF extraction and graph rebuild jobs."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, BinaryIO

from pypdf import PdfReader

from .storage import GraphStore

_executor = ThreadPoolExecutor(max_workers=max(1, int(os.environ.get("MMKG_JOB_WORKERS", "2"))))
_lock = Lock()


class JobStore:
    def __init__(self, graph_store: GraphStore) -> None:
        self.graphs = graph_store
        self.root = graph_store.root / "jobs"

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _path(self, job_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{32}", str(job_id)):
            raise ValueError("invalid job id")
        return self.root / f"{job_id}.json"

    def save(self, job: dict[str, Any]) -> dict[str, Any]:
        job = {**job, "updated_at": self._now()}
        path = self._path(job["job_id"])
        path.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            fd, temporary = tempfile.mkstemp(prefix=".job-", suffix=".json", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(job, stream, ensure_ascii=False, indent=2)
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return job

    def load(self, job_id: str) -> dict[str, Any] | None:
        path = self._path(job_id)
        if not path.is_file():
            return None
        with path.open(encoding="utf-8") as stream:
            payload = json.load(stream)
        return payload if isinstance(payload, dict) else None

    def update(self, job_id: str, **fields: Any) -> dict[str, Any]:
        job = self.load(job_id)
        if job is None:
            raise ValueError("job does not exist")
        return self.save({**job, **fields})

    def list(self, course_id: str, limit: int = 50) -> list[dict[str, Any]]:
        if not self.root.is_dir():
            return []
        result = []
        for path in sorted(self.root.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                with path.open(encoding="utf-8") as stream:
                    job = json.load(stream)
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(job, dict) and str(job.get("courseid")) == str(course_id):
                result.append(job)
            if len(result) >= limit:
                break
        return result

    def _new(self, course_id: str, kind: str, **fields: Any) -> dict[str, Any]:
        return self.save({
            "job_id": uuid.uuid4().hex,
            "courseid": str(course_id),
            "kind": kind,
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "message": "queued",
            "error": None,
            "created_at": self._now(),
            **fields,
        })

    def create_rebuild(self, course_id: str, reason: str = "api") -> dict[str, Any]:
        job = self._new(course_id, "rebuild", reason=reason)
        _executor.submit(self._run_rebuild, job["job_id"])
        return job

    def _run_rebuild(self, job_id: str) -> None:
        try:
            job = self.update(job_id, status="running", stage="rebuilding", progress=25)
            graph = self.graphs.rebuild_fused(job["courseid"])
            self.update(job_id, status="completed", stage="done", progress=100, message="completed", result={"view": "fused", "node_count": len(graph["nodes"])})
        except Exception as error:
            self.update(job_id, status="failed", stage="failed", message="failed", error=str(error))

    def create_video_extraction(
        self, course_id: str, segment_ids: list[str]
    ) -> dict[str, Any]:
        pending = self.graphs.video_chunks_needing_extraction(course_id, segment_ids)
        job = self._new(
            course_id,
            "video_extract",
            segment_ids=[str(row["segment_id"]) for row in pending],
            requested_segment_ids=list(dict.fromkeys(segment_ids)),
        )
        if not pending:
            return self.update(
                job["job_id"],
                status="completed",
                stage="done",
                progress=100,
                message="all chunks already extracted",
                result={"processed": 0, "failed": 0, "skipped": len(segment_ids)},
            )
        _executor.submit(self._run_video_extraction, job["job_id"])
        return job

    def _run_video_extraction(self, job_id: str) -> None:
        from .video_extraction import chunk_fingerprint, extract_video_chunk

        try:
            job = self.update(
                job_id,
                status="running",
                stage="extracting_video_chunks",
                progress=1,
            )
            chunks = self.graphs.video_chunks_needing_extraction(
                job["courseid"], list(job.get("segment_ids") or [])
            )
            failures: list[dict[str, str]] = []
            processed = 0
            total = max(1, len(chunks))
            for index, chunk in enumerate(chunks, start=1):
                try:
                    extraction = extract_video_chunk(job["courseid"], chunk)
                    self.graphs.write_video_extraction(job["courseid"], extraction)
                    processed += 1
                except Exception as error:
                    failures.append(
                        {"segment_id": str(chunk.get("segment_id")), "error": str(error)}
                    )
                    self.graphs.write_video_extraction(
                        job["courseid"],
                        {
                            "segment_id": str(chunk.get("segment_id")),
                            "lesson_id": str(chunk.get("lesson_id")),
                            "input_hash": chunk_fingerprint(chunk),
                            "status": "failed",
                            "error": str(error),
                            "triplets": [],
                        },
                    )
                self.update(
                    job_id,
                    progress=min(95, int(index / total * 90) + 5),
                    message=f"processed {index}/{len(chunks)}",
                )
            graph = self.graphs.rebuild_video(job["courseid"])
            result = {"processed": processed, "failed": len(failures), "failures": failures, **graph}
            self.update(
                job_id,
                status="failed" if failures else "completed",
                stage="failed" if failures else "done",
                progress=100,
                message="video extraction failed" if failures else "completed",
                error=json.dumps(failures, ensure_ascii=False) if failures else None,
                result=result,
            )
        except Exception as error:
            self.update(job_id, status="failed", stage="failed", message="failed", error=str(error))

    def create_extraction(self, course_id: str, filename: str, source: BinaryIO) -> dict[str, Any]:
        job = self._new(course_id, "extract", filename=filename)
        uploads = self.root / "uploads"
        uploads.mkdir(parents=True, exist_ok=True)
        upload = uploads / f"{job['job_id']}.pdf"
        with upload.open("wb") as target:
            shutil.copyfileobj(source, target)
        _executor.submit(self._run_extract, job["job_id"], upload)
        return job

    def _run_extract(self, job_id: str, upload: Path) -> None:
        try:
            job = self.update(job_id, status="running", stage="extracting", progress=10)
            reader = PdfReader(str(upload))
            headings: list[str] = []
            numbered = re.compile(r"^(?:第[一二三四五六七八九十百]+[章节]|\d+(?:\.\d+)*[、.\s])")
            for page in reader.pages:
                for raw in (page.extract_text() or "").splitlines():
                    line = re.sub(r"\s+", " ", raw).strip()
                    if 2 <= len(line) <= 80 and (numbered.match(line) or len(line) <= 24) and line not in headings:
                        headings.append(line)
                    if len(headings) >= 200:
                        break
            nodes = [{"id": f"pdf:{index}", "name": title, "zh_name": title} for index, title in enumerate(headings, 1)]
            edges = [{"id": f"pdf-edge:{index}", "source": nodes[index - 1]["id"], "target": nodes[index]["id"], "relation": "后续"} for index in range(1, len(nodes))]
            graph = self.graphs.write_view(job["courseid"], "document", {"nodes": nodes, "edges": edges})
            self.update(job_id, status="completed", stage="done", progress=100, message="completed", result={"view": "document", "node_count": len(graph["nodes"])})
        except Exception as error:
            self.update(job_id, status="failed", stage="failed", message="failed", error=str(error))
        finally:
            try:
                upload.unlink()
            except OSError:
                pass

    def course_status(self, course_id: str) -> dict[str, Any]:
        rebuilds = [job for job in self.list(course_id, 100) if job.get("kind") == "rebuild"]
        video_extracts = [
            job for job in self.list(course_id, 100) if job.get("kind") == "video_extract"
        ]
        rebuild = rebuilds[0] if rebuilds else {"state": "idle"}
        if rebuilds:
            rebuild = {**rebuild, "state": {"completed": "idle", "failed": "error"}.get(rebuild.get("status"), rebuild.get("status"))}
        return {"courseid": str(course_id), "stale": False, "rebuild": rebuild, "video_extract": video_extracts[0] if video_extracts else {"state": "idle"}, "diff": {"added": [], "changed": [], "removed": []}}
