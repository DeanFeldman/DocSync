"""Local ONLYOFFICE editing bridge for the optional desktop prototype."""

import base64
from collections import Counter
from ipaddress import IPv4Address
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
from threading import Lock
from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy.orm import Session

from .config import settings
from .database import get_session
from .document_service import get_document_set_or_404, serialize_document_set
from .editor_service import (
    EDITOR_GENERATION_LOCK,
    current_version_for_document,
    document_version_path,
    get_version_or_404,
    save_office_document_versions,
    serialize_editor_generation_status,
)
from .models import DocumentRecord, EditorOperation
from .office_related import sync_related_paragraphs
from .validation_service import DocumentValidationService


router = APIRouter()
lock = Lock()
save_state_lock = Lock()
active_saves: Counter[str] = Counter()
failed_saves: dict[str, str] = {}
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
        raise HTTPException(503, "The local ONLYOFFICE service is unavailable. Start it and try again.")
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
            if isinstance(packet, dict) and packet.get("operation", "callback") == "callback":
                if isinstance(packet.get("payload"), dict):
                    return packet["payload"]
                if "payload" not in packet and packet.get("operation") == "callback":
                    return packet
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


def _session_version(session: Session, version_id: str):
    base = get_version_or_404(session, version_id)
    current = current_version_for_document(session, base.document)
    if current.id == version_id:
        return current, None
    operation = session.get(EditorOperation, current.editor_operation_id) if current.editor_operation_id else None
    if operation:
        metadata = operation.preview_json or {}
        if metadata.get("office_session_version_id") == version_id and metadata.get("document_id") == base.document_id:
            return current, operation
    raise HTTPException(409, "This document was updated elsewhere. Reopen the latest version before editing.")


@router.get("/api/onlyoffice")
def check_onlyoffice():
    return {"enabled": bool(office_origin())}


def _save_scope(version_id: str) -> str:
    path = _directory(version_id) / "save-scope.txt"
    return path.read_text(encoding="ascii") if path.is_file() else "shared"


def _open_editor(version_id: str, local_origin: str) -> dict:
    with lock:
        directory = _directory(version_id)
        directory.mkdir(parents=True, exist_ok=True)
        key_file = directory / "editor-key.txt"
        if not key_file.exists():
            key_file.write_text(secrets.token_hex(24), encoding="ascii")
        key = _read_key(version_id)
        scope = _save_scope(version_id)
    return {
        "embed_url": f"{local_origin.replace('127.0.0.1', 'localhost')}/onlyoffice-bridge/{version_id}/{key}",
        "version_id": version_id,
        "save_scope": scope,
    }


@router.post("/api/onlyoffice/{version_id}/open")
def open_editor(version_id: str, request: Request, session: Session = Depends(get_session)):
    _, local_origin = _enabled(request)
    current, _ = _session_version(session, version_id)
    if current.id != version_id:
        raise HTTPException(409, "Open the latest version before starting a new editor session.")
    return _open_editor(version_id, local_origin)


@router.post("/api/documents/{document_id}/onlyoffice/open")
def open_document_editor(document_id: str, request: Request, session: Session = Depends(get_session)):
    _, local_origin = _enabled(request)
    document = session.get(DocumentRecord, document_id)
    if document is None:
        raise HTTPException(404, "Document not found.")
    return _open_editor(current_version_for_document(session, document).id, local_origin)


@router.put("/api/onlyoffice/{version_id}/save-scope")
def set_save_scope(
    version_id: str,
    request: Request,
    scope: Literal["shared", "document"] = Body(embed=True),
    session: Session = Depends(get_session),
):
    _enabled(request)
    with lock:
        _read_key(version_id)
        _session_version(session, version_id)
        path = _directory(version_id) / "save-scope.txt"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(scope, encoding="ascii")
        temporary.replace(path)
    return {"save_scope": scope}


@router.get("/onlyoffice-bridge/{version_id}/{key}", response_class=HTMLResponse)
def editor_bridge(version_id: str, key: str, request: Request, session: Session = Depends(get_session)):
    origin, local_origin = _enabled(request)
    if request.url.hostname != "localhost":
        raise HTTPException(404, "This editor frame uses a separate local origin.")
    _read_key(version_id, key)
    version, _ = _session_version(session, version_id)
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
                         "customization": {"forcesave": True, "anonymous": {"request": False}}},
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
    version, operation = _session_version(session, version_id)
    path = _draft_path(version_id)
    if operation is not None or not path.is_file():
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
def office_callback(version_id: str, key: str, request: Request, body: dict, session: Session = Depends(get_session)):
    origin, _ = _enabled(request)
    _read_key(version_id, key)
    token = body.get("token") or request.headers.get("Authorization", "").removeprefix("Bearer ")
    claims = _callback_claims(token if isinstance(token, str) else "")
    if claims.get("key") != key:
        raise HTTPException(403, "The document server signed a different editing session.")
    if claims.get("status") not in (2, 6):
        return {"error": 0}

    url = claims.get("url")
    if not isinstance(url, str):
        raise HTTPException(422, "The document server did not return a DOCX URL.")
    with save_state_lock:
        active_saves[version_id] += 1
        failed_saves.pop(version_id, None)

    with lock, EDITOR_GENERATION_LOCK:
        failure = None
        try:
            _read_key(version_id, key)
            current, _ = _session_version(session, version_id)
            content = _download_draft(origin, url)
            original = document_version_path(current).read_bytes()
            if original != content:
                DocumentValidationService.validate_package(content, filename="draft.docx")
                DocumentValidationService.parse_file(content, filename="draft.docx")
                related = {}
                if _save_scope(version_id) == "shared":
                    related = sync_related_paragraphs(session, current, original, content)
                save_office_document_versions(session, current.document_id, current.id, version_id, content, related)
        except HTTPException as exc:
            failure = str(exc.detail)
            raise
        except Exception:
            failure = "DocSync couldn’t save the document. Try saving again in ONLYOFFICE."
            raise
        finally:
            with save_state_lock:
                active_saves[version_id] -= 1
                if not active_saves[version_id]:
                    del active_saves[version_id]
                if failure:
                    failed_saves[version_id] = failure
                    if len(failed_saves) > 64:
                        del failed_saves[next(iter(failed_saves))]
                else:
                    failed_saves.pop(version_id, None)
    return {"error": 0}


@router.get("/api/onlyoffice/{version_id}/save-status")
def office_save_status(
    version_id: str,
    request: Request,
    session: Session = Depends(get_session),
    after_operation: str | None = None,
):
    _enabled(request)
    _read_key(version_id)
    current, operation = _session_version(session, version_id)
    with save_state_lock:
        if active_saves[version_id]:
            return {"save": None, "saving": True}
        if version_id in failed_saves:
            return {"save": None, "save_error": failed_saves[version_id]}
    if operation is None or operation.id == after_operation:
        return {"save": None}
    result = serialize_editor_generation_status(session, operation.id)
    result["document_set"] = serialize_document_set(get_document_set_or_404(session, current.document.document_set_id))
    return {"save": result}
