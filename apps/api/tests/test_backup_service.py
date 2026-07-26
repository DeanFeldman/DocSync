from __future__ import annotations

import sys
from io import BytesIO
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from docx import Document

from app.config import settings
from app.backup_service import DocumentBackupService
from app.storage_service import DocumentStorageService


def create_minimal_docx_bytes(text: str = "Test document") -> bytes:
    bio = BytesIO()
    doc = Document()
    doc.add_paragraph(text)
    doc.save(bio)
    return bio.getvalue()


def test_create_and_list_backups(tmp_path):
    data_dir = tmp_path / "DocuSyncData"
    object.__setattr__(settings, "data_dir", data_dir)

    payload = create_minimal_docx_bytes("Original Version")
    working_file, _, _ = DocumentStorageService.create_working_copy(payload, "doc1.docx")

    backup_file = DocumentBackupService.create_backup(working_file, doc_id="doc_123")
    assert backup_file is not None
    assert backup_file.exists()

    backups = DocumentBackupService.list_backups("doc_123")
    assert len(backups) == 1
    assert backups[0]["filename"] == backup_file.name


def test_restore_backup(tmp_path):
    data_dir = tmp_path / "DocuSyncData"
    object.__setattr__(settings, "data_dir", data_dir)

    original_payload = create_minimal_docx_bytes("Original text")
    working_file, _, _ = DocumentStorageService.create_working_copy(original_payload, "doc1.docx")

    # Create backup of original
    DocumentBackupService.create_backup(working_file, doc_id="doc_123")

    # Overwrite working file with modified text
    modified_payload = create_minimal_docx_bytes("Modified text")
    working_file.write_bytes(modified_payload)
    assert working_file.read_bytes() == modified_payload

    # Restore backup
    restored_file = DocumentBackupService.restore_latest_backup(working_file, doc_id="doc_123")
    assert restored_file == working_file
    assert restored_file.read_bytes() == original_payload


def test_prune_backups(tmp_path):
    data_dir = tmp_path / "DocuSyncData"
    object.__setattr__(settings, "data_dir", data_dir)

    payload = create_minimal_docx_bytes("Text")
    working_file, _, _ = DocumentStorageService.create_working_copy(payload, "doc1.docx")

    for _ in range(12):
        DocumentBackupService.create_backup(working_file, doc_id="doc_123")

    backups = DocumentBackupService.list_backups("doc_123")
    assert len(backups) == 10  # Max retention is 10
