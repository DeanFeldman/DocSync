from __future__ import annotations

import sys
import zipfile
from io import BytesIO
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import pytest
from docx import Document

from app.error_mapper import (
    CorruptedPackageError,
    FileTooLargeError,
    InvalidDocumentError,
    PasswordProtectedError,
    UnsupportedFormatError,
)
from app.validation_service import DocumentValidationService


def create_minimal_docx_bytes() -> bytes:
    bio = BytesIO()
    doc = Document()
    doc.add_paragraph("Hello world DocuSync test")
    doc.save(bio)
    return bio.getvalue()


def test_valid_docx_validation():
    payload = create_minimal_docx_bytes()
    validated = DocumentValidationService.validate_file(payload, filename="valid.docx")
    assert validated == payload


def test_unsupported_extension():
    payload = create_minimal_docx_bytes()
    with pytest.raises(UnsupportedFormatError) as exc_info:
        DocumentValidationService.validate_file(payload, filename="file.pdf")
    assert exc_info.value.code == "DOC-001"
    assert exc_info.value.status_code == 415


def test_empty_file_rejection():
    with pytest.raises(InvalidDocumentError) as exc_info:
        DocumentValidationService.validate_file(b"", filename="empty.docx")
    assert exc_info.value.code == "DOC-002"


def test_file_too_large_rejection():
    payload = create_minimal_docx_bytes()
    with pytest.raises(FileTooLargeError) as exc_info:
        DocumentValidationService.validate_file(payload, filename="large.docx", max_bytes=10)
    assert exc_info.value.code == "DOC-005"
    assert exc_info.value.status_code == 413


def test_non_zip_renamed_file():
    with pytest.raises(InvalidDocumentError) as exc_info:
        DocumentValidationService.validate_file(b"This is plain text not a zip", filename="renamed.docx")
    assert exc_info.value.code == "DOC-002"


def test_missing_content_types_xml():
    bio = BytesIO()
    with zipfile.ZipFile(bio, "w") as zf:
        zf.writestr("word/document.xml", "<w:document></w:document>")
    with pytest.raises(CorruptedPackageError) as exc_info:
        DocumentValidationService.validate_file(bio.getvalue(), filename="missing_types.docx")
    assert exc_info.value.code == "DOC-003"


def test_missing_word_document_xml():
    bio = BytesIO()
    with zipfile.ZipFile(bio, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types></Types>")
    with pytest.raises(CorruptedPackageError) as exc_info:
        DocumentValidationService.validate_file(bio.getvalue(), filename="missing_doc.docx")
    assert exc_info.value.code == "DOC-003"


def test_encrypted_package_detection():
    bio = BytesIO()
    with zipfile.ZipFile(bio, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types></Types>")
        zf.writestr("word/document.xml", "<w:document></w:document>")
        zf.writestr("EncryptedPackage", "encrypted_data_blob")
    with pytest.raises(PasswordProtectedError) as exc_info:
        DocumentValidationService.validate_file(bio.getvalue(), filename="protected.docx")
    assert exc_info.value.code == "DOC-004"
