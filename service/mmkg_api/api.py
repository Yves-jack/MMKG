"""FastAPI compatibility surface now owned by MMKG."""

from __future__ import annotations

import os
import random
import secrets
import smtplib
import string
import time
from email.mime.text import MIMEText
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, File, Header, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from . import auth
from .jobs import JobStore
from .storage import GraphStore

router = APIRouter(prefix="/api")
store = GraphStore()
jobs = JobStore(store)
_codes: dict[str, tuple[str, float]] = {}


class JxbLoginRequest(BaseModel):
    kg_token: str = Field(min_length=1)


class JaccountLoginRequest(BaseModel):
    code: str = Field(min_length=1)


class SendCodeRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class EmailLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    code: str = Field(min_length=6, max_length=6)


class NodePayload(BaseModel):
    id: str | None = Field(default=None, max_length=196)
    zh_name: str | None = Field(default=None, max_length=1024)
    en_name: str | None = Field(default=None, max_length=1024)
    name: str | None = Field(default=None, max_length=1024)
    type: str | None = Field(default=None, max_length=196)
    info: str | None = Field(default=None, max_length=100000)
    importance: float | None = None


class EdgePayload(BaseModel):
    id: str | None = Field(default=None, max_length=196)
    source: str | None = Field(default=None, max_length=196)
    target: str | None = Field(default=None, max_length=196)
    relation: str | None = Field(default=None, max_length=1024)


class GraphPayload(BaseModel):
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)


class VideoChunk(BaseModel):
    segment_id: str = Field(min_length=1, max_length=196)
    lesson_id: str = Field(min_length=1, max_length=196)
    summary: str = Field(min_length=1, max_length=10000)
    start_sec: float = Field(ge=0)
    end_sec: float = Field(gt=0)
    link: str = Field(min_length=1, max_length=2048)


class VideoChunksPayload(BaseModel):
    chunks: list[VideoChunk] = Field(min_length=1, max_length=1000)


class VideoRelation(BaseModel):
    knowledge_point_id: str = Field(min_length=1, max_length=196)
    knowledge_point_name: str = Field(default="", max_length=1024)
    segment_ids: list[str] = Field(default_factory=list, max_length=10000)


class VideoRelationsPayload(BaseModel):
    relations: list[VideoRelation] = Field(max_length=100000)


def _dump(model: BaseModel, *, exclude_none: bool = False) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_none=exclude_none)
    return model.dict(exclude_none=exclude_none)


def _not_found(error: ValueError) -> HTTPException:
    return HTTPException(status_code=404, detail=str(error))


def _storage_course(course_id: str) -> str:
    # Runtime storage always uses the authenticated Canvas course ID. Legacy
    # identifiers are translated once by scripts/migrate_legacy.py.
    return str(course_id)


def _require_ingest(authorization: str | None) -> None:
    expected = os.environ.get("VIDEO_SEARCH_INGEST_TOKEN", "").strip()
    scheme, separator, token = (authorization or "").partition(" ")
    if not expected:
        raise HTTPException(status_code=503, detail="VideoSearch ingestion authentication is not configured")
    if not separator or scheme.lower() != "bearer" or not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Unauthorized", headers={"WWW-Authenticate": "Bearer"})


@router.get("/health")
def health() -> dict[str, Any]:
    return {"status": "healthy", "service": "mmkg", "timestamp": int(time.time())}


@router.post("/jxb_login")
def jxb_login(request: JxbLoginRequest) -> dict[str, Any]:
    try:
        claims = auth.verify_jxb_token(request.kg_token)
    except Exception as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {
        "access_token": auth.create_access_token(claims["email"], claims["role"], claims["courseid"]),
        "token_type": "bearer",
        **claims,
    }


def _jaccount_login(request: JaccountLoginRequest) -> dict[str, Any]:
    try:
        identity = auth.exchange_jaccount_code(request.code)
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"JAccount login failed: {error}") from error
    return {
        "access_token": auth.create_access_token(identity["email"], identity["role"]),
        "token_type": "bearer",
        "email": identity["email"],
    }


router.add_api_route("/jaccount_login", _jaccount_login, methods=["POST"])
# Preserve the misspelled path used by one historical integration.
router.add_api_route("/jaccount_loggin", _jaccount_login, methods=["POST"], include_in_schema=False)


def _email_allowed(email: str) -> bool:
    return bool(auth._teacher_courses(email))


@router.post("/send_code")
def send_code(request: SendCodeRequest) -> dict[str, bool]:
    if not _email_allowed(request.email):
        raise HTTPException(status_code=403, detail="当前邮箱不在可登录名单中")
    code = "".join(random.choices(string.digits, k=6))
    host = os.environ.get("MMKG_SMTP_HOST", "").strip()
    user = os.environ.get("MMKG_SMTP_USER", "").strip()
    password = os.environ.get("MMKG_SMTP_PASSWORD", "")
    if not host or not user or not password:
        raise HTTPException(status_code=503, detail="email login is not configured")
    message = MIMEText(code)
    message["Subject"], message["From"], message["To"] = "MMKG login", user, request.email
    with smtplib.SMTP_SSL(host, int(os.environ.get("MMKG_SMTP_PORT", "465")), timeout=10) as server:
        server.login(user, password)
        server.sendmail(user, [request.email], message.as_string())
    _codes[request.email] = (code, time.time() + 300)
    return {"success": True}


@router.post("/login")
def email_login(request: EmailLoginRequest) -> dict[str, str]:
    expected = _codes.pop(request.email, None)
    if expected is None or expected[1] < time.time() or not secrets.compare_digest(expected[0], request.code):
        raise HTTPException(status_code=400, detail="验证码错误或已过期")
    return {"access_token": auth.create_access_token(request.email, auth.UserRole.TA), "token_type": "bearer"}


@router.get("/courses")
def list_courses(user=Depends(auth.get_current_user_or_none)) -> list[dict[str, Any]]:
    result = []
    for course in store.list_courses():
        permission = auth.get_course_permission(user, str(course["id"]))
        if permission != auth.GraphPermission.UNKNOWN:
            result.append({**course, "perm": permission.value})
    return result


@router.get("/graph/{course_id}/perm")
def permission(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, str]:
    return {"perm": auth.get_course_permission(user, course_id).value}


@router.get("/graph/{course_id}")
def graph(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    return store.read_graph(_storage_course(course_id))


@router.get("/graph/{course_id}/nodes")
def graph_nodes(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    nodes = store.list_nodes(_storage_course(course_id))
    return {"courseid": course_id, "nodes": nodes, "total": len(nodes)}


@router.get("/graph/{course_id}/node/{node_id:path}/edges")
def node_edges(course_id: str, node_id: str, user=Depends(auth.get_current_user)) -> list[dict[str, Any]]:
    auth.require_course(user, course_id)
    try:
        return store.node_edges(_storage_course(course_id), node_id)
    except ValueError as error:
        raise _not_found(error)


@router.get("/graph/{course_id}/node/{node_id:path}")
def get_node(course_id: str, node_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    try:
        return store.get_node(_storage_course(course_id), node_id)
    except ValueError as error:
        raise _not_found(error)


@router.post("/graph/{course_id}/node", status_code=201)
def add_node(course_id: str, body: NodePayload, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    try:
        return store.add_node(_storage_course(course_id), _dump(body, exclude_none=True))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.put("/graph/{course_id}/node/{node_id:path}")
def update_node(course_id: str, node_id: str, body: NodePayload, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    try:
        return store.update_node(_storage_course(course_id), node_id, _dump(body, exclude_none=True))
    except ValueError as error:
        raise _not_found(error)


@router.delete("/graph/{course_id}/node/{node_id:path}")
def delete_node(course_id: str, node_id: str, user=Depends(auth.get_current_user)) -> dict[str, bool]:
    auth.require_course(user, course_id, write=True)
    try:
        store.delete_node(_storage_course(course_id), node_id)
    except ValueError as error:
        raise _not_found(error)
    return {"success": True}


@router.get("/graph/{course_id}/edge/{edge_id}")
def get_edge(course_id: str, edge_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    try:
        return store.get_edge(_storage_course(course_id), edge_id)
    except ValueError as error:
        raise _not_found(error)


@router.post("/graph/{course_id}/edge", status_code=201)
def add_edge(course_id: str, body: EdgePayload, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    try:
        return store.add_edge(_storage_course(course_id), _dump(body, exclude_none=True))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.put("/graph/{course_id}/edge/{edge_id}")
def update_edge(course_id: str, edge_id: str, body: EdgePayload, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    try:
        return store.update_edge(_storage_course(course_id), edge_id, _dump(body, exclude_none=True))
    except ValueError as error:
        raise _not_found(error)


@router.delete("/graph/{course_id}/edge/{edge_id}")
def delete_edge(course_id: str, edge_id: str, user=Depends(auth.get_current_user)) -> dict[str, bool]:
    auth.require_course(user, course_id, write=True)
    try:
        store.delete_edge(_storage_course(course_id), edge_id)
    except ValueError as error:
        raise _not_found(error)
    return {"success": True}


@router.get("/graph/{course_id}/relations")
def relations(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, list[str]]:
    auth.require_course(user, course_id)
    values = sorted({str(edge.get("relation")) for edge in store.read_graph(_storage_course(course_id))["edges"] if edge.get("relation")})
    return {"relations": values}


@router.post("/v1/courses/{course_id}/video-chunks")
def video_chunks(course_id: str, body: VideoChunksPayload, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_ingest(authorization)
    return store.ingest_video_chunks(_storage_course(course_id), [_dump(item) for item in body.chunks])


@router.put("/v1/courses/{course_id}/video-relations/import")
def import_relations(course_id: str, body: VideoRelationsPayload, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_ingest(authorization)
    return store.import_video_relations(_storage_course(course_id), [_dump(item) for item in body.relations])


@router.get("/v1/courses/{course_id}/video-relations/import")
def relation_status(course_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _require_ingest(authorization)
    return store.video_relation_status(_storage_course(course_id))


@router.get("/v1/courses/{course_id}/knowledge-points/{point_id}/video-segments")
def point_segments(course_id: str, point_id: str, name: str | None = Query(default=None, max_length=1024), user=Depends(auth.get_current_user)) -> dict[str, list[str]]:
    auth.require_course(user, course_id)
    return {"segment_ids": store.find_video_segments(_storage_course(course_id), point_id, name)}


@router.get("/v1/courses/{course_id}/knowledge-points")
def all_points(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    nodes = store.list_nodes(_storage_course(course_id))
    return {"courseid": course_id, "knowledge_points": nodes, "total": len(nodes)}


@router.get("/v1/courses/{course_id}/graphs/{view}")
def graph_view(course_id: str, view: Literal["base", "document", "fused", "video"], user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    return store.read_view(_storage_course(course_id), view)


@router.put("/v1/courses/{course_id}/graphs/{view}")
def put_graph_view(course_id: str, view: Literal["base"], body: GraphPayload, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    storage_course = _storage_course(course_id)
    graph = store.write_view(storage_course, view, _dump(body))
    return {"graph": graph, "fused": store.read_view(storage_course, "fused")}


@router.post("/v1/courses/{course_id}/graphs/fused/rebuild")
def rebuild(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    return store.rebuild_fused(_storage_course(course_id))


@router.post("/v1/courses/{course_id}/graphs/fused/rebuild/jobs", status_code=202)
def rebuild_job(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    return jobs.create_rebuild(_storage_course(course_id))


@router.get("/v1/courses/{course_id}/status")
def course_status(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    return jobs.course_status(_storage_course(course_id))


@router.get("/v1/courses/{course_id}/config")
def config(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    return store.read_metadata(_storage_course(course_id), "config", {"source_weights": {"base": 1, "document": 1, "video": 1}})


@router.put("/v1/courses/{course_id}/config")
def put_config(course_id: str, body: dict[str, Any] = Body(...), user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    return store.write_metadata(_storage_course(course_id), "config", body)


@router.get("/v1/courses/{course_id}/overlay")
def overlay(course_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    return store.read_metadata(_storage_course(course_id), "overlay", {})


@router.put("/v1/courses/{course_id}/overlay")
def put_overlay(course_id: str, body: dict[str, Any] = Body(...), rebuild_after: bool = Query(True), user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    storage_course = _storage_course(course_id)
    value = store.write_metadata(storage_course, "overlay", body)
    return {"overlay": value, "rebuild": jobs.create_rebuild(storage_course, "overlay_updated") if rebuild_after else None}


@router.post("/v1/courses/{course_id}/extract/jobs", status_code=202)
def extract(course_id: str, file: UploadFile = File(...), user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id, write=True)
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="only PDF files are supported")
    return jobs.create_extraction(_storage_course(course_id), file.filename, file.file)


@router.get("/v1/jobs/{job_id}")
def get_job(job_id: str, user=Depends(auth.get_current_user)) -> dict[str, Any]:
    try:
        job = jobs.load(job_id)
    except ValueError as error:
        raise _not_found(error)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    auth.require_course(user, str(job["courseid"]))
    return job


@router.get("/v1/courses/{course_id}/jobs")
def list_jobs(course_id: str, limit: int = Query(50, ge=1, le=100), user=Depends(auth.get_current_user)) -> dict[str, Any]:
    auth.require_course(user, course_id)
    rows = jobs.list(_storage_course(course_id), limit)
    return {"jobs": rows, "total": len(rows)}
