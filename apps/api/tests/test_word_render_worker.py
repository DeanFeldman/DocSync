from __future__ import annotations

from pathlib import Path
from queue import Queue
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


class _LiveProcess:
    def poll(self):
        return None


def test_multiple_jobs_reuse_one_live_worker_and_remain_serial(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from app.word_render_service import PersistentWordRenderWorker

    worker = PersistentWordRenderWorker()
    worker._process = _LiveProcess()
    worker._responses = Queue()
    monkeypatch.setattr(
        "app.word_render_service.subprocess.Popen",
        lambda *_args, **_kwargs: pytest.fail("A live worker must be reused."),
    )
    monkeypatch.setattr(worker, "_send_locked", lambda _payload: None)
    active = 0
    maximum_active = 0

    def result(*_args, **_kwargs):
        nonlocal active, maximum_active
        active += 1
        maximum_active = max(maximum_active, active)
        time.sleep(0.04)
        active -= 1
        return {"type": "result", "ok": True, "job_id": _kwargs.get("job_id")}

    monkeypatch.setattr(worker, "_wait_for_message", result)
    outcomes = []

    def render(index: int) -> None:
        outcomes.append(
            worker.render(tmp_path / f"source-{index}.docx", tmp_path / f"out-{index}.pdf")
        )

    threads = [threading.Thread(target=render, args=(index,)) for index in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(outcomes) == 3
    assert maximum_active == 1
    assert worker._process is not None


def test_failed_render_restarts_worker_and_future_job_succeeds(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from app.word_render_service import PersistentWordRenderWorker

    worker = PersistentWordRenderWorker()
    worker._process = _LiveProcess()
    worker._responses = Queue()
    starts = 0
    stops = []
    responses = iter(
        [
            {"type": "result", "ok": False, "error": "COM disconnected", "worker_unusable": True},
            {"type": "result", "ok": True},
        ]
    )

    def start() -> None:
        nonlocal starts
        if worker._process is None:
            starts += 1
            worker._process = _LiveProcess()
            worker._responses = Queue()

    def stop(*, graceful: bool, reason: str) -> None:
        stops.append((graceful, reason))
        worker._process = None
        worker._responses = None

    monkeypatch.setattr(worker, "_start_locked", start)
    monkeypatch.setattr(worker, "_stop_locked", stop)
    monkeypatch.setattr(worker, "_send_locked", lambda _payload: None)
    monkeypatch.setattr(worker, "_wait_for_message", lambda *_args, **_kwargs: next(responses))

    result = worker.render(tmp_path / "source.docx", tmp_path / "output.pdf")
    assert result["ok"] is True
    assert starts == 1
    assert stops == [(True, "render_failure")]


def test_failed_refresh_keeps_good_pdf_and_cleans_temporary_output(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from app import document_service, editor_service
    from app.word_render_service import WordRenderFailed

    source_path = tmp_path / "source.docx"
    source_path.write_bytes(b"source")
    output_path = tmp_path / "cached.pdf"
    good_pdf = b"%PDF-1.7\nexisting complete preview\n%%EOF"
    output_path.write_bytes(good_pdf)
    document = SimpleNamespace(id="document", document_set_id="set")
    version = SimpleNamespace(id="version")

    monkeypatch.setattr(editor_service, "document_version_path", lambda _version: source_path)
    monkeypatch.setattr(document_service, "rendered_pdf_path", lambda *_args: output_path)
    monkeypatch.setattr(
        "app.preview_cache_service.cached_word_preview",
        lambda *_args, **_kwargs: ({"version_id": "version"}, "stale"),
    )

    def fail_after_partial_write(_source: Path, temporary: Path):
        temporary.write_bytes(b"%PDF-partial")
        raise WordRenderFailed("forced worker failure")

    monkeypatch.setattr(
        "app.word_render_service.render_docx_with_word_worker",
        fail_after_partial_write,
    )

    with pytest.raises(HTTPException) as error:
        document_service.render_document_with_word(
            SimpleNamespace(),
            document,
            version,
        )
    assert error.value.status_code == 422
    assert output_path.read_bytes() == good_pdf
    assert list(tmp_path.glob("version-*.tmp.pdf")) == []
