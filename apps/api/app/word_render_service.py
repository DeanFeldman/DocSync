from __future__ import annotations

from collections import deque
import json
import logging
from pathlib import Path
from queue import Empty, Queue
import shutil
import subprocess
import threading
from time import perf_counter
from uuid import uuid4

from .config import settings


logger = logging.getLogger(__name__)


class WordWorkerUnavailable(RuntimeError):
    pass


class WordWorkerTimedOut(RuntimeError):
    pass


class WordRenderFailed(RuntimeError):
    pass


class PersistentWordRenderWorker:
    """Own one serial PowerShell/Word COM worker for the backend lifecycle."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._responses: Queue[dict] | None = None
        self._stderr_tail: deque[str] = deque(maxlen=40)

    def _pump_stdout(
        self,
        process: subprocess.Popen[str],
        responses: Queue[dict],
    ) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("docsync.word_worker.invalid_output line=%r", line[:500])
                continue
            if isinstance(payload, dict):
                responses.put(payload)
        responses.put(
            {
                "type": "worker_exit",
                "returncode": process.poll(),
            }
        )

    def _pump_stderr(self, process: subprocess.Popen[str]) -> None:
        assert process.stderr is not None
        for line in process.stderr:
            self._stderr_tail.append(line.rstrip())

    def _wait_for_message(
        self,
        responses: Queue[dict],
        *,
        expected_type: str,
        job_id: str | None,
        timeout: float,
    ) -> dict:
        deadline = perf_counter() + timeout
        while True:
            remaining = deadline - perf_counter()
            if remaining <= 0:
                raise WordWorkerTimedOut("Microsoft Word took too long to respond.")
            try:
                payload = responses.get(timeout=remaining)
            except Empty as exc:
                raise WordWorkerTimedOut("Microsoft Word took too long to respond.") from exc
            if payload.get("type") == "worker_exit":
                raise WordWorkerUnavailable(
                    "The Microsoft Word worker stopped unexpectedly "
                    f"(exit code {payload.get('returncode')})."
                )
            if payload.get("type") != expected_type:
                continue
            if job_id is None or payload.get("job_id") == job_id:
                return payload

    def _start_locked(self) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        script = settings.word_worker_script
        if powershell is None or not script.is_file():
            raise WordWorkerUnavailable(
                "Microsoft Word rendering is unavailable on this server."
            )

        started_at = perf_counter()
        responses: Queue[dict] = Queue()
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            process = subprocess.Popen(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script),
                    "-MaxRenders",
                    str(settings.word_worker_max_renders),
                ],
                cwd=str(script.parent),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=creation_flags,
            )
        except OSError as exc:
            raise WordWorkerUnavailable(
                "Microsoft Word rendering is unavailable on this server."
            ) from exc

        self._process = process
        self._responses = responses
        self._stderr_tail.clear()
        threading.Thread(
            target=self._pump_stdout,
            args=(process, responses),
            name="docsync-word-worker-stdout",
            daemon=True,
        ).start()
        threading.Thread(
            target=self._pump_stderr,
            args=(process,),
            name="docsync-word-worker-stderr",
            daemon=True,
        ).start()
        try:
            ready = self._wait_for_message(
                responses,
                expected_type="ready",
                job_id=None,
                timeout=min(settings.word_worker_timeout_seconds, 30),
            )
        except Exception:
            self._stop_locked(graceful=False, reason="startup_failed")
            raise
        if not ready.get("ok"):
            detail = str(ready.get("error") or "Microsoft Word could not start.")
            self._stop_locked(graceful=False, reason="word_startup_failed")
            raise WordWorkerUnavailable(detail)
        logger.info(
            "docsync.word_worker_startup_timing process_ms=%.2f word_ms=%.2f "
            "worker_ms=%.2f",
            (perf_counter() - started_at) * 1000,
            float(ready.get("word_startup_ms") or 0),
            float(ready.get("worker_startup_ms") or 0),
        )

    def start(self) -> bool:
        with self._lock:
            try:
                self._start_locked()
            except (WordWorkerUnavailable, WordWorkerTimedOut) as exc:
                logger.warning("docsync.word_worker.unavailable detail=%s", exc)
                return False
            return True

    def _send_locked(self, payload: dict) -> None:
        process = self._process
        if process is None or process.poll() is not None or process.stdin is None:
            raise WordWorkerUnavailable("The Microsoft Word worker is not running.")
        try:
            process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
            process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise WordWorkerUnavailable("The Microsoft Word worker stopped unexpectedly.") from exc

    def _stop_locked(self, *, graceful: bool, reason: str) -> None:
        process = self._process
        responses = self._responses
        self._process = None
        self._responses = None
        if process is None:
            return
        if process.poll() is None and graceful and process.stdin is not None:
            job_id = uuid4().hex
            try:
                process.stdin.write(
                    json.dumps({"action": "shutdown", "job_id": job_id}) + "\n"
                )
                process.stdin.flush()
                if responses is not None:
                    self._wait_for_message(
                        responses,
                        expected_type="shutdown",
                        job_id=job_id,
                        timeout=10,
                    )
                process.wait(timeout=10)
            except Exception:
                graceful = False
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        logger.info(
            "docsync.word_worker_recycle reason=%s graceful=%s stderr=%s",
            reason,
            graceful,
            " | ".join(self._stderr_tail)[-1000:],
        )

    def shutdown(self) -> None:
        with self._lock:
            self._stop_locked(graceful=True, reason="application_shutdown")

    def render(self, source_path: Path, output_path: Path) -> dict:
        with self._lock:
            latest_error = "Microsoft Word could not render this document."
            for attempt in range(2):
                try:
                    self._start_locked()
                    responses = self._responses
                    if responses is None:
                        raise WordWorkerUnavailable(
                            "The Microsoft Word worker is not running."
                        )
                    job_id = uuid4().hex
                    self._send_locked(
                        {
                            "action": "render",
                            "job_id": job_id,
                            "source_path": str(source_path.resolve()),
                            "output_path": str(output_path.resolve()),
                        }
                    )
                    result = self._wait_for_message(
                        responses,
                        expected_type="result",
                        job_id=job_id,
                        timeout=settings.word_worker_timeout_seconds,
                    )
                    if result.get("ok"):
                        logger.info(
                            "docsync.word_worker_document_open_timing duration_ms=%.2f",
                            float(result.get("document_open_ms") or 0),
                        )
                        logger.info(
                            "docsync.word_worker_export_timing duration_ms=%.2f",
                            float(result.get("pdf_export_ms") or 0),
                        )
                        if result.get("recycled"):
                            logger.info(
                                "docsync.word_worker_recycle reason=max_renders max_renders=%s",
                                settings.word_worker_max_renders,
                            )
                        return result
                    latest_error = str(result.get("error") or latest_error)
                    if not result.get("worker_unusable"):
                        break
                    self._stop_locked(graceful=True, reason="render_failure")
                except WordWorkerTimedOut:
                    self._stop_locked(graceful=False, reason="render_timeout")
                    if attempt == 1:
                        raise
                except WordWorkerUnavailable:
                    self._stop_locked(graceful=False, reason="worker_unavailable")
                    if attempt == 1:
                        raise
            raise WordRenderFailed(latest_error)


WORD_RENDER_WORKER = PersistentWordRenderWorker()


def start_word_render_worker() -> bool:
    return WORD_RENDER_WORKER.start()


def shutdown_word_render_worker() -> None:
    WORD_RENDER_WORKER.shutdown()


def render_docx_with_word_worker(source_path: Path, output_path: Path) -> dict:
    return WORD_RENDER_WORKER.render(source_path, output_path)
