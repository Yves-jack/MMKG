from __future__ import annotations

import json
import time
from base64 import urlsafe_b64encode

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from mmkg_api import api, auth
from mmkg_api.jobs import JobStore
from mmkg_api.main import app
from mmkg_api.storage import GraphStore
from scripts.migrate_legacy import migrate


def signed_jxb_token(private_key, **overrides):
    now = int(time.time())
    payload = {
        "email": "teacher@sjtu.edu.cn",
        "role": "TeacherEnrollment",
        "courseid": "92311",
        "iat": now,
        "exp": now + 3600,
        "aud": "knowledge-graph",
        "jti": "test-token",
        **overrides,
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return urlsafe_b64encode(raw + b"|" + private_key.sign(raw)).decode()


def setup_api(tmp_path, monkeypatch):
    monkeypatch.setenv("MMKG_JWT_SECRET", "test-secret")
    monkeypatch.setenv("VIDEO_SEARCH_INGEST_TOKEN", "ingest-secret")
    private_key = Ed25519PrivateKey.generate()
    public_path = tmp_path / "public.pem"
    public_path.write_bytes(private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ))
    monkeypatch.setenv("JXB_PUBLIC_KEY_PATH", str(public_path))
    api.store = GraphStore(tmp_path / "data")
    api.jobs = JobStore(api.store)
    return TestClient(app), private_key


def login(client, private_key):
    response = client.post("/api/jxb_login", json={"kg_token": signed_jxb_token(private_key)})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_jxb_login_graph_crud_and_all_nodes(tmp_path, monkeypatch):
    client, key = setup_api(tmp_path, monkeypatch)
    headers = login(client, key)

    first = client.post("/api/graph/92311/node", headers=headers, json={"id": "kp:set", "name": "集合"})
    second = client.post("/api/graph/92311/node", headers=headers, json={"id": "kp:graph", "name": "图"})
    assert first.status_code == second.status_code == 201
    edge = client.post(
        "/api/graph/92311/edge",
        headers=headers,
        json={"source": "kp:set", "target": "kp:graph", "relation": "相关"},
    )
    assert edge.status_code == 201
    edge_id = edge.json()["id"]
    assert client.get("/api/graph/92311/node/kp:set/edges", headers=headers).status_code == 200

    all_nodes = client.get("/api/v1/courses/92311/knowledge-points", headers=headers)
    assert all_nodes.status_code == 200
    assert all_nodes.json()["total"] == 2
    assert {item["id"] for item in all_nodes.json()["knowledge_points"]} == {"kp:set", "kp:graph"}

    assert client.put(f"/api/graph/92311/edge/{edge_id}", headers=headers, json={"relation": "前置"}).json()["relation"] == "前置"
    assert client.delete(f"/api/graph/92311/edge/{edge_id}", headers=headers).status_code == 200
    renamed = client.put(
        "/api/graph/92311/node/kp:set",
        headers=headers,
        json={"id": "kp:sets", "name": "集合论", "info": "set theory"},
    )
    assert renamed.json()["id"] == "kp:sets"
    assert renamed.json()["info"] == "set theory"
    fused = client.get("/api/v1/courses/92311/graphs/fused", headers=headers).json()
    assert {node["id"] for node in fused["nodes"]} == {"kp:sets", "kp:graph"}
    assert client.delete("/api/graph/92311/node/kp:graph", headers=headers).status_code == 200


def test_student_can_read_but_cannot_mutate(tmp_path, monkeypatch):
    client, key = setup_api(tmp_path, monkeypatch)
    teacher = login(client, key)
    assert client.post(
        "/api/graph/92311/node",
        headers=teacher,
        json={"id": "kp:set", "name": "集合"},
    ).status_code == 201
    response = client.post(
        "/api/jxb_login",
        json={"kg_token": signed_jxb_token(key, role="StudentEnrollment")},
    )
    student = {"Authorization": f"Bearer {response.json()['access_token']}"}
    assert client.get("/api/graph/92311", headers=student).status_code == 200
    assert client.post(
        "/api/graph/92311/node",
        headers=student,
        json={"id": "kp:forbidden"},
    ).status_code == 403


def test_crud_updates_document_only_items_visible_in_fused_graph(tmp_path, monkeypatch):
    client, key = setup_api(tmp_path, monkeypatch)
    headers = login(client, key)
    api.store.write_view(
        "92311",
        "document",
        {
            "nodes": [
                {"id": "pdf:a", "name": "章节 A"},
                {"id": "pdf:b", "name": "章节 B"},
            ],
            "edges": [
                {"id": "pdf-edge:1", "source": "pdf:a", "target": "pdf:b", "relation": "后续"},
            ],
        },
    )
    renamed = client.put(
        "/api/graph/92311/node/pdf:a",
        headers=headers,
        json={"id": "pdf:intro", "name": "导论"},
    )
    assert renamed.status_code == 200, renamed.text
    updated = client.put(
        "/api/graph/92311/edge/pdf-edge:1",
        headers=headers,
        json={"relation": "前置"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["source"] == "pdf:intro"
    assert client.delete("/api/graph/92311/edge/pdf-edge:1", headers=headers).status_code == 200
    assert client.delete("/api/graph/92311/node/pdf:b", headers=headers).status_code == 200


def test_legacy_api_surface_is_present():
    paths = {route.path for route in app.routes}
    expected = {
        "/api/send_code",
        "/api/login",
        "/api/jaccount_login",
        "/api/jaccount_loggin",
        "/api/jxb_login",
        "/api/courses",
        "/api/graph/{course_id}",
        "/api/graph/{course_id}/nodes",
        "/api/graph/{course_id}/node/{node_id:path}",
        "/api/graph/{course_id}/node/{node_id:path}/edges",
        "/api/graph/{course_id}/edge/{edge_id}",
        "/api/graph/{course_id}/relations",
        "/api/v1/courses/{course_id}/video-chunks",
        "/api/v1/courses/{course_id}/video-relations/import",
        "/api/v1/courses/{course_id}/knowledge-points/{point_id}/video-segments",
        "/api/v1/courses/{course_id}/graphs/{view}",
        "/api/v1/courses/{course_id}/extract/jobs",
        "/api/v1/jobs/{job_id}",
    }
    assert expected <= paths


def test_video_chunks_are_authenticated_and_rebuild_dynamic_graph(tmp_path, monkeypatch):
    client, key = setup_api(tmp_path, monkeypatch)
    headers = login(client, key)
    client.put(
        "/api/v1/courses/92311/graphs/base",
        headers=headers,
        json={"nodes": [{"id": "kp:set", "name": "集合"}], "edges": []},
    )
    payload = {
        "chunks": [{
            "segment_id": "seg-1",
            "lesson_id": "1",
            "summary": "本段介绍集合与集合运算",
            "start_sec": 10,
            "end_sec": 20,
            "link": "https://video.example/1.mp4",
        }]
    }
    assert client.post("/api/v1/courses/92311/video-chunks", json=payload).status_code == 401
    ingested = client.post(
        "/api/v1/courses/92311/video-chunks",
        headers={"Authorization": "Bearer ingest-secret"},
        json=payload,
    )
    assert ingested.status_code == 200, ingested.text
    assert ingested.json()["video_nodes"] == 1

    relation = client.get(
        "/api/v1/courses/92311/knowledge-points/kp:set/video-segments",
        headers=headers,
    )
    assert relation.json() == {"segment_ids": ["seg-1"]}
    fused = client.get("/api/v1/courses/92311/graphs/fused", headers=headers).json()
    assert fused["nodes"][0]["video_anchors"][0]["segment_id"] == "seg-1"


def test_jaccount_login_and_misspelled_compatibility_path(tmp_path, monkeypatch):
    client, _key = setup_api(tmp_path, monkeypatch)
    monkeypatch.setattr(
        auth,
        "exchange_jaccount_code",
        lambda code: {"email": f"{code}@sjtu.edu.cn", "role": "TaEnrollment"},
    )
    for path in ("/api/jaccount_login", "/api/jaccount_loggin"):
        response = client.post(path, json={"code": "alice"})
        assert response.status_code == 200
        assert response.json()["email"] == "alice@sjtu.edu.cn"


def test_legacy_course_is_migrated_to_canvas_course_id(tmp_path):
    source = tmp_path / "legacy"
    source.mkdir()
    (source / "course_40.json").write_text(
        json.dumps({"nodes": [{"id": "kp:set", "name": "集合"}], "edges": []}),
        encoding="utf-8",
    )
    target = tmp_path / "mmkg"
    report = migrate(source, target, {"40": "92311"})
    assert report["92311"]["base_nodes"] == 1
    graph = GraphStore(target).read_view("92311", "fused")
    assert [node["id"] for node in graph["nodes"]] == ["kp:set"]
