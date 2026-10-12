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
        """Backward-compatible entry: enqueue lecture-level teachkg pipelines."""
        return self.create_lecture_pipelines_for_segments(course_id, segment_ids)

    def create_lecture_pipelines_for_segments(
        self, course_id: str, segment_ids: list[str]
    ) -> dict[str, Any]:
        from .chunk_pipeline import lecture_ids_from_chunks, lecture_input_hash
        from .video_extraction import chunk_fingerprint

        wanted = set(segment_ids)
        chunks = [
            row
            for row in self.graphs.read_video_chunks(course_id)
            if str(row.get("segment_id")) in wanted
        ]
        lecture_ids = lecture_ids_from_chunks(chunks)
        auto = os.environ.get("MMKG_AUTO_LECTURE_PIPELINE", "1").strip().lower() not in {
            "0", "false", "no", "off"
        }
        if not auto:
            return self._new(
                course_id,
                "video_extract",
                segment_ids=list(dict.fromkeys(segment_ids)),
                lecture_ids=lecture_ids,
                child_job_ids=[],
                status="completed",
                stage="stored_only",
                progress=100,
                message="chunks stored; auto lecture pipeline disabled",
                result={"lecture_ids": lecture_ids, "jobs": []},
            )
        child_jobs: list[dict[str, Any]] = []
        for lecture_id in lecture_ids:
            lecture_chunks = [
                c
                for c in self.graphs.read_video_chunks(course_id)
                if str(c.get("lesson_id") or "") == str(lecture_id)
            ]
            input_hash = lecture_input_hash(lecture_chunks, lecture_id)
            # Skip if a completed pipeline job already covers this hash
            prior = [
                j
                for j in self.list(course_id, 100)
                if j.get("kind") == "lecture_pipeline"
                and str(j.get("lecture_id")) == str(lecture_id)
                and j.get("input_hash") == input_hash
                and j.get("status") == "completed"
            ]
            if prior:
                child_jobs.append(prior[0])
                continue
            child_jobs.append(
                self.create_lecture_pipeline(
                    course_id, lecture_id, input_hash=input_hash, segment_ids=segment_ids
                )
            )

        # Mark accepted chunks deferred so old "needing extraction" checks settle
        for chunk in chunks:
            self.graphs.write_video_extraction(
                course_id,
                {
                    "segment_id": str(chunk.get("segment_id")),
                    "lesson_id": str(chunk.get("lesson_id")),
                    "input_hash": chunk_fingerprint(chunk),
                    "status": "deferred_to_lecture_pipeline",
                    "triplets": [],
                },
            )

        parent = self._new(
            course_id,
            "video_extract",
            segment_ids=list(dict.fromkeys(segment_ids)),
            lecture_ids=lecture_ids,
            child_job_ids=[j["job_id"] for j in child_jobs],
            status="completed" if child_jobs else "completed",
            stage="delegated",
            progress=100,
            message="delegated to lecture pipeline jobs",
            result={
                "lecture_ids": lecture_ids,
                "jobs": [
                    {
                        "job_id": j["job_id"],
                        "lecture_id": j.get("lecture_id"),
                        "status": j.get("status"),
                    }
                    for j in child_jobs
                ],
            },
        )
        return parent

    def create_lecture_pipeline(
        self,
        course_id: str,
        lecture_id: str,
        *,
        input_hash: str | None = None,
        segment_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        job = self._new(
            course_id,
            "lecture_pipeline",
            lecture_id=str(lecture_id),
            input_hash=input_hash,
            segment_ids=list(segment_ids or []),
        )
        _executor.submit(self._run_lecture_pipeline, job["job_id"])
        return job

    def _run_lecture_pipeline(self, job_id: str) -> None:
        from .chunk_pipeline import run_lecture_pipeline
        from .video_extraction import chunk_fingerprint

        try:
            job = self.update(
                job_id,
                status="running",
                stage="starting",
                progress=1,
                message="starting lecture pipeline",
            )
            course_id = str(job["courseid"])
            lecture_id = str(job.get("lecture_id"))

            def on_progress(stage: str, pct: int, message: str) -> None:
                self.update(
                    job_id,
                    stage=stage,
                    progress=max(1, min(99, int(pct))),
                    message=message,
                )

            result = run_lecture_pipeline(
                canvas_course_id=course_id,
                lecture_id=lecture_id,
                progress_cb=on_progress,
            )

            # Mark lecture chunks completed for fingerprint bookkeeping
            for chunk in self.graphs.read_video_chunks(course_id):
                if str(chunk.get("lesson_id") or "") != lecture_id:
                    continue
                self.graphs.write_video_extraction(
                    course_id,
                    {
                        "segment_id": str(chunk.get("segment_id")),
                        "lesson_id": lecture_id,
                        "input_hash": chunk_fingerprint(chunk),
                        "status": "lecture_pipeline_completed",
                        "triplets": [],
                        "pipeline_job_id": job_id,
                    },
                )
            try:
                self.graphs.rebuild_video(course_id)
            except Exception:
                pass

            self.update(
                job_id,
                status="completed",
                stage="done",
                progress=100,
                message="completed",
                input_hash=result.get("input_hash") or job.get("input_hash"),
                result=result,
            )
        except Exception as error:
            self.update(
                job_id,
                status="failed",
                stage="failed",
                message="failed",
                error=str(error),
            )

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
        lecture_pipelines = [
            job for job in self.list(course_id, 100) if job.get("kind") == "lecture_pipeline"
        ]
        rebuild = rebuilds[0] if rebuilds else {"state": "idle"}
        if rebuilds:
            rebuild = {**rebuild, "state": {"completed": "idle", "failed": "error"}.get(rebuild.get("status"), rebuild.get("status"))}
        return {
            "courseid": str(course_id),
            "stale": False,
            "rebuild": rebuild,
            "video_extract": video_extracts[0] if video_extracts else {"state": "idle"},
            "lecture_pipeline": lecture_pipelines[0] if lecture_pipelines else {"state": "idle"},
            "lecture_pipelines": lecture_pipelines[:20],
            "diff": {"added": [], "changed": [], "removed": []},
        }
