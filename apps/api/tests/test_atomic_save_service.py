from __future__ import annotations

import sys
from io import BytesIO
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import pytest
from docx import Document

from app.config import settings
from app.atomic_save_service import AtomicSaveService
from app.error_mapper import SaveValidationFailedError
from app.storage_service import DocumentStorageService


def create_minimal_docx_bytes(text: str = "Test document") -> bytes:
    bio = BytesIO()
    doc = Document()
    doc.add_paragraph(text)
    doc.save(bio)
    return bio.getvalue()


def test_atomic_save_success(tmp_path):
    data_dir = tmp_path / "DocuSyncData"
    object.__setattr__(settings, "data_dir", data_dir)

    initial_payload = create_minimal_docx_bytes("Initial Content")
    working_file, _, _ = DocumentStorageService.create_working_copy(initial_payload, "doc_save.docx")

    new_payload = create_minimal_docx_bytes("New Valid Content")
    saved_file = AtomicSaveService.save_document(working_file, doc_id="doc_save_1", content_or_writer=new_payload)

    assert saved_file.exists()
    assert saved_file.read_bytes() == new_payload


def test_atomic_save_rollback_on_malformed_output(tmp_path):
    data_dir = tmp_path / "DocuSyncData"
    object.__setattr__(settings, "data_dir", data_dir)

    initial_payload = create_minimal_docx_bytes("Valid Initial Version")
    working_file, _, _ = DocumentStorageService.create_working_copy(initial_payload, "doc_save.docx")

    malformed_payload = b"NOT A DOCX FILE AT ALL - MALFORMED SAVE"

    with pytest.raises(SaveValidationFailedError) as exc_info:
        AtomicSaveService.save_document(working_file, doc_id="doc_save_1", content_or_writer=malformed_payload)

    assert exc_info.value.code == "DOC-009"
    # Verify working file was restored to valid initial payload
    assert working_file.exists()
    assert working_file.read_bytes() == initial_payload
