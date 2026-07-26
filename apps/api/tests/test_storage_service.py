from __future__ import annotations

import sys
import time
from io import BytesIO
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from docx import Document
from app.config import settings
from app.storage_service import DocumentStorageService


def create_minimal_docx_bytes() -> bytes:
    bio = BytesIO()
    doc = Document()
    doc.add_paragraph("Storage service test paragraph")
    doc.save(bio)
    return bio.getvalue()


def test_create_working_copy_preserves_original(tmp_path):
    data_dir = tmp_path / "DocuSyncData"
    object.__setattr__(settings, "data_dir", data_dir)

    source_file = tmp_path / "external_source.docx"
    payload = create_minimal_docx_bytes()
    source_file.write_bytes(payload)

    working_file, unique_name, working_payload = DocumentStorageService.create_working_copy(
        source_file, "external_source.docx"
    )

    # Source file remains intact
    assert source_file.exists()
    assert source_file.read_bytes() == payload

    # Working copy created inside workspace
    assert working_file.exists()
    assert working_file.parent == DocumentStorageService.get_workspace_dir()
    assert unique_name == "external_source.docx"


def test_duplicate_file_handling_does_not_overwrite(tmp_path):
    data_dir = tmp_path / "DocuSyncData"
    object.__setattr__(settings, "data_dir", data_dir)

    payload = create_minimal_docx_bytes()
    _, name1, _ = DocumentStorageService.create_working_copy(payload, "report.docx")
    _, name2, _ = DocumentStorageService.create_working_copy(payload, "report.docx")

    assert name1 == "report.docx"
    assert name2 == "report (1).docx"
    assert (DocumentStorageService.get_workspace_dir() / name1).exists()
    assert (DocumentStorageService.get_workspace_dir() / name2).exists()


def test_stale_temp_cleanup(tmp_path):
    data_dir = tmp_path / "DocuSyncData"
    object.__setattr__(settings, "data_dir", data_dir)

    temp_dir = DocumentStorageService.get_temp_dir()
    stale_file = temp_dir / "tmp_stale123.docx"
    stale_file.write_bytes(b"temp")

    # Set mtime to 2 hours ago
    two_hours_ago = time.time() - 7200
    import os
    os.utime(stale_file, (two_hours_ago, two_hours_ago))

    cleaned = DocumentStorageService.cleanup_stale_temp_files(max_age_seconds=3600)
    assert cleaned == 1
    assert not stale_file.exists()
