from __future__ import annotations

from contextlib import asynccontextmanager
import logging
import secrets
from time import perf_counter

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from .config import settings
from .database import SessionLocal, get_session, init_db
from .document_service import (
    add_documents_to_set,
    current_document_path,
    create_document_set,
    delete_document_set,
    generate_versions,
    generation_download_path,
    get_document_or_404,
    get_document_set_or_404,
    get_generation_or_404,
    get_link_group_or_404,
    list_document_sets,
    preview_edit,
    remove_document_from_set,
    render_document_with_word,
    rendered_pdf_path,
    serialize_document_set_history,
    search_document_set,
    serialize_document_set,
    serialize_document_view,
)
from .editor_service import (
    EDITOR_GENERATION_LOCK,
    compare_elements,
    document_version_path,
    editor_operation_download_path,
    fail_interrupted_editor_generations,
    generate_editor_versions,
    get_editor_matches,
    get_similar_matches,
    get_version_or_404,
    preview_editor_edit,
    process_queued_editor_generation,
    queue_editor_generation,
    resolve_document_identifier,
    save_match_decisions,
    serialize_document_versions,
    serialize_editor_content,
    serialize_editor_generation_status,
    serialize_version_document_view,
    restore_document_version,
)
from .schemas import (
    CompareRequest,
    EditRequest,
    EditorEditRequest,
    MatchDecisionBatchRequest,
    VersionRestoreRequest,
)


from .audit_logger import AuditLogger
from .backup_service import DocumentBackupService
from .error_mapper import DocuSyncError, ErrorMapper
from .storage_service import DocumentStorageService

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.warning("docsync.startup.stage=database_initialization")
    init_db()
    logger.warning("docsync.startup.stage=storage_initialization")
    with SessionLocal() as session:
        fail_interrupted_editor_generations(session)
    DocumentStorageService.init_storage()
    logger.warning("docsync.startup.stage=temporary_file_cleanup")
    DocumentStorageService.cleanup_stale_temp_files()
    logger.warning("docsync.startup.stage=ready")
    yield


app = FastAPI(
    title="DocumentSync API",
    version="1.5.0",
    description="DocSync structured DOCX viewing and controlled editing service.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def secure_local_application(request: Request, call_next):
    if (
        settings.session_token
        and request.url.path.startswith("/api/")
        and request.url.path != "/api/health"
    ):
        supplied = request.cookies.get("docsync_session", "")
        if not secrets.compare_digest(settings.session_token, supplied):
            return JSONResponse(
                status_code=401,
                content={"detail": "The desktop session is missing or invalid."},
            )

    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'none'; "
        "frame-ancestors 'self'; form-action 'self'"
    )
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    return response


@app.exception_handler(DocuSyncError)
async def docusync_error_handler(request: Request, exc: DocuSyncError):
    AuditLogger.log_event(
        operation="api_error",
        error_code=exc.code,
        reference_id=exc.reference_id,
        details=exc.message,
    )
    return ErrorMapper.create_response(exc)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    mapped = ErrorMapper.map_exception(exc)
    AuditLogger.log_event(
        operation="unhandled_exception",
        error_code=mapped.code,
        reference_id=mapped.reference_id,
        details=str(exc),
    )
    return ErrorMapper.create_response(mapped)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/document-sets")
def read_document_sets(session: Session = Depends(get_session)) -> dict:
    return list_document_sets(session)


@app.post("/api/document-sets", status_code=201)
async def upload_document_set(
    response: Response,
    name: str = Form(...),
    files: list[UploadFile] = File(...),
    session: Session = Depends(get_session),
) -> dict:
    document_set = await create_document_set(session, name, files)
    serialization_started = perf_counter()
    payload = serialize_document_set(document_set)
    timings = dict(
        getattr(document_set, "_docsync_creation_timings", {})
    )
    timings["serialization_ms"] = (
        perf_counter() - serialization_started
    ) * 1000
    timings["total_ms"] = (
        timings.get("service_total_ms", 0.0) +
        timings["serialization_ms"]
    )
    response.headers["Server-Timing"] = ", ".join(
        f"{name.removesuffix('_ms').replace('_', '-')};dur={value:.2f}"
        for name, value in timings.items()
        if name != "service_total_ms"
    )
    logger.info(
        "docsync.create_set.response_timing %s",
        " ".join(f"{name}={value:.2f}" for name, value in timings.items()),
    )
    return payload


@app.get("/api/document-sets/{document_set_id}")
def read_document_set(
    document_set_id: str,
    session: Session = Depends(get_session),
) -> dict:
    return serialize_document_set(get_document_set_or_404(session, document_set_id))



@app.post("/api/document-sets/{document_set_id}/documents", status_code=201)
async def add_document_set_documents(
    document_set_id: str,
    files: list[UploadFile] = File(...),
    session: Session = Depends(get_session),
) -> dict:
    return serialize_document_set(
        await add_documents_to_set(session, document_set_id, files)
    )


@app.delete("/api/document-sets/{document_set_id}/documents/{document_id}")
def remove_document_set_document(
    document_set_id: str,
    document_id: str,
    session: Session = Depends(get_session),
) -> dict:
    return serialize_document_set(
        remove_document_from_set(session, document_set_id, document_id)
    )


@app.get("/api/document-sets/{document_set_id}/search")
def search_documents_in_set(
    document_set_id: str,
    q: str = Query(default="", max_length=500),
    limit: int | None = Query(default=None, ge=1, le=5000),
    session: Session = Depends(get_session),
) -> dict:
    return search_document_set(session, document_set_id, q, limit)


@app.delete("/api/document-sets/{document_set_id}")
def remove_document_set(
    document_set_id: str,
    session: Session = Depends(get_session),
) -> dict:
    return delete_document_set(session, document_set_id)


@app.post("/api/documents/{document_id}/render")
def render_document(
    document_id: str,
    session: Session = Depends(get_session),
) -> dict:
    document, version = resolve_document_identifier(session, document_id)
    return render_document_with_word(session, document, version)


@app.get("/api/document-versions/{version_id}/pages")
def read_document_pages(
    version_id: str,
    session: Session = Depends(get_session),
) -> dict:
    return serialize_version_document_view(session, version_id)


@app.get("/api/document-versions/{version_id}/rendered-file")
def read_rendered_document(
    version_id: str,
    session: Session = Depends(get_session),
) -> FileResponse:
    document, version = resolve_document_identifier(session, version_id)
    path = rendered_pdf_path(document, version.id)
    if not path.exists():
        render_document_with_word(session, document, version)
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=f"{document.original_name.removesuffix('.docx')}-preview.pdf",
        content_disposition_type="inline",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/documents/{document_id}/download")
def download_current_document(
    document_id: str,
    session: Session = Depends(get_session),
) -> FileResponse:
    document = get_document_or_404(session, document_id)
    return FileResponse(
        current_document_path(session, document),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=document.original_name,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/document-elements/{element_id}/matches")
def read_element_matches(
    element_id: str,
    session: Session = Depends(get_session),
) -> dict:
    return get_editor_matches(session, element_id)


@app.get("/api/document-elements/{element_id}/similar-matches")
def read_similar_element_matches(
    element_id: str,
    threshold: float | None = Query(default=None, ge=0.0, le=1.0),
    limit: int | None = Query(default=None, ge=1, le=100),
    session: Session = Depends(get_session),
) -> dict:
    return get_similar_matches(
        session,
        element_id,
        threshold=threshold,
        limit=limit,
    )


@app.post("/api/document-elements/{element_id}/compare")
def compare_document_elements(
    element_id: str,
    request: CompareRequest,
    session: Session = Depends(get_session),
) -> dict:
    return compare_elements(session, element_id, request)


@app.post("/api/document-elements/{element_id}/match-decisions")
def update_document_element_match_decisions(
    element_id: str,
    request: MatchDecisionBatchRequest,
    session: Session = Depends(get_session),
) -> dict:
    return save_match_decisions(session, element_id, request)


@app.get("/api/document-versions/{version_id}/editor-content")
def read_document_editor_content(
    version_id: str,
    session: Session = Depends(get_session),
) -> dict:
    return serialize_editor_content(session, version_id)


@app.get("/api/document-versions/{version_id}/download")
def download_document_version(
    version_id: str,
    session: Session = Depends(get_session),
) -> FileResponse:
    version = get_version_or_404(session, version_id)
    return FileResponse(
        document_version_path(version),
        media_type=(
            "application/vnd.openxmlformats-officedocument."
            "wordprocessingml.document"
        ),
        filename=version.download_name or version.document.original_name,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/documents/{document_id}/versions")
def read_document_versions(
    document_id: str,
    session: Session = Depends(get_session),
) -> dict:
    return serialize_document_versions(session, document_id)


@app.post(
    "/api/documents/{document_id}/versions/{target_version_id}/restore",
    status_code=201,
)
def restore_historical_document_version(
    document_id: str,
    target_version_id: str,
    request: VersionRestoreRequest,
    session: Session = Depends(get_session),
) -> dict:
    return restore_document_version(
        session,
        document_id,
        target_version_id,
        request,
    )


@app.post("/api/document-sets/{document_set_id}/preview")
def preview_document_set_edit(
    document_set_id: str,
    request: EditRequest,
    session: Session = Depends(get_session),
) -> dict:
    group = get_link_group_or_404(session, document_set_id, request.link_group_id)
    return preview_edit(
        group,
        request.replacement_text,
        request.included_element_ids,
        request.source_element_id,
    )


@app.post("/api/document-sets/{document_set_id}/generate", status_code=201)
def generate_document_set_edit(
    document_set_id: str,
    request: EditRequest,
    session: Session = Depends(get_session),
) -> dict:
    with EDITOR_GENERATION_LOCK:
        group = get_link_group_or_404(session, document_set_id, request.link_group_id)
        job = generate_versions(
            session,
            document_set_id,
            group,
            request.replacement_text,
            request.included_element_ids,
            request.source_element_id,
        )
    return {
        "generation_id": job.id,
        "status": job.status,
        "files": [
            {
                "source_document_id": version.source_document_id,
                "name": version.download_name,
            }
            for version in sorted(job.versions, key=lambda item: item.download_name.casefold())
        ],
        "download_url": f"/api/generations/{job.id}/download",
        "document_set": serialize_document_set(
            get_document_set_or_404(session, document_set_id)
        ),
    }


@app.post("/api/document-sets/{document_set_id}/editor-preview")
def preview_document_set_editor_edit(
    document_set_id: str,
    request: EditorEditRequest,
    session: Session = Depends(get_session),
) -> dict:
    return preview_editor_edit(session, document_set_id, request)


@app.post(
    "/api/document-sets/{document_set_id}/editor-generate",
    status_code=201,
)
def generate_document_set_editor_edit(
    document_set_id: str,
    request: EditorEditRequest,
    session: Session = Depends(get_session),
) -> dict:
    return generate_editor_versions(session, document_set_id, request)


@app.post(
    "/api/document-sets/{document_set_id}/editor-generate-async",
    status_code=202,
)
def queue_document_set_editor_edit(
    document_set_id: str,
    request: EditorEditRequest,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
) -> dict:
    queued = queue_editor_generation(session, document_set_id, request)
    background_tasks.add_task(
        process_queued_editor_generation,
        queued["operation_id"],
    )
    return queued


@app.get("/api/editor-operations/{operation_id}")
def read_editor_operation_status(
    operation_id: str,
    session: Session = Depends(get_session),
) -> dict:
    return serialize_editor_generation_status(session, operation_id)


@app.get("/api/document-sets/{document_set_id}/history")
def read_document_set_history(
    document_set_id: str,
    session: Session = Depends(get_session),
) -> dict:
    return serialize_document_set_history(session, document_set_id)


@app.get("/api/generations/{generation_id}/download")
def download_generation(
    generation_id: str,
    session: Session = Depends(get_session),
) -> FileResponse:
    job = get_generation_or_404(session, generation_id)
    path = generation_download_path(job)
    return FileResponse(
        path,
        media_type="application/zip",
        filename=f"DocumentSync-{generation_id}.zip",
    )


@app.get("/api/editor-operations/{operation_id}/download")
def download_editor_operation(
    operation_id: str,
    session: Session = Depends(get_session),
) -> FileResponse:
    return FileResponse(
        editor_operation_download_path(session, operation_id),
        media_type="application/zip",
        filename=f"DocumentSync-editor-{operation_id}.zip",
    )


@app.get("/api/documents/{document_id}/backups")
def get_document_backups(
    document_id: str,
    session: Session = Depends(get_session),
) -> dict:
    document = get_document_or_404(session, document_id)
    backups = DocumentBackupService.list_backups(document.id)
    return {"document_id": document.id, "backups": backups}


@app.post("/api/documents/{document_id}/backups/restore")
def restore_document_backup(
    document_id: str,
    session: Session = Depends(get_session),
) -> dict:
    document = get_document_or_404(session, document_id)
    working_path = current_document_path(session, document)
    restored_path = DocumentBackupService.restore_latest_backup(working_path, document.id)
    return {
        "status": "success",
        "message": f"Restored previous valid version for {document.original_name}",
        "document_id": document.id,
        "restored_file": restored_path.name,
    }


if settings.web_dist_dir.is_dir():
    assets_dir = settings.web_dist_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="desktop-assets")

    @app.get("/", include_in_schema=False)
    def read_desktop_application() -> FileResponse:
        return FileResponse(settings.web_dist_dir / "index.html", headers={"Cache-Control": "no-store"})
