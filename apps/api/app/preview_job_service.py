from __future__ import annotations

from datetime import UTC, datetime
import logging
from pathlib import Path
from queue import Queue
import threading
import time

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import DocumentRecord, DocumentVersion, PreviewRenderJob
from .preview_cache_service import (
    cached_word_preview,
    record_preview_refresh_error,
)


logger = logging.getLogger(__name__)

# Microsoft Word COM automation is intentionally serialized. A daemon queue is
# used instead of an executor so a desktop shutdown never waits for Word; the
# durable row is recovered as failed/retryable on the next startup.
PREVIEW_WORKER_COUNT = 1
PREVIEW_JOB_QUEUE: Queue[str] = Queue()
PREVIEW_WORKER: threading.Thread | None = None
PREVIEW_RENDER_LOCK = threading.RLock()
ACTIVE_PREVIEW_JOBS: set[str] = set()
def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _pdf_is_ready(path: Path) -> bool:
    try:
        if not path.is_file() or path.stat().st_size < 16:
            return False
        with path.open("rb") as source:
            if not source.read(8).startswith(b"%PDF-"):
                return False
            source.seek(max(0, path.stat().st_size - 2048))
            return b"%%EOF" in source.read()
    except OSError:
        return False


def _set_stage(
    session: Session,
    job: PreviewRenderJob,
    stage: str,
    *,
    status: str | None = None,
) -> None:
    changed = job.stage != stage or (status is not None and job.status != status)
    if not changed:
        return
    job.stage = stage
    if status is not None:
        job.status = status
    job.updated_at = _now()
    session.commit()


def serialize_preview_job(
    job: PreviewRenderJob,
    *,
    cached_preview: dict | None = None,
) -> dict:
    payload = {
        "job_id": job.id,
        "document_id": job.document_id,
        "version_id": job.version_id,
        "status": job.status,
        "stage": job.stage,
        "pdf_ready": bool(job.pdf_ready),
        "render_map_ready": bool(job.render_map_ready),
        "render_map_status": job.render_map_status,
        "cache_hit": bool(job.cache_hit),
        "stale_preview_available": bool(job.stale_preview_available),
        "created_at": _iso(job.created_at),
        "updated_at": _iso(job.updated_at),
        "completed_at": _iso(job.completed_at),
        "error": job.error_detail,
        "status_url": f"/api/preview-jobs/{job.id}",
        "preview_url": f"/api/document-versions/{job.version_id}/preview",
        "render_map_url": (
            f"/api/document-versions/{job.version_id}/render-map"
        ),
        "retry_allowed": job.status in {"failed", "interrupted"},
    }
    if cached_preview is not None:
        payload["cached_preview"] = cached_preview
    return payload


def create_preview_job(
    session: Session,
    version_id: str,
    *,
    start: bool = True,
) -> dict:
    from .document_service import rendered_pdf_path, serialize_cached_word_preview
    from .editor_service import get_version_or_404

    version = get_version_or_404(session, version_id)
    active = session.scalar(
        select(PreviewRenderJob)
        .where(
            PreviewRenderJob.version_id == version.id,
            PreviewRenderJob.status.in_(("queued", "processing")),
        )
        .order_by(PreviewRenderJob.created_at.desc())
        .limit(1)
    )
    if active is not None:
        cached_preview, cache_state = cached_word_preview(
            session,
            version,
            rendered_pdf_path(version.document, version.id),
        )
        if cached_preview is not None:
            cached_preview = {
                **cached_preview,
                "preview_cache_status": cache_state,
            }
        if start:
            submit_preview_job(active.id)
        return serialize_preview_job(active, cached_preview=cached_preview)

    pdf_path = rendered_pdf_path(version.document, version.id)
    pdf_ready = _pdf_is_ready(pdf_path)
    cached_preview, cache_state = cached_word_preview(session, version, pdf_path)
    if pdf_ready and cache_state == "legacy":
        # Adopt version-keyed previews created before the SQLite preview cache.
        cached_preview = serialize_cached_word_preview(session, version.document, version)
        cache_state = "fresh"
    if cached_preview is not None:
        cached_preview = {
            **cached_preview,
            "preview_cache_status": cache_state,
        }
    stale_preview_available = bool(
        pdf_ready and cache_state == "stale" and cached_preview is not None
    )
    job = PreviewRenderJob(
        id=_new_id(),
        document_id=version.document_id,
        version_id=version.id,
        status="queued",
        stage=(
            "updating_preview"
            if stale_preview_available
            else "displaying_document"
            if pdf_ready
            else "queued"
        ),
        pdf_ready=pdf_ready,
        render_map_ready=False,
        render_map_status="not_requested",
        cache_hit=pdf_ready and cache_state == "fresh",
        stale_preview_available=stale_preview_available,
    )
    session.add(job)
    session.commit()
    if start:
        submit_preview_job(job.id)
    return serialize_preview_job(job, cached_preview=cached_preview)


def get_preview_job(session: Session, job_id: str) -> dict:
    job = session.get(PreviewRenderJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Preview render job not found.")
    return serialize_preview_job(job)


def preview_for_version(session: Session, version_id: str) -> dict:
    from .document_service import rendered_pdf_path, serialize_cached_word_preview
    from .editor_service import get_version_or_404

    version = get_version_or_404(session, version_id)
    cached_preview, cache_state = cached_word_preview(
        session,
        version,
        rendered_pdf_path(version.document, version.id),
    )
    if cached_preview is not None:
        return {**cached_preview, "preview_cache_status": cache_state}
    if cache_state in {"fresh", "legacy"}:
        return serialize_cached_word_preview(session, version.document, version)
    raise HTTPException(status_code=409, detail="The Word preview is still being rendered.")


def _new_id() -> str:
    from .document_service import new_id

    return new_id()


def _process_preview_job(job_id: str) -> None:
    from .database import SessionLocal
    from .document_service import (
        render_document_with_word,
        rendered_pdf_path,
        serialize_cached_word_preview,
    )
    from .render_map_service import wait_for_render_map

    with SessionLocal() as session:
        job = session.get(PreviewRenderJob, job_id)
        if job is None or job.status not in {"queued", "processing"}:
            return
        version = session.get(DocumentVersion, job.version_id)
        document = session.get(DocumentRecord, job.document_id)
        if version is None or document is None or version.document_id != document.id:
            job.status = "failed"
            job.stage = "failed"
            job.error_detail = "The immutable document version is no longer available."
            job.completed_at = _now()
            job.updated_at = job.completed_at
            session.commit()
            return

        try:
            pdf_path = rendered_pdf_path(document, version.id)
            cached_preview, cache_state = cached_word_preview(
                session,
                version,
                pdf_path,
            )
            if _pdf_is_ready(pdf_path) and cache_state in {"fresh", "legacy"}:
                job.cache_hit = True
                job.pdf_ready = True
                job.stale_preview_available = False
                _set_stage(session, job, "displaying_document", status="processing")
                conversion_started = time.perf_counter()
                serialize_cached_word_preview(session, document, version)
                logger.info(
                    "docsync.docx_conversion_timing version_id=%s cache_hit=true "
                    "duration_ms=%.2f",
                    version.id,
                    (time.perf_counter() - conversion_started) * 1000,
                )
            else:
                job.stale_preview_available = bool(cached_preview)
                _set_stage(
                    session,
                    job,
                    "updating_preview" if cached_preview else "starting_microsoft_word",
                    status="processing",
                )
                conversion_started = time.perf_counter()
                render_document_with_word(session, document, version)
                logger.info(
                    "docsync.docx_conversion_timing version_id=%s cache_hit=false "
                    "duration_ms=%.2f",
                    version.id,
                    (time.perf_counter() - conversion_started) * 1000,
                )
                if not _pdf_is_ready(pdf_path):
                    raise RuntimeError("Microsoft Word did not create a complete PDF preview.")
                job.pdf_ready = True
                job.cache_hit = False
                job.stale_preview_available = False
                _set_stage(session, job, "displaying_document")

            _set_stage(session, job, "preparing_selectable_text")
            render_map = wait_for_render_map(session, version.id, timeout=180)
            job.render_map_status = str(render_map.get("status", "processing"))

            job.status = "completed"
            job.stage = "ready_to_edit"
            job.render_map_ready = job.render_map_status in {"completed", "partial"}
            job.error_detail = None
            job.completed_at = _now()
            job.updated_at = job.completed_at
            session.commit()
        except Exception as exc:
            logger.exception("docsync.preview_job.failed job_id=%s", job_id)
            session.rollback()
            failed = session.get(PreviewRenderJob, job_id)
            if failed is not None:
                failed.status = "failed"
                failed.stage = "failed"
                failed.error_detail = (
                    str(exc.detail)
                    if isinstance(exc, HTTPException)
                    else str(exc) or "The Word preview could not be rendered."
                )
                if version is not None:
                    record_preview_refresh_error(
                        session,
                        version,
                        failed.error_detail,
                    )
                failed.completed_at = _now()
                failed.updated_at = failed.completed_at
                session.commit()


def _run_preview_job(job_id: str) -> None:
    try:
        _process_preview_job(job_id)
    finally:
        with PREVIEW_RENDER_LOCK:
            ACTIVE_PREVIEW_JOBS.discard(job_id)


def _preview_worker_loop() -> None:
    while True:
        job_id = PREVIEW_JOB_QUEUE.get()
        try:
            _run_preview_job(job_id)
        finally:
            PREVIEW_JOB_QUEUE.task_done()


def submit_preview_job(job_id: str) -> None:
    global PREVIEW_WORKER
    with PREVIEW_RENDER_LOCK:
        if job_id in ACTIVE_PREVIEW_JOBS:
            return
        ACTIVE_PREVIEW_JOBS.add(job_id)
        if PREVIEW_WORKER is None or not PREVIEW_WORKER.is_alive():
            PREVIEW_WORKER = threading.Thread(
                target=_preview_worker_loop,
                name="docsync-word-preview",
                daemon=True,
            )
            PREVIEW_WORKER.start()
    PREVIEW_JOB_QUEUE.put(job_id)


def fail_interrupted_preview_jobs(session: Session) -> int:
    interrupted = list(
        session.scalars(
            select(PreviewRenderJob).where(
                PreviewRenderJob.status.in_(("queued", "processing"))
            )
        )
    )
    now = _now()
    for job in interrupted:
        job.status = "failed"
        job.stage = "failed"
        job.error_detail = (
            "DocSync restarted before this preview finished. Retry the preview; "
            "the document and structured editor are unchanged."
        )
        job.completed_at = now
        job.updated_at = now
    if interrupted:
        session.commit()
    return len(interrupted)


def queue_generated_version_previews(
    session: Session,
    version_ids: list[str],
) -> list[dict]:
    """Queue fresh immutable previews only after generation has committed."""

    # Generation creates the durable jobs immediately. The active Layout starts
    # its job through the normal POST, while unopened documents remain queued
    # until their preview is requested instead of starting Word unnecessarily.
    return [
        create_preview_job(session, version_id, start=False)
        for version_id in version_ids
    ]
