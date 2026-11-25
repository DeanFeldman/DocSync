"""Local ONLYOFFICE editing bridge for the optional desktop prototype."""

import base64
from difflib import unified_diff
from ipaddress import IPv4Address
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
from threading import Lock
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .batch_service import stage_related_find_operations
from .config import settings
from .database import get_session
from .editor_service import (
    current_version_for_document,
    document_version_path,
    get_version_or_404,
    save_external_document_version,
)
from .office_related import related_operations, suggest_related_edits
from .validation_service import DocumentValidationService
from .text_inventory_service import build_text_inventory


router = APIRouter()
lock = Lock()
MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def office_origin() -> str:
    value = os.getenv("DOCSYNC_ONLYOFFICE_URL", "").rstrip("/")
    try:
        source = urlsplit(value)
        if (
            source.scheme == "http" and source.hostname in {"localhost", "127.0.0.1"}
            and source.netloc == f"{source.hostname}:{source.port}"
            and source.port and not (source.path or source.query or source.fragment)
            and len(os.getenv("DOCSYNC_ONLYOFFICE_SECRET", "")) >= 24
        ):
            return value
    except ValueError:
        pass
    return ""


def _enabled(request: Request) -> tuple[str, str]:
    origin = office_origin()
    if not origin or request.url.hostname not in {"127.0.0.1", "localhost"} or not request.url.port:
        raise HTTPException(404, "The local ONLYOFFICE editor is disabled.")
    return origin, f"http://127.0.0.1:{request.url.port}"


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _signature(value: str) -> str:
    return _b64(hmac.digest(os.environ["DOCSYNC_ONLYOFFICE_SECRET"].encode(), value.encode(), "sha256"))


def _sign(claims: dict) -> str:
    header = _b64(b'{"alg":"HS256","typ":"JWT"}')
    message = header + "." + _b64(json.dumps(claims, separators=(",", ":")).encode())
    return message + "." + _signature(message)


def _callback_claims(token: str) -> dict:
    try:
        header, claims, signature = token.split(".")
        if hmac.compare_digest(signature, _signature(header + "." + claims)):
            packet = json.loads(base64.urlsafe_b64decode(claims + "=" * (-len(claims) % 4)))
            if packet.get("operation", "callback") == "callback" and isinstance(packet.get("payload"), dict):
                return packet["payload"]
    except (ValueError, TypeError, UnicodeError, AttributeError):
        pass
    raise HTTPException(403, "The document server signature is invalid.")


def _directory(version_id: str) -> Path:
    return settings.data_dir / "onlyoffice-drafts" / hashlib.sha256(version_id.encode()).hexdigest()


def _read_key(version_id: str, supplied: str | None = None) -> str:
    key_file = _directory(version_id) / "editor-key.txt"
    if not key_file.is_file():
        raise HTTPException(404, "This editing session is unavailable.")
    actual = key_file.read_text(encoding="ascii")
    if supplied is not None and not hmac.compare_digest(actual, supplied):
        raise HTTPException(404, "This editing session is unavailable.")
    return actual


def _draft_path(version_id: str) -> Path:
    return _directory(version_id) / "draft.docx"


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _current(session: Session, version_id: str):
    version = get_version_or_404(session, version_id)
    if current_version_for_document(session, version.document).id != version.id:
        raise HTTPException(409, "The current version changed. Reopen the latest version before editing in ONLYOFFICE.")
    return version


@router.get("/api/onlyoffice")
def check_onlyoffice():
    return {"enabled": bool(office_origin())}


@router.post("/api/onlyoffice/{version_id}/open")
def open_editor(version_id: str, request: Request, session: Session = Depends(get_session)):
    _, local_origin = _enabled(request)
    _current(session, version_id)
    with lock:
        directory = _directory(version_id)
        directory.mkdir(parents=True, exist_ok=True)
        key_file = directory / "editor-key.txt"
        if not key_file.exists():
            key_file.write_text(secrets.token_hex(24), encoding="ascii")
        key = _read_key(version_id)
    return {"embed_url": f"{local_origin.replace('127.0.0.1', 'localhost')}/onlyoffice-bridge/{version_id}/{key}"}


@router.get("/onlyoffice-bridge/{version_id}/{key}", response_class=HTMLResponse)
def editor_bridge(version_id: str, key: str, request: Request, session: Session = Depends(get_session)):
    origin, local_origin = _enabled(request)
    if request.url.hostname != "localhost":
        raise HTTPException(404, "This editor frame uses a separate local origin.")
    _read_key(version_id, key)
    version = get_version_or_404(session, version_id)
    service_origin = local_origin
    relay_host = os.getenv("DOCSYNC_ONLYOFFICE_WSL_RELAY_HOST")
    if relay_host:
        try:
            address = IPv4Address(relay_host)
        except ValueError as exc:
            raise HTTPException(503, "The local document relay address is invalid.") from exc
        if not address.is_private or address.is_loopback:
            raise HTTPException(503, "The document relay needs a private WSL address.")
        service_origin = f"http://{address}:8092/{request.url.port}"
    root = f"{service_origin}/onlyoffice-service/{version_id}/{key}"
    config = {
        "documentType": "word", "height": "100%", "width": "100%",
        "document": {
            "fileType": "docx", "key": key, "title": version.document.original_name,
            "url": root + "/source", "permissions": {"edit": True, "download": False, "print": False},
        },
        "editorConfig": {"mode": "edit", "callbackUrl": root + "/callback",
                         "customization": {"forcesave": True}},
    }
    config["token"] = _sign(config)
    serialized = json.dumps(config).replace("<", "\\u003c")
    nonce = secrets.token_hex(16)
    return HTMLResponse(f'''<!doctype html><html lang="en"><meta charset="utf-8">
        <title>ONLYOFFICE document editor</title>
        <style nonce="{nonce}">html,body,#editor,iframe{{width:100%;height:100%;margin:0;border:0}}</style>
        <div id="editor">Loading the local editor…</div>
        <script src="{origin}/web-apps/apps/api/documents/api.js"></script>
        <script nonce="{nonce}">
          if (window.DocsAPI) {{
            const config = {serialized};
            config.events = {{
              onDocumentReady: () => {{ document.body.dataset.officeStatus = 'ready'; }},
              onError: () => {{ document.body.dataset.officeStatus = 'error'; }},
            }};
            new DocsAPI.DocEditor('editor', config);
          }}
          else document.getElementById('editor').textContent = 'The local ONLYOFFICE service is unavailable.';
        </script></html>''', headers={
        "Content-Security-Policy": (
            f"default-src 'none'; script-src {origin} 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
            f"frame-src {origin}; frame-ancestors {local_origin}; connect-src {origin}; base-uri 'none'"
        ),
    })


@router.get("/onlyoffice-service/{version_id}/{key}/source")
def office_source(version_id: str, key: str, request: Request, session: Session = Depends(get_session)):
    _enabled(request)
    _read_key(version_id, key)
    version = _current(session, version_id)
    path = _draft_path(version_id)
    if not path.is_file():
        path = document_version_path(version)
    return FileResponse(path, media_type=MIME)


def _download_draft(origin: str, url: str) -> bytes:
    parts = urlsplit(url)
    if f"{parts.scheme}://{parts.netloc}" != origin or parts.fragment:
        raise HTTPException(422, "The saved document URL is outside the local document service.")
    result = bytearray()
    try:
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=30) as client:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                for chunk in response.iter_bytes():
                    result.extend(chunk)
                    if len(result) > settings.max_file_bytes:
                        raise HTTPException(413, "The saved DOCX exceeds the document size limit.")
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Could not retrieve the saved DOCX from the local document service.") from exc
    return bytes(result)


@router.post("/onlyoffice-service/{version_id}/{key}/callback")
def office_callback(version_id: str, key: str, request: Request, body: dict):
    origin, _ = _enabled(request)
    _read_key(version_id, key)
    token = body.get("token") or request.headers.get("Authorization", "").removeprefix("Bearer ")
    claims = _callback_claims(token if isinstance(token, str) else "")
    if claims.get("key") != key:
        raise HTTPException(403, "The document server signed a different editing session.")
    if claims.get("status") in {2, 6}:
        url = claims.get("url")
        if not isinstance(url, str):
            raise HTTPException(422, "The document server did not return a DOCX URL.")
        with lock:
            _read_key(version_id, key)
            content = _download_draft(origin, url)
            DocumentValidationService.validate_package(content, filename="draft.docx")
            DocumentValidationService.parse_file(content, filename="draft.docx")
            path = _draft_path(version_id)
            temporary = path.with_suffix(".tmp")
            temporary.write_bytes(content)
            temporary.replace(path)
    return {"error": 0}


@router.get("/api/onlyoffice/{version_id}/draft")
def office_draft(version_id: str, request: Request):
    _enabled(request)
    _read_key(version_id)
    with lock:
        path = _draft_path(version_id)
        return {"draft_sha256": _digest(path.read_bytes()) if path.is_file() else None}


@router.get("/api/onlyoffice/{version_id}/draft/download")
def download_draft(version_id: str, request: Request):
    _enabled(request)
    _read_key(version_id)
    with lock:
        path = _draft_path(version_id)
        if not path.is_file():
            raise HTTPException(404, "Save the document in ONLYOFFICE first.")
        return Response(path.read_bytes(), media_type=MIME, headers={"Content-Disposition": 'attachment; filename="DocSync-draft.docx"'})


@router.get("/api/onlyoffice/{version_id}/review")
def review_draft(version_id: str, request: Request, session: Session = Depends(get_session)):
    _enabled(request)
    _read_key(version_id)
    version = _current(session, version_id)
    with lock:
        path = _draft_path(version_id)
        if not path.is_file():
            raise HTTPException(404, "Save the document in ONLYOFFICE first.")
        draft = path.read_bytes()

    def lines(content: bytes) -> list[str]:
        inventory = build_text_inventory(content, document_id=version.document_id, version_id=version.id)
        return [segment.text for segment in inventory.segments
                if segment.structure_type not in {"field_instruction", "tracked_delete"}]

    original = document_version_path(version).read_bytes()
    changes = list(unified_diff(lines(original), lines(draft), lineterm=""))
    related = suggest_related_edits(session, version, original, draft)
    return {
        "draft_sha256": _digest(draft), "changes": changes[:160], "truncated": len(changes) > 160,
        "related_edits": [edit.preview() for edit in related],
    }


class AcceptDraft(BaseModel):
    draft_sha256: str


class StageRelatedEdits(AcceptDraft):
    target_ids: set[str] = Field(min_length=1, max_length=20000)


@router.post("/api/documents/{document_id}/onlyoffice/{version_id}/stage-related", status_code=201)
def stage_related_draft(document_id: str, version_id: str, body: StageRelatedEdits, request: Request, session: Session = Depends(get_session)):
    _enabled(request)
    with lock:
        _read_key(version_id)
        version = _current(session, version_id)
        if version.document_id != document_id:
            raise HTTPException(404, "The saved copy does not belong to this document.")
        path = _draft_path(version_id)
        if not path.is_file():
            raise HTTPException(409, "Save the document before staging related edits.")
        draft = path.read_bytes()
        if _digest(draft) != body.draft_sha256:
            raise HTTPException(409, "The saved draft changed. Review the latest saved copy.")
        related = suggest_related_edits(session, version, document_version_path(version).read_bytes(), draft)
        chosen = [edit for edit in related if edit.target.occurrence_id in body.target_ids]
        if len(chosen) != len(body.target_ids):
            raise HTTPException(409, "A related version changed. Review the current matches before staging.")
        return stage_related_find_operations(session, version.document.document_set_id, related_operations(chosen))


@router.post("/api/documents/{document_id}/onlyoffice/{version_id}/apply", status_code=201)
def apply_draft(document_id: str, version_id: str, body: AcceptDraft, request: Request, session: Session = Depends(get_session)):
    _enabled(request)
    with lock:
        _read_key(version_id)
        path = _draft_path(version_id)
        if not path.is_file() or _digest(path.read_bytes()) != body.draft_sha256:
            raise HTTPException(409, "The saved draft changed. Review the latest saved copy before applying.")
        return save_external_document_version(session, document_id, version_id, path)
