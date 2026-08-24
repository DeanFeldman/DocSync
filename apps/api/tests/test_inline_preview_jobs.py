from __future__ import annotations

import importlib
import io
import os
from pathlib import Path
import sys
import time

from docx import Document
from fastapi import HTTPException
from fastapi.testclient import TestClient
import pymupdf


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)


def load_test_app(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DOCUMENTSYNC_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv(
        "DOCUMENTSYNC_DATABASE_URL",
        f"sqlite:///{tmp_path / 'inline-preview.db'}",
    )
    monkeypatch.setenv("DOCUMENTSYNC_SESSION_TOKEN", "")
    monkeypatch.delenv("DOCUMENTSYNC_WEB_DIST", raising=False)
    for module_name in list(sys.modules):
        if module_name == "app" or module_name.startswith("app."):
            del sys.modules[module_name]
    return importlib.import_module("app.main").app


def docx_bytes(*paragraphs: str) -> bytes:
    document = Document()
    for paragraph in paragraphs:
        document.add_paragraph(paragraph)
    stream = io.BytesIO()
    document.save(stream)
    return stream.getvalue()


def upload(client: TestClient, payload: bytes) -> tuple[dict, dict]:
    response = client.post(
        "/api/document-sets",
        data={"name": "Inline preview"},
        files=[
            ("files", ("Primary.docx", io.BytesIO(payload), DOCX_MEDIA_TYPE)),
            ("files", ("Related.docx", io.BytesIO(payload), DOCX_MEDIA_TYPE)),
        ],
    )
    assert response.status_code == 201, response.text
    workspace = response.json()
    primary = next(
        document
        for document in workspace["documents"]
        if document["name"] == "Primary.docx"
    )
    return workspace, primary


def write_pdf(path: Path, lines: list[tuple[float, float, str, float | None]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = pymupdf.open()
    page = pdf.new_page(width=612, height=792)
    for x, y, text, width in lines:
        if width:
            page.insert_textbox(
                pymupdf.Rect(x, y, x + width, y + 180),
                text,
                fontsize=11,
            )
        else:
            page.insert_text((x, y), text, fontsize=11)
    pdf.save(path)
    pdf.close()


def write_multipage_pdf(path: Path, page_texts: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = pymupdf.open()
    for text in page_texts:
        page = pdf.new_page(width=612, height=792)
        page.insert_text((72, 100), text, fontsize=11)
    pdf.save(path)
    pdf.close()


def poll_job(client: TestClient, job_id: str, timeout: float = 8) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/preview-jobs/{job_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["status"] in {"completed", "failed"}:
            return payload
        time.sleep(0.03)
    raise AssertionError("Preview job did not reach a terminal state.")


def poll_map(client: TestClient, version_id: str, timeout: float = 8) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/document-versions/{version_id}/render-map")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["status"] in {"completed", "partial", "failed"}:
            return payload
        time.sleep(0.03)
    raise AssertionError("Render map did not reach a terminal state.")


def test_preview_job_returns_before_word_finishes_and_reuses_cache(
    tmp_path: Path,
    monkeypatch,
) -> None:
    text = "A supported paragraph for inline editing"
    app = load_test_app(tmp_path, monkeypatch)
    document_service = importlib.import_module("app.document_service")
    render_calls = 0

    def fake_word_render(session, document, version):
        nonlocal render_calls
        render_calls += 1
        time.sleep(0.25)
        output_path = document_service.rendered_pdf_path(document, version.id)
        temporary_path = output_path.with_name(f"{version.id}-test-refresh.pdf")
        write_pdf(
            temporary_path,
            [(72, 100, text, None)],
        )
        temporary_path.replace(output_path)
        return document_service.serialize_cached_word_preview(
            session,
            document,
            version,
        )

    monkeypatch.setattr(
        document_service,
        "render_document_with_word",
        fake_word_render,
    )

    with TestClient(app) as client:
        _workspace, primary = upload(client, docx_bytes(text))
        version_id = primary["version_id"]
        started = time.monotonic()
        accepted = client.post(
            f"/api/document-versions/{version_id}/preview-jobs"
        )
        elapsed = time.monotonic() - started

        assert accepted.status_code == 202, accepted.text
        assert elapsed < 0.2
        initial = accepted.json()
        assert initial["status"] in {"queued", "processing"}
        assert initial["version_id"] == version_id
        assert initial["pdf_ready"] is False

        completed = poll_job(client, initial["job_id"])
        assert completed["status"] == "completed"
        assert completed["stage"] == "ready_to_edit"
        assert completed["pdf_ready"] is True
        assert completed["render_map_ready"] is True
        assert completed["cache_hit"] is False
        preview_response = client.get(completed["preview_url"])
        assert preview_response.status_code == 200
        assert preview_response.json()["preview_cache_status"] == "fresh"
        assert render_calls == 1

        first_pages = client.get(f"/api/document-versions/{version_id}/pages")
        second_pages = client.get(f"/api/document-versions/{version_id}/pages")
        assert first_pages.status_code == 200
        assert second_pages.status_code == 200
        assert second_pages.headers["x-docsync-preview-cache"] == "hit"

        cached = client.post(
            f"/api/document-versions/{version_id}/preview-jobs"
        )
        assert cached.status_code == 202
        assert cached.json()["cached_preview"]["preview_cache_status"] == "fresh"
        cached_result = poll_job(client, cached.json()["job_id"])
        assert cached_result["status"] == "completed"
        assert cached_result["pdf_ready"] is True
        assert cached_result["cache_hit"] is True
        assert render_calls == 1

        database = importlib.import_module("app.database")
        models = importlib.import_module("app.models")
        editor_service = importlib.import_module("app.editor_service")
        with database.SessionLocal() as session:
            version = session.get(models.DocumentVersion, version_id)
            assert version is not None
            cache = session.get(models.DocumentPreviewCache, version_id)
            assert cache is not None
            assert cache.word_preview_json["version_id"] == version_id
            source_path = editor_service.document_version_path(version)
            source_stat = source_path.stat()
            os.utime(
                source_path,
                ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns + 1_000_000),
            )

        stale = client.post(f"/api/document-versions/{version_id}/preview-jobs")
        assert stale.status_code == 202
        stale_payload = stale.json()
        assert stale_payload["stale_preview_available"] is True
        assert stale_payload["cached_preview"]["preview_cache_status"] == "stale"
        refreshed = poll_job(client, stale_payload["job_id"])
        assert refreshed["status"] == "completed"
        assert refreshed["cache_hit"] is False
        assert refreshed["stale_preview_available"] is False
        assert render_calls == 2

        with database.SessionLocal() as session:
            version = session.get(models.DocumentVersion, version_id)
            assert version is not None
            source_path = editor_service.document_version_path(version)
            source_stat = source_path.stat()
            os.utime(
                source_path,
                ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns + 1_000_000),
            )

        def fail_refresh(*_args, **_kwargs):
            raise HTTPException(status_code=422, detail="Forced cached refresh failure")

        monkeypatch.setattr(
            document_service,
            "render_document_with_word",
            fail_refresh,
        )
        retained = client.post(
            f"/api/document-versions/{version_id}/preview-jobs"
        )
        assert retained.status_code == 202
        retained_payload = retained.json()
        assert retained_payload["stale_preview_available"] is True
        assert retained_payload["cached_preview"]["preview_cache_status"] == "stale"
        failed_refresh = poll_job(client, retained_payload["job_id"])
        assert failed_refresh["status"] == "failed"
        assert failed_refresh["stale_preview_available"] is True
        still_visible = client.get(f"/api/document-versions/{version_id}/preview")
        assert still_visible.status_code == 200
        assert still_visible.json()["preview_cache_status"] == "stale"
        assert render_calls == 2


def test_controlled_pages_are_published_before_coordinate_matching(
    tmp_path: Path,
    monkeypatch,
) -> None:
    first = "Repeated wording"
    wrapped = "A long supported paragraph that wraps over several visual lines in the controlled preview"
    app = load_test_app(tmp_path, monkeypatch)
    render_map_service = importlib.import_module("app.render_map_service")
    original_match = render_map_service._match_blocks

    def slow_match(*args, **kwargs):
        time.sleep(0.35)
        return original_match(*args, **kwargs)

    monkeypatch.setattr(render_map_service, "_match_blocks", slow_match)

    with TestClient(app) as client:
        workspace, primary = upload(client, docx_bytes(first, first, wrapped))
        version_id = primary["version_id"]
        pdf_path = (
            tmp_path / "data" / "renders" / workspace["id"] / f"{version_id}.pdf"
        )
        write_pdf(
            pdf_path,
            [
                (72, 100, first, None),
                (72, 135, first, None),
                (72, 180, wrapped, 250),
            ],
        )

        queued = client.get(f"/api/document-versions/{version_id}/render-map")
        assert queued.status_code == 200
        progressive = None
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            candidate = client.get(
                f"/api/document-versions/{version_id}/render-map"
            ).json()
            if candidate["status"] == "processing" and candidate["pages"]:
                progressive = candidate
                break
            time.sleep(0.02)
        assert progressive is not None
        assert progressive["page_count"] == 1
        assert progressive["regions"] == []
        page_response = client.get(progressive["pages"][0]["image_url"])
        assert page_response.status_code == 200
        assert page_response.content.startswith(b"\x89PNG")

        mapped = poll_map(client, version_id)
        assert mapped["status"] == "completed"
        duplicate_regions = [
            region for region in mapped["regions"] if region["text_preview"] == first
        ]
        assert len({region["element_id"] for region in duplicate_regions}) == 2
        assert all(region["confidence"] == 0.95 for region in duplicate_regions)
        wrapped_regions = [
            region
            for region in mapped["regions"]
            if region["text_preview"] == wrapped
        ]
        assert len(wrapped_regions) >= 2
        assert all(0 <= region[axis] <= 1 for region in mapped["regions"] for axis in ("x", "y", "width", "height"))


def test_later_pdf_pages_render_only_on_demand_and_reuse_cache(
    tmp_path: Path,
    monkeypatch,
) -> None:
    page_texts = [f"Unique selectable content for page {page}" for page in range(1, 7)]
    app = load_test_app(tmp_path, monkeypatch)

    with TestClient(app) as client:
        workspace, primary = upload(client, docx_bytes(*page_texts))
        version_id = primary["version_id"]
        pdf_path = (
            tmp_path / "data" / "renders" / workspace["id"] / f"{version_id}.pdf"
        )
        write_multipage_pdf(pdf_path, page_texts)

        mapped = poll_map(client, version_id)
        assert mapped["page_count"] == 6
        render_id = mapped["render_id"]
        page_directory = pdf_path.parent / f"{version_id}.pages" / render_id
        assert not (page_directory / "page-5.png").exists()
        assert not (page_directory / "page-6.png").exists()

        page_url = mapped["pages"][4]["image_url"]
        first = client.get(page_url)
        assert first.status_code == 200
        assert first.content.startswith(b"\x89PNG")
        page_five = page_directory / "page-5.png"
        first_mtime = page_five.stat().st_mtime_ns

        second = client.get(page_url)
        assert second.status_code == 200
        assert page_five.stat().st_mtime_ns == first_mtime
        assert client.get(
            f"/api/document-versions/{version_id}/render-pages/{'0' * 24}/5.png"
        ).status_code == 404
        assert client.get(
            f"/api/document-versions/{version_id}/render-pages/{render_id}/7.png"
        ).status_code == 404


def test_failed_preview_can_be_retried_without_blocking_the_workspace(
    tmp_path: Path,
    monkeypatch,
) -> None:
    text = "Retry this preview"
    app = load_test_app(tmp_path, monkeypatch)
    document_service = importlib.import_module("app.document_service")

    def fail_render(*_args, **_kwargs):
        raise HTTPException(status_code=422, detail="Forced Word render failure")

    monkeypatch.setattr(document_service, "render_document_with_word", fail_render)
    with TestClient(app) as client:
        workspace, primary = upload(client, docx_bytes(text))
        version_id = primary["version_id"]
        first = client.post(f"/api/document-versions/{version_id}/preview-jobs")
        failed = poll_job(client, first.json()["job_id"])
        assert failed["status"] == "failed"
        assert failed["stage"] == "failed"
        assert failed["retry_allowed"] is True
        assert "Forced Word render failure" in failed["error"]
        assert client.get(f"/api/document-versions/{version_id}/pages").status_code == 200

        def recover_render(session, document, version):
            write_pdf(
                tmp_path
                / "data"
                / "renders"
                / workspace["id"]
                / f"{version.id}.pdf",
                [(72, 100, text, None)],
            )
            return document_service.serialize_cached_word_preview(
                session,
                document,
                version,
            )

        monkeypatch.setattr(
            document_service,
            "render_document_with_word",
            recover_render,
        )
        retried = client.post(f"/api/document-versions/{version_id}/preview-jobs")
        assert retried.json()["job_id"] != failed["job_id"]
        recovered = poll_job(client, retried.json()["job_id"])
        assert recovered["status"] == "completed"
        assert recovered["pdf_ready"] is True
