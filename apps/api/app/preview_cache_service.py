from __future__ import annotations

from dataclasses import dataclass
import logging
from pathlib import Path
from time import perf_counter

from sqlalchemy.orm import Session

from .config import settings
from .models import DocumentPreviewCache, DocumentVersion, utc_now


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SourceIdentity:
    sha256: str | None
    size: int
    mtime_ns: int


def _source_path(version: DocumentVersion) -> Path:
    roots = {
        "originals": settings.data_dir / "originals",
        "generated": settings.data_dir / "generated",
    }
    root = roots.get(version.storage_area)
    if root is None:
        raise FileNotFoundError("Document version storage is invalid.")
    path = (root / version.storage_name).resolve()
    path.relative_to(root.resolve())
    if not path.is_file():
        raise FileNotFoundError("The document version file is missing.")
    return path


def source_identity(version: DocumentVersion) -> SourceIdentity:
    source_stat = _source_path(version).stat()
    return SourceIdentity(
        sha256=version.checksum_sha256,
        size=source_stat.st_size,
        mtime_ns=source_stat.st_mtime_ns,
    )


def _cache(session: Session, version: DocumentVersion) -> DocumentPreviewCache | None:
    return session.get(DocumentPreviewCache, version.id)


def _payload(value: dict | list | None) -> dict | None:
    return dict(value) if isinstance(value, dict) else None


def cached_word_preview(
    session: Session,
    version: DocumentVersion,
    pdf_path: Path,
) -> tuple[dict | None, str]:
    """Return the last usable payload and whether it is fresh or stale."""

    if not pdf_path.is_file() or pdf_path.stat().st_size < 16:
        return None, "missing"
    cache = _cache(session, version)
    if cache is None:
        return None, "legacy"
    payload = _payload(cache.word_preview_json)
    try:
        identity = source_identity(version)
        pdf_stat = pdf_path.stat()
    except OSError:
        return payload, "stale" if payload else "missing"
    fresh = bool(
        cache.source_size == identity.size
        and cache.source_mtime_ns == identity.mtime_ns
        and cache.source_sha256 == identity.sha256
        and cache.pdf_size == pdf_stat.st_size
        and cache.pdf_mtime_ns == pdf_stat.st_mtime_ns
    )
    return payload, "fresh" if fresh else "stale"


def store_word_preview(
    session: Session,
    version: DocumentVersion,
    pdf_path: Path,
    preview: dict,
) -> dict:
    identity = source_identity(version)
    pdf_stat = pdf_path.stat()
    cache = _cache(session, version)
    if cache is None:
        cache = DocumentPreviewCache(
            version_id=version.id,
            document_id=version.document_id,
        )
        session.add(cache)
    cache.source_sha256 = identity.sha256
    cache.source_size = identity.size
    cache.source_mtime_ns = identity.mtime_ns
    cache.pdf_size = pdf_stat.st_size
    cache.pdf_mtime_ns = pdf_stat.st_mtime_ns
    cache.word_preview_json = dict(preview)
    if cache.structured_preview_json is None:
        cache.structured_preview_json = {
            **{
                key: value
                for key, value in preview.items()
                if key not in {"pdf_url", "render_map_status", "render_map_url"}
            },
            "render_mode": "structured",
            "pagination": "estimated",
            "notice": (
                "Structured browser preview backed by an immutable document version. "
                "Unsupported Word objects remain available in Layout mode and are read-only."
            ),
        }
    cache.refresh_error = None
    cache.updated_at = utc_now()
    session.commit()
    return dict(preview)


def record_preview_refresh_error(
    session: Session,
    version: DocumentVersion,
    detail: str,
) -> None:
    cache = _cache(session, version)
    if cache is None:
        return
    cache.refresh_error = detail
    cache.updated_at = utc_now()
    session.commit()


def get_or_create_structured_preview(
    session: Session,
    version_id: str,
) -> tuple[dict, bool]:
    """Load the processed structured preview from SQLite, creating it once."""

    from .editor_service import get_version_or_404, serialize_version_document_view

    started = perf_counter()
    version = get_version_or_404(session, version_id)
    cache = _cache(session, version)
    cached = _payload(cache.structured_preview_json) if cache is not None else None
    if cached is not None:
        payload = cached
        cache_hit = True
    else:
        payload = serialize_version_document_view(session, version.id)
        if cache is None:
            cache = DocumentPreviewCache(
                version_id=version.id,
                document_id=version.document_id,
            )
            session.add(cache)
        cache.structured_preview_json = dict(payload)
        cache.updated_at = utc_now()
        session.commit()
        cache_hit = False
    payload = {**payload, "preview_cache_status": "fresh"}
    logger.info(
        "docsync.document_fetch_timing version_id=%s cache_hit=%s duration_ms=%.2f",
        version.id,
        cache_hit,
        (perf_counter() - started) * 1000,
    )
    return payload, cache_hit
