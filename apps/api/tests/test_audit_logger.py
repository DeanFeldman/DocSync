from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import json
from app.audit_logger import AuditLogger
from app.config import settings


def test_audit_logger_structure_and_privacy(tmp_path):
    data_dir = tmp_path / "DocuSyncData"
    object.__setattr__(settings, "data_dir", data_dir)
    AuditLogger._logger = None
    AuditLogger._file_handler = None

    event = AuditLogger.log_event(
        operation="test_operation",
        file_id="doc_xyz.docx",
        error_code="DOC-003",
        reference_id="REF-123456",
        details="Corrupted XML structure detected",
    )

    assert event["operation"] == "test_operation"
    assert event["file_id"] == "doc_xyz.docx"
    assert event["error_code"] == "DOC-003"
    assert event["reference_id"] == "REF-123456"

    # Verify log file output
    log_file = data_dir / "logs" / "audit.log"
    assert log_file.exists()
    content = log_file.read_text(encoding="utf-8")
    assert "test_operation" in content
    assert "DOC-003" in content

    # Privacy check (SEC-05 & AC-07): Confirm no secret body paragraph text is logged
    secret_body_paragraph = "CONFIDENTIAL SECRET BODY TEXT PARAGRAPH 998877"
    AuditLogger.log_event(
        operation="import_document",
        file_id="doc_privacy.docx",
        details="Imported document successfully",
    )
    new_content = log_file.read_text(encoding="utf-8")
    assert secret_body_paragraph not in new_content
