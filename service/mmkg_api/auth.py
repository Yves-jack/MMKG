"""Authentication and course-scoped authorization owned by MMKG."""

from __future__ import annotations

import csv
import json
import os
import time
from base64 import urlsafe_b64decode
from enum import Enum
from pathlib import Path
from typing import Any

import httpx
import jwt
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/jaccount_login", auto_error=False)


class UserRole(str, Enum):
    STUDENT = "StudentEnrollment"
    TA = "TaEnrollment"
    TEACHER = "TeacherEnrollment"


class GraphPermission(str, Enum):
    UNKNOWN = "U"
    LOGIN = "L"
    READ = "RO"
    WRITE = "RW"


ROLE_ALIASES = {
    "student": UserRole.STUDENT,
    "studentenrollment": UserRole.STUDENT,
    "ta": UserRole.TA,
    "taenrollment": UserRole.TA,
    "teacher": UserRole.TEACHER,
    "teacherenrollment": UserRole.TEACHER,
}


def normalize_role(value: str | UserRole | None) -> UserRole | None:
    if isinstance(value, UserRole):
        return value
    return ROLE_ALIASES.get(str(value or "").strip().lower())


def _jwt_secret() -> str:
    secret = os.environ.get("MMKG_JWT_SECRET", "").strip()
    if not secret:
        raise RuntimeError("MMKG_JWT_SECRET is required")
    return secret


def create_access_token(email: str, role: str | UserRole, course_id: str | None = None) -> str:
    normalized = normalize_role(role)
    if not normalized:
        raise ValueError("invalid role")
    now = int(time.time())
    return jwt.encode(
        {
            "email": email,
            "role": normalized.value,
            "courseid": str(course_id) if course_id not in (None, "") else None,
            "iat": now,
            "exp": now + int(os.environ.get("MMKG_ACCESS_TOKEN_TTL_SECONDS", "43200")),
            "aud": "mmkg-api",
        },
        _jwt_secret(),
        algorithm="HS256",
    )


def decode_access_token(token: str) -> dict[str, Any]:
    try:
        return jwt.decode(token, _jwt_secret(), algorithms=["HS256"], audience="mmkg-api")
    except Exception as error:
        raise HTTPException(status_code=401, detail="invalid access token") from error


def get_current_user(token: str | None = Depends(oauth2_scheme)) -> dict[str, Any]:
    if not token or token == "undefined":
        raise HTTPException(status_code=401, detail="missing access token")
    payload = decode_access_token(token)
    role = normalize_role(payload.get("role"))
    if not payload.get("email") or role is None:
        raise HTTPException(status_code=401, detail="invalid access token claims")
    return {"email": str(payload["email"]), "role": role, "courseid": payload.get("courseid")}


def get_current_user_or_none(token: str | None = Depends(oauth2_scheme)) -> dict[str, Any] | None:
    return None if not token or token == "undefined" else get_current_user(token)


def _load_public_key() -> Ed25519PublicKey:
    path = os.environ.get("JXB_PUBLIC_KEY_PATH", "").strip()
    if not path:
        raise RuntimeError("JXB_PUBLIC_KEY_PATH is required")
    with open(path, "rb") as stream:
        key = serialization.load_pem_public_key(stream.read())
    if not isinstance(key, Ed25519PublicKey):
        raise RuntimeError("JXB_PUBLIC_KEY_PATH must contain an Ed25519 public key")
    return key


def verify_jxb_token(token: str) -> dict[str, str]:
    try:
        raw = urlsafe_b64decode(token + "=" * (-len(token) % 4))
    except Exception as error:
        raise ValueError("invalid kg_token encoding") from error
    if len(raw) < 65 or raw[-65:-64] != b"|":
        raise ValueError("invalid kg_token format")
    payload_bytes, signature = raw[:-65], raw[-64:]
    try:
        _load_public_key().verify(signature, payload_bytes)
    except InvalidSignature as error:
        raise ValueError("invalid kg_token signature") from error
    payload = json.loads(payload_bytes.decode("utf-8"))
    now = int(time.time())
    required = ("email", "role", "courseid", "iat", "exp", "aud", "jti")
    if any(payload.get(key) in (None, "") for key in required):
        raise ValueError("kg_token missing required claims")
    skew = max(0, int(os.environ.get("KG_TOKEN_CLOCK_SKEW_SECONDS", "30")))
    if int(payload["iat"]) > now + skew or int(payload["exp"]) <= now - skew:
        raise ValueError("kg_token is expired or not yet valid")
    if payload["aud"] != os.environ.get("KG_TOKEN_AUDIENCE", "knowledge-graph"):
        raise ValueError("invalid kg_token audience")
    role = normalize_role(payload["role"])
    if role is None:
        raise ValueError("invalid kg_token role")
    return {"email": str(payload["email"]), "role": role.value, "courseid": str(payload["courseid"])}


def exchange_jaccount_code(code: str) -> dict[str, str]:
    client_id = os.environ.get("JACCOUNT_CLIENT_ID", "").strip()
    client_secret = os.environ.get("JACCOUNT_CLIENT_SECRET", "").strip()
    redirect_uri = os.environ.get("JACCOUNT_REDIRECT_URI", "").strip()
    if not client_id or not client_secret or not redirect_uri:
        raise RuntimeError("JAccount OIDC is not configured")
    token_url = os.environ.get("JACCOUNT_TOKEN_URL", "https://jaccount.sjtu.edu.cn/oauth2/token")
    response = httpx.post(
        token_url,
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri},
        auth=(client_id, client_secret),
        timeout=10,
    )
    response.raise_for_status()
    token_data = response.json()
    id_token = str(token_data.get("id_token") or "")
    if not id_token:
        raise ValueError("JAccount did not return id_token")
    issuer = os.environ.get("JACCOUNT_ISSUER", "https://jaccount.sjtu.edu.cn/oauth2/")
    jwks_url = os.environ.get("JACCOUNT_JWKS_URL", "https://jaccount.sjtu.edu.cn/oauth2/jwks")
    key = jwt.PyJWKClient(jwks_url).get_signing_key_from_jwt(id_token).key
    claims = jwt.decode(id_token, key, algorithms=["RS256"], audience=client_id, issuer=issuer)
    subject = str(claims.get("sub") or "").strip()
    if not subject:
        raise ValueError("JAccount id_token missing sub")
    email = subject if "@" in subject else f"{subject}@sjtu.edu.cn"
    return {"email": email, "role": UserRole.TA.value}


def _teacher_courses(email: str) -> set[str]:
    path = Path(os.environ.get("MMKG_TEACHER_INFO", "/data/teacher_info.csv"))
    if not path.is_file():
        return set()
    result: set[str] = set()
    with path.open(encoding="utf-8") as stream:
        for row in csv.reader(stream):
            if len(row) < 2:
                continue
            row_email = row[1].strip()
            if row_email and "@" not in row_email:
                row_email += "@sjtu.edu.cn"
            if row_email == email:
                result.add(row[0].strip())
                if len(row) >= 3 and row[2].strip():
                    result.add(row[2].strip())
    return result


def get_course_permission(user: dict[str, Any] | None, course_id: str) -> GraphPermission:
    if user is None:
        return GraphPermission.LOGIN
    role = normalize_role(user.get("role"))
    token_course = str(user.get("courseid") or "")
    if token_course:
        if token_course != str(course_id):
            return GraphPermission.UNKNOWN
        return GraphPermission.READ if role == UserRole.STUDENT else GraphPermission.WRITE
    if role in {UserRole.TA, UserRole.TEACHER} and str(course_id) in _teacher_courses(str(user.get("email") or "")):
        return GraphPermission.WRITE
    return GraphPermission.UNKNOWN


def require_course(user: dict[str, Any], course_id: str, *, write: bool = False) -> None:
    permission = get_course_permission(user, course_id)
    allowed = permission == GraphPermission.WRITE if write else permission in {GraphPermission.READ, GraphPermission.WRITE}
    if not allowed:
        raise HTTPException(status_code=403, detail="course permission denied")
